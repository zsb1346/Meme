/**
 * 卷帘电脑键盘弹奏 —— 纯映射层的回归。
 *
 * 为什么这些断言值得写：这一层的错误形态全是**安静**的 ——
 * 「按了没反应」「两个键落到同一行」「基准被自己的夹取压回去」，
 * 手点和截图都很难稳定重现（要靠时序运气）。而它们全都可以用
 * 「给一组键域 + 按几下，看落到哪一行」精确断言。
 */
import { describe, it, expect } from 'vitest';
import {
  KEYBOARD_BASE_DEFAULT,
  KEYBOARD_OCTAVE_DOWN,
  KEYBOARD_OCTAVE_UP,
  KEYBOARD_SEMITONES,
  isTypingTarget,
  keyboardBasePitch,
  resolveKeyboardNote,
} from './keyboard-play';

/** 连续半音键域：C3 起 n 个键（与项目的键域定义一致，48 = C3） */
const chromatic = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => 48 + i);

/** 自然音（大调）键域：C D E F G A B … 从 C3 起 n 个键 */
const diatonic = (n: number): number[] => {
  const steps = [0, 2, 4, 5, 7, 9, 11];
  return Array.from({ length: n }, (_, i) => 48 + 12 * Math.floor(i / 7) + steps[i % 7]);
};

/** 全部音乐打字键的 code（布局表里那一排） */
const ALL_CODES = Object.keys(KEYBOARD_SEMITONES);

describe('keyboardBasePitch 基准音', () => {
  it('出厂位置是 C4（60）', () => {
    expect(KEYBOARD_BASE_DEFAULT).toBe(60);
  });

  it('键域够宽时落在 C4', () => {
    expect(keyboardBasePitch(chromatic(61), null)).toBe(60);
  });

  it('永远落在键域内、且一定是某个 C（音级 0）', () => {
    for (const n of [1, 5, 12, 24, 36, 61]) {
      const lanes = chromatic(n);
      const b = keyboardBasePitch(lanes, null);
      expect(b).toBeGreaterThanOrEqual(lanes[0]);
      expect(b).toBeLessThanOrEqual(lanes[lanes.length - 1]);
      expect(((b % 12) + 12) % 12).toBe(0);
    }
  });

  it('键域窄（12 键 C3–B3）时退到域内的 C3，不会越界', () => {
    expect(keyboardBasePitch(chromatic(12), null)).toBe(48);
  });

  it('⛔ X 上移八度后**必须真的移得动**：算出来的基准不许被夹取压回原位', () => {
    const lanes = chromatic(61);
    const up = keyboardBasePitch(lanes, 60) + 12;
    // 这一步曾经是「按 X 毫无反应」的现场：夹取区间若按「给上行留 16 个半音」
    // 收窄到 [lo, hi−16]，60 会被压到键域下沿，X 又被同一个夹取压回去。
    expect(keyboardBasePitch(lanes, up)).toBe(72);
    expect(keyboardBasePitch(lanes, 72 + 12)).toBe(84);
  });

  it('键域到顶时 X 是**安静的空操作**（是设计行为，不是 bug）', () => {
    /* 默认键域只有 24 键（C3–B4）→ C4 之上再没有更高的 C。
       此时「X 没反应」是正确结果，但必须满足两条：
         · 基准仍是域内的 C（不会跑到域外、不会变成非 C）；
         · 幂等（连按 X 不会漂到别处）。
       回归价值：这正是**默认**键域，而上面那条 X 的用例用的是 61 键域 ——
       只测非默认参数会让「默认配置下一按就没用」漏网。 */
    const lanes = chromatic(24);
    const b = keyboardBasePitch(lanes, null);
    expect(b).toBe(60);
    expect(keyboardBasePitch(lanes, b + 12)).toBe(60);
    expect(keyboardBasePitch(lanes, b + 24)).toBe(60);
  });

  it('到顶时不留下「延迟生效的意图」：存回算出来的值，之后加宽键域不会自己跳八度', () => {
    /* 调用方（hook）写 ref 的是**重算后的实际值**而不是「想要的原始值」。
       若存原始值 72，窄键域下按 X 看着毫无反应，等用户哪天把键域加宽，
       音区会凭空跳一个八度 —— 他没按任何键。这个用例把这条语义钉住。 */
    const narrow = chromatic(24);
    const b0 = keyboardBasePitch(narrow, null);
    const applied = keyboardBasePitch(narrow, b0 + 12);
    expect(applied).toBe(60);
    expect(keyboardBasePitch(chromatic(61), applied)).toBe(60);
    // 而真的按得动的时候，值当然要跟着走
    expect(keyboardBasePitch(chromatic(61), 72)).toBe(72);
  });

  it('Z / X 来回按回得到原位', () => {
    const lanes = chromatic(61);
    const b0 = keyboardBasePitch(lanes, null);
    const bUp = keyboardBasePitch(lanes, b0 + 12);
    expect(keyboardBasePitch(lanes, bUp - 12)).toBe(b0);
  });

  it('Z 到底不越界、再按还是同一个值（幂等）', () => {
    const lanes = chromatic(61);
    const lowest = keyboardBasePitch(lanes, 48);
    expect(lowest).toBe(48);
    expect(keyboardBasePitch(lanes, lowest - 12)).toBe(48);
  });

  it('空键域不崩（返回出厂基准，调用方另有非空保证）', () => {
    expect(keyboardBasePitch([], null)).toBe(KEYBOARD_BASE_DEFAULT);
  });
});

describe('resolveKeyboardNote 落点', () => {
  it('半音键齐全时，17 个键落在 17 个**互不相同**的行上', () => {
    const lanes = chromatic(61);
    const base = keyboardBasePitch(lanes, null);
    const lanesHit = ALL_CODES.map(
      (c) => resolveKeyboardNote(lanes, base, KEYBOARD_SEMITONES[c]).lane,
    );
    expect(ALL_CODES.length).toBe(17);
    expect(new Set(lanesHit).size).toBe(17);
  });

  it('A 就是基准音本身（「A = 一个八度的起点」）', () => {
    const lanes = chromatic(61);
    const base = keyboardBasePitch(lanes, null);
    expect(resolveKeyboardNote(lanes, base, KEYBOARD_SEMITONES.KeyA).pitch).toBe(60);
  });

  it('返回的 pitch 与 lane 自洽（pitch === lanePitches[lane]）', () => {
    const lanes = diatonic(24);
    const base = keyboardBasePitch(lanes, null);
    for (const c of ALL_CODES) {
      const r = resolveKeyboardNote(lanes, base, KEYBOARD_SEMITONES[c]);
      expect(r.pitch).toBe(lanes[r.lane]);
      expect(r.lane).toBeGreaterThanOrEqual(0);
      expect(r.lane).toBeLessThan(lanes.length);
    }
  });

  it('⛔ 自然音键域里没有死键：每个键都有落点、且都落在真实存在的行上', () => {
    const lanes = diatonic(21);
    const base = keyboardBasePitch(lanes, null);
    for (const c of ALL_CODES) {
      const r = resolveKeyboardNote(lanes, base, KEYBOARD_SEMITONES[c]);
      expect(lanes).toContain(r.pitch);
    }
  });

  it('超出键域上沿 → 吸附到顶行，不越界', () => {
    const lanes = chromatic(13); // C3..C4（48..60）
    const base = keyboardBasePitch(lanes, null);
    const r = resolveKeyboardNote(lanes, base, 16); // 远超 60
    expect(r.lane).toBe(lanes.length - 1);
    expect(r.pitch).toBe(60);
  });

  it('低于键域下沿 → 吸附到首行，不越界', () => {
    const lanes = chromatic(13);
    const r = resolveKeyboardNote(lanes, 48, -5);
    expect(r.lane).toBe(0);
    expect(r.pitch).toBe(48);
  });

  it('同分时取低音（半音正好卡在两个键中间）', () => {
    const lanes = diatonic(8); // 48 50 52 53 55 57 59 60
    // base 49（不存在于域内）→ 半音 0 → 49；49 与 48 / 50 等距 → 取 48
    expect(resolveKeyboardNote(lanes, 49, 0).pitch).toBe(48);
  });

  it('单键键域也可用（所有键都落到那一行）', () => {
    expect(resolveKeyboardNote([60], 60, 0)).toEqual({ lane: 0, pitch: 60 });
    expect(resolveKeyboardNote([60], 60, 11)).toEqual({ lane: 0, pitch: 60 });
  });
});

describe('键位表自身', () => {
  it('半音偏移覆盖 0..16 且无重复（= 一个半八度）', () => {
    const vals = Object.values(KEYBOARD_SEMITONES).sort((a, b) => a - b);
    expect(vals).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('八度键不在半音表里（否则一次按键会既移八度又弹音）', () => {
    expect(KEYBOARD_SEMITONES[KEYBOARD_OCTAVE_DOWN]).toBeUndefined();
    expect(KEYBOARD_SEMITONES[KEYBOARD_OCTAVE_UP]).toBeUndefined();
  });
});

describe('isTypingTarget 输入焦点守卫', () => {
  it('输入类控件 → true（不许把字符吃掉）', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName } as unknown as EventTarget)).toBe(true);
    }
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  it('普通元素 / window / null → false', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false);
  });

  it('小写标签名也认（innerHTML 解析出来的是大写，但不靠这个假设）', () => {
    expect(isTypingTarget({ tagName: 'input' } as unknown as EventTarget)).toBe(true);
  });
});
