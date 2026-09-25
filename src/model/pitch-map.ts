/**
 * 键域与音高序列 —— 全项目「键 → 音高」的**单一事实来源**。
 *
 * ══ 设计（2026-09-25 与用户第二次定稿）══
 *
 * 1. **键集恒为「从键域起点起的连续半音序列」**：第 i 个键的音高 = base + i。
 *    半音键**默认就铺在数据里**，不是用户一个个加上去的 —— 用户原话
 *    「默认应该在后台上就加载好了那些半音按键」。
 *    新工程 base = **C3 = 48**；旧存档由 `migrateProject` 补全（音域不变）。
 * 2. **「半音」开关 = 黑键的可见/可用开关**，是**纯视图状态**：
 *      · 关闭 → 键盘不摆黑键（只剩白键），键还在数据里；
 *      · 打开 → 黑键全部出现。
 *    它不改任何键的音高、不改键数组长度、不改 Take 里的音符 ——
 *    关掉再打开，一个音都不跑。（旧实现把它当「新增键取哪条序列」，
 *    于是关掉开关后已存在的黑键被当白键「挤掉」别人的位置，用户实报。）
 * 3. 序列起点 C3 = MIDI 48，域上限 C8 = MIDI 108 → 格数上限 61。
 * 4. 音名一律科学音高记谱 **C4 = MIDI 60**（与 .mid 文件一致），
 *    全站统一 `midiNoteName`，不再出现 do/re/mi 唱名。
 *
 * 历史映射（lane 0 = C4 = 60、大调铺开）只保留为 `legacyPitchOfLane`，
 * 供旧存档迁移与「缺 pitchMidi 的兜底」两条路使用 —— 新代码不得直接调它。
 */

/** 新工程第一个键的音高：C3 = 48（用户定稿的标准起点） */
export const KEY_BASE_MIDI = 48;
/** 键域上限：C8 = 108 */
export const KEY_MAX_MIDI = 108;
/** 键数的硬上限 = 键域的格数，61（与半音开关**无关**） */
export const KEY_DOMAIN_MAX_COUNT = KEY_MAX_MIDI - KEY_BASE_MIDI + 1;
/** 旧映射的锚点：lane 0 = C4 = 60（仅迁移用） */
export const LEGACY_BASE_MIDI = 60;

/** 大调音阶相对主音的半音偏移（do re mi fa sol la si）—— 仅旧映射用 */
export const MAJOR_STEPS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
/** 一个八度的半音数（键域格数 = 12 × 八度数） */
export const SEMITONES_PER_OCTAVE = 12;
/** 一个八度的白键数（关闭半音时，n 个八度 = 7n 个可见键） */
export const DIATONIC_PER_OCTAVE = 7;

/** 十二平均律音名（pitch % 12 → 音名） */
const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;
/** 黑键音级集合（八度内偏移）：C# D# F# G# A# */
const BLACK_DEGREES = new Set([1, 3, 6, 8, 10]);

/** MIDI 音号 → 音名（如 60 → "C4"，A4 = 69；科学音高记谱） */
export function midiNoteName(midi: number): string {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}

/** 是否黑键音级（钢琴外观/布局/半音开关用） */
export function isBlackMidi(midi: number): boolean {
  return BLACK_DEGREES.has(((Math.round(midi) % 12) + 12) % 12);
}

/** 是否白键（自然音） */
export function isDiatonicMidi(midi: number): boolean {
  return !isBlackMidi(midi);
}

/**
 * 旧键道下标 → MIDI 音高（lane 0 = C4 = 60，大调铺开，每八度 7 行 +12）。
 *
 * ⚠️ 仅两条合法用途：① 旧存档迁移（`migrateProject` 给老键补 pitchMidi）；
 * ② 缺 pitchMidi 数据的兜底。新功能代码一律走 Key.pitchMidi。
 */
export function legacyPitchOfLane(lane: number): number {
  const l = Math.max(0, Math.round(lane));
  return Math.min(
    127,
    LEGACY_BASE_MIDI + Math.floor(l / DIATONIC_PER_OCTAVE) * 12 + MAJOR_STEPS[l % DIATONIC_PER_OCTAVE],
  );
}

/**
 * 键的权威音高：显式 `pitchMidi` 优先；缺省回落旧下标映射
 * （只有「未经 migrateProject 的旧数据」才会走到兜底 —— 正常路径不会发生）。
 */
export function keyPitch(key: { pitchMidi?: number }, keyIndex: number): number {
  return typeof key.pitchMidi === 'number' && Number.isFinite(key.pitchMidi)
    ? key.pitchMidi
    : legacyPitchOfLane(keyIndex);
}

/**
 * 键集里第 `index` 个键的音高（**连续半音序列**，从 C3 起）。
 *
 * 这是「后台默认铺好的那套键」的公式：半音键从一开始就在，不靠用户添加。
 * 域上限之外夹到 C8（调用方应先确保 index < KEY_DOMAIN_MAX_COUNT）。
 */
export function keyPitchAt(index: number): number {
  const i = Math.max(0, Math.round(index));
  return Math.min(KEY_MAX_MIDI, KEY_BASE_MIDI + i);
}

/**
 * 序列中「下一个**可见**的音」。
 *   · `after === null` → 序列起点 C3；
 *   · `semitoneEnabled`（= 半音键开启）→ 逐半音（+1）；
 *   · 关闭 → 跳过一个八度里的黑键，只停在白键上；
 *   · 越过域上限 C8 → `null`（调用方据此「停住并提示」，不绕回）。
 *
 * ⚠️ 关闭时**必须跳黑键**：否则「＋」会把音域扩到一个看不见的黑键上，
 * 用户点了半天键盘毫无变化（这是「后台铺好键集」之后最容易踩的坑）。
 */
export function nextVisiblePitch(
  after: number | null,
  semitoneEnabled: boolean,
): number | null {
  let p = (after === null ? KEY_BASE_MIDI - 1 : Math.round(after)) + 1;
  if (!semitoneEnabled) while (p <= KEY_MAX_MIDI && !isDiatonicMidi(p)) p++;
  return p <= KEY_MAX_MIDI ? p : null;
}

/**
 * 音域格数 → **键盘上实际能看到的键数**。
 *
 * 关闭半音时黑键被收起：n 个八度 = 7n 个可见键。
 * 只对 `span % 12 === 0`（预设档位）成立 —— 自定档请直接用
 * `visibleKeyCount(pitches, on)` 数实际键数组。
 */
export function visibleKeysInSpan(span: number, semitoneEnabled: boolean): number {
  if (semitoneEnabled) return span;
  const full = Math.floor(span / SEMITONES_PER_OCTAVE);
  const rest = span - full * SEMITONES_PER_OCTAVE;
  let n = full * DIATONIC_PER_OCTAVE;
  // 尾段：从 C 起数 rest 个半音里有几个白键（预设档位下 rest = 0）
  for (let i = 0; i < rest; i++) if (isDiatonicMidi(KEY_BASE_MIDI + i)) n++;
  return n;
}

/** 当前键集里可显示的键数（按实际音高数，自定档也准） */
export function visibleKeyCount(
  pitches: readonly number[],
  semitoneEnabled: boolean,
): number {
  return semitoneEnabled
    ? pitches.length
    : pitches.reduce((n, p) => n + (isDiatonicMidi(p) ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// 音域档位
// ---------------------------------------------------------------------------

/**
 * 音域档位 —— **以「八度」为单位**，`span` = 12 × octaves 个**半音格**。
 *
 * ══ 为什么口径是八度、而不是键数（2026-09-25 用户提出）══
 *
 * 旧口径是「键数 7 / 14 / 21」，同一串数字在两种模式下指向的音域完全不同
 * （半音的「21」= 1.75 个八度，收在黑键 G#4 上）；而且它和开关互相打架。
 *
 * 改成八度后，同一个档位**在任何开关状态下都是同一段音域**：
 * 选「2 个八度」永远是 24 个半音格（C3–B4），打开半音只是把这段音域
 * **切得更细**（14 个可见键 → 24 个），不是把范围换掉。
 *
 * 于是「开关」和「音域」彻底正交：拨开关不会动音域，改音域不会动开关。
 */
export interface KeyRangePreset {
  /** 八度数 —— 档位的内部值 */
  readonly octaves: number;
  /** 音域格数（半音数）—— **与开关无关** */
  readonly span: number;
}

/** 预设档位（1/2/3 个八度）—— UI 与校验共用这一处 */
export const KEY_RANGE_PRESET_OCTAVES: readonly number[] = [1, 2, 3];

/** 整套音域档位（不依赖开关状态） */
export function keyRangePresets(): KeyRangePreset[] {
  return KEY_RANGE_PRESET_OCTAVES.map((octaves) => ({
    octaves,
    span: SEMITONES_PER_OCTAVE * octaves,
  }));
}

/** 音域格数 → 命中的档位八度数；没命中返回 `null`（UI 落到「自定」） */
export function presetOctavesOfSpan(span: number): number | null {
  return keyRangePresets().find((p) => p.span === span)?.octaves ?? null;
}

/** 档位八度数 → 音域格数；非法档位返回 `null`（调用方据此不做变更） */
export function spanOfPresetOctaves(octaves: number): number | null {
  return keyRangePresets().find((p) => p.octaves === octaves)?.span ?? null;
}
