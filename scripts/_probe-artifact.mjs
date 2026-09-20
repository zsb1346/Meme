// 定位输出里「最陡的跳变」到底长什么样 —— 全段扫描，不只看尾巴。
//
//   node scripts/_probe-artifact.mjs [信号] [pitch] [time] [mode]
//   信号 ∈ glide | onsets | gap | long | noise | 素材名
//
// 对每个跳变点打印：位置/时间、Δ、Δ/中段RMS，以及前后 6 个样点。
// 同时在**同一输出时间**打印源的时间映射位置，判断「这个陡沿是源里就有的，
// 还是合成器造出来的」——这是区分「忠实还原瞬态」与「爆音」的关键。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const KIND = process.argv[2] ?? 'glide';
const PITCH = Number(process.argv[3] ?? 2 ** (5 / 12));
const TIME = Number(process.argv[4] ?? 1.4);
const MODE = Number(process.argv[5] ?? 1);
const SR = 48000;

const bytes = readFileSync(wasmPath);
const inst = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {
  env: {
    memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536 }),
    __memory_base: 0,
    __table_base: 0,
  },
});
const ex = inst.exports;
const memory = ex.memory;
const alloc = (n) => ex.hajimi_alloc(n) >>> 0;
const f32 = (ptr, len) => new Float32Array(memory.buffer, ptr, len);

// ---------- 信号构造（与 _probe-clicks.mjs 一致） ----------
function vowel(f0, n, offsetSamples = 0) {
  const x = new Float32Array(n);
  const formants = [
    [500, 260, 1.0],
    [1500, 420, 0.55],
    [2600, 600, 0.22],
  ];
  for (let k = 1; k * f0 < SR * 0.45; k++) {
    const fq = k * f0;
    let a = 0.02;
    for (const [fc, bw, g] of formants) {
      const d = (fq - fc) / bw;
      a += g * Math.exp(-(d * d));
    }
    a *= 1 / (1 + (fq / 4000) ** 1.6);
    const ph = (k * 2.399963) % (2 * Math.PI);
    for (let i = 0; i < n; i++) {
      x[i] += a * Math.sin((2 * Math.PI * fq * (i + offsetSamples)) / SR + ph);
    }
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
  if (pk > 0) for (let i = 0; i < n; i++) x[i] *= 0.7 / pk;
  return x;
}
function buildGlide() {
  const n = SR * 2;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 150 + (150 * t) / 2;
    ph += (2 * Math.PI * f) / SR;
    x[i] = 0.5 * Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph);
  }
  return x;
}
function buildOnsets() {
  const noteLen = Math.round(SR * 0.18);
  const gap = Math.round(SR * 0.1);
  const count = 5;
  const x = new Float32Array(count * (noteLen + gap));
  for (let k = 0; k < count; k++) {
    const off = k * (noteLen + gap);
    const seg = vowel(200 + k * 20, noteLen);
    for (let i = 0; i < noteLen; i++) {
      const atk = Math.min(1, i / (SR * 0.004));
      const rel = Math.min(1, (noteLen - i) / (SR * 0.012));
      x[off + i] = seg[i] * atk * rel;
    }
  }
  return x;
}
function buildGap() {
  const n = SR;
  const x = new Float32Array(n);
  const a = vowel(220, 14400);
  for (let i = 0; i < 14400; i++) {
    const atk = Math.min(1, i / (SR * 0.005));
    const rel = Math.min(1, (14400 - i) / (SR * 0.02));
    x[i] = a[i] * atk * rel;
  }
  const b = vowel(220, 14400, 14400 + 19200);
  for (let i = 0; i < 14400; i++) {
    const atk = Math.min(1, i / (SR * 0.005));
    const rel = Math.min(1, (14400 - i) / (SR * 0.02));
    x[33600 + i] = b[i] * atk * rel;
  }
  return x;
}
function buildLong() {
  return vowel(180, SR * 4);
}
function buildNoise() {
  const x = new Float32Array(SR);
  let s = 0x12345678;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = ((s >>> 8) / 8388608 - 1) * 0.5;
  }
  return x;
}

let src;
let label = KIND;
const dir = join(root, '素材');
const matFile = readdirSync(dir).find(
  (f) => f.toLowerCase().endsWith('.mp3') && f.replace('.mp3', '') === KIND,
);
if (matFile) {
  const buf = new Uint8Array(readFileSync(join(dir, matFile)));
  const ptr = alloc(buf.length);
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  ex.hajimi_dealloc(ptr, buf.length);
  if (nch <= 0) {
    console.error('解码失败');
    process.exit(2);
  }
  const N = ex.hajimi_decode_frames() | 0;
  const sr = ex.hajimi_decode_sample_rate() | 0;
  src = new Float32Array(N);
  for (let c = 0; c < nch; c++) {
    const ch = new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, N));
    for (let i = 0; i < N; i++) src[i] += ch[i] / nch;
  }
  ex.hajimi_decode_free();
  label = matFile;
} else {
  const builders = { glide: buildGlide, onsets: buildOnsets, gap: buildGap, long: buildLong, noise: buildNoise };
  if (!builders[KIND]) {
    console.error(`未知信号 ${KIND}（可用：glide/onsets/gap/long/noise 或素材名）`);
    process.exit(2);
  }
  src = builders[KIND]();
}

const N = src.length;
const p = alloc(N * 4);
f32(p, N).set(src);
const outF = ex.hajimi_tx_run(p, N, 1, PITCH, TIME, MODE, SR) | 0;
ex.hajimi_dealloc(p, N * 4);
if (outF <= 0) {
  console.error('tx_run 失败');
  process.exit(2);
}
const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
const marks = ex.hajimi_tx_marks() | 0;
const voiced = ex.hajimi_tx_voiced_frames() | 0;
ex.hajimi_tx_free();

const rms = (x, a, b) => {
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  let s = 0;
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, hi - lo));
};
const midSrc = rms(src, Math.floor(N * 0.45), Math.floor(N * 0.55));
const midOut = rms(out, Math.floor(outF * 0.45), Math.floor(outF * 0.55));

console.log(
  `\n信号=${label}  ${(N / SR).toFixed(3)}s→${(outF / SR).toFixed(3)}s  marks=${marks} voicedFrames=${voiced}`,
);
console.log(`pitch=${PITCH.toFixed(4)} time=${TIME.toFixed(4)} mode=${MODE}`);
console.log(`源中段RMS=${midSrc.toFixed(5)}  输出中段RMS=${midOut.toFixed(5)}\n`);

// 找输出中最陡的若干 |Δ|
const jumps = [];
for (let i = Math.max(1, Math.floor(outF * 0.02)); i < outF - 1; i++) {
  jumps.push([Math.abs(out[i] - out[i - 1]), i]);
}
jumps.sort((a, b) => b[0] - a[0]);

// 源自身的 Δ 分布，用来判断「源里本来就有多陡」
const srcJumps = [];
for (let i = Math.max(1, Math.floor(N * 0.02)); i < N - 1; i++) {
  srcJumps.push(Math.abs(src[i] - src[i - 1]));
}
srcJumps.sort((a, b) => b[0] - a[0]);

console.log(
  `源 最陡 Δ = ${srcJumps[0].toFixed(5)} (${(srcJumps[0] / midSrc).toFixed(2)}×中段RMS)` +
    `   第 99.99 百分位 = ${srcJumps[Math.floor(srcJumps.length * 0.0001)].toFixed(5)}`,
);
console.log(
  `输出 最陡 Δ = ${jumps[0][0].toFixed(5)} (${(jumps[0][0] / midOut).toFixed(2)}×中段RMS)\n`,
);

for (let r = 0; r < 5; r++) {
  const [d, i] = jumps[r];
  const srcPos = Math.round(i / TIME);
  console.log(
    `── 第 ${r + 1} 陡：i=${i} (t=${((i / SR) * 1000).toFixed(1)}ms, pos=${(i / outF).toFixed(3)})  ` +
      `Δ=${d.toFixed(5)} = ${(d / midOut).toFixed(2)}×中段RMS  →  源位置≈${srcPos}`,
  );
  const lo = Math.max(1, i - 6);
  console.log('   输出: ' + Array.from(out.subarray(lo, i + 6)).map((v) => v.toFixed(4).padStart(9)).join(''));
  const slo = Math.max(1, srcPos - 6);
  console.log('   源@ : ' + Array.from(src.subarray(slo, Math.min(N, srcPos + 6))).map((v) => v.toFixed(4).padStart(9)).join(''));
  console.log(
    `   Δ 位置对齐：i=${i} 处 Δ=${d.toFixed(5)}；源同位置 Δ=${Math.abs(src[srcPos] - src[srcPos - 1]).toFixed(5)}` +
      ` (${(Math.abs(src[srcPos] - src[srcPos - 1]) / midSrc).toFixed(2)}×中段RMS)`,
  );
  if (r < 4) console.log();
}

// 精确 0 占比（门控痕迹）
const nearZero = (x, from) => {
  let z = 0;
  let t = 0;
  for (let i = from; i < x.length; i++) {
    t++;
    if (Math.abs(x[i]) < 1e-7) z++;
  }
  return `${z}/${t} = ${((z / Math.max(1, t)) * 100).toFixed(2)}%`;
};
console.log(`\n精确 0 样点占比（后 70%）：源 ${nearZero(src, Math.floor(N * 0.3))}  输出 ${nearZero(out, Math.floor(outF * 0.3))}`);

// 削顶统计
let clip = 0;
let peak = 0;
for (let i = 0; i < outF; i++) {
  const a = Math.abs(out[i]);
  if (a > peak) peak = a;
  if (a > 1.0) clip++;
}
console.log(`输出峰值=${peak.toFixed(4)}  |x|>1.0 样点=${clip}\n`);
