// 局部增益匹配（psola::apply_local_gain_match）的剖面体检。
//
//   node scripts/_probe-gain.mjs
//
// 机制回顾（照搬 PitchNet）：逐输出帧算 gain = clamp(RMS(源该帧) / RMS(合成该帧), 0.25, 4.0)，
// 再对 gain 做 ±2 帧平滑，最后逐样本乘上去。它在**Σw 归一之后**作用，且**没有输出上限**。
//
// 三个要看的量（只用 time=1 的配置，输出与源时间轴严格对齐，逐帧比才成立）：
//   ratio = RMS(输出帧)/RMS(源帧)。gain 生效且未触限时应当 ≈ 1.0。
//   触到 4.0 上限的帧 = 该处合成比源薄 12dB 以上，被硬拽上来 —— 这里最容易把残渣放大。
//   触到 0.25 下限的帧 = 该处合成比源厚 12dB 以上，被硬压下去。
//   peakBump = 输出整段峰值 / 源整段峰值。> 1.0 就是「变调把素材推过了满刻度」。

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

const HOP = 480; // psola::HOP
const rms = (x, a, b) => {
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  if (hi <= lo) return 0;
  let s = 0;
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return Math.sqrt(s / (hi - lo));
};
const peak = (x) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
};

const SHIFTS = [5, 7, 12, -5, -7, -12];
const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log('\n局部增益匹配剖面（time=1，逐 10ms 帧对齐）');
console.log('ratio=RMS(输出帧)/RMS(源帧)；卡上限/下限 = 触到 4.0 / 0.25 的帧数\n');

const agg = new Map(SHIFTS.map((s) => [s, { ratios: [], hi: 0, lo: 0, frames: 0, bump: [], clips: 0 }]));
const detail = [];

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
  const srcPeak = peak(mono);

  for (const s of SHIFTS) {
    const pitch = 2 ** (s / 12);
    const out = txRun(mono, pitch, 1, dec.sr);
    if (!out) continue;
    const nf = Math.floor(Math.min(mono.length, out.length) / HOP);
    const ratios = [];
    let hi = 0;
    let lo = 0;
    for (let k = 0; k < nf; k++) {
      const a = rms(mono, k * HOP, (k + 1) * HOP);
      const b = rms(out, k * HOP, (k + 1) * HOP);
      if (a < 1e-6 || b < 1e-6) continue;
      const r = b / a;
      ratios.push(r);
      if (r > 3.5) hi++;
      if (r < 0.3) lo++;
    }
    if (!ratios.length) continue;
    const sorted = ratios.slice().sort((a, b) => a - b);
    const a = agg.get(s);
    a.ratios.push(...ratios);
    a.hi += hi;
    a.lo += lo;
    a.frames += ratios.length;
    const bump = peak(out) / srcPeak;
    a.bump.push(bump);
    if (bump > 1.0) a.clips++;
    detail.push({ f, s, max: sorted[sorted.length - 1], min: sorted[0], hi, lo, bump, frames: ratios.length });
  }
}

console.log(
  '半音'.padStart(5) +
    '帧数'.padStart(8) +
    'ratio p50'.padStart(11) +
    'p99'.padStart(7) +
    'max'.padStart(8) +
    'min'.padStart(8) +
    '卡4.0'.padStart(7) +
    '卡0.25'.padStart(8) +
    '峰增中位'.padStart(10) +
    '峰增max'.padStart(9) +
    '峰>1'.padStart(7),
);
console.log('-'.repeat(90));
for (const s of SHIFTS) {
  const a = agg.get(s);
  if (!a.ratios.length) continue;
  const sorted = a.ratios.slice().sort((x, y) => x - y);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const bumps = a.bump.slice().sort((x, y) => x - y);
  console.log(
    `${s > 0 ? '+' : ''}${s}`.padStart(5) +
      String(a.frames).padStart(8) +
      q(0.5).toFixed(3).padStart(11) +
      q(0.99).toFixed(3).padStart(7) +
      sorted[sorted.length - 1].toFixed(2).padStart(8) +
      sorted[0].toFixed(3).padStart(8) +
      String(a.hi).padStart(7) +
      String(a.lo).padStart(8) +
      bumps[bumps.length >> 1].toFixed(3).padStart(10) +
      bumps[bumps.length - 1].toFixed(3).padStart(9) +
      `${a.clips}/${a.bump.length}`.padStart(7),
  );
}

console.log('\n峰值增量最大的 15 条（输出峰值 / 源峰值）：');
detail.sort((x, y) => y.bump - x.bump);
console.log('  素材'.padEnd(14) + '半音'.padStart(6) + '峰增'.padStart(8) + 'ratio max'.padStart(11) + '卡4.0'.padStart(7));
for (const d of detail.slice(0, 15)) {
  console.log(
    `  ${d.f.replace('.mp3', '').slice(0, 12)}`.padEnd(14) +
      `${d.s > 0 ? '+' : ''}${d.s}`.padStart(6) +
      d.bump.toFixed(3).padStart(8) +
      d.max.toFixed(2).padStart(11) +
      String(d.hi).padStart(7),
  );
}

console.log('\nratio 偏离 1.0 最远（合成与源电平最不匹配）的 15 条：');
const byDev = [...detail].sort(
  (a, b) => Math.max(b.max, 1 / b.min) - Math.max(a.max, 1 / a.min),
);
for (const d of byDev.slice(0, 15)) {
  console.log(
    `  ${d.f.replace('.mp3', '').slice(0, 12)}`.padEnd(14) +
      `${d.s > 0 ? '+' : ''}${d.s}`.padStart(6) +
      `  min=${d.min.toFixed(3)} max=${d.max.toFixed(2)}`.padEnd(26) +
      `卡4.0=${d.hi} 卡0.25=${d.lo}`,
  );
}
console.log();
