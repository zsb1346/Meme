/**
 * 卷帘的**电脑键盘弹奏**映射 —— 纯函数层（零 React、零音频、零 DOM 状态）。
 *
 * 抽出来的理由：这一段全是「输入一个键 → 该响哪一行」的换算，出错的形态
 * 又都是**安静的**（按了没反应 / 两个键落到同一行 / 基准被自己夹回去），
 * 靠手点和截图都很难稳定发现。放进纯模块后可以在 vitest 里逐个断言。
 *
 * ⚠️ 本模块**只回答「响哪个音」**，绝不发声。发声在 `useRollController`，
 * 且只调合成声部 —— 卷帘从不触发素材播放（见 `roll-synth-only.test.ts`）。
 */
import { clamp } from './geometry';

/**
 * 音乐打字布局（Ableton / FL 同款），一个半八度：
 *
 *     W  E     T  Y  U     O  P
 *    A  S  D  F  G  H  J  K  L  ;
 *    0  2  4  5  7  9  11 12 14 16   ← 相对基准的半音偏移
 *    1  3     6  8  10    13 15
 *
 * 用 **`KeyboardEvent.code`（物理键位）** 而不是 `key`：`key` 随输入法、
 * 大小写、键盘布局漂移（中文输入法下可能给到 'Process' 甚至空串），
 * 同一排键在不同机器上落点不同；`code` 描述的是「手指按了哪一格」，
 * DAW 的惯例也是记物理位置。
 */
export const KEYBOARD_SEMITONES: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
};

/** 基准八度下移 / 上移 */
export const KEYBOARD_OCTAVE_DOWN = 'KeyZ';
export const KEYBOARD_OCTAVE_UP = 'KeyX';

/** 弹奏基准的出厂位置（C4）。会被夹进当前键域，见 `keyboardBasePitch`。 */
export const KEYBOARD_BASE_DEFAULT = 60;

/**
 * 基准音（= `A` 键发出的音高）。
 *
 * 规则：**基准始终吸附到键域内的某个 C** —— 于是「A 键 = 一个八度的起点」
 * 在任何键域下都成立，`Z`/`X` 来回按也永远回得到原位。
 *
 * ⛔ 夹取区间只能是键域本身 `[lo, hi]`，**不能再按「给上行留 16 个半音」
 * 收窄**：收紧之后默认 C4 会被压到键域下沿，而 `X`（上移八度）算出的基准
 * 又会被同一个夹取压回去 → **按 X 毫无反应**。键太少时上方按键吸附到顶行
 * 是可接受的降级；基准走不动才是 bug。
 *
 * @param lanePitches 键域的权威音高（升序）
 * @param want        期望的基准（`null` = 用户还没移过，用出厂 C4）
 */
export function keyboardBasePitch(
  lanePitches: readonly number[],
  want: number | null,
): number {
  if (lanePitches.length === 0) return KEYBOARD_BASE_DEFAULT;
  const lo = lanePitches[0];
  const hi = lanePitches[lanePitches.length - 1];
  const wanted = clamp(want ?? KEYBOARD_BASE_DEFAULT, lo, hi);
  const lowerC = wanted - (((wanted % 12) + 12) % 12);
  const cands = [lowerC, lowerC + 12].filter((p) => p >= lo && p <= hi);
  if (cands.length === 0) return wanted;
  return cands.reduce((best, p) =>
    Math.abs(p - wanted) < Math.abs(best - wanted) ? p : best,
  );
}

/**
 * 半音偏移 → 该响哪一行。
 *
 * 先按音高**精确**匹配；匹配不到说明这个半音在当前键域里不存在
 * （关掉半音后没有黑键行）→ **落到最接近的键**。
 * 为什么不「不发声」：那样 W/E/T/Y/U 在自然音模式下全成死键，用户只会得到
 * 「按了没反应」；他要的是「按哪个都有声、且看得见落在哪一行」。
 * 同分时取低音（`<` 而非 `<=`），符合「往低处靠」的直觉。
 *
 * @param lanePitches 键域的权威音高（升序），**必须非空**
 * @param base        基准音（一般来自 `keyboardBasePitch`）
 * @param semitone    相对基准的半音偏移
 */
export function resolveKeyboardNote(
  lanePitches: readonly number[],
  base: number,
  semitone: number,
): { lane: number; pitch: number } {
  const want = base + semitone;
  let lane = -1;
  for (let i = 0; i < lanePitches.length; i++) {
    if (lanePitches[i] === want) {
      lane = i;
      break;
    }
  }
  if (lane < 0) {
    let bestD = Infinity;
    for (let i = 0; i < lanePitches.length; i++) {
      const d = Math.abs(lanePitches[i] - want);
      if (d < bestD) {
        bestD = d;
        lane = i;
      }
    }
  }
  return { lane, pitch: lanePitches[lane] };
}

/**
 * 焦点是否在「会吃字符的控件」里。
 *
 * 弹奏监听挂在 `window` 上（用户不必先点一下画布才能弹），所以必须自己判断
 * —— 否则在搜索框里打 "a" 会同时弹出一个音，且 `preventDefault` 把字符吞掉。
 * 与 App.tsx 里数字键跳页的守卫保持同一套判据。
 *
 * 用**鸭子类型**（只看 `tagName` / `isContentEditable`）而不是
 * `target instanceof HTMLElement`：后者在 `HTMLElement` 不存在的环境里
 * （node 单测）会直接抛，于是这个函数的正例永远测不到。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}
