/**
 * `KeyLayout` 的**纯几何**：八度分组、排数、以及给调用方的高度区间。
 *
 * 为什么单测这一层：手机端「缩小塞进一屏」是把**排数**换算成键区高度的上下限
 * （`排数 × 64…96 + 间隙`），而排数来自八度分组。这两件事一旦各算一份，
 * 症状是「按 4 排算的高度配 3 排的画面」——末排被拉长、底下多一条空带，
 * 而且只在特定音域下出现（末尾刚好是个半黑键的尾组），极难复现。
 * 所以这里钉的是**分组语义本身**：
 *   - 白键按**音级**落列（不是按数组顺序填格）；
 *   - 黑键带正确的缝隙号；
 *   - 收起黑键时「整组只有黑键」的尾组整排丢掉（否则渲染成 7 个空格子的空白带）；
 *   - 高度区间 = 排数 × (64…96) + (排数−1) × 8。
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_ROW_GAP,
  KEY_ROW_MAX_H,
  KEY_ROW_MIN_H,
  keyAreaHeightRange,
  octaveGroups,
  octaveRowCount,
} from './KeyLayout';
import { isBlackMidi } from '../../model/pitch-map';

/** 从 C3 起、只取白键的 n 个键（半音键收起后的常态） */
function whitePitches(n: number): number[] {
  const out: number[] = [];
  for (let p = 48; out.length < n; p++) if (!isBlackMidi(p)) out.push(p);
  return out;
}
/** 从 C3 起的连续半音 n 个键 */
function chromaticPitches(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 48 + i);
}

describe('octaveRowCount（排数 = 八度组数）', () => {
  it('半音键收起：7 个白键一排，21 个正好三排', () => {
    expect(octaveRowCount(whitePitches(7), 7, true)).toBe(1);
    expect(octaveRowCount(whitePitches(14), 14, true)).toBe(2);
    expect(octaveRowCount(whitePitches(21), 21, true)).toBe(3);
  });

  it('⭐ 第 22 个白键开始进入第四排（手机横屏的分水岭）', () => {
    expect(octaveRowCount(whitePitches(21), 21, true)).toBe(3);
    expect(octaveRowCount(whitePitches(22), 22, true)).toBe(4);
    expect(octaveRowCount(whitePitches(26), 26, true)).toBe(4);
    expect(octaveRowCount(whitePitches(28), 28, true)).toBe(4);
    expect(octaveRowCount(whitePitches(35), 35, true)).toBe(5);
  });

  it('半音键开启：12 个一排', () => {
    expect(octaveRowCount(chromaticPitches(12), 12, false)).toBe(1);
    expect(octaveRowCount(chromaticPitches(24), 24, false)).toBe(2);
    expect(octaveRowCount(chromaticPitches(25), 25, false)).toBe(3);
  });

  it('⛔ 收起黑键时，末尾「整组只有黑键」的尾组整排丢掉', () => {
    // C3 + C#3：第二组（八度 5）只有黑键 C#3 → 收起黑键后不该占一排
    const pitches = [48, 49];
    expect(octaveRowCount(pitches, 2, false)).toBe(1); // 同组，本来就一排
    expect(octaveRowCount(pitches, 2, true)).toBe(1);
    // 补一个 C4（八度 5）→ 第二组有白键了 → 两排
    expect(octaveRowCount([48, 49, 60], 3, true)).toBe(2);
    // 对照：只给 C3 + C#3 + C#4（八度 5 仍然只有黑键）→ 仍然一排
    expect(octaveRowCount([48, 49, 61], 3, true)).toBe(1);
    expect(octaveRowCount([48, 49, 61], 3, false)).toBe(2);
  });

  it('排数只增不减：往后加键绝不会把已有的排挤掉', () => {
    const pitches = whitePitches(28);
    let prev = 0;
    for (let n = 1; n <= pitches.length; n++) {
      const rows = octaveRowCount(pitches.slice(0, n), n, true);
      expect(rows).toBeGreaterThanOrEqual(prev);
      prev = rows;
    }
  });
});

describe('octaveGroups（白键落列 / 黑键缝隙号）', () => {
  it('白键按**音级**落列，不按数组顺序', () => {
    // 只给 D3 与 E3：必须是第 1、2 列，而不是被顺次填成第 0、1 列
    const [entry] = octaveGroups([50, 52], 2, true);
    expect([...entry[1].whiteByCol.keys()].sort()).toEqual([1, 2]);
  });

  it('空列留洞：C3 + E3 时第 1 列必须空着', () => {
    const [entry] = octaveGroups([48, 52], 2, true);
    expect(entry[1].whiteByCol.get(0)).toBe(0);
    expect(entry[1].whiteByCol.has(1)).toBe(false);
    expect(entry[1].whiteByCol.get(2)).toBe(1);
  });

  it('黑键带正确的缝隙号（C#→1 D#→2 F#→4 G#→5 A#→6）', () => {
    const pitches = chromaticPitches(12);
    const [entry] = octaveGroups(pitches, 12, false);
    const byBoundary = entry[1].blacks.map((b) => b.boundary).sort((a, b) => a - b);
    expect(byBoundary).toEqual([1, 2, 4, 5, 6]);
    // 每个黑键的 i 都必须指向真的黑键
    for (const b of entry[1].blacks) expect(isBlackMidi(pitches[b.i])).toBe(true);
  });

  it('收起黑键时 blacks 为空，但键下标仍然有效（键还在，只是不摆）', () => {
    const pitches = chromaticPitches(12);
    const [entry] = octaveGroups(pitches, 12, true);
    expect(entry[1].blacks).toEqual([]);
    expect(entry[1].whiteByCol.size).toBe(7);
  });

  it('组按八度升序（自上而下 = 从低到高，与键盘一致）', () => {
    const rows = octaveGroups(whitePitches(21), 21, true).map(([g]) => g);
    expect(rows).toEqual([4, 5, 6]); // C3 / C4 / C5 的八度组号
  });
});

describe('keyAreaHeightRange（排数 → 键区高度区间）', () => {
  it('一排：64–96', () => {
    expect(keyAreaHeightRange(1)).toEqual({ minH: 64, maxH: 96 });
  });

  it('三排 / 四排：含排间间隙', () => {
    expect(keyAreaHeightRange(3)).toEqual({
      minH: 3 * KEY_ROW_MIN_H + 2 * KEY_ROW_GAP,
      maxH: 3 * KEY_ROW_MAX_H + 2 * KEY_ROW_GAP,
    });
    expect(keyAreaHeightRange(4)).toEqual({ minH: 280, maxH: 408 });
  });

  it('零排不出负数下限（空键集时不该给个负高度）', () => {
    expect(keyAreaHeightRange(0)).toEqual({ minH: 0, maxH: 0 });
  });

  it('⭐ 与排数换算一致：maxH − minH = 排数 × 32（每排的可伸缩余量）', () => {
    for (const rows of [1, 2, 3, 4, 7]) {
      const { minH, maxH } = keyAreaHeightRange(rows);
      expect(maxH - minH).toBe(rows * (KEY_ROW_MAX_H - KEY_ROW_MIN_H));
    }
  });
});
