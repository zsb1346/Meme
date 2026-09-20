// 尾部不连续的机制验证：源缓冲「跑完」时，颗粒读越界被整颗丢弃
// （连窗权重一起丢），env 塌陷 → 输出被 MIN_ENVELOPE 门硬切到 0 → 咔哒。
//
// 验法：把同一段素材**补零**后再过同一个 wasm 入口。
// 补零后越界读变成「读 0 但照旧累加窗权重」→ env 不塌 → 输出平滑淡出。
// 若补零后跳变比明显下降，机制成立，且修法就是把源缓冲按 grain_pad 补零。
//
//   node scripts/_probe-tail.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

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

/** 中段平均值，用于判断「尾部是否被整段削掉」 */
function levels(x) {
  const n = x.length;
  const seg = Math.max(1, Math.floor(n * 0.1));
  const rms = (a, b) => {
    const lo = Math.max(0, a);
    const hi = Math.min(n, b);
    if (hi <= lo) return 0;
    let s = 0;
    for (let i = lo; i < hi; i++) s += x[i] * x[i];
    return Math.sqrt(s / (hi - lo));
  };
  const mid = rms(Math.floor(n * 0.45), Math.floor(n * 0.55));
  const tail = [
    rms(n - Math.round(n * 0.02), n),
    rms(n - Math.round(n * 0.05), n - Math.round(n * 0.02)),
    rms(n - Math.round(n * 0.1), n - Math.round(n * 0.05)),
  ];
  // 尾部逐样本最大跳变
  let dmax = 0;
  let at = 0;
  for (let i = n - Math.round(n * 0.1); i < n; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > dmax) {
      dmax = d;
      at = i;
    }
  }
  return { mid, tail, dmax, at, n };
}

const PAD = 4096; // grain_pad(48000) = 3840，取 4096 大于它
function padTail(x, pad) {
  const y = new Float32Array(x.length + pad);
  y.set(x, 0);
  return y;
}
function padBoth(x, pad) {
  const y = new Float32Array(x.length + 2 * pad);
  y.set(x, pad);
  return y;
}

const CONFIGS = [
  { name: '恒等 1.00/1.00', pitch: 1.0, time: 1.0 },
  { name: '变调 +5', pitch: 2 ** (5 / 12), time: 1.0 },
  { name: '变速 1.40x', pitch: 1.0, time: 1.4 },
  { name: '+5 & 1.40x', pitch: 2 ** (5 / 12), time: 1.4 },
];

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log('\n尾部不连续：原样 vs 源缓冲补零（机制验证）');
console.log('跳变比 = 尾部 10% 内 max|Δ| / 全段 RMS；「尾部电平」= 最后 2% RMS / 中段 RMS');
console.log('补零版输出按**同一时间轴**截到与原版等长后再比 —— 否则量到的是补零区的静音。\n');

const dirs = [];
for (const cfg of CONFIGS) {
  console.log(`\n─── ${cfg.name} ───`);
  console.log(
    '  素材'.padEnd(16) +
      '原样跳变比'.padStart(11) +
      '补零后'.padStart(9) +
      '改善'.padStart(8) +
      '原样尾部电平'.padStart(13) +
      '补零后'.padStart(9),
  );
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

    const raw = txRun(mono, cfg.pitch, cfg.time, 1, dec.sr);
    const paddedFull = txRun(padTail(mono, PAD), cfg.pitch, cfg.time, 1, dec.sr);
    if (!raw || !paddedFull) continue;
    // 对齐时间轴：补零只影响「源读越界」的那几颗颗粒，输出前缀逐样本可比
    const padded = paddedFull.subarray(0, raw.length);

    const L = levels(raw);
    const Lp = levels(padded);

    const jr = L.dmax / L.mid;
    const jp = Lp.dmax / Lp.mid;
    const imp = jr > 0 ? jp / jr : NaN;
    const tailRatio = L.tail[0] / L.mid;
    const tailRatioP = Lp.tail[0] / Lp.mid;

    dirs.push({ f, cfg: cfg.name, jr, jp, imp, tailRatio, tailRatioP });
    if (imp < 0.75 || jr > 1.3) {
      console.log(
        `  ${f.replace('.mp3', '').slice(0, 14)}`.padEnd(16) +
          jr.toFixed(2).padStart(11) +
          jp.toFixed(2).padStart(9) +
          imp.toFixed(2).padStart(8) +
          tailRatio.toFixed(3).padStart(13) +
          tailRatioP.toFixed(3).padStart(9),
      );
    }
  }
}

console.log('\n\n== 汇总：补零后的改善比例（<1 = 补零让尾部更干净）==');
for (const cfg of CONFIGS) {
  const arr = dirs.filter((d) => d.cfg === cfg.name && Number.isFinite(d.imp));
  const sorted = arr.map((d) => d.imp).sort((a, b) => a - b);
  if (!sorted.length) continue;
  const med = sorted[sorted.length >> 1];
  console.log(
    `  ${cfg.name.padEnd(12)} 中位 ${med.toFixed(2)}  最好 ${sorted[0].toFixed(2)}  ` +
      `被改善( <0.9 ) ${sorted.filter((v) => v < 0.9).length}/${arr.length}  ` +
      `被恶化( >1.1 ) ${sorted.filter((v) => v > 1.1).length}`,
  );
}

console.log('\n== 尾部电平比（最后 2% RMS / 中段 RMS）—— 越接近 0 说明尾部被削 ==');
for (const cfg of CONFIGS) {
  const arr = dirs.filter((d) => d.cfg === cfg.name);
  const raw = arr.map((d) => d.tailRatio).sort((a, b) => a - b);
  const pad = arr.map((d) => d.tailRatioP).sort((a, b) => a - b);
  if (!raw.length) continue;
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(
    `  ${cfg.name.padEnd(12)} 原样 p10/p50/p90 = ${q(raw, 0.1).toFixed(3)}/${q(raw, 0.5).toFixed(3)}/${q(raw, 0.9).toFixed(3)}` +
      `   补零 = ${q(pad, 0.1).toFixed(3)}/${q(pad, 0.5).toFixed(3)}/${q(pad, 0.9).toFixed(3)}`,
  );
}
console.log();
