/**
 * 波形预览几何测试。
 *
 * 预览是「看不见就不知道自己在调什么」的那一块 —— 而它出错时的表现同样安静：
 * 一条平线看不出是「真的一路为零」还是「算成了 NaN」，缩略图全一样。
 */

import { describe, expect, it } from 'vitest';

import { frameWavePath, harmBarPercent, midLinePath } from './wave-preview';

/** 从路径 `d` 里取出全部坐标对 */
function points(d: string): Array<[number, number]> {
  return (d.match(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g) ?? []).map((seg) => {
    const m = seg.slice(1).split(' ');
    return [Number(m[0]), Number(m[1])] as [number, number];
  });
}

const W = 34;
const H = 26;

describe('frameWavePath', () => {
  it('采样点数与请求一致，且首末点贴住左右边界', () => {
    const d = frameWavePath([0, 1, 0.5], W, H, 40);
    const pts = points(d);
    expect(pts.length).toBe(40);
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBe(W);
  });

  it('全零 / 空数组 → 一条正中平线（不是 NaN 路径 = 整块不渲染）', () => {
    for (const amps of [[], [0], [0, 0, 0, 0]]) {
      const d = frameWavePath(amps, W, H, 8);
      expect(d).not.toMatch(/NaN|Infinity/);
      for (const [, y] of points(d)) expect(y).toBe(H / 2);
    }
  });

  it('非有限输入被当成 0（上游断言失败时预览不该整块消失）', () => {
    const d = frameWavePath([0, 1, NaN, Infinity, -Infinity], W, H, 16);
    expect(d).not.toMatch(/NaN|Infinity/);
    for (const [x, y] of points(d)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
    }
  });

  it('越界振幅不画出画框（预览不该依赖上游已经夹过）', () => {
    const d = frameWavePath([0, 1e6, -1e6], W, H, 32);
    for (const [, y] of points(d)) {
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeLessThanOrEqual(H + 0.01);
    }
  });

  it('归一化：整体放大 10 倍后形状不变（否则小振幅的帧会是一条平线）', () => {
    const a = frameWavePath([0, 0.1, 0.05, 0.02], W, H, 32);
    const b = frameWavePath([0, 1, 0.5, 0.2], W, H, 32);
    expect(a).toBe(b);
  });

  it('真的动起来：纯基频是一条起伏的曲线，不是直线', () => {
    const d = frameWavePath([0, 1], W, H, 32);
    const ys = points(d).map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(H * 0.5);
  });

  it('直流分量被忽略（否则整条波形会被抬起来，读不出音色）', () => {
    const ac = frameWavePath([0, 1, 0], W, H, 32);
    const withDc = frameWavePath([5, 1, 0], W, H, 32);
    expect(withDc).toBe(ac);
  });
});

describe('harmBarPercent', () => {
  it('全零也留 2% 的底（柱子完全不见会被当成「这一格点不上」）', () => {
    expect(harmBarPercent(0)).toBe(2);
  });

  it('夹在 [2, 100]，非有限值回落到 2', () => {
    expect(harmBarPercent(1)).toBe(100);
    expect(harmBarPercent(3)).toBe(100);
    expect(harmBarPercent(-5)).toBe(2);
    expect(harmBarPercent(NaN)).toBe(2);
    expect(harmBarPercent(Infinity)).toBe(2);
  });

  it('单调：振幅大的柱子一定不矮', () => {
    let prev = -1;
    for (const v of [0, 0.1, 0.3, 0.5, 0.9, 1]) {
      const p = harmBarPercent(v);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('midLinePath', () => {
  it('是一条横穿画布中线的直线', () => {
    expect(midLinePath(W, H)).toBe(`M0 ${H / 2} H${W}`);
  });
});
