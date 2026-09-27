/**
 * 波形整形曲线的「无直流」回归测试。
 *
 * ## 为什么值得单独测
 *
 * `WaveShaperNode` 把输入 `x ∈ [−1, 1]` 线性映射到曲线索引
 * `(x + 1) / 2 * (n − 1)`。曲线长度 `n` 是**偶数**时，映射出的索引
 * `(n − 1) / 2` 是**半整数** —— 输入 0 会落在两个样点中间，插值出一个
 * 非零常量。于是「过零」的正弦、乃至「所有音量都拧到 0」的静音 patch，
 * 输出都带一个直流偏置（实测 −60 dBFS，指纹是 `rms ≈ peak`）。
 *
 * 直流本身听不见，但它会一路喂进延迟 / 混响的反馈路径，更要紧的是会
 * **污染「静音 = 绝对零」这条基线** —— 而本项目的规矩是
 * 「判有没有出声必须用绝对量」，基线不干净，绝对量就失去意义。
 *
 * 这里不依赖 Web Audio（vitest 跑在 node 环境，没有 `OfflineAudioContext`），
 * 只把 `WaveShaper` 的索引映射照抄一遍，直接问：**输入 0 时曲线给出什么？**
 */

import { describe, expect, it } from 'vitest';

import { makeBitCurve, makeDistCurve } from './engine';
import { DRIVE_TYPE_OPTIONS } from './patch';

/** WaveShaper 的索引映射：输入 x ∈ [−1, 1] → 曲线上的浮点索引 */
function shaperIndex(x: number, n: number): number {
  return ((x + 1) / 2) * (n - 1);
}

/** 按 WaveShaper 的语义（线性插值）读曲线在输入 x 处的输出 */
function shaperAt(curve: Float32Array, x: number): number {
  const p = shaperIndex(x, curve.length);
  const i = Math.floor(p);
  const f = p - i;
  const a = curve[i];
  const b = curve[Math.min(i + 1, curve.length - 1)];
  return a * (1 - f) + b * f;
}

describe('波形整形曲线：奇数长度 ⇒ 输入 0 输出恒为 0（无直流）', () => {
  it('曲线长度必须是奇数（偶数会让 x=0 落在两个样点之间）', () => {
    for (const [type] of DRIVE_TYPE_OPTIONS) {
      for (const amount of [0, 0.3, 0.8]) {
        const c = makeDistCurve(amount, type);
        expect(c.length % 2, `driveType=${type} amount=${amount} 曲线长度是偶数`).toBe(1);
      }
    }
    for (const bits of [4, 8, 12, 16]) {
      expect(makeBitCurve(bits).length % 2, `bits=${bits} 曲线长度是偶数`).toBe(1);
    }
  });

  it('⛔ 输入 0 的输出必须精确为 0 —— 三种削波形态 × 各档强度', () => {
    for (const [type] of DRIVE_TYPE_OPTIONS) {
      for (const amount of [0, 0.005, 0.3, 0.8, 1]) {
        const got = shaperAt(makeDistCurve(amount, type), 0);
        expect(Math.abs(got), `driveType=${type} amount=${amount} 在 0 处有直流 ${got}`)
          .toBeLessThan(1e-9);
      }
    }
  });

  it('⛔ 位深量化曲线在 0 处也必须精确为 0（量化不许把 0 抬起来）', () => {
    for (const bits of [2, 4, 8, 12, 16]) {
      const got = shaperAt(makeBitCurve(bits), 0);
      expect(Math.abs(got), `bits=${bits} 在 0 处有直流 ${got}`).toBeLessThan(1e-9);
    }
  });

  it('「旁通档」（driveAmount≈0）必须是**真正的恒等直线**，不出任何染色', () => {
    // 三种形态在 amount < 0.005 时都走同一条旁通支路 —— 它若不等价于 y = x，
    // 就等于「关掉失真还在染色」，而这种偏差在耳朵上极难与失真本身区分。
    for (const [type] of DRIVE_TYPE_OPTIONS) {
      const c = makeDistCurve(0, type);
      for (const x of [-1, -0.5, 0, 0.25, 1]) {
        expect(shaperAt(c, x), `driveType=${type} 旁通档在 x=${x} 不是恒等`).toBeCloseTo(x, 9);
      }
    }
  });

  it('奇数长度的曲线在 0 处**命中一个样点**（不是插值出来的近似）', () => {
    const c = makeDistCurve(0.6, 'soft');
    const p = shaperIndex(0, c.length);
    expect(Number.isInteger(p)).toBe(true);
    expect(c[p]).toBe(0);
  });
});
