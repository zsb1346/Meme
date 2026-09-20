import { describe, expect, it } from 'vitest';
import { checkShiftOutput } from './shift-output-guard';

/**
 * 出口验收的回归 —— 每个用例都对着 `probe-silence-lag.mjs` 的**实测数字**写，
 * 不是拍脑袋编的阈值。素材：龙.001 / 立体声 / 0.72s / 源峰值 0.55。
 */
const src = (() => {
  // 一个 RMS≈0.37、峰值≈0.53 的「素材」（够真实即可，不追求音频学意义）
  const a = new Float32Array(48000);
  for (let i = 0; i < a.length; i++) {
    a[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / 48000) * 3.5;
  }
  return a;
})();

/** 造一段「电平 = 源 × gain、长度 = 源 × lenRatio」的输出 */
function makeOut(gain: number, lenRatio = 1): Float32Array {
  const n = Math.max(1, Math.round(src.length * lenRatio));
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (src[i] ?? 0) * gain;
  return a;
}

describe('第三方引擎出口验收', () => {
  it('正常输出通过（各引擎在 ±24 半音内实测长度比 1.000、电平 ±6dB 内）', () => {
    expect(checkShiftOutput(src, makeOut(1)).ok).toBe(true);
    expect(checkShiftOutput(src, makeOut(0.5)).ok).toBe(true); // −6dB，ola 那一档
  });

  it('整段听不见 → 拒（shift-sample @ ratio 1/32，实测 −46.3dB）', () => {
    const v = checkShiftOutput(src, makeOut(Math.pow(10, -46.3 / 20)));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('没声音');
      expect(v.stats.levelDb).toBeCloseTo(-46.3, 0);
    }
  });

  it('长度塌缩 → 拒（ST-声码器 @ ratio 16，实测长度比 0.352）', () => {
    const v = checkShiftOutput(src, makeOut(1, 0.352));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('截断');
  });

  it('电平爆表 → 拒（ST-声码器 @ ratio 8，实测 +16.3dB / 峰值 31.96）', () => {
    const v = checkShiftOutput(src, makeOut(Math.pow(10, 16.3 / 20)));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('数值发散');
  });

  it('非有限值 → 拒（一个 NaN 就让整段静音，而相对指标在 NaN 上全部失灵）', () => {
    const bad = makeOut(1);
    bad[1234] = NaN;
    const v = checkShiftOutput(src, bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.stats.nonFinite).toBe(1);
      expect(v.reason).toContain('非有限值');
    }
  });

  it('空输出 → 拒（不是「静音也算合法音频」）', () => {
    expect(checkShiftOutput(src, new Float32Array(0)).ok).toBe(false);
  });

  it('源本身是静音时不拿电平判据误伤（静进静出不算失败）', () => {
    const silent = new Float32Array(1024);
    expect(checkShiftOutput(silent, new Float32Array(1024)).ok).toBe(true);
  });

  it('阈值内侧不误伤：−39dB / 0.55 倍长度都通过（判据只挡「明显坏了」）', () => {
    // 刻意不测「正好等于阈值」那一格：20·log10(10^(−40/20)) 在浮点下是
    // −40.000000000000004，会把一条**数学上相等**的断言变成随机红。
    expect(checkShiftOutput(src, makeOut(Math.pow(10, -39 / 20))).ok).toBe(true);
    expect(checkShiftOutput(src, makeOut(1, 0.55)).ok).toBe(true);
  });
});
