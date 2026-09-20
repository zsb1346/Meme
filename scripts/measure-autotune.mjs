// 自动修音（hajimi_at_run）质量客观测量 —— 离线跑 wasm，对修音结果做量化体检。
//
//   node scripts/measure-autotune.mjs [wasm路径]
//
// 为什么单独一套测量：自动修音曾经有一条**独立于变调**的合成路径（逐 mark 手动
// 铺点、线性插值采样、无 onset anchor、无局部增益匹配），于是修音的音质比变调
// 差一档。现在两者共用同一个颗粒编排内核，只差「ratio 是常量还是逐帧曲线」。
// 这个脚本量的就是「曲线有没有真的接进几何」：
//
//   1) 分段 F0（4 段）：锁定目标音后全程都该在目标上，不是只有两端。
//   2) 颤音压平量（音分）：源带 ±50 音分颤音，修音后残留摆幅应显著变小。
//   3) 周期 RMS 起伏 CV / 峰谷比 PT：抓 f0 速率的振幅调制（「颤/噗噗」）。
//   4) 样点跳变峰值：抓音头处的咔哒（无 onset anchor 时必然抬升）。
//   5) 杂散能量 dBc：输出抖动 / 相位错乱 / 修音没跟上时的漏能。
//   6) 长清音段是否逐样本放行（blend mask=0 区段应为恒等拷贝）。
//   7) 时长守恒（修音不改时长）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2] ? resolve(process.argv[2]) : join(root, 'public', 'hajimi_audio.wasm');

const SR = 48000;

// ---------------------------------------------------------------------------
// 信号生成
// ---------------------------------------------------------------------------

/** 类元音：谐波堆 + 三个共振峰包络。f0At(i) 给出每样本瞬时基频，支持颤音/滑音。 */
function makeVowel(f0At, sr, seconds, phaseFn = (k) => (k * 2.399963) % (Math.PI * 2)) {
  const n = Math.round(sr * seconds);
  const x = new Float32Array(n);
  const formants = [
    [500, 260, 1.0],
    [1500, 420, 0.55],
    [2600, 600, 0.22],
  ];
  // 逐样本相位积分：谐波堆用同一个瞬时基频驱动，颤音时不会相位打架。
  const kmax = Math.ceil((sr * 0.45) / Math.max(60, f0At(0)));
  const phase = new Float64Array(kmax + 2);
  const amps = new Float64Array(kmax + 2);
  for (let k = 1; k <= kmax; k++) {
    phase[k] = phaseFn(k);
    const f = k * Math.max(60, f0At(0));
    let a = 0.02;
    for (const [fc, bw, g] of formants) a += g * Math.exp(-(((f - fc) / bw) ** 2));
    a *= 1 / (1 + (f / 4000) ** 1.6);
    amps[k] = a;
  }
  for (let i = 0; i < n; i++) {
    const inc = f0At(i) / sr;
    let s = 0;
    for (let k = 1; k <= kmax; k++) {
      phase[k] += inc;
      if (k * f0At(i) < sr * 0.45) s += amps[k] * Math.sin(2 * Math.PI * phase[k]);
    }
    x[i] = s;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) for (let i = 0; i < n; i++) x[i] *= 0.7 / peak;
  return x;
}

/** 鬼畜式短促音符串：200ms 发声 + 120ms 静音，用来照音头的咔哒。 */
function makeOnsetTrain(f0, sr, notes) {
  const noteLen = Math.round(sr * 0.2);
  const gapLen = Math.round(sr * 0.12);
  const x = new Float32Array(notes * (noteLen + gapLen));
  for (let k = 0; k < notes; k++) {
    const off = k * (noteLen + gapLen);
    const seg = makeVowel(() => f0, sr, 0.2);
    for (let i = 0; i < noteLen; i++) {
      const env = Math.min(1, i / (sr * 0.004)) * Math.min(1, (noteLen - i) / (sr * 0.01));
      x[off + i] = seg[i] * env;
    }
  }
  return x;
}

/** 稳态音 + 0.6s 噪声（长清音）+ 稳态音，检验长清音是否原样放行。 */
function makeWithNoiseGap(f0, sr) {
  const toneLen = Math.round(sr * 0.4);
  const noiseLen = Math.round(sr * 0.6);
  const tone = makeVowel(() => f0, sr, 0.4);
  const x = new Float32Array(toneLen * 2 + noiseLen);
  x.set(tone, 0);
  let st = 0x9e3779b9;
  for (let i = 0; i < noiseLen; i++) {
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    x[toneLen + i] = (st / 4294967295) * 0.5 - 0.25;
  }
  x.set(tone, toneLen + noiseLen);
  return { x, toneLen, noiseLen };
}

// ---------------------------------------------------------------------------
// 分析工具（与 measure-psola.mjs 同一套实现，保持两处口径一致）
// ---------------------------------------------------------------------------

/** YIN（CMND + 阈值内首个局部极小 + 抛物线细化）基频，返回 Hz；0 = 未检出。 */
function measureF0(x, from, len) {
  const minTau = Math.max(2, Math.floor(SR / 1000));
  const maxTau = Math.ceil(SR / 60);
  const lo = Math.max(0, from);
  const n = Math.min(len, x.length - lo);
  const w = n - maxTau;
  if (w < 1024) return 0;

  const diff = new Float64Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const d = x[lo + j] - x[lo + j + tau];
      s += d * d;
    }
    diff[tau] = s;
  }
  let running = 0;
  const cmnd = new Float64Array(maxTau + 1);
  cmnd[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }
  let tauEst = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < 0.15) {
      let t = tau;
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tauEst = t;
      break;
    }
  }
  if (tauEst < 0) return 0;
  let refined = tauEst;
  if (tauEst > minTau && tauEst < maxTau) {
    const a = cmnd[tauEst - 1];
    const b = cmnd[tauEst];
    const c = cmnd[tauEst + 1];
    const den = 2 * (a + c - 2 * b);
    if (den !== 0) refined = tauEst + (a - c) / den;
  }
  const hz = SR / refined;
  return Number.isFinite(hz) && hz > 0 ? hz : 0;
}

/** 基频摆幅（音分）：滑窗测 F0，返回 (max-min) 的音分值。颤音压平的直读指标。 */
function f0ExcursionCents(x, from, len, winSec = 0.06) {
  const win = Math.round(SR * winSec);
  const step = Math.round(win / 2);
  const hi = Math.min(x.length, Math.max(from + 1, from + len));
  const vals = [];
  for (let s = from; s + win <= hi; s += step) {
    const hz = measureF0(x, s, win);
    if (hz > 0) vals.push(hz);
  }
  if (vals.length < 3) return NaN;
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  return 1200 * Math.log2(mx / mn);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 杂散能量 dBc：不落在 f0 各次谐波（±1 bin）上的能量 / 谐波能量。 */
function spuriousDbc(x, from, f0) {
  const N = 4096;
  const lo = from;
  if (lo + N > x.length || f0 <= 0) return NaN;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[lo + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im);
  const half = N / 2;
  const binHz = SR / N;
  let total = 0;
  const P = new Float64Array(half + 1);
  for (let k = 1; k <= half; k++) {
    P[k] = re[k] * re[k] + im[k] * im[k];
    total += P[k];
  }
  if (total <= 0) return NaN;
  let harm = 0;
  for (let k = 1; k * f0 < SR * 0.45; k++) {
    const c = Math.round((k * f0) / binHz);
    for (let d = -1; d <= 1; d++) {
      const idx = c + d;
      if (idx > 0 && idx <= half) harm += P[idx];
    }
  }
  const spur = Math.max(total - harm, 1e-30);
  return 10 * Math.log10(spur / Math.max(harm, 1e-30));
}

/** 周期对齐 RMS 起伏 —— 「颤 / 噗噗」的直接度量（无重叠、不平滑）。 */
function cycleRipple(x, from, len, f0) {
  if (!(f0 > 0)) return { cv: NaN, pt: NaN };
  const period = Math.round(SR / f0);
  if (period < 4) return { cv: NaN, pt: NaN };
  const hi = Math.min(x.length, from + len);
  const vals = [];
  for (let s = from; s + period <= hi; s += period) {
    let e = 0;
    for (let i = 0; i < period; i++) e += x[s + i] * x[s + i];
    vals.push(Math.sqrt(e / period));
  }
  if (vals.length < 6) return { cv: NaN, pt: NaN };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 1e-9) return { cv: NaN, pt: NaN };
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { cv: sd / mean, pt: (Math.max(...vals) - Math.min(...vals)) / mean };
}

/** 一阶差分峰值 / RMS —— 抓拼接处的样点跳变（咔哒）。 */
function jumpPeak(x, from, len) {
  const hi = Math.min(x.length, from + len);
  let dmax = 0;
  let e = 0;
  let c = 0;
  for (let i = Math.max(1, from); i < hi; i++) {
    dmax = Math.max(dmax, Math.abs(x[i] - x[i - 1]));
    e += x[i] * x[i];
    c++;
  }
  const rms = Math.sqrt(e / Math.max(1, c));
  return rms > 1e-9 ? dmax / rms : 0;
}

const cents = (a, b) => (a > 0 && b > 0 ? 1200 * Math.log2(a / b) : NaN);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  --  ');
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** 区间 RMS。 */
function rms(x, from, len) {
  const hi = Math.min(x.length, from + len);
  let e = 0;
  let c = 0;
  for (let i = Math.max(0, from); i < hi; i++) {
    e += x[i] * x[i];
    c++;
  }
  return c > 0 ? Math.sqrt(e / c) : NaN;
}

// ---------------------------------------------------------------------------
// wasm ABI
// ---------------------------------------------------------------------------

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const mem = () => ex.memory.buffer;

/** alloc → 写 planar → hajimi_at_run → 读回 → free。返回单声道 Float32Array。 */
function atRun(mono, opts) {
  const frames = mono.length;
  const ptr = ex.hajimi_alloc(frames * 4) >>> 0;
  new Float32Array(mem(), ptr, frames).set(mono);
  let out;
  try {
    const rc = ex.hajimi_at_run(
      ptr,
      frames,
      1,
      SR,
      opts.targetMidi,
      0xfff,
      opts.retuneMs ?? 15,
      opts.transitionMs ?? 120,
      opts.toleranceCents ?? 0,
      opts.amount ?? 1,
      opts.refHz ?? 440,
    );
    if (rc <= 0) throw new Error(`修音失败 code=${rc}`);
    const cp = ex.hajimi_at_channel_ptr(0) >>> 0;
    out = new Float32Array(new Float32Array(mem(), cp, rc));
  } finally {
    ex.hajimi_at_free();
    ex.hajimi_dealloc(ptr, frames * 4);
  }
  return out;
}

/** 变调路径（hajimi_tx_run mode=1）的同一套 alloc/读回；用于第 ⑥ 节做对照。 */
function txRun(inputs, pitch, time, mode) {
  const ch = inputs.length;
  const frames = inputs[0].length;
  const ptr = ex.hajimi_alloc(ch * frames * 4) >>> 0;
  const view = new Float32Array(mem(), ptr, ch * frames);
  inputs.forEach((a, c) => view.set(a, c * frames));
  try {
    const rc = ex.hajimi_tx_run(ptr, frames, ch, pitch, time, mode, SR) | 0;
    if (rc <= 0) return null;
    const outs = [];
    for (let c = 0; c < ex.hajimi_tx_channels(); c++) {
      const cp = ex.hajimi_tx_channel_ptr(c) >>> 0;
      outs.push(new Float32Array(new Float32Array(mem(), cp, rc)));
    }
    return outs;
  } finally {
    ex.hajimi_tx_free();
    ex.hajimi_dealloc(ptr, ch * frames * 4);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const label = wasmPath.replace(root, '.');
console.log(`\n${'='.repeat(112)}`);
console.log(`自动修音（hajimi_at_run）质量测量   wasm = ${label}`);
console.log(`${'='.repeat(112)}`);

// ---- ① 稳态元音：220Hz（A3）锁到 D4（midi 62，+5 半音）→ 全程都该是 293.66Hz
{
  const f0 = 220;
  const target = 62;
  const want = midiHz(target);
  const x = makeVowel(() => f0, SR, 2.0);
  const y = atRun(x, { targetMidi: target });

  const segLen = Math.floor((y.length * 0.8) / 4);
  const base = Math.floor(y.length * 0.1);
  const q = [];
  for (let i = 0; i < 4; i++) q.push(measureF0(y, base + i * segLen, segLen));
  const errs = q.map((v) => Math.abs(cents(v, want))).filter(Number.isFinite);
  const src = cycleRipple(x, base, Math.floor(x.length * 0.8), f0);
  const out = cycleRipple(y, base, Math.floor(y.length * 0.8), want);
  console.log(`\n① 稳态元音 220Hz → 锁 D4（${want.toFixed(1)}Hz，+5 半音，在 ±1200 音分内）`);
  console.log(`   时长        ${x.length} → ${y.length}  ${y.length === x.length ? 'OK 守恒' : 'NG 变了'}`);
  console.log(`   四段 F0     ${q.map((v) => (v > 0 ? v.toFixed(1) : '--')).join(' / ')}   最大音分误差 ${fmt(Math.max(...errs), 1)}`);
  console.log(`   周期CV      源 ${fmt(src.cv, 4)} → 修音后 ${fmt(out.cv, 4)}`);
  console.log(`   周期峰谷比  源 ${fmt(src.pt, 4)} → 修音后 ${fmt(out.pt, 4)}`);
  console.log(`   稳态响度比  ${fmt(rms(y, base, segLen * 4) / rms(x, base, segLen * 4), 4)}  ← 「修音后 RMS / 源 RMS」，应 ≈1.00（局部增益匹配）`);
  console.log(`   杂散dBc     源 ${fmt(spuriousDbc(x, base + segLen, f0), 1)} → 修音后 ${fmt(spuriousDbc(y, base + segLen, want), 1)}`);
}

// ---- ② 颤音压平：源 ±50 音分 5Hz 颤音，修音后残留摆幅应显著变小
{
  const f0 = 220;
  const target = 62;
  const want = midiHz(target);
  const vib = (i) => f0 * 2 ** ((50 * Math.sin(2 * Math.PI * 5 * (i / SR))) / 1200);
  const x = makeVowel(vib, SR, 2.0);
  const y = atRun(x, { targetMidi: target });
  const from = Math.floor(SR * 0.5);
  const len = Math.floor(SR * 1.0);
  const eSrc = f0ExcursionCents(x, from, len);
  const eOut = f0ExcursionCents(y, from, len);
  console.log(`\n② 颤音压平（源 ±50 音分 / 5Hz 颤音 → 锁 D4）`);
  console.log(`   F0 摆幅     源 ${fmt(eSrc, 1)} 音分 → 修音后 ${fmt(eOut, 1)} 音分   压平 ${fmt(eSrc - eOut, 1)} 音分`);
  const q = [];
  for (let i = 0; i < 4; i++) q.push(measureF0(y, from + i * (len / 4), len / 4));
  const errs = q.map((v) => Math.abs(cents(v, want))).filter(Number.isFinite);
  console.log(`   四段 F0     ${q.map((v) => (v > 0 ? v.toFixed(1) : '--')).join(' / ')}   最大音分误差 ${fmt(Math.max(...errs), 1)}`);
}

// ---- ③ glissando 320→230Hz 锁到 A4：四段都该在 440
{
  const n = SR * 2;
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin(2 * Math.PI * phase);
    phase += (320 + ((230 - 320) * i) / n) / SR;
  }
  const y = atRun(x, { targetMidi: 69 });
  const q = [];
  const segLen = Math.floor(n / 4);
  for (let i = 0; i < 4; i++) q.push(measureF0(y, i * segLen + segLen / 8, (segLen * 3) / 4));
  const errs = q.map((v) => Math.abs(cents(v, 440))).filter(Number.isFinite);
  console.log(`\n③ glissando 320→230Hz → 锁 A4（440Hz）`);
  console.log(`   四段 F0     ${q.map((v) => (v > 0 ? v.toFixed(1) : '--')).join(' / ')}   最大音分误差 ${fmt(Math.max(...errs), 1)}`);
}

// ---- ④ 起音串：只在 y 轴上照音头的咔哒
{
  const f0 = 220;
  const target = 62;
  const train = makeOnsetTrain(f0, SR, 12);
  const y = atRun(train, { targetMidi: target });
  console.log(`\n④ 起音串（12 × 200ms 音符 + 120ms 间隔，220Hz → 锁 D4）`);
  console.log(`   跳变峰      源 ${fmt(jumpPeak(train, 0, train.length), 2)} → 修音后 ${fmt(jumpPeak(y, 0, y.length), 2)}`);
  console.log(`   周期CV      源 ${fmt(cycleRipple(train, 0, train.length, f0).cv, 4)} → 修音后 ${fmt(cycleRipple(y, 0, y.length, midiHz(target)).cv, 4)}`);
}

// ---- ⑤ 长清音段：0.6s 噪声夹在稳态音之间，中段应逐样本放行
{
  const f0 = 220;
  const { x, toneLen, noiseLen } = makeWithNoiseGap(f0, SR);
  const y = atRun(x, { targetMidi: 62 });
  const a = toneLen + Math.floor(SR * 0.1);
  const b = toneLen + noiseLen - Math.floor(SR * 0.1);
  let maxd = 0;
  for (let i = a; i < b; i++) maxd = Math.max(maxd, Math.abs(y[i] - x[i]));
  console.log(`\n⑤ 长清音段（0.6s 噪声夹在两个稳态音之间）`);
  console.log(`   中段最大偏差 ${maxd}  ${maxd === 0 ? 'OK 逐样本放行原声' : 'NG 被合成了'}`);

  // 段边界：blend mask 在这里把「合成」交叉淡化到「原声」。两侧响度或相位不一致
  // 时这里会出现塌陷/梳状 —— 而这正是旧路径缺 onset anchor 与增益匹配的地方。
  const ramp = 1024;
  const ratios = [];
  for (const edge of [toneLen, toneLen + noiseLen]) {
    const from = Math.max(0, edge - ramp / 2);
    ratios.push(rms(y, from, ramp) / rms(x, from, ramp));
  }
  console.log(
    `   边界 RMS 比 ${ratios.map((v) => fmt(v, 3)).join(' / ')}  ← 应为 ~1.000，偏离即交叉淡化处塌陷/隆起`,
  );
}

// ---- ⑥ 变调比 vs 电平：PSOLA 几何的已知极限（见 wasm/src/psola.rs 模块头）
{
  const f0 = 200;
  const x = makeVowel(() => f0, SR, 2.0);
  const ref = rms(x, Math.round(SR * 0.4), Math.round(SR * 0.6));
  console.log(`\n⑥ 修正比 → 电平（本脚本的合成元音逐样本相位积分＝严格周期，是最坏一支）`);
  const rows = [];
  for (const semis of [-12, -7, -5, 0, 5, 7, 9, 11, 12, 12.9]) {
    const r = 2 ** (semis / 12);
    const y = txRun([x], r, 1.0, 1);
    const g = y ? rms(y[0], Math.round(SR * 0.4), Math.round(SR * 0.6)) / ref : NaN;
    rows.push(`${String(semis).padStart(4)}半音 r=${r.toFixed(3)}:${fmt(g, 3)}`);
  }
  console.log('   ' + rows.join('  '));
  console.log('   ← ≤ +9 半音应 ≈1.000；+11 起可能塌陷。真实素材介于两个极端之间，必须实测。');
}

console.log();
