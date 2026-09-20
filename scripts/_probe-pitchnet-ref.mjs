// 拿 PitchNet **真实导出**的 WAV 当基准，跟我们的 PSOLA 逐项对比。
//
//   node scripts/_probe-pitchnet-ref.mjs [导出的wav] [源素材名] [pitch]
//   默认: 原型/PitchNet-master/导出测试.wav  龙.001  (自动从导出文件反推 pitch)
//
// 为什么需要它：`_probe-hnr.mjs` 只能拿「源 / 纯重采样 / 我们的 PSOLA」互比，
// 没有 PitchNet 的实际输出。而 PitchNet 的日志（%APPDATA%/PitchNet/Logs/debug_*.log）
// 已经确认它跑的是 `engine=Vocoder`（PC-NSF-HiFiGAN 神经声码器），所以这个导出文件
// 是**我们真正要对的靶**，不是 PSOLA 的替身。
//
// 量什么：
//   - 导出时长 vs 源时长（确认是「只变调不变速」）
//   - f0（反推它到底降到了哪个音）
//   - 逐帧周期同步平均 HNR（「沙沙」的直接量化）
//   - 频谱质心 / 高频占比 / 谱斜率（神经声码器的 HF 行为与颗粒合成差在哪）
//   - 峰值、RMS、精确 0 样点占比
//
// 写 WAV 到 outputs/_ab/ 供三路 A/B 试听。

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const ARG_WAV = process.argv[2] ?? join(root, '原型', 'PitchNet-master', '导出测试.wav');
const KIND = process.argv[3] ?? '龙.001';
const SR = 48000; // wasm 侧渲染采样率
const NT = 512;

// ============================ 工具 ============================

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF/WAVE');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: b.readUInt16LE(off + 8),
        channels: b.readUInt16LE(off + 10),
        sampleRate: b.readUInt32LE(off + 12),
        bitsPerSample: b.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = { offset: off + 8, bytes: sz };
      break; // data 之后不用再看
    }
    off += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error('缺 fmt 或 data 块');

  const nch = fmt.channels;
  const bits = fmt.bitsPerSample;
  const bytesPer = bits / 8;
  const frames = Math.floor(data.bytes / (bytesPer * nch));
  const mono = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < nch; c++) {
      const p = data.offset + (i * nch + c) * bytesPer;
      let v;
      if (bits === 16) v = b.readInt16LE(p) / 32768;
      else if (bits === 32 && fmt.audioFormat === 3) v = b.readFloatLE(p);
      else if (bits === 32) v = b.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (b.readUInt8(p) - 128) / 128;
      else throw new Error('不支持的位深 ' + bits);
      acc += v;
    }
    mono[i] = acc / nch;
  }
  return { sr: fmt.sampleRate, nch, bits, frames, mono, fmt: fmt.audioFormat };
}

const lerpAt = (x, pos) => {
  const i0 = Math.floor(pos);
  if (i0 < 0) return 0;
  if (i0 + 1 >= x.length) return x[i0] ?? 0;
  const fr = pos - i0;
  return x[i0] * (1 - fr) + x[i0 + 1] * fr;
};

const rmsBuf = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

const peakBuf = (x) => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};

const zeroRatio = (x) => {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === 0) n++;
  return n / Math.max(1, x.length);
};

function roughF0(x, sr, loHz, hiHz) {
  const minLag = Math.max(2, Math.floor(sr / hiHz));
  const maxLag = Math.min(Math.floor(sr / loHz), Math.floor(x.length / 2));
  let bestLag = minLag;
  let bestVal = -2;
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acc = 0, a = 0, b = 0;
    for (let i = 0; i + tau < x.length; i++) {
      acc += x[i] * x[i + tau];
      a += x[i] * x[i];
      b += x[i + tau] * x[i + tau];
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestVal) { bestVal = v; bestLag = tau; }
  }
  return sr / bestLag;
}

function refineF0(x, sr, f0approx) {
  const span = 0.06, steps = 240;
  let best = f0approx, bestV = -2;
  for (let s = 0; s <= steps; s++) {
    const f = f0approx * (1 - span + (2 * span * s) / steps);
    const P = sr / f;
    const max = Math.floor(x.length - P - 2);
    let acc = 0, a = 0, b = 0;
    for (let i = 0; i < max; i++) {
      const xj = lerpAt(x, i + P);
      acc += x[i] * xj;
      a += x[i] * x[i];
      b += xj * xj;
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestV) { bestV = v; best = f; }
  }
  return { f0: best, score: bestV };
}

function syncAvg(x, P, K) {
  const h = new Float64Array(NT);
  const cnt = new Float64Array(NT);
  for (let k = 0; k < K; k++) {
    let stop = false;
    for (let j = 0; j < NT; j++) {
      const pos = (k + j / NT) * P;
      if (pos + 2 >= x.length) { stop = true; break; }
      h[j] += lerpAt(x, pos);
      cnt[j]++;
    }
    if (stop) break;
  }
  for (let j = 0; j < NT; j++) if (cnt[j] > 0) h[j] /= cnt[j];
  return h;
}

function tmplAt(h, phi) {
  const p = ((phi % 1) + 1) % 1;
  const idx = p * NT;
  const i0 = Math.floor(idx) % NT;
  const i1 = (i0 + 1) % NT;
  const fr = idx - Math.floor(idx);
  return h[i0] * (1 - fr) + h[i1] * fr;
}

/// 级联双二阶带通（RBJ）
function bandpass(x, sr, f1, f2) {
  const y = new Float64Array(x.length);
  const mid = Math.sqrt(f1 * f2);
  const w0 = (2 * Math.PI * mid) / sr;
  const alpha = Math.sin(w0) / (2 * 0.7);
  const b0 = alpha, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const inp = x[i];
      const o = (b0 / a0) * inp + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = inp; y2 = y1; y1 = o;
      y[i] = o;
    }
    for (let i = 0; i < x.length; i++) x[i] = y[i];
  }
  return x;
}

function frameHnr(x, sr) {
  const rough = roughF0(x, sr, 60, 900);
  if (!(rough > 0) || !isFinite(rough)) return null;
  const { f0, score } = refineF0(x, sr, rough);
  const P = sr / f0;
  const K = Math.min(Math.floor((x.length - 2) / P), 60);
  if (K < 6 || P < 6) return null;

  const h = syncAvg(x, P, K);
  let eH = 0, eR = 0, n = 0;
  const resid = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const hv = tmplAt(h, i / P);
    const rv = x[i] - hv;
    resid[i] = rv;
    eH += hv * hv;
    eR += rv * rv;
    n++;
  }
  const hRms = Math.sqrt(eH / Math.max(1, n));
  const rRms = Math.sqrt(eR / Math.max(1, n));

  // 噪声（残余）按频段拆开 —— 「沙沙」是 2k 以上的残余，不是总量。
  const rb = (f1, f2) => rmsBuf(bandpass(Float64Array.from(resid), sr, f1, f2));
  const bandRms = rb(2000, 8000);
  const nLow = rb(0, 2000);
  const n2to4 = rb(2000, 4000);
  const n4to8 = rb(4000, 8000);
  const n8up = rb(8000, 16000);

  return {
    f0, periodicity: score,
    hnr_dB: 20 * Math.log10(Math.max(1e-9, hRms) / Math.max(1e-9, rRms)),
    hRms, rRms, bandRms,
    hnrLow_dB: 20 * Math.log10(Math.max(1e-9, hRms) / Math.max(1e-9, nLow)),
    hnrHi_dB: 20 * Math.log10(Math.max(1e-9, hRms) / Math.max(1e-9, bandRms)),
    nLow, n2to4, n4to8, n8up,
    bandRatio: bandRms / Math.max(1e-9, rRms),
  };
}

function analyze(x, sr) {
  const F = Math.round(sr * 0.04);
  const hop = Math.round(F / 2);
  const rows = [];
  for (let s = 0; s + F <= x.length; s += hop) {
    const r = frameHnr(x.subarray(s, s + F), sr);
    if (r && r.periodicity > 0.45) rows.push(r);
  }
  if (!rows.length) return null;
  const med = (key) => {
    const v = rows.map((r) => r[key]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return {
    frames: rows.length,
    f0: med('f0'),
    periodicity: med('periodicity'),
    hnr_dB: med('hnr_dB'),
    hnrLow_dB: med('hnrLow_dB'),
    hnrHi_dB: med('hnrHi_dB'),
    hRms: med('hRms'),
    rRms: med('rRms'),
    bandRms: med('bandRms'),
    bandRatio: med('bandRatio'),
    rRmsMean: rows.reduce((a, r) => a + r.rRms, 0) / rows.length,
    bandRmsMean: rows.reduce((a, r) => a + r.bandRms, 0) / rows.length,
    nLowMean: rows.reduce((a, r) => a + r.nLow, 0) / rows.length,
    n2to4Mean: rows.reduce((a, r) => a + r.n2to4, 0) / rows.length,
    n4to8Mean: rows.reduce((a, r) => a + r.n4to8, 0) / rows.length,
    n8upMean: rows.reduce((a, r) => a + r.n8up, 0) / rows.length,
  };
}

// ---- 简单 FFT（radix-2）用于频谱质心与高频占比 ----
function fftMag(frame) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const half = n / 2;
  const m = new Float64Array(half);
  for (let i = 0; i < half; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}

/// 平均频谱 → 质心、高频占比(>4k)、谱斜率(每倍频程 dB)
function spectrumProfile(x, sr) {
  const N = 2048, hopN = 1024;
  const half = N / 2;
  const acc = new Float64Array(half);
  let cnt = 0;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const start = Math.floor(x.length * 0.15);
  const end = Math.floor(x.length * 0.85);
  for (let s = start; s + N <= end; s += hopN) {
    const f = new Float64Array(N);
    for (let i = 0; i < N; i++) f[i] = x[s + i] * win[i];
    const m = fftMag(f);
    for (let i = 0; i < half; i++) acc[i] += m[i] * m[i];
    cnt++;
  }
  if (!cnt) return null;
  for (let i = 0; i < half; i++) acc[i] /= cnt;
  const binHz = sr / N;
  let num = 0, den = 0, tot = 0, hi = 0;
  for (let i = 1; i < half; i++) {
    const e = acc[i];
    const hz = i * binHz;
    num += hz * e; den += e; tot += e;
    if (hz > 4000) hi += e;
  }
  // 斜率：对 1k~8k 的 log 频率做线性回归（dB per octave）
  const pts = [];
  for (let i = 1; i < half; i++) {
    const hz = i * binHz;
    if (hz < 1000 || hz > 8000) continue;
    const db = 10 * Math.log10(Math.max(1e-20, acc[i]));
    pts.push([Math.log2(hz), db]);
  }
  let slope = NaN;
  if (pts.length > 8) {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxy = 0, sxx = 0;
    for (const [X, Y] of pts) { sxy += (X - mx) * (Y - my); sxx += (X - mx) ** 2; }
    slope = sxy / Math.max(1e-12, sxx);
  }
  return { centroidHz: num / Math.max(1e-20, den), hfRatio: hi / Math.max(1e-20, tot), slope };
}

function writeWav(path, data, sr) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '   n/a' : v.toFixed(d));

// ============================ 主流程 ============================

const wavPath = isAbsolute(ARG_WAV) ? ARG_WAV : join(root, ARG_WAV);
if (!existsSync(wavPath)) {
  console.error(`找不到导出文件 ${wavPath}\n用法: node scripts/_probe-pitchnet-ref.mjs <导出的wav> [源素材名] [pitch]`);
  process.exit(2);
}

const ref = readWav(wavPath);

// 读源素材（.wav 或 .mp3 都可以：走 wasm 解码）
const dir = join(root, '素材');
let srcPath = null;
for (const f of readdirSync(dir)) {
  if (f.replace(/\.[^.]+$/, '') === KIND) { srcPath = join(dir, f); break; }
}
if (!srcPath) { console.error(`找不到素材 ${KIND}`); process.exit(2); }

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

let src, srcSr;
{
  const buf = new Uint8Array(readFileSync(srcPath));
  const ptr = alloc(buf.length);
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  ex.hajimi_dealloc(ptr, buf.length);
  if (nch <= 0) { console.error('解码失败'); process.exit(2); }
  const N = ex.hajimi_decode_frames() | 0;
  src = new Float32Array(N);
  for (let c = 0; c < nch; c++) {
    const ch = new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, N));
    for (let i = 0; i < N; i++) src[i] += ch[i] / nch;
  }
  // ⚠ 采样率必须在 hajimi_decode_free() **之前**读 —— 释放后 getter 返回 0。
  srcSr = ex.hajimi_decode_sample_rate() | 0;
  ex.hajimi_decode_free();
  if (!srcSr) { console.error('拿不到解码采样率'); process.exit(2); }
}
console.log(`\n导出文件 = ${wavPath.replace(root + '\\', '').replace(root + '/', '')}`);
console.log(`  格式 ${ref.sr}Hz / ${ref.nch}ch / ${ref.bits}bit   帧数 ${ref.frames}  (${(ref.frames / ref.sr).toFixed(3)}s)`);
console.log(`源素材 = ${srcPath.replace(root + '\\', '').replace(root + '/', '')}`);
console.log(`  帧数 ${src.length} @ ${srcSr}Hz  (${(src.length / srcSr).toFixed(3)}s)`);
console.log(`  → 时长比 导出/源 = ${(ref.frames / ref.sr / (src.length / srcSr)).toFixed(4)}  (≈1 说明只变调不变速)`);

// 源统一重采样到导出采样率，方便逐项对比
const srcAtRefSr =
  srcSr === ref.sr
    ? src
    : (() => {
        const n = Math.round((src.length * ref.sr) / srcSr);
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = lerpAt(src, (i * srcSr) / ref.sr);
        return y;
      })();

// 用导出文件自己的 f0 反推 ratio（比信「我以为是 C4」可靠）
const PITCH = process.argv[4] ? Number(process.argv[4]) : null;
const cut = (x) => x.subarray(Math.floor(x.length * 0.15), Math.floor(x.length * 0.85));
const srcF0 = analyze(cut(Float64Array.from(srcAtRefSr)), ref.sr)?.f0 ?? null;
const refF0 = analyze(cut(Float64Array.from(ref.mono)), ref.sr)?.f0 ?? null;
const ratio = PITCH ?? (srcF0 && refF0 ? refF0 / srcF0 : null);

console.log(
  `\n源 f0 ≈ ${fmt(srcF0, 1)}Hz   导出 f0 ≈ ${fmt(refF0, 1)}Hz  → 实测 ratio ${ratio ? ratio.toFixed(4) : 'n/a'}` +
    ` (${ratio ? (12 * Math.log2(ratio)).toFixed(2) : 'n/a'} 半音)`,
);

// 渲染我们的 PSOLA：pitch 用导出文件反推出来的 ratio
const N = src.length;
const p = alloc(N * 4);
f32(p, N).set(src);
const outF = ex.hajimi_tx_run(p, N, 1, ratio, 1.0, 1, SR) | 0;
ex.hajimi_dealloc(p, N * 4);
if (outF <= 0) { console.error('tx_run 失败'); process.exit(2); }
const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
ex.hajimi_tx_free();

// ---- 三路统计 ----
const stats = (name, x, sr) => {
  const h = analyze(cut(Float64Array.from(x)), sr);
  const sp = spectrumProfile(x, sr);
  return {
    name, sr,
    dur: x.length / sr,
    rms: rmsBuf(x),
    peak: peakBuf(x),
    zero: zeroRatio(x),
    hnr: h ? h.hnr_dB : null,
    hnrLow_dB: h ? h.hnrLow_dB : null,
    hnrHi_dB: h ? h.hnrHi_dB : null,
    periodicity: h ? h.periodicity : null,
    f0: h ? h.f0 : null,
    noiseRms: h ? h.rRmsMean : null,
    bandRms: h ? h.bandRmsMean : null,
    nLowMean: h ? h.nLowMean : null,
    n2to4Mean: h ? h.n2to4Mean : null,
    n4to8Mean: h ? h.n4to8Mean : null,
    n8upMean: h ? h.n8upMean : null,
    centroid: sp ? sp.centroidHz : null,
    hf: sp ? sp.hfRatio : null,
    slope: sp ? sp.slope : null,
  };
};

const rows = [
  stats('源', srcAtRefSr, ref.sr),
  stats('PitchNet导出', ref.mono, ref.sr),
  stats('我们的PSOLA', out, SR),
];

console.log('\n【逐项对比 —— 拿真·PitchNet 导出当基准】');
console.log(
  '  ' +
    '项目'.padEnd(14) +
    '时长s'.padStart(7) + 'RMS'.padStart(9) + '峰值'.padStart(8) +
    'HNR总'.padStart(8) + 'HNR<2k'.padStart(9) + 'HNR>2k'.padStart(9) +
    '质心Hz'.padStart(9) + '>4k占比'.padStart(9) + '斜率'.padStart(8),
);
for (const r of rows) {
  console.log(
    '  ' +
      r.name.padEnd(14) +
      fmt(r.dur, 3).padStart(7) +
      fmt(r.rms, 5).padStart(9) +
      fmt(r.peak, 4).padStart(8) +
      fmt(r.hnr, 2).padStart(8) +
      fmt(r.hnrLow_dB, 2).padStart(9) +
      fmt(r.hnrHi_dB, 2).padStart(9) +
      fmt(r.centroid, 0).padStart(9) +
      (r.hf * 100).toFixed(1).padStart(9) +
      fmt(r.slope, 2).padStart(8),
  );
}

const [s0, s1, s2] = rows;
if (s1.hnr != null && s2.hnr != null) {
  console.log(
    `\n  HNR：PitchNet导出 ${fmt(s1.hnr, 2)}dB  vs  我们的PSOLA ${fmt(s2.hnr, 2)}dB` +
      `   →  差 ${fmt(s2.hnr - s1.hnr, 2)}dB（负 = 我们更毛）`,
  );
  console.log(
    `  噪声能量 我们/导出 = ${fmt(s2.noiseRms / Math.max(1e-9, s1.noiseRms), 2)}×` +
      `   2-8k 我们/导出 = ${fmt(s2.bandRms / Math.max(1e-9, s1.bandRms), 2)}×`,
  );
  console.log(
    `  质心 我们/导出 = ${fmt(s2.centroid / Math.max(1e-9, s1.centroid), 2)}×` +
      `   >4k 占比 我们/导出 = ${fmt(s2.hf / Math.max(1e-9, s1.hf), 2)}×`,
  );
}

// ---- 决定性的一张表：噪声（残余）落在哪个频段 ----
// 「沙沙」= 2k 以上的**残余**，不是总残余。把三路的残余按频段摊开，
// 就能分清「我们比 PitchNet 多出来的到底是低频毛刺还是高频沙沙」。
console.log('\n【噪声（周期同步平均的残余）频段分布 —— 同一时刻三路对同一段音频】');
console.log(
  '  ' + '项目'.padEnd(14) +
    '0-2k'.padStart(10) + '2-4k'.padStart(10) + '4-8k'.padStart(10) + '8-16k'.padStart(10) +
    '   |  相对源(dB) 2-4k / 4-8k / 8-16k',
);
const fmtSci = (v) => (v == null || !isFinite(v) ? '   n/a' : v.toExponential(2));
for (const r of rows) {
  const rel = (v, base) =>
    v == null || base == null || base <= 0 ? '  n/a' : (20 * Math.log10(v / base)).toFixed(1).padStart(6);
  console.log(
    '  ' + r.name.padEnd(14) +
      fmtSci(r.nLowMean).padStart(10) + fmtSci(r.n2to4Mean).padStart(10) +
      fmtSci(r.n4to8Mean).padStart(10) + fmtSci(r.n8upMean).padStart(10) +
      '   |  ' + rel(r.n2to4Mean, s0.n2to4Mean) + ' / ' + rel(r.n4to8Mean, s0.n4to8Mean) + ' / ' + rel(r.n8upMean, s0.n8upMean),
  );
}
console.log(
  '\n  读法：2-4k / 4-8k / 8-16k 的「相对源」列是我们真正要看的量。\n' +
    '        正数 = 这一档比源多了噪声（= 听成沙沙）；负很多 = 这一档被削掉了（= 听成发闷）。\n' +
    '        关键问题：我们多出来的 HF 噪声，和 PitchNet 削掉的 HF，是不是同一个频段。',
);

// ---- 写三路 A/B ----
const abDir = join(root, 'outputs', '_ab');
mkdirSync(abDir, { recursive: true });
const tag = `PN导出对比_${KIND}`;
writeWav(join(abDir, `${tag}_1源.wav`), srcAtRefSr, ref.sr);
writeWav(join(abDir, `${tag}_2_PitchNet导出.wav`), ref.mono, ref.sr);
writeWav(join(abDir, `${tag}_3_我们PSOLA.wav`), out, SR);
console.log(
  `\nWAV → outputs/_ab/\n  ${tag}_1源.wav\n  ${tag}_2_PitchNet导出.wav   (神经声码器，真基准)\n  ${tag}_3_我们PSOLA.wav\n`,
);
