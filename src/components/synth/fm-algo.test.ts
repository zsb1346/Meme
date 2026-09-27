/**
 * FM 算法矩阵的几何测试。
 *
 * 这段代码全是「算坐标」，而算错坐标的表现是**图静静地画错**：
 * 箭头指反、方框压住连线、某个坐标算成 NaN 导致整张图不渲染 ——
 * 一个运行时报错都没有，只能靠断言抓住。
 */

import { describe, expect, it } from 'vitest';

import { FM_ALGOS } from '../../engine/synth/patch';
import { fmAlgoCaption, fmAlgoGlyph, fmAlgoGlyphAll, FM_GLYPH_H, FM_GLYPH_W } from './fm-algo';

/** 从一个 SVG path 的 `d` 里取出全部数字（用于越界与 NaN 检查） */
function nums(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe('FM 算法矩阵几何', () => {
  it('8 张图都能算出来，且每张恰好 4 个算子方框', () => {
    const all = fmAlgoGlyphAll();
    expect(all.length).toBe(FM_ALGOS.length);
    for (const [i, g] of all.entries()) {
      expect(g.boxes.length, `算法 ${i + 1} 的算子数不对`).toBe(4);
      expect(g.boxes.map((b) => b.i)).toEqual([1, 2, 3, 4]);
    }
  });

  it('没有 NaN / Infinity 坐标（一个 NaN 会让整张图不渲染）', () => {
    for (const g of fmAlgoGlyphAll()) {
      for (const d of [...g.edges, ...g.arrows, ...g.rails]) {
        expect(d, '路径里出现了非有限数').not.toMatch(/NaN|Infinity/);
        expect(nums(d).length, `路径 "${d}" 里没有数字，说明算空了`).toBeGreaterThan(0);
      }
      for (const c of g.dots) {
        expect(Number.isFinite(c.cx) && Number.isFinite(c.cy)).toBe(true);
      }
    }
  });

  it('全部坐标都落在视口内（跑出视口 = 连线被裁断，看起来像少了一条边）', () => {
    // ⚠️ `d` 里 x 与 y 是混在一起的，没法逐个数分开判；用较大的那一维做上界，
    //    再单独把「横向到底在哪」的两处（输出轨圆点、方框右边缘）钉死。
    const maxDim = Math.max(FM_GLYPH_W, FM_GLYPH_H);
    for (const [i, g] of fmAlgoGlyphAll().entries()) {
      for (const d of [...g.edges, ...g.arrows, ...g.rails]) {
        for (const v of nums(d)) {
          expect(v, `算法 ${i + 1} 的路径越界：${d}`).toBeGreaterThanOrEqual(-1);
          expect(v, `算法 ${i + 1} 的路径越界：${d}`).toBeLessThanOrEqual(maxDim + 1);
        }
      }
      for (const c of g.dots) {
        expect(c.cx, `算法 ${i + 1} 的输出轨圆点跑到视口右边去了`).toBeLessThanOrEqual(FM_GLYPH_W);
      }
      for (const b of g.boxes) {
        expect(b.x).toBeGreaterThan(0);
        expect(b.x + b.w).toBeLessThanOrEqual(FM_GLYPH_W);
        expect(b.y).toBeGreaterThan(0);
        expect(b.y + b.h).toBeLessThan(FM_GLYPH_H);
      }
    }
  });

  it('输出轨数 = 发声算子数（少一条轨就是「这个算子其实不发声」）', () => {
    for (const [i, g] of fmAlgoGlyphAll().entries()) {
      expect(g.rails.length, `算法 ${i + 1} 的输出轨数不对`).toBe(FM_ALGOS[i].out.length);
      expect(g.dots.length).toBe(FM_ALGOS[i].out.length);
    }
  });

  it('调制边与箭头一一对应，条数 = 算法里的边数', () => {
    for (const [i, g] of fmAlgoGlyphAll().entries()) {
      expect(g.edges.length).toBe(FM_ALGOS[i].edges.length);
      expect(g.arrows.length).toBe(g.edges.length);
    }
  });

  it('算子 1 永远在底部（原型约定：1 号最靠输出总线）', () => {
    const g = fmAlgoGlyph(0);
    const y = new Map(g.boxes.map((b) => [b.i, b.y]));
    for (let i = 2; i <= 4; i++) {
      expect(y.get(i)!, `算子 ${i} 不在算子 1 上方`).toBeLessThan(y.get(1)!);
    }
  });

  it('发声算子有描边强调、非发声算子没有（否则看不出谁会响）', () => {
    // 全部 8 张算法里 1 号都是主载波
    for (const g of fmAlgoGlyphAll()) {
      expect(g.boxes[0].isOut).toBe(true);
    }
    // 算法 6（索引 6）里 4 号是「直出」，也该被标为发声
    expect(fmAlgoGlyph(6).boxes[3].isOut).toBe(true);
    // 算法 1（索引 0）里 4 号只是链尾调制器，不发声
    expect(fmAlgoGlyph(0).boxes[3].isOut).toBe(false);
  });

  it('越界的算法号被夹取（UI 传进来一个脏值时不该整块消失）', () => {
    expect(() => fmAlgoGlyph(-3)).not.toThrow();
    expect(() => fmAlgoGlyph(99)).not.toThrow();
    expect(fmAlgoGlyph(99).boxes.length).toBe(4);
    expect(fmAlgoGlyph(NaN).boxes.length).toBe(4);
  });

  it('说明文案永远指向真实存在的那张算法', () => {
    for (let i = 0; i < FM_ALGOS.length; i++) {
      const cap = fmAlgoCaption(i);
      expect(cap).toContain(FM_ALGOS[i].name);
      expect(cap).toContain(`算法 ${i + 1}/`);
    }
    expect(fmAlgoCaption(999)).toContain(FM_ALGOS[FM_ALGOS.length - 1].name);
  });
});
