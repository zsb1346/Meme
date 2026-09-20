// 真素材 + 对抗性合成信号的「爆音/杂音」体检。
//
//   node scripts/_probe-clicks.mjs [wasm路径] [--json 输出文件]
//
// 判据（每个区段都算一遍，**整段**与**中段**分开报，因为咔哒最爱藏在边缘）：
//
//   1. 跳变比 = max|x[i]-x[i-1]| / RMS          —— 源里没有的陡沿 = 咔哒/爆音
//   2. 跳变峰值位置（相对整段的位置 0..1）        —— 定位到具体时刻
//   3. HF 比 = RMS(x[i]-x[i-1]) / RMS(x)        —— 输出比源多出来的宽带高频 = 杂音
//
// 合成信号专门制造「PSOLA 最怕的几何」：
//   gap      —— 有声/静音/有声，逼出 blend mask 的 0↔1 斜坡与起音锚定
//   onset    —— 一拍一个短音 + 静音间隙，逼出每个 voiced run 的 onset anchor
//   longnote —— 4s 长音，看中段是否稳
//   noise    —— 纯噪声，走固定颗粒路径（对照）
//
// 恒等档（pitch=1/time=1）走逐样本拷贝，是每个素材的**下限基线**。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const wasmPath =
  args[0] && !args[0].startsWith('--')
    ? resolve(args[0])
    : join(root, 'public', 'hajimi_audio.wasm');

const CONFIGS = [
  { name: '恒等 1.00/1.00', pitch: 1.0, time: 1.0, mode: 1 },
  { name: '变调 +5', pitch: 2 ** (5 / 12), time: 1.0, mode: 1 },
  { name: '变调 -5', pitch: 2 ** (-5 / 12), time: 1.0, mode: 1 },
  { name: '变调 +12', pitch: 2.0, time: 1.0, mode: 1 },
  { name: '变速 1.40x', pitch: 1.0, time: 1.4, mode: 1 },
  { name: '变速 0.70x', pitch: 1.0, time: 0.7, mode: 1 },
  { name: '+5 & 1.40x', pitch: 2 ** (5 / 12), time: 1.4, mode: 1 },
  { name: 'SOLA +5', pitch: 2 ** (5 / 12), time: 1.0, mode: 2 },
];

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

function decodeMp3(buf) {
  const ptr = alloc(buf.length);
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  ex.hajimi_dealloc(ptr, buf.length);
  if (nch <= 0) return null;
  const frames = ex.hajimi_decode_frames() | 0;
  const sr = ex.hajimi_decode_sample_rate() | 0;
  const chans = [];
  for (let c = 0; c < nch; c++) {
    chans.push(new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, frames)));
  }
  ex.hajimi_decode_free();
  return { nch, frames, sr, chans };
}

function txRun(mono, pitch, time, mode, sr) {
  const frames = mono.length;
  const ptr = alloc(frames * 4);
  f32(ptr, frames).set(mono);
  const outF = ex.hajimi_tx_run(ptr, frames, 1, pitch, time, mode, sr) | 0;
  ex.hajimi_dealloc(ptr, frames * 4);
  if (outF <= 0) return null;
  const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
  ex.hajimi_tx_free();
  return out;
}

/** 区段指标。from/len 以样本计；返回 null 表示区段太短或近似静音。 */
function metrics(x, from, len) {
  const lo = Math.max(1, Math.min(x.length, from));
  const hi = Math.max(lo, Math.min(x.length, from + len));
  if (hi - lo < 64) return null;
  let peak = 0;
  let sum2 = 0;
  let dmax = 0;
  let dsum2 = 0;
  let dmaxAt = lo;
  const ds = [];
  for (let i = lo; i < hi; i++) {
    const v = x[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum2 += v * v;
    const d = Math.abs(v - x[i - 1]);
    if (d > dmax) {
      dmax = d;
      dmaxAt = i;
    }
    dsum2 += d * d;
    ds.push(d);
  }
  const rms = Math.sqrt(sum2 / (hi - lo));
  if (!(rms > 1e-9)) return null;
  const sorted = ds.slice().sort((a, b) => a - b);
  const dmed = sorted[sorted.length >> 1] || 1e-12;
  let clip = 0;
  for (let i = lo; i < hi; i++) if (Math.abs(x[i]) > 1.0) clip++;
  return {
    rms,
    peak,
    clip,
    crest: peak / rms,
    jump: dmax / rms,
    dmax,
    hf: Math.sqrt(dsum2 / ds.length) / rms,
    clicks: ds.filter((v) => v > 8 * dmed).length,
    at: (dmaxAt - lo) / (hi - lo),
  };
}

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nwasm = ${wasmPath.replace(root, '.')}`);
console.log('「爆音/杂音」体检 —— 整段（含边缘）｜中段\n');

// ===========================================================================
// 1. 真素材
// ===========================================================================
const rows = [];
for (const f of files) {
  let dec;
  try {
    dec = decodeMp3(new Uint8Array(readFileSync(join(dir, f))));
  } catch {
    continue;
  }
  if (!dec) continue;
  const n = dec.frames;
  const mono = new Float32Array(n);
  for (const c of dec.chans) for (let i = 0; i < n; i++) mono[i] += c[i] / dec.chans.length;
  const srcFull = metrics(mono, 1, n - 1);
  if (!srcFull) continue;
  const srcMid = metrics(mono, Math.floor(n * 0.2), Math.floor(n * 0.6));

  const row = { f, ms: Math.round((n / dec.sr) * 1000), srcFull, srcMid, cfg: {} };
  for (const cfg of CONFIGS) {
    const out = txRun(mono, cfg.pitch, cfg.time, cfg.mode, dec.sr);
    if (!out) {
      row.cfg[cfg.name] = null;
      continue;
    }
    const of = metrics(out, 1, out.length - 1);
    const om = metrics(out, Math.floor(out.length * 0.2), Math.floor(out.length * 0.6));
    row.cfg[cfg.name] = of
      ? {
          ...of,
          vs: of.jump / srcFull.jump,
          vsMid: om ? om.jump / (srcMid?.jump || srcFull.jump) : NaN,
          hfVs: of.hf / srcFull.hf,
          peakVs: of.peak / srcFull.peak,
          crestVs: of.crest / srcFull.crest,
        }
      : null;
  }
  rows.push(row);
}

console.log('【真素材 41 个】跳变比 = 输出 max|Δ|/RMS ÷ 源同区间同量');
console.log(
  '配置'.padEnd(16) +
    '整段中位'.padStart(9) +
    '整段最差'.padStart(9) +
    '>2.0'.padStart(6) +
    '中段中位'.padStart(9) +
    '中段最差'.padStart(9) +
    'HF比中位'.padStart(9) +
    'HF最大'.padStart(8) +
    '峰值比最大'.padStart(11) +
    '>1.0 个数'.padStart(9),
);
console.log('-'.repeat(96));
for (const cfg of CONFIGS) {
  const good = rows.filter((r) => r.cfg[cfg.name]);
  const vf = good.map((r) => r.cfg[cfg.name].vs).sort((a, b) => a - b);
  const vm = good
    .map((r) => r.cfg[cfg.name].vsMid)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const hf = good.map((r) => r.cfg[cfg.name].hfVs).sort((a, b) => a - b);
  const pk = good.map((r) => r.cfg[cfg.name].peakVs).sort((a, b) => a - b);
  if (!vf.length) continue;
  console.log(
    cfg.name.padEnd(16) +
      vf[vf.length >> 1].toFixed(2).padStart(9) +
      vf[vf.length - 1].toFixed(2).padStart(9) +
      String(vf.filter((v) => v > 2).length).padStart(6) +
      (vm.length ? vm[vm.length >> 1].toFixed(2) : '--').padStart(9) +
      (vm.length ? vm[vm.length - 1].toFixed(2) : '--').padStart(9) +
      hf[hf.length >> 1].toFixed(2).padStart(9) +
      hf[hf.length - 1].toFixed(2).padStart(8) +
      pk[pk.length - 1].toFixed(2).padStart(11) +
      String(pk.filter((v) => v > 1.0).length).padStart(9),
  );
}

// ---- 削顶（|x| > 1.0）----
console.log('\n【削顶】输出里 |x| > 1.0 的样点数（源峰值 / 输出峰值 / 输出削顶数 / 增量）：');
const clippers = [];
for (const r of rows) {
  for (const cfg of CONFIGS) {
    const c = r.cfg[cfg.name];
    if (!c) continue;
    if (c.clip > 0 || c.peak > 1.0) {
      clippers.push({
        f: r.f,
        cfg: cfg.name,
        srcPeak: r.srcFull.peak,
        outPeak: c.peak,
        clip: c.clip,
        bump: c.peakVs,
      });
    }
  }
}
clippers.sort((a, b) => b.outPeak - a.outPeak);
if (!clippers.length) {
  console.log('  无（所有配置的输出峰值都 ≤ 1.0）');
} else {
  console.log(
    '  素材'.padEnd(14) + '配置'.padEnd(14) + '源峰值'.padStart(9) + '输出峰值'.padStart(10) + '削顶样点'.padStart(10) + '峰值比'.padStart(8),
  );
  for (const c of clippers.slice(0, 20)) {
    console.log(
      `  ${c.f.replace('.mp3', '').slice(0, 12)}`.padEnd(14) +
        c.cfg.padEnd(14) +
        c.srcPeak.toFixed(3).padStart(9) +
        c.outPeak.toFixed(3).padStart(10) +
        String(c.clip).padStart(10) +
        c.bump.toFixed(2).padStart(8),
    );
  }
}
console.log(`\n  源峰值本身 > 1.0 的素材数：${rows.filter((r) => r.srcFull.peak > 1.0).length}/${rows.length}`);

console.log('\n每档「整段跳变比」最高的 6 个（括号内是跳变发生位置 0..1）：');
for (const cfg of CONFIGS) {
  const good = rows
    .filter((r) => r.cfg[cfg.name])
    .sort((a, b) => b.cfg[cfg.name].vs - a.cfg[cfg.name].vs)
    .slice(0, 6);
  console.log(
    `  ${cfg.name.padEnd(14)}` +
      good
        .map(
          (r) =>
            `${r.f.replace('.mp3', '')} ${r.cfg[cfg.name].vs.toFixed(1)}x@${r.cfg[cfg.name].at.toFixed(2)}`,
        )
        .join('  '),
  );
}

// ===========================================================================
// 2. 对抗性合成信号
// ===========================================================================
const SR = 48000;

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

function buildGap() {
  const n = SR; // 1s：300ms 有声 + 400ms 静音 + 300ms 有声
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

function buildLong() {
  const x = new Float32Array(SR * 4);
  const seg = vowel(180, SR * 4);
  x.set(seg);
  return x;
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

function buildGlide() {
  // 频率随时间线性下滑（150→300Hz），逼出逐帧变化的 F0 与 mark 间距
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

const SYNTH = [
  ['gap 有声/静音/有声', buildGap()],
  ['onsets 5 短音+间隙', buildOnsets()],
  ['long 4s 长音', buildLong()],
  ['glide 150→300Hz', buildGlide()],
  ['noise 纯噪声', buildNoise()],
];

console.log('\n【对抗性合成信号】跳变比（整段）  ——  恒等档=1.00 是理想值');
console.log('信号'.padEnd(24) + CONFIGS.map((c) => c.name.slice(0, 8).padStart(9)).join(''));
console.log('-'.repeat(24 + 9 * CONFIGS.length));
const synthRows = [];
for (const [label, x] of SYNTH) {
  const cells = [];
  const rec = { label, cfg: {} };
  for (const cfg of CONFIGS) {
    const out = txRun(x, cfg.pitch, cfg.time, cfg.mode, SR);
    if (!out) {
      cells.push('  --  '.padStart(9));
      continue;
    }
    const s = metrics(x, 1, x.length - 1);
    const o = metrics(out, 1, out.length - 1);
    const vs = s && o ? o.jump / s.jump : NaN;
    rec.cfg[cfg.name] = { vs, at: o?.at, hfVs: s && o ? o.hf / s.hf : NaN };
    cells.push((Number.isFinite(vs) ? vs.toFixed(2) : '--').padStart(9));
  }
  synthRows.push(rec);
  console.log(label.padEnd(24) + cells.join(''));
}

console.log('\n【合成信号】HF 比（>1.3 = 输出明显比源毛躁）');
console.log('信号'.padEnd(24) + CONFIGS.map((c) => c.name.slice(0, 8).padStart(9)).join(''));
console.log('-'.repeat(24 + 9 * CONFIGS.length));
for (const rec of synthRows) {
  const cells = CONFIGS.map((c) => {
    const v = rec.cfg[c.name]?.hfVs;
    return (Number.isFinite(v) ? v.toFixed(2) : '--').padStart(9);
  });
  console.log(rec.label.padEnd(24) + cells.join(''));
}

if (jsonOut) {
  writeFileSync(
    resolve(jsonOut),
    JSON.stringify({ wasmPath, rows, synth: synthRows }, null, 1),
    'utf8',
  );
  console.log(`\nJSON → ${resolve(jsonOut)}`);
}
console.log();
