/**
 * 探针：列出 public/hajimi_audio.wasm 的导出，确认新入口已经进产物。
 *
 * 为什么需要它：`cargo test` 编的是 host target（.exe），不是 wasm32 产物 ——
 * 「测试全绿」并不代表 `public/*.wasm` 是新的（这个坑踩过一次，
 * 见 .workbuddy/memory/MEMORY.md）。验收 wasm 侧改动前先跑这个。
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../public/hajimi_audio.wasm');

const st = statSync(wasmPath);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const names = Object.keys(instance.exports).sort();

console.log(`wasm: ${wasmPath}`);
console.log(`mtime: ${st.mtime.toISOString()}  size: ${(st.size / 1024).toFixed(1)} KB`);
console.log(`exports (${names.length}):`);
for (const n of names) console.log(`  ${n}`);

const want = ['hajimi_yin_f32', 'hajimi_detect_pitch'];
let ok = true;
for (const w of want) {
  const has = names.includes(w);
  if (!has) ok = false;
  console.log(`[${has ? 'OK' : 'MISSING'}] ${w}`);
}

// 顺带冒烟：220Hz 正弦 @48k，1 秒，阈值/范围传 0（用 Rust 默认）
const sr = 48000;
const n = sr;
const ptr = instance.exports.hajimi_alloc(n * 4 + 4) >>> 0;
const aligned = (ptr + 3) & ~3;
const view = new Float32Array(instance.exports.memory.buffer, aligned, n);
for (let i = 0; i < n; i++) view[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
const hz = instance.exports.hajimi_yin_f32(aligned, n, sr, 0, 0, 0);
console.log(`smoke: 220Hz sine -> ${hz.toFixed(2)} Hz  (未检出为 0)`);

console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
