// PSOLA 渲染耗时定位：区分「YIN 音高轨迹」与「颗粒合成」各自的成本。
//
//   node scripts/_perf-psola.mjs <wasm路径>
//
// mode=1 = PSOLA（每帧跑一次 YIN，max_tau=960，差分函数 O(win·max_tau)）
// mode=2 = SOLA（完全不跑 YIN）
// 两者之差就是 YIN 轨迹+marks 的净成本。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SR = 48000;
const wasmPath = resolve(process.argv[2] ?? 'public/hajimi_audio.wasm');
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const mem = () => ex.memory.buffer;

function makeVowel(f0, seconds) {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  for (let k = 1; k * f0 < SR * 0.45; k++) {
    const f = k * f0;
    const a = 1 / (k * k) * (1 / (1 + (f / 4000) ** 1.6));
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / SR + k);
  }
  return x;
}

function txRun(input, pitch, time, mode) {
  const frames = input.length;
  const ptr = ex.hajimi_alloc(frames * 4) >>> 0;
  new Float32Array(mem(), ptr, frames).set(input);
  const t0 = performance.now();
  const outF = ex.hajimi_tx_run(ptr, frames, 1, pitch, time, mode, SR) | 0;
  const ms = performance.now() - t0;
  if (outF > 0) ex.hajimi_tx_free();
  ex.hajimi_dealloc(ptr, frames * 4);
  return ms;
}

console.log(`\nwasm = ${wasmPath}`);
console.log('素材s  mode1(PSOLA)  mode2(SOLA)  差=YIN净成本   mode1 每秒音频');
console.log('-'.repeat(72));
for (const secs of [5, 15]) {
  const x = makeVowel(180, secs);
  // 注意：pitch=time=1 会走 apply_planar 的逐样本拷贝短路，测不到任何 DSP。
  // 必须用非恒等比例，否则量到的是 memcpy。
  const m1 = Math.min(txRun(x, 1.5, 1.0, 1), txRun(x, 1.5, 1.2, 1));
  const m2 = Math.min(txRun(x, 1.5, 1.0, 2), txRun(x, 1.5, 1.2, 2));
  console.log(
    String(secs).padStart(5) +
      `${m1.toFixed(0)} ms`.padStart(13) +
      `${m2.toFixed(0)} ms`.padStart(12) +
      `${(m1 - m2).toFixed(0)} ms`.padStart(14) +
      `${((m1 / secs) * 1000 / 1000).toFixed(0)} ms/s`.padStart(16),
  );
}

// hajimi_detect_pitch：对 4 秒素材跑一次「帧级」YIN（内部是 4 秒全长的整体检测）
{
  const x = makeVowel(180, 4);
  const frames = x.length;
  const ptr = ex.hajimi_alloc(frames * 4) >>> 0;
  new Float32Array(mem(), ptr, frames).set(x);
  const t0 = performance.now();
  ex.hajimi_tx_run(ptr, frames, 1, 1.0, 1.0, 2, SR);
  const ms = performance.now() - t0;
  console.log(`\n（参照）4s 素材 mode=2 纯 SOLA 端到端：${ms.toFixed(0)} ms`);
  ex.hajimi_dealloc(ptr, frames * 4);
}
console.log();
