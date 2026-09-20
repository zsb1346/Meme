// PSOLA / 拉伸质量客观测量 —— 离线跑 wasm，对合成元音做量化体检。
//
//   node scripts/measure-psola.mjs [wasm路径]
//
// 测量项：
//   1) 分段 F0：把输出切成 4 段各自测基频。变调应四段一致（不是只有前段对），
//      拉伸应四段都保持源音高（这是「改前 mask 建错时基」的直接照妖镜）。
//   2) 谐波占比：Hann 窗 + FFT，统计落在各次谐波 ±1 bin 的能量占全谱比例。
//      输出颤/抖/噪 → 能量从谐波漏到边带 → 该值下降（dB）。
//   3) 包络起伏 CV：短时 RMS 的变异系数。稳态元音应接近 0；
//      「放屁声」= f0 速率的振幅调制 → CV 显著抬升。
//   4) 样点跳变峰值：一阶差分绝对值的最大值 / RMS，用来抓拼接处的咔哒。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2] ? resolve(process.argv[2]) : join(root, 'public', 'hajimi_audio.wasm');

const SR = 48000;

// ---------------------------------------------------------------------------
// 信号生成
// ---------------------------------------------------------------------------

/** 类元音：谐波堆 + 两个共振峰包络，稳态。 */
function makeVowel(f0, sr, seconds) {
  const n = Math.round(sr * seconds);
  const x = new Float32Array(n);
  const formants = [
    [500, 260, 1.0],
    [1500, 420, 0.55],
    [2600, 600, 0.22],
  ];
  for (let k = 1; k * f0 < sr * 0.45; k++) {
    const f = k * f0;
    let a = 0.02;
    for (const [fc, bw, g] of formants) a += g * Math.exp(-(((f - fc) / bw) ** 2));
    a *= 1 / (1 + (f / 4000) ** 1.6);
    const ph = (k * 2.399963) % (Math.PI * 2);
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / sr + ph);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] *= 0.7 / peak;
  return x;
}

/** 鬼畜式短促音符串：200ms 发声 + 120ms 静音，检查每个起音处是否咔哒。 */
function makeOnsetTrain(f0, sr, notes) {
  const noteLen = Math.round(sr * 0.2);
  const gapLen = Math.round(sr * 0.12);
  const x = new Float32Array(notes * (noteLen + gapLen));
  for (let k = 0; k < notes; k++) {
    const off = k * (noteLen + gapLen);
    const seg = makeVowel(f0, sr, 0.2);
    for (let i = 0; i < noteLen; i++) {
      const env = Math.min(1, i / (sr * 0.004)) * Math.min(1, (noteLen - i) / (sr * 0.01));
      x[off + i] = seg[i] * env;
    }
  }
  return x;
}

// ---------------------------------------------------------------------------
// 分析工具
// ---------------------------------------------------------------------------

/**
 * YIN（CMND + 阈值内首个局部极小 + 抛物线细化）基频，返回 Hz；0 = 未检出。
 * 刻意与 wasm 内 yin_core 同算法：裸自相关会在 lags 的整数倍上挑错峰，
 * 测出来全是 true/2、true/5 这类八度/次谐波结果，没法当验收依据。
 */
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

/** 迭代 radix-2 FFT（就地，实输入补零到 2 的幂）。 */
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

/**
 * 杂散能量（dBc）：Hann 窗 + 4096 点 FFT，统计**不落在** f0 各次谐波（±1 bin）
 * 上的能量相对于谐波能量的比值。
 *
 * 比「谐波占比」更好用：合规输出该值是 -30dBc 量级，一旦输出抖动/相位错乱/
 * 变调没跟上，能量就漏到边带和噪声底上，这个值会冲到 0dBc 上下 —— 量程够宽，
 * 一个数字就能分辨好坏。实测 τ>1 直通段能到 +1.9dBc。
 */
function spuriousDbc(x, from, f0) {
  const N = 4096;
  const lo = from;
  if (lo + N > x.length || f0 <= 0) return NaN;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re[i] = x[lo + i] * w;
  }
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

/**
 * 周期对齐 RMS 起伏 —— 「放屁声 / 颤」的直接度量。
 *
 * 以**输出自身**的一个基频周期为窗、逐周期连续取 RMS（无重叠，不做任何平滑），
 * 再看这些周期 RMS 的变异系数 CV 与峰谷比 PT。
 *
 * 为什么不用固定窗短时 RMS：那必须靠加长窗来压掉窗内的基频波动，而「颤」的
 * 调制周期恰好等于基频周期，加长窗等于把要测的东西一起抹平（实测会把
 * 降八度 47% 的缺口低估到 0.17）。逐周期取整就把窗内的基频波动归一掉了。
 */
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
  const mx = Math.max(...vals);
  const mn = Math.min(...vals);
  return { cv: sd / mean, pt: (mx - mn) / mean };
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const mem = () => ex.memory.buffer;

function txRun(inputs, pitch, time, mode) {
  const ch = inputs.length;
  const frames = inputs[0].length;
  const ptr = ex.hajimi_alloc(ch * frames * 4) >>> 0;
  {
    const view = new Float32Array(mem(), ptr, ch * frames);
    inputs.forEach((a, c) => view.set(a, c * frames));
  }
  const outF = ex.hajimi_tx_run(ptr, frames, ch, pitch, time, mode, SR) | 0;
  if (outF <= 0) {
    ex.hajimi_dealloc(ptr, ch * frames * 4);
    return null;
  }
  const outCh = ex.hajimi_tx_channels() | 0;
  const outs = [];
  for (let c = 0; c < outCh; c++) {
    const cp = ex.hajimi_tx_channel_ptr(c) >>> 0;
    outs.push(new Float32Array(new Float32Array(mem(), cp, outF)));
  }
  ex.hajimi_tx_free();
  ex.hajimi_dealloc(ptr, ch * frames * 4);
  return outs;
}

const cases = [
  { name: '升 5 半音', f0: 200, pitch: 2 ** (5 / 12), time: 1.0 },
  { name: '升 7 半音', f0: 200, pitch: 2 ** (7 / 12), time: 1.0 },
  { name: '升八度  ', f0: 200, pitch: 2.0, time: 1.0 },
  { name: '降 5 半音', f0: 200, pitch: 2 ** (-5 / 12), time: 1.0 },
  { name: '降八度  ', f0: 200, pitch: 0.5, time: 1.0 },
  { name: '只拉伸1.5x', f0: 200, pitch: 1.0, time: 1.5 },
  { name: '只拉伸0.75x', f0: 200, pitch: 1.0, time: 0.75 },
  { name: '升5+拉1.5x', f0: 200, pitch: 2 ** (5 / 12), time: 1.5 },
  { name: '降5+拉2.0x', f0: 200, pitch: 2 ** (-5 / 12), time: 2.0 },
];

const label = `wasm = ${wasmPath.replace(root, '.')}`;
const HEAD =
  '用例'.padEnd(10) +
  '期望F0'.padStart(8) +
  '输出F0(四段)'.padStart(30) +
  '最大音分误差'.padStart(12) +
  '杂散dBc'.padStart(9) +
  '周期CV'.padStart(8) +
  '峰谷比'.padStart(8) +
  '跳变峰'.padStart(8) +
  '帧数(期望)'.padStart(15);
const LINE = '-'.repeat(112);

function row(name, y, expectHz, src) {
  const base = Math.floor(y.length * 0.1);
  const segLen = Math.floor((y.length * 0.8) / 4);
  const q = [];
  for (let i = 0; i < 4; i++) q.push(measureF0(y, base + i * segLen, segLen));
  const errs = q.map((v) => Math.abs(cents(v, expectHz))).filter(Number.isFinite);
  const maxErr = errs.length ? Math.max(...errs) : NaN;
  // 谐波占比取**最后一段**：拉伸崩坏时那里最先露馅，取中段会被合规段掩盖。
  const hr = spuriousDbc(y, base + 3 * segLen, expectHz);
  const rip = cycleRipple(y, base, Math.floor(y.length * 0.8), expectHz);
  const jp = jumpPeak(y, base, Math.floor(y.length * 0.8));
  const expectFrames = src ? Math.round(src * 1) : y.length;
  console.log(
    name.padEnd(10),
    expectHz.toFixed(1).padStart(8),
    q.map((v) => (v > 0 ? v.toFixed(1) : '--')).join(' / ').padStart(30),
    fmt(maxErr, 1).padStart(12),
    fmt(hr, 1).padStart(10),
    fmt(rip.cv, 3).padStart(8),
    fmt(rip.pt, 3).padStart(8),
    fmt(jp, 1).padStart(8),
    `${y.length}(${expectFrames})`.padStart(15),
  );
}

console.log(`\n${'='.repeat(112)}`);
console.log(`PSOLA(mode=1) 质量测量   ${label}`);
console.log(`${'='.repeat(112)}`);
console.log(HEAD);
console.log(LINE);

const input = makeVowel(200, SR, 3.0);

// 源信号参照：任何指标都必须拿它当尺子 —— 源本身就有包络起伏（共振峰 + 有限长度），
// 只看绝对值会把源的天然起伏误算成算法缺陷。
console.log(
  '源信号'.padEnd(10) +
    '200.0'.padStart(8) +
    '200.0 / 200.0 / 200.0 / 200.0'.padStart(30) +
    '0.0'.padStart(12) +
    fmt(spuriousDbc(input, Math.floor(input.length * 0.1) + 3 * Math.floor((input.length * 0.8) / 4), 200), 1).padStart(10) +
    fmt(cycleRipple(input, Math.floor(input.length * 0.1), Math.floor(input.length * 0.8), 200).cv, 3).padStart(8) +
    fmt(cycleRipple(input, Math.floor(input.length * 0.1), Math.floor(input.length * 0.8), 200).pt, 3).padStart(8) +
    fmt(jumpPeak(input, Math.floor(input.length * 0.1), Math.floor(input.length * 0.8)), 1).padStart(8) +
    `${input.length}(${input.length})`.padStart(15),
);
console.log(LINE);

for (const c of cases) {
  const outs = txRun([input], c.pitch, c.time, 1);
  if (!outs) {
    console.log(c.name.padEnd(10), ' 变换失败');
    continue;
  }
  row(c.name, outs[0], c.f0 * c.pitch, Math.round(input.length * c.time));
}

// ---- 鬼畜式起音串：只看向上跳变 ----
console.log(`\n${LINE}`);
console.log('起音串（12 个 200ms 音符 + 120ms 间隔，f0=220）—— 起音处跳变应接近源');
console.log(LINE);
const train = makeOnsetTrain(220, SR, 12);
console.log(`  源          跳变峰=${fmt(jumpPeak(train, 0, train.length), 1)}`);
for (const c of [
  { name: '升5半音', pitch: 2 ** (5 / 12), time: 1.0 },
  { name: '降5半音', pitch: 2 ** (-5 / 12), time: 1.0 },
  { name: '拉伸1.5x', pitch: 1.0, time: 1.5 },
]) {
  const outs = txRun([train], c.pitch, c.time, 1);
  if (!outs) {
    console.log(`  ${c.name}   变换失败`);
    continue;
  }
  console.log(`  ${c.name.padEnd(10)} 跳变峰=${fmt(jumpPeak(outs[0], 0, outs[0].length), 1)}`);
}

// ---- unity 位精确 ----
console.log(`\n${LINE}`);
{
  const outs = txRun([input], 1.0, 1.0, 1);
  if (!outs) console.log('unity: 变换失败');
  else {
    let maxd = 0;
    for (let i = 0; i < input.length; i++) maxd = Math.max(maxd, Math.abs(outs[0][i] - input[i]));
    console.log(`unity(pitch=1,time=1) 与源最大样点差 = ${maxd}  ${maxd === 0 ? 'OK 位精确' : 'NG 不等'}`);
  }
}

// ---- mode=2 SOLA 作对照 ----
console.log(`\n${LINE}`);
console.log('对照：mode=2（SOLA）');
console.log(LINE);
console.log(HEAD);
for (const c of cases.slice(0, 8)) {
  const outs = txRun([input], c.pitch, c.time, 2);
  if (!outs) continue;
  row(c.name, outs[0], c.f0 * c.pitch, Math.round(input.length * c.time));
}
// ---- 性能：3 分钟素材的实际耗时（主线程同步渲染，直接决定手感）----
console.log(`\n${LINE}`);
console.log('性能（mode=1 整段同步渲染）');
console.log(LINE);
for (const secs of [5, 15, 30]) {
  const long = makeVowel(180, SR, secs);
  for (const [name, pitch, time] of [
    ['变调 +5 半音', 2 ** (5 / 12), 1.0],
    ['拉伸 1.5x', 1.0, 1.5],
    ['变调+拉伸', 2 ** (5 / 12), 1.5],
  ]) {
    const t0 = performance.now();
    const outs = txRun([long], pitch, time, 1);
    const ms = performance.now() - t0;
    console.log(
      `  ${String(secs).padStart(3)}s 素材 ${name.padEnd(12)} ${ms.toFixed(0).padStart(6)} ms  (${((ms / secs) * 1000).toFixed(0)} ms / 秒音频)${outs ? '' : '  失败'}`,
    );
  }
}
console.log();

