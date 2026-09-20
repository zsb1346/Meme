// 直接量化「沙沙声」——用周期同步平均把信号拆成「谐波」与「噪声」，再看噪声落在哪个频段。
//
//   node scripts/_probe-hnr.mjs [素材名] [pitch] [time] [mode]
//
// 原理：信号若在 f0 上真周期，把相隔整数个周期的片段平均起来，谐波同相叠加、
// 噪声按 1/sqrt(K) 衰减 —— 于是
//
//     h = 周期同步平均（谐波成分）      r = x - h（噪声成分）
//     HNR = 20*log10(rms(h)/rms(r))
//
// HNR 掉下去 + 残余能量落在 2~8kHz（"沙沙"频段）= 合成器在造噪声。
// 这条判据比 F0、比频谱质心都直接：它量的是**听感上的沙沙**本身。
//
// ⚠ 必须用**分数周期 + 插值**。第一版用 round(period) 的整数周期平均，
//    周期非整数时 K 个周期后彻底失相，谐波估计塌成 0 → 干净的元音也量出
//    -5dB 的假 HNR（源 HNR 变负 = estimator 坏了，不是音频坏了）。
//    现在：先分数周期精搜（最大化归一化自相关），再做插值同步平均。
//
// 同时写 WAV 到 outputs/_ab/ 供试听。

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const KIND = process.argv[2] ?? '龙.001';
const PITCH = Number(process.argv[3] ?? 0.6216);
const TIME = Number(process.argv[4] ?? 1.0);
const MODE = Number(process.argv[5] ?? 1);
const SR = 48000;
const NT = 512; // 谐波模板的相位分辨率

// 估计器自检要在读素材之前跑 —— 素材查找失败会 process.exit。
if (process.argv.includes('--selftest')) {
  selftest();
  process.exit(0);
}

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

// ---------- 渲染 ----------
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

// ---------- 工具 ----------
function lerpAt(x, pos) {
  const i0 = Math.floor(pos);
  if (i0 < 0) return 0;
  if (i0 + 1 >= x.length) return x[i0] ?? 0;
  const fr = pos - i0;
  return x[i0] * (1 - fr) + x[i0 + 1] * fr;
}

function rmsBuf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/// 在 f0 附近精搜周期（分数 lag + 插值），最大化归一化自相关
function refineF0(x, sr, f0approx) {
  const span = 0.06;
  const steps = 240;
  let best = f0approx;
  let bestV = -2;
  for (let s = 0; s <= steps; s++) {
    const f = f0approx * (1 - span + (2 * span * s) / steps);
    const P = sr / f;
    const max = Math.floor(x.length - P - 2);
    let acc = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < max; i++) {
      const xj = lerpAt(x, i + P);
      acc += x[i] * xj;
      a += x[i] * x[i];
      b += xj * xj;
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestV) {
      bestV = v;
      best = f;
    }
  }
  return { f0: best, score: bestV };
}

/// 粗自相关给初值
function roughF0(x, sr, loHz, hiHz) {
  const minLag = Math.max(2, Math.floor(sr / hiHz));
  const maxLag = Math.min(Math.floor(sr / loHz), Math.floor(x.length / 2));
  let bestLag = minLag;
  let bestVal = -2;
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acc = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i + tau < x.length; i++) {
      acc += x[i] * x[i + tau];
      a += x[i] * x[i];
      b += x[i + tau] * x[i + tau];
    }
    const v = acc / Math.sqrt(Math.max(1e-12, a * b));
    if (v > bestVal) {
      bestVal = v;
      bestLag = tau;
    }
  }
  return sr / bestLag;
}

/// 周期同步平均 → 谐波模板 h（按**归一化相位**存储，分辨率 NT）。
///
/// ⚠ 模板必须按相位索引。曾经试过「模板长 round(P)、残差用 i % L」——那是错的：
///    真周期 P 是分数（如 137.1428），而 L=137，读模板时每周期累积 0.143 样点的
///    相位漂移，175 个周期后整段失相 → 残余被结构性地抬高，纯周期信号也量出
///    +1.35dB 的假 HNR。按相位（i/P mod 1）索引则精确无漂移。
///    `--selftest` 就是为抓这个而写的：纯谐波必须量出很高、且随噪声单调下降。
function syncAvg(x, P, K) {
  const h = new Float64Array(NT);
  const cnt = new Float64Array(NT);
  for (let k = 0; k < K; k++) {
    let stop = false;
    for (let j = 0; j < NT; j++) {
      const pos = (k + j / NT) * P;
      if (pos + 2 >= x.length) {
        stop = true;
        break;
      }
      h[j] += lerpAt(x, pos);
      cnt[j]++;
    }
    if (stop) break;
  }
  for (let j = 0; j < NT; j++) if (cnt[j] > 0) h[j] /= cnt[j];
  return h;
}

/// 相位模板的循环线性插值，phi ∈ [0,1)
function tmplAt(h, phi) {
  const p = ((phi % 1) + 1) % 1;
  const idx = p * NT;
  const i0 = Math.floor(idx) % NT;
  const i1 = (i0 + 1) % NT;
  const fr = idx - Math.floor(idx);
  return h[i0] * (1 - fr) + h[i1] * fr;
}

/// 单帧 HNR。帧要**短**（40ms）：周期同步平均假设「整段周期与波形都不变」，
/// 真语音有共振峰过渡与幅度包络，段一长平均就抹开 → 残余被人为做大。
/// 段级结论用**逐帧中位数**，不要用整段一次算。
function frameHnr(x, sr) {
  const rough = roughF0(x, sr, 60, 900);
  if (!(rough > 0) || !isFinite(rough)) return null;
  const { f0, score } = refineF0(x, sr, rough);
  const P = sr / f0;
  const K = Math.min(Math.floor((x.length - 2) / P), 60);
  if (K < 6 || P < 6) return null;

  const h = syncAvg(x, P, K);

  let eH = 0;
  let eR = 0;
  let n = 0;
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

  const band = bandpass(Float64Array.from(resid), sr, 2000, 8000);
  const bandRms = rmsBuf(band);

  return {
    f0,
    periodicity: score,
    hnr_dB: 20 * Math.log10(Math.max(1e-9, hRms) / Math.max(1e-9, rRms)),
    hRms,
    rRms,
    bandRms,
    bandRatio: bandRms / Math.max(1e-9, rRms),
  };
}

/// 逐帧（40ms，半重叠）算 HNR，只收周期性够的帧，返回中位数与分位数
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
    hRms: med('hRms'),
    rRms: med('rRms'),
    bandRms: med('bandRms'),
    bandRatio: med('bandRatio'),
    /// 噪声能量中位数（不是 dB 中位数）—— 用于「输出/源」比值
    rRmsMean: rows.reduce((a, r) => a + r.rRms, 0) / rows.length,
    bandRmsMean: rows.reduce((a, r) => a + r.bandRms, 0) / rows.length,
  };
}

/// 估计器自检：合成一个已知 HNR 的元音，看它量出来对不对。
/// 估计器坏了的时候，「源 HNR 变负」会伪装成「音频坏」—— 这个自检是防这个的。
function selftest() {
  const mk = (f0, noiseAmp, sr = SR, n = 24000) => {
    const x = new Float64Array(n);
    for (let k = 1; k * f0 < sr * 0.45; k++) {
      const a = (1 / k) * (0.6 + 0.4 * Math.exp(-(((k * f0 - 500) / 300) ** 2)));
      for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * k * f0 * i) / sr);
    }
    let s = 0x2545f491;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      x[i] += noiseAmp * ((s >>> 8) / 8388608 - 1);
    }
    return x;
  };
  console.log('\n【估计器自检】分数周期（f0=350Hz → 137.14 样点），加已知白噪');
  for (const na of [0.0, 0.03, 0.1, 0.3]) {
    const r = analyze(mk(350, na), SR);
    console.log(
      `  噪声幅度=${na.toFixed(2)}  → f0=${r.f0.toFixed(2)}Hz  周期性=${r.periodicity.toFixed(4)}` +
        `  帧数=${r.frames}  HNR=${r.hnr_dB.toFixed(2)}dB  (应随噪声单调下降；0 时应 >25dB)`,
    );
  }
  console.log();
}


/// 级联双二阶带通（RBJ）
function bandpass(x, sr, f1, f2) {
  const y = new Float64Array(x.length);
  const mid = Math.sqrt(f1 * f2);
  const w0 = (2 * Math.PI * mid) / sr;
  const alpha = Math.sin(w0) / (2 * 0.7);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const inp = x[i];
      const o =
        (b0 / a0) * inp + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1;
      x1 = inp;
      y2 = y1;
      y1 = o;
      y[i] = o;
    }
    for (let i = 0; i < x.length; i++) x[i] = y[i];
  }
  return x;
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

// ---------- 参考：纯线性重采样 ----------
// 就是 PitchNet `ResampledLoopAudition::render` 的算法（拖动音符时的试听）：
//   outputLength = lround(originalSamples / pitchRatio);  out[i] = src[i * pitchRatio]
// 它**不做任何颗粒合成**，所以不可能因为合成而变毛 —— 是本项目「沙沙」归因的对照基线。
const refLen = Math.max(1, Math.round(N / PITCH));
const ref = new Float32Array(refLen);
for (let i = 0; i < refLen; i++) {
  const pos = i * PITCH;
  const i0 = Math.floor(pos);
  const fr = pos - i0;
  ref[i] = i0 + 1 < N ? src[i0] * (1 - fr) + src[i0 + 1] * fr : src[i0] ?? 0;
}

// ---------- 分析：源 / 纯重采样 / PSOLA 各自逐帧测 HNR，取中位数 ----------
const cut = (x) => x.subarray(Math.floor(x.length * 0.15), Math.floor(x.length * 0.85));
const srcH = analyze(cut(src), SR);
const refH = analyze(cut(ref), SR);
const outH = analyze(cut(out), SR);

console.log(
  `\n素材 = ${matFile}   pitch=${PITCH} (${(12 * Math.log2(PITCH)).toFixed(2)} 半音)   time=${TIME}   mode=${MODE}`,
);
console.log(
  `marks=${marks}  voicedFrames=${voiced}   源 ${(N / SR).toFixed(3)}s → 输出 ${(outF / SR).toFixed(3)}s\n`,
);

const row = (name, h) =>
  console.log(
    `  ${name.padEnd(8)} f0=${h ? h.f0.toFixed(1).padStart(6) : '   n/a'}Hz  周期性=${h ? h.periodicity.toFixed(3) : '  n/a'}` +
      `  HNR=${h ? h.hnr_dB.toFixed(2).padStart(7) : '    n/a'}dB` +
      `  谐波rms=${h ? h.hRms.toFixed(5) : 'n/a'}  噪声rms=${h ? h.rRms.toFixed(5) : 'n/a'}` +
      `  残余中2-8k=${h ? (h.bandRatio * 100).toFixed(1) + '%' : 'n/a'}`,
  );
console.log('【逐帧(40ms)周期同步平均 HNR 中位数 —— 越高越干净】');
row('源', srcH);
row('纯重采样', refH);
row('我们的PSOLA', outH);
if (srcH && outH) {
  console.log(
    `\n  PSOLA   : HNR 变化 ${(outH.hnr_dB - srcH.hnr_dB).toFixed(2)}dB` +
      `   噪声 输出/源 = ${(outH.rRmsMean / Math.max(1e-9, srcH.rRmsMean)).toFixed(2)}×` +
      `   沙沙频段(2-8k) = ${(outH.bandRmsMean / Math.max(1e-9, srcH.bandRmsMean)).toFixed(2)}×`,
  );
  if (refH)
    console.log(
      `  纯重采样: HNR 变化 ${(refH.hnr_dB - srcH.hnr_dB).toFixed(2)}dB` +
        `   噪声 输出/源 = ${(refH.rRmsMean / Math.max(1e-9, srcH.rRmsMean)).toFixed(2)}×` +
        `   沙沙频段(2-8k) = ${(refH.bandRmsMean / Math.max(1e-9, srcH.bandRmsMean)).toFixed(2)}×`,
    );
}

// ---------- 写 WAV 供试听 ----------
const abDir = join(root, 'outputs', '_ab');
mkdirSync(abDir, { recursive: true });
const tag = `${KIND}_p${PITCH.toFixed(3)}_t${TIME}_m${MODE}`;
writeWav(join(abDir, `${KIND}_源.wav`), src, SR);
writeWav(join(abDir, `${tag}_PSOLA.wav`), out, SR);
writeWav(join(abDir, `${tag}_纯重采样PitchNet试听.wav`), ref, SR);
console.log(
  `\nWAV → outputs/_ab/\n  ${KIND}_源.wav\n  ${tag}_PSOLA.wav                (我们)\n  ${tag}_纯重采样PitchNet试听.wav  (PitchNet 拖动试听那条路)\n`,
);
