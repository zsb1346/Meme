// 谐波/噪声分离（HNSEP）能否消掉「降调沙沙」—— 决定性实验。
//
//   node scripts/_probe-hnsep.mjs [素材名] [pitch]
//
// 背景（已量到的）：
//   PSOLA 的颗粒间距 = period/ratio，而窗半宽恒 = period，
//   于是输出重叠率 = 1 - 1/(2*ratio)：ratio .62 → 19%，ratio .50 → 0%。
//
//   决定性证据（本探针第一版量出来的）：
//     同一套 marks、同样的颗粒几何，只把**严格周期成分**喂进去 →
//     HNR 14.02dB（周期性 0.991），比源本身（10.72）还干净；
//     而喂原始素材 → 9.07dB。**颗粒几何不造噪，造噪的是源里的非周期成分
//     被颗粒重排。** 所以「越降越沙」= 非周期成分被重排得越狠。
//
// 结论方向：把源拆成 harmon + residual，只让 harmon 进颗粒重排，residual 原样保留。
//   → 实测 α（残余回加比例）是一个可调「净化量」：α=1 保住气声、α=0 最干净。
//     这正是 PitchNet 默认那条路的来源 —— 它跑的是 PC-NSF-HiFiGAN 神经声码器
//     （用户日志 152/152 次渲染全走 Vocoder），**波形是重新生成的**，
//     相当于自带降噪，所以听感「干净舒服」。
//
// 拆分方法（第一版踩的坑）：不能用「±K 个周期的同步平均」——f0 有 1% 误差时
//   第 10 次谐波只剩 3.6%（13 抽头 Dirichlet 核在主瓣外塌掉），漏出来的谐波
//   混进残余、又不跟着变调，回加后与主路打架 → v2 反而比原 PSOLA 更差（7.74）。
//   现在改成**按谐波频率做窗内正交相关**（4 个周期的 Hann 窗）：
//     a_k = 2·Σ w·x·cos(2πkφ)/Σw ,  b_k = 2·Σ w·x·sin(2πkφ)/Σw
//   其中 φ 是**累积相位**（φ[i] = φ[i-1] + 1/period[i]，周期逐样本插值），
//   所以 f0 漂移不会破坏谐波对齐。重建 harm = Σ [a_k cos + b_k sin]。
//
// 同时写 WAV 到 outputs/_ab/ 供试听（含 α 扫描）。

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const KIND = process.argv[2] ?? '龙.001';
const PITCH = Number(process.argv[3] ?? 0.6216);
const SR = 48000;
const NT = 512;

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

// ---------- 读素材 ----------
const dir = join(root, '素材');
const matFile = readdirSync(dir).find(
  (f) => f.toLowerCase().endsWith('.mp3') && f.replace('.mp3', '') === KIND,
);
if (!matFile) {
  console.error(`找不到素材 ${KIND}`);
  process.exit(2);
}
let src;
{
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
  src = new Float32Array(N);
  for (let c = 0; c < nch; c++) {
    const ch = new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, N));
    for (let i = 0; i < N; i++) src[i] += ch[i] / nch;
  }
  ex.hajimi_decode_free();
}

function tx(x, pitch, mode = 1) {
  const p = alloc(x.length * 4);
  f32(p, x.length).set(x);
  const n = ex.hajimi_tx_run(p, x.length, 1, pitch, 1.0, mode, SR) | 0;
  ex.hajimi_dealloc(p, x.length * 4);
  if (n <= 0) throw new Error('tx_run 失败');
  const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, n));
  ex.hajimi_tx_free();
  return out;
}

// ---------- 工具 ----------
function lerpAt(x, pos) {
  const i0 = Math.floor(pos);
  if (i0 < 0) return 0;
  if (i0 + 1 >= x.length) return x[i0] ?? 0;
  const fr = pos - i0;
  return x[i0] * (1 - fr) + x[i0 + 1] * fr;
}
const rmsBuf = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

function refineF0(x, sr, f0approx, steps = 100) {
  const span = 0.06;
  let best = f0approx, bestV = -2;
  for (let s = 0; s <= steps; s++) {
    const f = f0approx * (1 - span + (2 * span * s) / steps);
    const P = sr / f;
    const max = Math.floor(x.length - P - 2);
    let acc = 0, a = 0, b = 0;
    for (let i = 0; i < max; i++) {
      const xj = lerpAt(x, i + P);
      acc += x[i] * xj; a += x[i] * x[i]; b += xj * xj;
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestV) { bestV = v; best = f; }
  }
  return { f0: best, score: bestV };
}

function roughF0(x, sr, loHz, hiHz) {
  const minLag = Math.max(2, Math.floor(sr / hiHz));
  const maxLag = Math.min(Math.floor(sr / loHz), Math.floor(x.length / 2));
  let bestLag = minLag, bestVal = -2;
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acc = 0, a = 0, b = 0;
    for (let i = 0; i + tau < x.length; i++) {
      acc += x[i] * x[i + tau]; a += x[i] * x[i]; b += x[i + tau] * x[i + tau];
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestVal) { bestVal = v; bestLag = tau; }
  }
  return sr / bestLag;
}

function tmplAt(h, phi) {
  const p = ((phi % 1) + 1) % 1;
  const idx = p * NT;
  const i0 = Math.floor(idx) % NT;
  const i1 = (i0 + 1) % NT;
  const fr = idx - Math.floor(idx);
  return h[i0] * (1 - fr) + h[i1] * fr;
}

// ---------- 逐帧 F0 轨迹 ----------
const HOPA = 240;
const FNW = 2048;
const frames = [];
for (let c = 0; c + FNW <= src.length; c += HOPA) {
  const seg = src.subarray(c, c + FNW);
  const rough = roughF0(seg, SR, 60, 900);
  if (!(rough > 0) || !isFinite(rough)) { frames.push({ c, f0: 0, P: 0, vo: false }); continue; }
  const { f0, score } = refineF0(seg, SR, rough);
  const P = SR / f0;
  const vo = score > 0.5 && P > 6 && P < SR / 50;
  frames.push({ c, f0, P, vo, score });
}
if (!frames.length) { console.error('帧太少'); process.exit(2); }

// ---------- 逐样本周期 + 累积相位 ----------
// f0 只在 voiced 帧之间插值；unvoiced 区间沿用最近的 voiced 值（残余会被置零，
// 那里的相位值不影响结果，只需要单调）。
const N = src.length;
const idxVoiced = frames.map((f, i) => (f.vo ? i : -1)).filter((i) => i >= 0);
if (!idxVoiced.length) { console.error('整段无声'); process.exit(2); }
const perSampleP = new Float64Array(N);
{
  const pts = idxVoiced.map((i) => ({ x: frames[i].c, P: frames[i].P }));
  for (let i = 0; i < N; i++) {
    if (i <= pts[0].x) { perSampleP[i] = pts[0].P; continue; }
    if (i >= pts[pts.length - 1].x) { perSampleP[i] = pts[pts.length - 1].P; continue; }
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].x <= i) lo = m; else hi = m; }
    const u = (i - pts[lo].x) / Math.max(1, pts[hi].x - pts[lo].x);
    perSampleP[i] = pts[lo].P * (1 - u) + pts[hi].P * u;
  }
}
const phi = new Float64Array(N + 1);
for (let i = 0; i < N; i++) phi[i + 1] = phi[i] + 1 / perSampleP[i];
const TWO_PI = 2 * Math.PI;

// ---------- 谐波正弦模型分析 ----------
// 每帧：4 个周期的 Hann 窗内，对 k·f0 做正交相关。
const KMAX = 80;
const frameCoeff = frames.map((f, fi) => {
  if (!f.vo) return null;
  const W = Math.max(8, Math.round(4 * f.P));
  const half = W >> 1;
  const a0 = Math.max(0, f.c - half);
  const a1 = Math.min(N, f.c + half);
  const K = Math.min(KMAX, Math.floor((0.45 * SR) / f.f0));
  const cos = new Float64Array(K + 1);
  const sin = new Float64Array(K + 1);
  let wsum = 0;
  for (let i = a0; i < a1; i++) {
    const t = (i - (f.c - half)) / W;
    const w = 0.5 - 0.5 * Math.cos(TWO_PI * t); // Hann
    wsum += w;
  }
  if (wsum < 1) return null;
  for (let i = a0; i < a1; i++) {
    const t = (i - (f.c - half)) / W;
    const w = 0.5 - 0.5 * Math.cos(TWO_PI * t);
    const xv = src[i] * w;
    const ph = phi[i];
    for (let k = 1; k <= K; k++) {
      const ang = TWO_PI * k * ph;
      cos[k] += xv * Math.cos(ang);
      sin[k] += xv * Math.sin(ang);
    }
  }
  for (let k = 1; k <= K; k++) { cos[k] *= 2 / wsum; sin[k] *= 2 / wsum; }
  return { K, cos, sin };
});

// ---------- 重建 harm ----------
// 帧间线性混合系数（K 不同时按零补齐）。
const harm = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / HOPA;
  let m = Math.floor(t);
  let u = t - m;
  if (m >= frames.length - 1) { m = frames.length - 1; u = 0; }
  const A = frameCoeff[m];
  const B = frameCoeff[Math.min(m + 1, frames.length - 1)];
  if (!A && !B) { harm[i] = src[i]; continue; }
  const wA = A ? 1 - u : 0;
  const wB = B ? u : 0;
  const tot = wA + wB;
  if (tot <= 0) { harm[i] = src[i]; continue; }
  const KA = A ? A.K : 0;
  const KB = B ? B.K : 0;
  const K = Math.max(KA, KB);
  const ph = phi[i];
  let v = 0;
  for (let k = 1; k <= K; k++) {
    const ak = (wA * (k <= KA ? A.cos[k] : 0) + wB * (k <= KB ? B.cos[k] : 0)) / tot;
    const bk = (wA * (k <= KA ? A.sin[k] : 0) + wB * (k <= KB ? B.sin[k] : 0)) / tot;
    const ang = TWO_PI * k * ph;
    v += ak * Math.cos(ang) + bk * Math.sin(ang);
  }
  harm[i] = v;
}
const noise = new Float32Array(N);
for (let i = 0; i < N; i++) noise[i] = src[i] - harm[i];

let voFrames = 0;
for (const f of frames) if (f.vo) voFrames++;

// ---------- 渲染 ----------
const tA = Date.now();
const ourOut = tx(src, PITCH, 1);
const ms1 = Date.now() - tA;
// 内核里的 mode 3 = PSOLA + 谐波/噪声分离（本探针第一/二版验证的就是它）
const t0 = Date.now();
const mode3 = tx(src, PITCH, 3);
const ms3 = Date.now() - t0;
const harmOut = tx(harm, PITCH, 1);
const comb = (alpha) => {
  const n = Math.min(harmOut.length, noise.length);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = harmOut[i] + alpha * noise[i];
  return o;
};
const v0 = comb(0.0);
const v5 = comb(0.5);
const v10 = comb(1.0);

// ---------- 契约：mode 3 只在启用线以下与 mode 1 有区别 ----------
// Rust 单测（harmonic_mode_leaves_upshift_bit_exact）钉的是 host 产物 .exe；
// 这里钉的是**真正交付的 wasm32 产物** —— 两者是不同构建，必须各验一次。
// 用户明确说过「高音我们可能比 PitchNet 好」，所以升调侧逐样本不变是硬契约。
const PARITY_UP = [1.0, 2 ** (5 / 12), 2 ** (7 / 12), 2.0, 0.89];
const PARITY_DOWN = [0.85, 0.62];
function parityAt(p) {
  const a = tx(src, p, 1);
  const b = tx(src, p, 3);
  const n = Math.min(a.length, b.length);
  let maxAbs = 0, maxAt = -1, se = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) { maxAbs = d; maxAt = i; }
    se += (a[i] - b[i]) ** 2;
  }
  const diffRms = Math.sqrt(se / Math.max(1, n));
  return {
    p, semi: 12 * Math.log2(p), lenEq: a.length === b.length, maxAbs, maxAt, diffRms,
    // 相对源 RMS 的差异（线性）：<0.01 ≈ 可忽略；>0.1 是听得出的音色台阶
    diffRel: diffRms / Math.max(1e-12, rmsBuf(src)),
    // 最大偏差落在两端 5% 内 = 边缘效应；落在中段 = 系统性的音色差异
    edge: maxAt >= 0 && (maxAt < n * 0.05 || maxAt > n * 0.95),
  };
}
const parityUp = PARITY_UP.map(parityAt);
const parityDown = PARITY_DOWN.map(parityAt);

// 参考：纯线性重采样（PitchNet 拖动试听那条路）
const refLen = Math.max(1, Math.round(N / PITCH));
const ref = new Float32Array(refLen);
for (let i = 0; i < refLen; i++) {
  const pos = i * PITCH;
  const i0 = Math.floor(pos);
  const fr = pos - i0;
  ref[i] = i0 + 1 < N ? src[i0] * (1 - fr) + src[i0 + 1] * fr : src[i0] ?? 0;
}

// ---------- 测量 ----------
function bandpass(x, sr, f1, f2) {
  const y = new Float64Array(x.length);
  const mid = Math.sqrt(f1 * f2);
  const w0 = (2 * Math.PI * mid) / sr;
  const alpha = Math.sin(w0) / (2 * 0.7);
  const b0 = alpha, b2 = -alpha, a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
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

// 「在指定 f0 上有多周期性」——返回相干能量占比（0..1，线性）。
// 用来回答一个关键问题：拆分出来的残余，是**干净的白噪**，
// 还是**仍然锁在原音高上的谐波残留**？
// 后者被原样加回（不做变调），就会与已经被变调的谐波**打拍**（不相谐的部分音）→ 粗糙/嗡嗡 = 另一种噪音。
function coherentAt(x, f0, sr) {
  const P = sr / f0;
  const K = Math.min(Math.floor((x.length - 2) / P), 60);
  if (K < 6 || P < 6) return null;
  const h = new Float64Array(NT);
  const cnt = new Float64Array(NT);
  for (let k = 0; k < K; k++) {
    for (let j = 0; j < NT; j++) {
      const pos = (k + j / NT) * P;
      if (pos + 2 >= x.length) break;
      h[j] += lerpAt(x, pos);
      cnt[j]++;
    }
  }
  for (let j = 0; j < NT; j++) if (cnt[j] > 0) h[j] /= cnt[j];
  let eH = 0, eT = 0;
  for (let i = 0; i < x.length; i++) {
    const hv = tmplAt(h, i / P);
    eH += hv * hv;
    eT += x[i] * x[i];
  }
  return eT > 0 ? Math.sqrt(eH / eT) : null;
}

function frameHnr(x, sr) {
  const rough = roughF0(x, sr, 60, 900);
  if (!(rough > 0) || !isFinite(rough)) return null;
  const { f0, score } = refineF0(x, sr, rough);
  const P = sr / f0;
  const K = Math.min(Math.floor((x.length - 2) / P), 60);
  if (K < 6 || P < 6) return null;
  const h = new Float64Array(NT);
  const cnt = new Float64Array(NT);
  for (let k = 0; k < K; k++) {
    let stop = false;
    for (let j = 0; j < NT; j++) {
      const pos = (k + j / NT) * P;
      if (pos + 2 >= x.length) { stop = true; break; }
      h[j] += lerpAt(x, pos); cnt[j]++;
    }
    if (stop) break;
  }
  for (let j = 0; j < NT; j++) if (cnt[j] > 0) h[j] /= cnt[j];

  let eH = 0, eR = 0, n = 0;
  const resid = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const hv = tmplAt(h, i / P);
    const rv = x[i] - hv;
    resid[i] = rv; eH += hv * hv; eR += rv * rv; n++;
  }
  const hRms = Math.sqrt(eH / Math.max(1, n));
  const rRms = Math.sqrt(eR / Math.max(1, n));
  const bandRms = rmsBuf(bandpass(Float64Array.from(resid), sr, 2000, 8000));
  return {
    f0, periodicity: score,
    hnr_dB: 20 * Math.log10(Math.max(1e-9, hRms) / Math.max(1e-9, rRms)),
    hRms, rRms, bandRms, bandRatio: bandRms / Math.max(1e-9, rRms),
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
  const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  return {
    frames: rows.length, f0: med('f0'), periodicity: med('periodicity'),
    hnr_dB: med('hnr_dB'), hRms: med('hRms'), rRms: med('rRms'),
    bandRms: med('bandRms'), bandRatio: med('bandRatio'),
  };
}

// ---------- 频谱侧写（质心 / >4k 占比 / 分档能量） ----------
// 与真·PitchNet 导出对比时用的同一套量：质心偏高 = 发亮，>4k 偏高 = "沙沙"。
function fftPow(x, sr) {
  const NFFT = 1024;
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  const acc = new Float64Array(NFFT / 2 + 1);
  let nf = 0;
  for (let s = 0; s + NFFT <= x.length; s += NFFT / 2) {
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    for (let i = 0; i < NFFT; i++) re[i] = x[s + i] * win[i];
    // 迭代 radix-2 FFT
    for (let i = 1, j = 0; i < NFFT; i++) {
      let bit = NFFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= NFFT; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < NFFT; i += len) {
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
    for (let b = 0; b <= NFFT / 2; b++) acc[b] += re[b] * re[b] + im[b] * im[b];
    nf++;
  }
  for (let b = 0; b <= NFFT / 2; b++) acc[b] /= Math.max(1, nf);
  return acc;
}

function spectral(x, sr) {
  const P = fftPow(x, sr);
  const df = sr / 1024;
  let sA = 0, sF = 0, tot = 0, hf4 = 0;
  const bands = [0, 0, 0, 0];
  const edges = [2000, 4000, 8000, 16000];
  for (let b = 1; b <= 512; b++) {
    const f = b * df;
    if (f < 50 || f > 16000) continue;
    const p = P[b];
    const a = Math.sqrt(p);
    sA += a; sF += a * f; tot += p;
    if (f > 4000) hf4 += p;
    for (let i = 0; i < 4; i++) if (f < edges[i]) { bands[i] += p; break; }
  }
  const rmsOf = (e) => Math.sqrt(e / Math.max(1, tot)) * rmsBuf(x);
  return {
    centroid: sA > 0 ? sF / sA : 0,
    hf4: tot > 0 ? hf4 / tot : 0,
    bands: bands.map(rmsOf),
  };
}

const cut = (x) => x.subarray(Math.floor(x.length * 0.15), Math.floor(x.length * 0.85));
const rows = [
  ['源', src],
  ['纯重采样', ref],
  ['mode1 我们的PSOLA', ourOut],
  ['★mode3 内核谐波分离', mode3],
  ['拆分:只谐波harm', harm],
  ['拆分:只残余noise', noise],
  ['谐波PSOLA (α=0)', v0],
  ['谐波PSOLA+0.5残余', v5],
  ['谐波PSOLA+1.0残余', v10],
].map(([name, x]) => {
  let sp = null;
  try { sp = spectral(cut(x), SR); } catch { sp = null; }
  return { name, x, h: analyze(cut(x), SR), rms: rmsBuf(x), sp };
});

const semi = 12 * Math.log2(PITCH);
console.log(
  `\n素材 = ${matFile}   pitch=${PITCH} (${semi.toFixed(2)} 半音)   源 ${(N / SR).toFixed(3)}s` +
    `   voiced 帧 ${voFrames}/${frames.length}`,
);
console.log(
  `\n【拆分质量】rms(noise)/rms(src) = ${(rmsBuf(noise) / rmsBuf(src)).toFixed(3)}` +
    `   rms(harm)/rms(src) = ${(rmsBuf(harm) / rmsBuf(src)).toFixed(3)}` +
    `  → 两者平方和应为 1.000（正交性检查）`,
);
console.log('\n【逐帧(40ms)周期同步平均 HNR 中位数 —— 越高越干净】\n');
console.log(
  '  项目'.padEnd(24) + 'f0 Hz'.padStart(8) + '周期性'.padStart(8) +
  'HNR dB'.padStart(9) + 'RMS'.padStart(9) + '残余2-8k'.padStart(10),
);
for (const r of rows) {
  const h = r.h;
  console.log(
    '  ' + r.name.padEnd(22) +
      (h ? h.f0.toFixed(1).padStart(8) : '     n/a') +
      (h ? h.periodicity.toFixed(3).padStart(8) : '     n/a') +
      (h ? h.hnr_dB.toFixed(2).padStart(9) : '      n/a') +
      r.rms.toFixed(5).padStart(9) +
      (h ? (h.bandRatio * 100).toFixed(1).padStart(9) + '%' : '      n/a'),
  );
}

const get = (n) => rows.find((r) => r.name === n);
const s0 = get('源').h;
if (s0) {
  console.log('\n  相对源的 HNR 差：');
  for (const n of ['纯重采样', 'mode1 我们的PSOLA', '★mode3 内核谐波分离',
                   '谐波PSOLA (α=0)', '谐波PSOLA+0.5残余', '谐波PSOLA+1.0残余']) {
    const h = get(n)?.h;
    if (h) console.log(`    ${n.padEnd(24)} ${(h.hnr_dB - s0.hnr_dB).toFixed(2).padStart(7)} dB`);
  }
}

// ---------- 残余到底是「白噪」还是「锁在原音高上的谐波残留」 ----------
// 这是判「噪音换了一种形式」的关键一测：
// 若残余在**原 f0** 上仍有高相干占比，说明它带着没被模型吃掉的谐波；
// 它被原样加回（不变调）时，会与已经变调的谐波形成不相谐的部分音 → 粗糙/嗡嗡。
const srcF0 = get('源')?.h?.f0 ?? 0;
const outF0 = get('mode1 我们的PSOLA')?.h?.f0 ?? 0;
const halfF0 = get('mode1 我们的PSOLA')?.h?.f0 ? get('mode1 我们的PSOLA').h.f0 / 2 : 0;
if (srcF0 > 0 && outF0 > 0) {
  const cutN = (x) => x.subarray(Math.floor(x.length * 0.15), Math.floor(x.length * 0.85));
  const cResidSrc = coherentAt(cutN(noise), srcF0, SR);
  const cResidOut = coherentAt(cutN(noise), outF0, SR);
  const cResidHalf = coherentAt(cutN(noise), halfF0, SR);
  const cSrc = coherentAt(cutN(src), srcF0, SR);
  const cM1 = coherentAt(cutN(ourOut), outF0, SR);
  const cM3 = coherentAt(cutN(mode3), outF0, SR);
  const f = (v) => (v == null ? 'n/a' : v.toFixed(3));
  console.log('\n【残余的性质】相干能量占比（0=纯白噪，1=完全周期）\n');
  console.log(`  源            @源 f0 ${srcF0.toFixed(0)}Hz   ${f(cSrc)}   ← 参照：源本身当然高`);
  console.log(`  残余 noise    @源 f0 ${srcF0.toFixed(0)}Hz   ${f(cResidSrc)}   ← ★高 = 残余锁在**原**音高上（模型没吃干净的谐波）`);
  console.log(`  残余 noise    @输出 f0 ${outF0.toFixed(0)}Hz  ${f(cResidOut)}   ← 低 = 残余不是输出音高的结构`);
  console.log(`  残余 noise    @半输出 f0 ${halfF0.toFixed(0)}Hz ${f(cResidHalf)}`);
  console.log(`  mode1 输出     @输出 f0 ${outF0.toFixed(0)}Hz  ${f(cM1)}`);
  console.log(`  mode3 输出     @输出 f0 ${outF0.toFixed(0)}Hz  ${f(cM3)}`);
  if (cResidSrc != null && cResidSrc > 0.25) {
    console.log('\n  → 残余带有明显的**原音高**周期结构。把它原样（不变调）加回变调后的谐波，');
    console.log('    等于在低八度的谐波上叠了一层原音高的部分音 → 打拍/粗糙，听感就是「另一种噪音」。');
  }
}


const ref0 = get('源').sp;
console.log('\n【频谱侧写 —— 质心偏高 = 发亮；>4k 偏高 = 沙沙；分档列是「相对源(dB)」】\n');
console.log(
  '  项目'.padEnd(24) + '质心Hz'.padStart(9) + '质心比'.padStart(9) +
  '>4k占比'.padStart(9) + '  0-2k'.padStart(9) + '  2-4k'.padStart(9) +
  '  4-8k'.padStart(9) + ' 8-16k'.padStart(9),
);
for (const r of rows) {
  const sp = r.sp;
  if (!sp || !ref0) continue;
  const db = (a, b) => 20 * Math.log10(Math.max(1e-12, a) / Math.max(1e-12, b));
  console.log(
    '  ' + r.name.padEnd(22) +
      sp.centroid.toFixed(0).padStart(9) +
      (sp.centroid / Math.max(1, ref0.centroid)).toFixed(3).padStart(9) +
      (sp.hf4 * 100).toFixed(1).padStart(8) + '%' +
      db(sp.bands[0], ref0.bands[0]).toFixed(1).padStart(9) +
      db(sp.bands[1], ref0.bands[1]).toFixed(1).padStart(9) +
      db(sp.bands[2], ref0.bands[2]).toFixed(1).padStart(9) +
      db(sp.bands[3], ref0.bands[3]).toFixed(1).padStart(9),
  );
}

// ---------- 契约：mode 3 只在启用线以下与 mode 1 有区别 ----------
// Rust 单测钉的是 host 产物；这里钉的是真正交付的 wasm32 产物。
const pfmt = (r) => `    pitch ${r.p.toFixed(4)} (${r.semi >= 0 ? '+' : ''}${r.semi.toFixed(2)} 半音)` +
  `  max ${r.maxAbs.toExponential(2)}` +
  `  差异RMS/源RMS ${r.diffRel.toFixed(4)}` +
  `  ${r.maxAbs === 0 ? '逐样本相同' : r.edge ? '（最大偏差在两端）' : '（最大偏差在中段）'}`;
console.log('\n【契约】mode 3 在启用线（ratio 0.89 ≈ −2 半音）及以上必须与 mode 1 逐样本相同\n');
for (const r of parityUp) console.log(pfmt(r));
console.log('  以上应全部为 0 —— 升调 / unity / 轻微降调一点没被改动');
for (const r of parityDown) console.log(pfmt(r));
console.log('  以下应显著非 0 —— 这才是谐波分离真正起作用的地方');
const upMax = Math.max(...parityUp.map((r) => r.maxAbs));
console.log(`\n  ${upMax === 0 ? 'PASS' : 'FAIL'}  启用线以上最大偏差 ${upMax.toExponential(2)}` +
  `${upMax === 0 ? '（逐样本相同）' : '（不该有偏差！）'}`);
// 启用线正下方：分离只是「刚刚开始」的地方。差异必须小到听不出，
// 否则参数轴扫过这条线时会有音色台阶。
const justBelow = parityAt(0.889);
console.log(`  [边界] ratio 0.889（刚过线，β≈1.0）差异RMS/源RMS = ${justBelow.diffRel.toFixed(4)}` +
  `  ${justBelow.diffRel < 0.02 ? '平滑' : '有台阶！'}`);

// ---------- 写 WAV ----------
function writeWav(path, data, sr) {

  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const abDir = join(root, 'outputs', '_ab');
mkdirSync(abDir, { recursive: true });
const tag = `${KIND}_p${PITCH.toFixed(3)}`;
writeWav(join(abDir, `${tag}_A源.wav`), src, SR);
writeWav(join(abDir, `${tag}_B我们PSOLA.wav`), ourOut, SR);
writeWav(join(abDir, `${tag}_C内核mode3.wav`), mode3, SR);
writeWav(join(abDir, `${tag}_D谐波α05.wav`), v5, SR);
writeWav(join(abDir, `${tag}_E谐波α10.wav`), v10, SR);
writeWav(join(abDir, `${tag}_F纯重采样.wav`), ref, SR);
console.log(
  `\n【成本】mode 1 ${ms1}ms | mode 3 ${ms3}ms / ${(N / SR).toFixed(2)}s 素材` +
    `  → mode3 ${(N / SR / (ms3 / 1000)).toFixed(1)}× 实时，另加 ${(ms3 / Math.max(1, ms1)).toFixed(2)}× mode1`,
);
console.log(
  `\nWAV → outputs/_ab/${tag}_*.wav\n  A源 / B我们PSOLA / C内核mode3 / D谐波α0.5 / E谐波α1.0 / F纯重采样\n`,
);
