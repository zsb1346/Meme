import { describe, expect, it } from 'vitest';
import {
  KEY_BASE_MIDI,
  KEY_DOMAIN_MAX_COUNT,
  KEY_MAX_MIDI,
  isBlackMidi,
  isDiatonicMidi,
  keyPitch,
  keyPitchAt,
  keyRangePresets,
  legacyPitchOfLane,
  midiNoteName,
  nextVisiblePitch,
  presetOctavesOfSpan,
  spanOfPresetOctaves,
  visibleKeyCount,
  visibleKeysInSpan,
} from './pitch-map';

describe('midiNoteName（科学音高记谱，C4 = 60）', () => {
  it('常用音', () => {
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(69)).toBe('A4');
    expect(midiNoteName(48)).toBe('C3');
    expect(midiNoteName(61)).toBe('C#4');
    expect(midiNoteName(108)).toBe('C8');
    expect(midiNoteName(0)).toBe('C-1');
  });
  it('越界与小数夹取', () => {
    expect(midiNoteName(-5)).toBe('C-1');
    expect(midiNoteName(200)).toBe('G9'); // 127
    expect(midiNoteName(60.4)).toBe('C4');
  });
});

describe('legacyPitchOfLane（旧映射：lane 0 = C4，大调铺开）', () => {
  it('与旧行为逐点一致', () => {
    expect(legacyPitchOfLane(0)).toBe(60); // C4 = do
    expect(legacyPitchOfLane(1)).toBe(62); // D4
    expect(legacyPitchOfLane(6)).toBe(71); // B4 = si
    expect(legacyPitchOfLane(7)).toBe(72); // C5 = do'
    expect(legacyPitchOfLane(13)).toBe(83); // B5
    expect(legacyPitchOfLane(20)).toBe(95); // B6
  });
});

describe('keyPitchAt（键集 = 从 C3 起的连续半音序列）', () => {
  it('逐半音铺开，一格一个半音', () => {
    expect(keyPitchAt(0)).toBe(48); // C3
    expect(keyPitchAt(1)).toBe(49); // C#3 —— 半音键**从一开始就在**
    expect(keyPitchAt(2)).toBe(50); // D3
    expect(keyPitchAt(12)).toBe(60); // C4 —— 第 2 个八度起点
    expect(keyPitchAt(24)).toBe(72); // C5
    expect(keyPitchAt(60)).toBe(108); // C8 —— 最后一格
  });
  it('越界夹到 C8 / 负数夹到 C3', () => {
    expect(keyPitchAt(61)).toBe(KEY_MAX_MIDI);
    expect(keyPitchAt(999)).toBe(KEY_MAX_MIDI);
    expect(keyPitchAt(-3)).toBe(KEY_BASE_MIDI);
  });
  it('域格数上限与序列长度一致', () => {
    expect(KEY_DOMAIN_MAX_COUNT).toBe(61);
    expect(keyPitchAt(KEY_DOMAIN_MAX_COUNT - 1)).toBe(KEY_MAX_MIDI);
  });
});

describe('nextVisiblePitch（扩大音域时的下一个音）', () => {
  it('null → 键域起点 C3', () => {
    expect(nextVisiblePitch(null, true)).toBe(KEY_BASE_MIDI);
    expect(nextVisiblePitch(null, false)).toBe(KEY_BASE_MIDI);
  });
  it('半音键开启：逐 +1（黑键也算一格）', () => {
    expect(nextVisiblePitch(48, true)).toBe(49); // C3 → C#3
    expect(nextVisiblePitch(59, true)).toBe(60); // B3 → C4
  });
  it('半音键收起：跳过黑键，只落在白键上', () => {
    expect(nextVisiblePitch(48, false)).toBe(50); // C3 → **D3**（跳过 C#3）
    expect(nextVisiblePitch(52, false)).toBe(53); // E3 → F3（半音步，F 是白键）
    expect(nextVisiblePitch(59, false)).toBe(60); // B3 → C4
  });
  it('⭐ 关闭半音键时「下一个」永远是白键（否则「＋」加了个看不见的键）', () => {
    let p: number | null = null;
    for (let i = 0; i < 8; i++) {
      p = nextVisiblePitch(p, false);
      expect(p).not.toBeNull();
      expect(isDiatonicMidi(p!)).toBe(true);
    }
  });
  it('到顶返回 null（停住，不绕回低音区）', () => {
    expect(nextVisiblePitch(KEY_MAX_MIDI, false)).toBeNull();
    expect(nextVisiblePitch(KEY_MAX_MIDI, true)).toBeNull();
    expect(nextVisiblePitch(107, false)).toBe(108); // B7 → C8
    expect(nextVisiblePitch(107, true)).toBe(108);
  });
});

describe('keyPitch（权威音高）', () => {
  it('显式 pitchMidi 优先', () => {
    expect(keyPitch({ pitchMidi: 49 }, 0)).toBe(49);
  });
  it('缺省回落旧映射（仅未迁移的老数据会走到）', () => {
    expect(keyPitch({}, 0)).toBe(60);
    expect(keyPitch({}, 7)).toBe(72);
  });
});

describe('黑白键判定', () => {
  it('黑键', () => {
    for (const p of [49, 51, 54, 56, 58, 61]) expect(isBlackMidi(p)).toBe(true);
    expect(isDiatonicMidi(61)).toBe(false);
  });
  it('白键', () => {
    for (const p of [48, 50, 52, 53, 55, 57, 59, 60]) expect(isBlackMidi(p)).toBe(false);
    expect(isDiatonicMidi(60)).toBe(true);
  });
});

describe('可见键数（半音键开关只改「露多少个键」）', () => {
  it('整八度：n 个八度 = 开启 12n 键 / 收起 7n 键', () => {
    expect(visibleKeysInSpan(12, true)).toBe(12);
    expect(visibleKeysInSpan(12, false)).toBe(7);
    expect(visibleKeysInSpan(24, false)).toBe(14);
    expect(visibleKeysInSpan(36, false)).toBe(21);
  });

  it('⭐ 开关不改音域：同一段音域在两种状态下可见键数不同，但都不越界', () => {
    for (const p of keyRangePresets()) {
      const on = visibleKeysInSpan(p.span, true);
      const off = visibleKeysInSpan(p.span, false);
      expect(on).toBe(p.span);
      expect(off).toBe((p.span / 12) * 7);
      expect(off).toBeLessThan(on);
    }
  });

  it('自定档按实际音高数（非整八度也准）', () => {
    const pitches = [48, 49, 50]; // C3 C#3 D3
    expect(visibleKeyCount(pitches, true)).toBe(3);
    expect(visibleKeyCount(pitches, false)).toBe(2); // C#3 被收起
  });
});

describe('音域档位（口径 = 八度数，与半音键开关无关）', () => {
  it('档位取值 = 12 / 24 / 36 个半音格', () => {
    expect(keyRangePresets().map((p) => p.span)).toEqual([12, 24, 36]);
    expect(keyRangePresets().map((p) => p.octaves)).toEqual([1, 2, 3]);
  });

  it('⭐ 档位的含义与开关无关（拨开关音域不会跳）', () => {
    // 同一个档位在两态下 span 恒等 —— 这正是「拨开关不跑音」的数学表达
    for (const p of keyRangePresets()) {
      expect(p.span).toBe(12 * p.octaves);
    }
  });

  it('档位都落在合法可建区间内', () => {
    for (const p of keyRangePresets()) {
      expect(p.span).toBeLessThanOrEqual(KEY_DOMAIN_MAX_COUNT);
      expect(keyPitchAt(p.span - 1)).toBeLessThanOrEqual(KEY_MAX_MIDI);
      expect(p.span % 12).toBe(0); // 整数八度 → 键位矩阵永远是满行
    }
  });

  it('presetOctavesOfSpan：命中返回八度数，否则 null', () => {
    expect(presetOctavesOfSpan(12)).toBe(1);
    expect(presetOctavesOfSpan(24)).toBe(2);
    expect(presetOctavesOfSpan(36)).toBe(3);
    expect(presetOctavesOfSpan(14)).toBeNull(); // 旧「14 键」不是整八度
    expect(presetOctavesOfSpan(21)).toBeNull();
    expect(presetOctavesOfSpan(61)).toBeNull();
  });

  it('spanOfPresetOctaves：非法档位返回 null（调用方据此不做变更）', () => {
    expect(spanOfPresetOctaves(1)).toBe(12);
    expect(spanOfPresetOctaves(3)).toBe(36);
    expect(spanOfPresetOctaves(4)).toBeNull();
    expect(spanOfPresetOctaves(0)).toBeNull();
  });
});
