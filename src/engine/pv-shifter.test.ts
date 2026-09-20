/**
 * pv-shifter 离线核心单测（vitest, node env，无需 AudioContext）。
 *
 * 全部只测纯核心 `pvShiftChannels` 与流式 `processBlock`；
 * 音高验证复用同目录 `pitch.ts` 的 `detectPitchYinCore`（纯函数、无音色依赖）。
 */
import { describe, expect, it } from 'vitest';
import { PvPitchShifter, pvShiftChannels } from './pv-shifter';
import { detectPitchYinCore } from './pitch';

const SR = 44100;
const TWO_PI_REF = Math.PI * 2;

/** 生成纯正弦（Float32Array）。 */
function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((TWO_PI_REF * freq * i) / SR);
  return x;
}

/** 皮尔逊相关系数（两等长序列）。 */
function pearson(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** 对 out 相对 in 做延迟搜索，取 |pearson| 最大值（PV 存在 fifo 延迟，且相位声码器非采样对齐）。 */
function bestCorrelationWithLatency(
  input: Float32Array,
  output: Float32Array,
  segStart: number,
  segLen: number,
  maxLag: number,
): number {
  let best = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    const ia = input.subarray(segStart, segStart + segLen);
    const ob = output.subarray(segStart + lag, segStart + lag + segLen);
    if (ia.length < segLen || ob.length < segLen) continue;
    const c = Math.abs(pearson(ia, ob));
    if (c > best) best = c;
  }
  return best;
}

describe('pvShiftChannels · 相位声码器离线核心', () => {
  it('220Hz 正弦 ratio=2 → 检测到 ≈440Hz（±2%）', () => {
    const x = sine(220, 1.5);
    const [out] = pvShiftChannels([x], SR, 2.0);
    // 跳过 fifo 延迟头部，喂中段
    const seg = out.subarray(2000);
    const hz = detectPitchYinCore(seg, SR);
    expect(hz).not.toBeNull();
    expect(hz!).toBeGreaterThan(440 * 0.98);
    expect(hz!).toBeLessThan(440 * 1.02);
  });

  it('220Hz 正弦 ratio=0.5 → 检测到 ≈110Hz（±2%）', () => {
    const x = sine(220, 1.5);
    const [out] = pvShiftChannels([x], SR, 0.5);
    const seg = out.subarray(2000);
    const hz = detectPitchYinCore(seg, SR);
    expect(hz).not.toBeNull();
    expect(hz!).toBeGreaterThan(110 * 0.98);
    expect(hz!).toBeLessThan(110 * 1.02);
  });

  it('常量 ratio=1.0 → 与输入强相关（pearson>0.9）且等长', () => {
    const x = sine(220, 1.5);
    const [out] = pvShiftChannels([x], SR, 1.0);
    expect(out.length).toBe(x.length);
    // 中段（跳过起始延迟/瞬态），带延迟搜索
    const c = bestCorrelationWithLatency(x, out, 1500, 4000, 2000);
    expect(c).toBeGreaterThan(0.9);
  });

  it('曲线 1.0→2.0（1s 线性）→ 尾段 f0>300Hz，首段 ≈220Hz', () => {
    const x = sine(220, 1.0);
    // 每 hop 一个值的升调曲线
    const hops = Math.floor(x.length / 256);
    const curve = new Float32Array(hops);
    for (let i = 0; i < hops; i++) curve[i] = 1.0 + (i / (hops - 1)) * 1.0; // 1→2
    const [out] = pvShiftChannels([x], SR, curve);

    // 首 100ms（跳过延迟头）
    const first = out.subarray(1000, 1000 + Math.round(0.1 * SR));
    const hzFirst = detectPitchYinCore(first, SR);
    // 尾 100ms
    const tail = out.subarray(out.length - Math.round(0.1 * SR) - 100, out.length - 100);
    const hzTail = detectPitchYinCore(tail, SR);

    expect(hzFirst).not.toBeNull();
    expect(hzTail).not.toBeNull();
    expect(hzTail!).toBeGreaterThan(300);
    expect(hzFirst!).toBeGreaterThan(180);
    expect(hzFirst!).toBeLessThan(250);
  });

  it('全零输入 → 全零输出且有限（永不 NaN）', () => {
    const zeros = new Float32Array(4410);
    const [out] = pvShiftChannels([zeros], SR, 1.5);
    expect(out.length).toBe(zeros.length);
    let allZero = true;
    let allFinite = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== 0) allZero = false;
      if (!Number.isFinite(out[i])) allFinite = false;
    }
    expect(allFinite).toBe(true);
    expect(allZero).toBe(true);
  });

  it('10ms 分块流式 processBlock == 整段常量结果（差 <1e-4）', () => {
    const x = sine(220, 1.0);
    const whole = pvShiftChannels([x], SR, 1.5)[0];

    const streamed = new Float32Array(x.length);
    const shifter = new PvPitchShifter(SR);
    const block = Math.round(0.01 * SR); // 441
    for (let pos = 0; pos < x.length; pos += block) {
      const end = Math.min(pos + block, x.length);
      shifter.processBlock(x.subarray(pos, end), streamed.subarray(pos, end), 1.5);
    }

    let maxDiff = 0;
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(whole[i] - streamed[i]);
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff).toBeLessThan(1e-4);
  });
});
