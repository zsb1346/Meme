/**
 * 决定性实验：项目自带的神经检测器（basic-pitch）能否救回 YIN 漏检的素材。
 *
 *   node scripts/probe-ai/_probe-ai-material.mjs
 *
 * 背景：真素材上 `hajimi_detect_pitch`（YIN）漏检 14/41，PSOLA 内部逐帧 YIN 在
 * 13/41 上取不到 pitch mark。两者是同一批短切片/带音效素材。PitchNet 之所以稳，
 * 用的是神经 F0（RMVPE/FCPE）。本项目已经装了 basic-pitch（同样是神经检测），
 * 但那条链坏着。这个探针只回答一件事：**换成神经检测，漏检会消失吗？**
 *
 * 解码用项目自己的 wasm（symphonia，原生采样率），再线性重采样到 22050 喂模型。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as tf from '@tensorflow/tfjs';
import {
  BasicPitch,
  outputToNotesPoly,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
} from '@spotify/basic-pitch';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

// ---------------------------------------------------------------------------
// wasm 解码（同 scripts/_probe-material-detect.mjs）
// ---------------------------------------------------------------------------
const wasmBytes = readFileSync(join(root, 'public', 'hajimi_audio.wasm'));
const inst = await WebAssembly.instantiate(await WebAssembly.compile(wasmBytes), {
  env: {
    memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536 }),
    __memory_base: 0,
    __table_base: 0,
  },
});
const ex = inst.exports;
const memory = ex.memory;

function decodeMono(buf) {
  const ptr = ex.hajimi_alloc(buf.length) >>> 0;
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  ex.hajimi_dealloc(ptr, buf.length);
  if (nch <= 0) return null;
  const frames = ex.hajimi_decode_frames() | 0;
  const sr = ex.hajimi_decode_sample_rate() | 0;
  const yinHz = ex.hajimi_detect_pitch();
  const mono = new Float32Array(frames);
  for (let c = 0; c < nch; c++) {
    const cp = ex.hajimi_decode_channel_ptr(c) >>> 0;
    const ch = new Float32Array(memory.buffer, cp, frames);
    for (let i = 0; i < frames; i++) mono[i] += ch[i] / nch;
  }
  ex.hajimi_decode_free();
  return { mono, sr, yinHz, ms: (frames / sr) * 1000 };
}

/** 线性插值重采样（仅用于喂检测模型）。 */
function resampleTo(x, from, to) {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    y[i] = a * (1 - f) + b * f;
  }
  return y;
}

// ---------------------------------------------------------------------------
// basic-pitch
// ---------------------------------------------------------------------------
const modelJson = JSON.parse(readFileSync(join(root, 'public/model.json'), 'utf8'));
const bin = readFileSync(join(root, 'public/group1-shard1of1.bin'));
const artifacts = {
  modelTopology: modelJson.modelTopology,
  weightSpecs: modelJson.weightsManifest[0].weights,
  weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
  format: 'graph-model',
  generatedBy: modelJson.generatedBy,
  convertedBy: modelJson.convertedBy,
};
await tf.setBackend('cpu');
await tf.ready();
const bp = new BasicPitch(tf.loadGraphModel({ load: async () => artifacts }));

const SR = 22050;

/** 神经检测：跑模型 → 音符事件 → 用「时长加权」的音高当作整体基频。 */
async function neuralPitch(mono, sr) {
  const pcm = resampleTo(mono, sr, SR);
  const frames = [];
  const onsets = [];
  const contours = [];
  const t0 = Date.now();
  await bp.evaluateModel(
    pcm,
    (f, o, c) => {
      for (const v of f) frames.push(v);
      for (const v of o) onsets.push(v);
      for (const v of c) contours.push(v);
    },
    () => {},
  );
  const inferMs = Date.now() - t0;
  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)),
  );
  if (!notes.length) return { hz: 0, inferMs, notes: 0 };
  // 时长加权中位数：鬼畜切片里常有一声主音 + 一点尾巴，取"占时间最多"的那个音
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  let acc = 0;
  let total = 0;
  for (const n of sorted) {
    acc += n.pitchMidi * n.durationSeconds;
    total += n.durationSeconds;
  }
  const midi = acc / total;
  return { hz: 440 * 2 ** ((midi - 69) / 12), inferMs, notes: notes.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nbackend=${tf.getBackend()}  basic-pitch 模型已加载\n`);
console.log('素材'.padEnd(16), '时长ms'.padStart(7), 'YIN(Hs)'.padStart(9), '神经(Hz)'.padStart(9), '推理ms'.padStart(8), '  结论');
console.log('-'.repeat(84));

let yinMiss = 0;
let yinMissRescued = 0;
let bothOk = 0;
let neuralMiss = 0;
let totalMs = 0;

for (const f of files) {
  const d = decodeMono(new Uint8Array(readFileSync(join(dir, f))));
  if (!d) continue;
  const n = await neuralPitch(d.mono, d.sr);
  totalMs += n.inferMs;

  const yinBad = !(d.yinHz > 0);
  const neuBad = !(n.hz > 0);
  if (yinBad) yinMiss++;
  if (yinBad && !neuBad) yinMissRescued++;
  if (neuBad) neuralMiss++;
  if (!yinBad && !neuBad) bothOk++;

  const verdict = yinBad
    ? neuBad
      ? '  两者都漏'
      : '  OK 神经救回'
    : neuBad
      ? ' 神经反而漏'
      : '  两者都ok';

  console.log(
    f.padEnd(16),
    d.ms.toFixed(0).padStart(7),
    (d.yinHz > 0 ? d.yinHz.toFixed(1) : '  --  ').padStart(9),
    (n.hz > 0 ? n.hz.toFixed(1) : '  --  ').padStart(9),
    String(n.inferMs).padStart(8),
    verdict,
  );
}

console.log('-'.repeat(84));
console.log(`\nYIN 漏检            : ${yinMiss}/${files.length}`);
console.log(`其中被神经检测救回  : ${yinMissRescued}/${yinMiss}`);
console.log(`神经检测漏检        : ${neuralMiss}/${files.length}`);
console.log(`两者都成功          : ${bothOk}/${files.length}`);
console.log(`\nCPU 后端推理总耗时  : ${(totalMs / 1000).toFixed(1)}s（${files.length} 个文件，平均 ${(totalMs / files.length).toFixed(0)}ms/个）`);
console.log(`前端超时（pitch-async.ts TIMEOUT_MS）= 15000ms\n`);
