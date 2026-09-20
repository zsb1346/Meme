// 逐样本转储：定位输出里「源里没有的」不连续到底长什么样、在哪、多宽。
//
//   node scripts/_probe-dump.mjs [素材名] [pitch] [time] [mode]
//   例：node scripts/_probe-dump.mjs 高绿 1.0 1.4 1
//
// 打印：输出最后 15% 里所有 |Δ| > 3×中段RMS 的位置（连同前后 4 个样点），
// 以及该处的时间（毫秒）与相对于整段的位置。源同区间同样打印一份作对照。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = join(root, 'public', 'hajimi_audio.wasm');

const nameArg = process.argv[2] ?? '高绿';
const PITCH = Number(process.argv[3] ?? 1.0);
const TIME = Number(process.argv[4] ?? 1.4);
const MODE = Number(process.argv[5] ?? 1);

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

const dir = join(root, '素材');
const file = readdirSync(dir).find(
  (f) => f.toLowerCase().endsWith('.mp3') && f.replace('.mp3', '') === nameArg,
);
if (!file) {
  console.error(`找不到素材 ${nameArg}.mp3`);
  process.exit(2);
}
const buf = new Uint8Array(readFileSync(join(dir, file)));
const ptr = alloc(buf.length);
new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
const nch = ex.hajimi_decode(ptr, buf.length) | 0;
ex.hajimi_dealloc(ptr, buf.length);
if (nch <= 0) {
  console.error('解码失败');
  process.exit(2);
}
const N = ex.hajimi_decode_frames() | 0;
const SR = ex.hajimi_decode_sample_rate() | 0;
const mono = new Float32Array(N);
for (let c = 0; c < nch; c++) {
  const ch = new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, N));
  for (let i = 0; i < N; i++) mono[i] += ch[i] / nch;
}
ex.hajimi_decode_free();

const p = alloc(N * 4);
f32(p, N).set(mono);
const outF = ex.hajimi_tx_run(p, N, 1, PITCH, TIME, MODE, SR) | 0;
ex.hajimi_dealloc(p, N * 4);
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

console.log(`\n素材=${file}  ${(N / SR).toFixed(3)}s @${SR}Hz  marks=${marks} voicedFrames=${voiced}`);
console.log(`pitch=${PITCH.toFixed(4)} time=${TIME.toFixed(4)} mode=${MODE}`);
console.log(`源 ${N} 帧 → 输出 ${outF} 帧（期望 ${Math.round(N * TIME)}）\n`);

const midSrc = rms(mono, Math.floor(N * 0.45), Math.floor(N * 0.55));
const midOut = rms(out, Math.floor(outF * 0.45), Math.floor(outF * 0.55));
console.log(`源中段 RMS=${midSrc.toFixed(5)}   输出中段 RMS=${midOut.toFixed(5)}\n`);

function scan(x, mid, label, fromFrac) {
  const from = Math.floor(x.length * fromFrac);
  let n = 0;
  console.log(`── ${label}：最后 ${((1 - fromFrac) * 100).toFixed(0)}% 内 |Δ| > 3×中段RMS 的点 ──`);
  let worst = 0;
  let worstAt = -1;
  for (let i = Math.max(1, from); i < x.length; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d / mid > worst) {
      worst = d / mid;
      worstAt = i;
    }
    if (d > 3 * mid && n < 12) {
      const t = (i / SR) * 1000;
      console.log(
        `  i=${String(i).padStart(7)} (t=${t.toFixed(1)}ms, pos=${(i / x.length).toFixed(4)})` +
          `  Δ=${d.toFixed(5)} (${(d / mid).toFixed(1)}×mid)  ` +
          `x[i-1]=${x[i - 1].toFixed(5)} x[i]=${x[i].toFixed(5)}`,
      );
      n++;
    }
  }
  console.log(
    `  → 全程最大 |Δ|=${(worst * mid).toFixed(5)} (${worst.toFixed(1)}×mid) @ i=${worstAt} ` +
      `pos=${(worstAt / x.length).toFixed(4)} t=${((worstAt / SR) * 1000).toFixed(1)}ms`,
  );
  return { worst, worstAt };
}

scan(mono, midSrc, '源', 0.85);
console.log();
const r = scan(out, midOut, '输出', 0.85);

// ── 中段原始波形对照：能直接看出「每周期被门掉一段」这种包络缺陷 ──
console.log('\n── 中段 3 个周期长度的原始样点对照 ──');
const segFrom = Math.floor(outF * 0.5);
console.log('  输出:');
for (let i = 0; i < 3; i++) {
  const s = segFrom + i * 48;
  console.log(
    '   ' + Array.from(out.subarray(s, s + 48)).map((v) => v.toFixed(3).padStart(7)).join(''),
  );
}
const sFrom = Math.floor(N * 0.5);
console.log('  源:');
for (let i = 0; i < 3; i++) {
  const s = sFrom + i * 48;
  console.log(
    '   ' + Array.from(mono.subarray(s, s + 48)).map((v) => v.toFixed(3).padStart(7)).join(''),
  );
}

// ── 门控统计：输出里接近 0 的样点占比，以及它们的周期性 ──
const nearZero = (x, fromFrac) => {
  const from = Math.floor(x.length * fromFrac);
  let z = 0;
  let total = 0;
  for (let i = from; i < x.length; i++) {
    total++;
    if (Math.abs(x[i]) < 1e-7) z++;
  }
  return { z, total, frac: z / Math.max(1, total) };
};
const zs = nearZero(mono, 0.3);
const zo = nearZero(out, 0.3);
console.log(
  `\n── 精确 0 样点占比（后 70%）── 源 ${zs.z}/${zs.total} = ${(zs.frac * 100).toFixed(2)}%` +
    `   输出 ${zo.z}/${zo.total} = ${(zo.frac * 100).toFixed(2)}%`,
);
console.log();

