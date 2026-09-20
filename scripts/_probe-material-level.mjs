// 真素材电平体检：各档变调下 PSOLA 输出的中段 RMS 比（输出/源）。
//
//   node scripts/_probe-material-level.mjs [wasm路径]
//
// 为什么单独量这个：psola.rs 模块头记录了一个**已知极限** —— 颗粒按 period/ratio
// 排放，大幅变调时重叠部分可能相干抵消，输出会变薄（+12 半音在严格周期的合成信号上
// 能塌到近静音）。但那条记录同时强调：**真实素材介于两个极端之间，必须实测**。
//
// 鬼畜调教常用 ±5~±12 半音，正好压在需要实测的区间上，所以这里用 41 个真素材把
// 每个档位的电平比跑出来。判读：
//   ~1.00  → 电平无损（局部增益匹配生效）
//   < 0.70 → 听感会明显变薄，需要在此档位考虑换算法（SOLA / 重采样式变调）
//
// 同时给出质心比作参考：PSOLA 保共振峰 → 质心比明显小于 pitch 比；
// 若某素材质心比 ≈ pitch 比，说明它走的是固定颗粒路径（无周期可同步）。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, 'public', 'hajimi_audio.wasm');

const SHIFTS = [5, 7, 12, -5, -7, -12];

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

function txRun(mono, pitch, mode, sr) {
  const frames = mono.length;
  const ptr = alloc(frames * 4);
  f32(ptr, frames).set(mono);
  const outF = ex.hajimi_tx_run(ptr, frames, 1, pitch, 1.0, mode, sr) | 0;
  ex.hajimi_dealloc(ptr, frames * 4);
  if (outF <= 0) return null;
  const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
  ex.hajimi_tx_free();
  return out;
}

const rms = (x, from, len) => {
  const lo = Math.max(0, from);
  const hi = Math.min(x.length, lo + len);
  let s = 0;
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, hi - lo));
};

function centroid(x, from, len, sr) {
  const N = 1024;
  const lo = Math.max(0, from);
  if (lo + N > x.length) return NaN;
  let num = 0;
  let den = 0;
  for (let k = 2; k < 258; k++) {
    const w = (2 * Math.PI * k) / N;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const s0 = x[lo + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    num += ((k * sr) / N) * p;
    den += p;
  }
  return den > 0 ? num / den : NaN;
}

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nwasm = ${wasmPath.replace(root, '.')}`);
console.log('真素材电平体检：中段 RMS(输出)/RMS(源)，mode=1(PSOLA)，time=1\n');

const stats = new Map(SHIFTS.map((s) => [s, []]));
const rows = [];

for (const f of files) {
  const dec = decodeMp3(new Uint8Array(readFileSync(join(dir, f))));
  if (!dec) continue;
  const n = dec.frames;
  const mono = new Float32Array(n);
  for (const c of dec.chans) for (let i = 0; i < n; i++) mono[i] += c[i] / dec.chans.length;
  if (rms(mono, 0, n) < 1e-4) continue;

  // 中段 30%，避开起音/收尾
  const from = Math.floor(n * 0.35);
  const len = Math.floor(n * 0.3);
  const ref = rms(mono, from, len);
  const c0 = centroid(mono, from, len, dec.sr);
  const row = { f, levels: {}, centroids: {} };

  for (const s of SHIFTS) {
    const pitch = 2 ** (s / 12);
    const out = txRun(mono, pitch, 1, dec.sr);
    if (!out) {
      row.levels[s] = NaN;
      continue;
    }
    // 输出时间轴与源时间轴对齐（time=1），同一区间可直接比
    const lv = ref > 0 ? rms(out, from, len) / ref : NaN;
    row.levels[s] = lv;
    const c = centroid(out, from, len, dec.sr);
    row.centroids[s] = c0 > 0 && Number.isFinite(c) ? c / c0 : NaN;
    stats.get(s).push({ f, lv });
  }
  rows.push(row);
}

// ---- 汇总 ----
console.log('档位'.padEnd(8), '中位'.padStart(7), '最差'.padStart(7), '<0.70 个数'.padStart(10), '质心比中位'.padStart(11), '  pitch比');
console.log('-'.repeat(72));
for (const s of SHIFTS) {
  const arr = stats.get(s).filter((r) => Number.isFinite(r.lv));
  if (!arr.length) continue;
  const sorted = [...arr].sort((a, b) => a.lv - b.lv);
  const med = sorted[Math.floor(sorted.length / 2)].lv;
  const worst = sorted[0];
  const thin = sorted.filter((r) => r.lv < 0.7).length;
  const cArr = rows
    .map((r) => r.centroids[s])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const cMed = cArr.length ? cArr[Math.floor(cArr.length / 2)] : NaN;
  console.log(
    `${s > 0 ? '+' : ''}${s}半音`.padEnd(8),
    med.toFixed(3).padStart(7),
    worst.lv.toFixed(3).padStart(7),
    String(thin).padStart(10),
    (Number.isFinite(cMed) ? cMed.toFixed(3) : '  --  ').padStart(11),
    `  ${(2 ** (s / 12)).toFixed(3)}`,
  );
}

// ---- 最薄清单 ----
console.log('\n每个档位最薄的 5 个素材：');
for (const s of SHIFTS) {
  const arr = stats.get(s)
    .filter((r) => Number.isFinite(r.lv))
    .sort((a, b) => a.lv - b.lv)
    .slice(0, 5);
  console.log(
    `  ${(s > 0 ? '+' : '') + s}半音：` + arr.map((r) => `${r.f.replace('.mp3', '')} ${r.lv.toFixed(2)}`).join('  '),
  );
}
console.log();
