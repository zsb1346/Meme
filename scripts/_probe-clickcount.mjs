// 「咔哒计数」：输出里出现了多少个**离散发散点**，而不是单纯看最大跳变。
//
//   node scripts/_probe-clickcount.mjs
//
// 原理：正常带限音频的相邻样本差 |Δ| 有一个窄分布。真正的咔哒是**孤立**的
// 若干样本上 |Δ| 突然比中位数大很多倍。所以统计：
//
//   n8  = |Δ| >  8×median(|Δ|) 的样点数
//   n16 = |Δ| > 16×median(|Δ|) 的样点数
//   burst = 这些点聚成的簇个数（连续/近邻算一簇）→ 每个簇 ≈ 一声咔哒
//
// 源同类统计作为基线：输出 burst 明显多于源 = 合成器新增的咔哒。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const CONFIGS = [
  { name: '恒等', pitch: 1.0, time: 1.0, mode: 1 },
  { name: '+5', pitch: 2 ** (5 / 12), time: 1.0, mode: 1 },
  { name: '+7', pitch: 2 ** (7 / 12), time: 1.0, mode: 1 },
  { name: '+12', pitch: 2.0, time: 1.0, mode: 1 },
  { name: '-5', pitch: 2 ** (-5 / 12), time: 1.0, mode: 1 },
  { name: '-7', pitch: 2 ** (-7 / 12), time: 1.0, mode: 1 },
  { name: '-9', pitch: 2 ** (-9 / 12), time: 1.0, mode: 1 },
  { name: '-12', pitch: 0.5, time: 1.0, mode: 1 },
  { name: 'x1.40', pitch: 1.0, time: 1.4, mode: 1 },
  { name: 'x0.70', pitch: 1.0, time: 0.7, mode: 1 },
  { name: '+5&x1.4', pitch: 2 ** (5 / 12), time: 1.4, mode: 1 },
  { name: 'SOLA+5', pitch: 2 ** (5 / 12), time: 1.0, mode: 2 },
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
  for (let c = 0; c < nch; c++)
    chans.push(new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, frames)));
  ex.hajimi_decode_free();
  return { nch, frames, sr, chans };
}
function txRun(mono, pitch, time, mode, sr) {
  const n = mono.length;
  const ptr = alloc(n * 4);
  f32(ptr, n).set(mono);
  const outF = ex.hajimi_tx_run(ptr, n, 1, pitch, time, mode, sr) | 0;
  ex.hajimi_dealloc(ptr, n * 4);
  if (outF <= 0) return null;
  const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
  ex.hajimi_tx_free();
  return out;
}

/** 离散跳变统计。跳过首尾各 2%（边界本来就是切口，另有 envelope 处理）。 */
function disc(x) {
  const lo = Math.max(1, Math.floor(x.length * 0.02));
  const hi = Math.min(x.length, Math.ceil(x.length * 0.98));
  const ds = [];
  for (let i = lo; i < hi; i++) ds.push(Math.abs(x[i] - x[i - 1]));
  if (ds.length < 64) return null;
  const sorted = ds.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1] || 1e-12;
  const isBurst = (i) => ds[i] > 8 * med;
  const n8 = ds.filter((v) => v > 8 * med).length;
  const n16 = ds.filter((v) => v > 16 * med).length;
  // 簇：相邻（间隔 < 16 样本）算同一簇
  let bursts = 0;
  let last = -100;
  for (let i = 0; i < ds.length; i++) {
    if (!isBurst(i)) continue;
    if (i - last >= 16) bursts++;
    last = i;
  }
  return { med, n8, n16, bursts };
}

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

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
  const s = disc(mono);
  if (!s) continue;
  const row = { f, s, cfg: {} };
  for (const cfg of CONFIGS) {
    const out = txRun(mono, cfg.pitch, cfg.time, cfg.mode, dec.sr);
    row.cfg[cfg.name] = out ? disc(out) : null;
  }
  rows.push(row);
}

const med = (arr) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
};

console.log(`\nwasm = ${wasmPath.replace(root, '.')}`);
console.log('【咔哒簇计数】源 vs 输出（41 素材，跳过首尾 2%）\n');
console.log(
  '配置'.padEnd(10) +
    '源簇中位'.padStart(10) +
    '源簇最大'.padStart(10) +
    '出簇中位'.padStart(10) +
    '出簇最大'.padStart(10) +
    '增簇中位'.padStart(10) +
    '增簇最大'.padStart(10) +
    ' >源+3 个数'.padStart(11),
);
console.log('-'.repeat(84));
for (const cfg of CONFIGS) {
  const src = rows.map((r) => r.s.bursts);
  const out = rows.map((r) => r.cfg[cfg.name]?.bursts).filter((v) => v !== undefined);
  const delta = rows
    .map((r) => (r.cfg[cfg.name] ? r.cfg[cfg.name].bursts - r.s.bursts : undefined))
    .filter((v) => v !== undefined);
  console.log(
    cfg.name.padEnd(10) +
      String(med(src)).padStart(10) +
      String(Math.max(...src)).padStart(10) +
      String(med(out)).padStart(10) +
      String(Math.max(...out)).padStart(10) +
      String(med(delta)).padStart(10) +
      String(Math.max(...delta)).padStart(10) +
      String(delta.filter((v) => v > 3).length).padStart(11),
  );
}

console.log('\n输出簇数比源多 3 个以上的素材（列出全部）：');
for (const cfg of CONFIGS) {
  const bad = rows
    .filter((r) => r.cfg[cfg.name] && r.cfg[cfg.name].bursts - r.s.bursts > 3)
    .map((r) => `${r.f.replace('.mp3', '')}(源${r.s.bursts}→出${r.cfg[cfg.name].bursts})`);
  if (bad.length) console.log(`  ${cfg.name.padEnd(9)} ${bad.join(' ')}`);
}
console.log();
