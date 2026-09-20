// 量化 detectedPitchHz 的未检出率 —— 自动修音（autoTuneEnabled）失效的直接原因。
//
//   node scripts/_probe-material-detect.mjs [wasm路径]
//
// 链路：导入素材 → audio-worker → wasmDecode → hajimi_detect_pitch（yin::detect_pitch）
//       → store.detectedPitchHz
//       → sampleSemitonesAtPitch(sample, ev.pitch)：detectedPitchHz 为 null 时
//         **直接退回 manualSemitoneOffset**（默认 0）→ 自动修音静默无效。
//
// 所以这里只问一个问题：41 个真素材里，有多少个检测结果为 0（未检出）。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, 'public', 'hajimi_audio.wasm');

const bytes = readFileSync(wasmPath);
const mod = await WebAssembly.compile(bytes);
const inst = await WebAssembly.instantiate(mod, {
  env: {
    memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536 }),
    __memory_base: 0,
    __table_base: 0,
  },
});
const ex = inst.exports;
const memory = ex.memory;
const alloc = (n) => ex.hajimi_alloc(n) >>> 0;

function detect(buf) {
  const ptr = alloc(buf.length);
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  ex.hajimi_dealloc(ptr, buf.length);
  if (nch <= 0) return { ok: false };
  const hz = ex.hajimi_detect_pitch();
  const frames = ex.hajimi_decode_frames() | 0;
  const sr = ex.hajimi_decode_sample_rate() | 0;
  ex.hajimi_decode_free();
  return { ok: true, hz, frames, sr, nch };
}

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nwasm = ${wasmPath.replace(root, '.')}\nhajimi_detect_pitch（= store.detectedPitchHz 的来源）在真素材上的结果\n`);
console.log('素材'.padEnd(16), '时长ms'.padStart(7), '声道'.padStart(4), '  检测 Hz / 未检出');
console.log('-'.repeat(60));

let miss = 0;
const missList = [];
for (const f of files) {
  const r = detect(new Uint8Array(readFileSync(join(dir, f))));
  if (!r.ok) {
    console.log(f.padEnd(16), '       解码失败');
    continue;
  }
  const ms = (r.frames / r.sr) * 1000;
  if (r.hz > 0) {
    console.log(
      f.padEnd(16),
      ms.toFixed(0).padStart(7),
      String(r.nch).padStart(4),
      `  ${r.hz.toFixed(1)} Hz`,
    );
  } else {
    miss++;
    missList.push(f);
    console.log(
      f.padEnd(16),
      ms.toFixed(0).padStart(7),
      String(r.nch).padStart(4),
      '  ✘ 未检出 → detectedPitchHz = null',
    );
  }
}

console.log('-'.repeat(60));
console.log(`\n未检出 ${miss}/${files.length}  → 这些素材上「自动修音」开关按下去不会有任何效果`);
if (missList.length) console.log(`\n清单：\n  ${missList.join('\n  ')}`);
console.log();
