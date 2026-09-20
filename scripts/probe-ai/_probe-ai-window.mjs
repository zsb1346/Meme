/**
 * 决定「AI 检测能不能缩短输入」与「结果聚合该用哪种口径」。
 *
 *   node scripts/probe-ai/_probe-ai-window.mjs [--limit N]
 *
 * 背景：`pitch-async.ts::sendToWorker` 固定传 **4 秒** PCM，而 basic-pitch 的模型
 * 窗口只有 2 秒（`AUDIO_N_SAMPLES = 22050*2 - 256`，`prepareData` 用
 * `tf.signal.frame(..., padEnd=true)`）。实测 CPU 后端 **1 批 ≈ 3.5~3.9s**：
 *   1s 输入 → 1 批 ≈ 3.8s
 *   4s 输入 → 3 批 ≈ 10.5~11.7s
 * 而 `pitch-async.ts::TIMEOUT_MS = 15000` —— 余量只有 1.3 倍，慢机器/浏览器开销
 * 一超就永远显示「未检出音高」。
 *
 * 所以这里回答三件事：
 *   ① 1s / 2s / 4s 三种输入长度，**结论是否一致**（不一致就不能缩短）；
 *   ② 同一份模型输出，三种聚合口径是否一致：
 *        - `amp`    生产代码现用：取 amplitude 最大的那个 note
 *        - `durMean` 探针旧用：时长加权平均音高
 *        - `durMed`  时长加权中位数
 *   ③ 有 YIN 可信值的素材上，AI 与 YIN 差多少音分（AI 跑偏了多少）。
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
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

const wasmPath = process.argv.includes('--wasm')
  ? resolve(process.argv[process.argv.indexOf('--wasm') + 1])
  : join(root, 'public', 'hajimi_audio.wasm');

// ---------------------------------------------------------------------------
// wasm 解码（同 _probe-material-detect.mjs）
// ---------------------------------------------------------------------------
const inst = await WebAssembly.instantiate(
  await WebAssembly.compile(readFileSync(wasmPath)),
  {
    env: {
      memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536 }),
      __memory_base: 0,
      __table_base: 0,
    },
  },
);
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

/**
 * 线性插值重采样 —— 与 `pitch-worker.ts::resampleToAi` **逐行一致**。
 * 一致性很重要：探针改了重采样而生产没改，探针结论就不代表线上行为。
 */
function resampleToAi(input, fromSr) {
  const to = 22050;
  if (fromSr === to) return input;
  const ratio = fromSr / to;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// basic-pitch
// ---------------------------------------------------------------------------
const modelJson = JSON.parse(readFileSync(join(root, 'public', 'model.json'), 'utf8'));
const bin = readFileSync(join(root, 'public', 'group1-shard1of1.bin'));
await tf.setBackend('cpu');
await tf.ready();
const bp = new BasicPitch(
  tf.loadGraphModel({
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs: modelJson.weightsManifest[0].weights,
      weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    }),
  }),
);

function midiToHz(m) {
  return 440 * 2 ** ((m - 69) / 12);
}
function cents(a, b) {
  return 1200 * Math.log2(a / b);
}

/** 跑一次模型，返回三种聚合口径的结果 + 耗时 + 批次数。 */
async function detectAi(mono, sr, seconds) {
  const maxSamples = Math.min(mono.length, Math.floor(sr * seconds));
  const pcm = resampleToAi(mono.subarray(0, maxSamples), sr);
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
  const ms = Date.now() - t0;
  if (!frames.length) return { ms, amp: null, durMean: null, durMed: null, notes: 0 };

  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)),
  );
  if (!notes.length) return { ms, amp: null, durMean: null, durMed: null, notes: 0 };

  // ① 生产代码口径：amplitude 最大的 note
  let best = notes[0];
  for (const n of notes) if ((n.amplitude ?? 0) > (best.amplitude ?? 0)) best = n;
  const amp = midiToHz(best.pitchMidi);

  // ② 时长加权平均（旧探针口径）
  let acc = 0;
  let tot = 0;
  for (const n of notes) {
    acc += n.pitchMidi * n.durationSeconds;
    tot += n.durationSeconds;
  }
  const durMean = tot > 0 ? midiToHz(acc / tot) : null;

  // ③ 时长加权中位数（对单个刺耳音头更稳）
  const sorted = [...notes].sort((a, b) => a.pitchMidi - b.pitchMidi);
  const half = tot / 2;
  let run = 0;
  let durMed = null;
  for (const n of sorted) {
    run += n.durationSeconds;
    if (run >= half) {
      durMed = midiToHz(n.pitchMidi);
      break;
    }
  }
  if (durMed == null) durMed = midiToHz(sorted[sorted.length - 1].pitchMidi);

  return { ms, amp, durMean, durMed, notes: notes.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const dir = join(root, '素材');
let files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();
if (Number.isFinite(limit)) files = files.slice(0, limit);

const LENGTHS = [1, 2, 4];

console.log(`\nbackend=${tf.getBackend()}  素材 ${files.length} 个  输入长度 ${LENGTHS.join('/')}s\n`);
console.log(
  '素材'.padEnd(16),
  '时长ms'.padStart(7),
  '1s(ms)'.padStart(7),
  '4s(ms)'.padStart(7),
  '1s结论Hz'.padStart(9),
  '4s结论Hz'.padStart(9),
  '长度差'.padStart(8),
  'amp vs durMed'.padStart(13),
  '  vs YIN',
);
console.log('-'.repeat(104));

const lenDiff = [];
const aggDiff = [];
const vsYin = [];
let t1 = 0;
let t4 = 0;

for (const f of files) {
  const d = decodeMono(new Uint8Array(readFileSync(join(dir, f))));
  if (!d) continue;

  const r1 = await detectAi(d.mono, d.sr, 1);
  const r4 = await detectAi(d.mono, d.sr, 4);
  t1 += r1.ms;
  t4 += r4.ms;

  const valid = (a, b) => a && b;
  const dl = valid(r1.amp, r4.amp) ? Math.abs(cents(r1.amp, r4.amp)) : NaN;
  const da = valid(r1.amp, r1.durMed) ? Math.abs(cents(r1.amp, r1.durMed)) : NaN;
  const dy = d.yinHz > 0 && r4.amp ? cents(r4.amp, d.yinHz) : NaN;

  if (Number.isFinite(dl)) lenDiff.push({ f, c: dl });
  if (Number.isFinite(da)) aggDiff.push({ f, c: da });
  if (Number.isFinite(dy)) vsYin.push({ f, c: dy });

  console.log(
    f.padEnd(16),
    d.ms.toFixed(0).padStart(7),
    String(r1.ms).padStart(7),
    String(r4.ms).padStart(7),
    (r1.amp ? r1.amp.toFixed(1) : '  --  ').padStart(9),
    (r4.amp ? r4.amp.toFixed(1) : '  --  ').padStart(9),
    (Number.isFinite(dl) ? `${dl.toFixed(0)}¢` : '  --  ').padStart(8),
    (Number.isFinite(da) ? `${da.toFixed(0)}¢` : '  --  ').padStart(13),
    Number.isFinite(dy)
      ? `  ${dy > 0 ? '+' : ''}${dy.toFixed(0)}¢`
      : d.yinHz > 0
        ? '  AI 无音符'
        : '  YIN 也漏',
  );
}

const med = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].map((x) => x.c).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const over = (arr, th) => arr.filter((x) => x.c > th).length;

console.log('-'.repeat(104));
console.log(`\n推理耗时：1s 输入合计 ${(t1 / 1000).toFixed(1)}s（均值 ${(t1 / files.length).toFixed(0)}ms）`);
console.log(`          4s 输入合计 ${(t4 / 1000).toFixed(1)}s（均值 ${(t4 / files.length).toFixed(0)}ms）`);
console.log(`          → 缩短到 1s 省 ${(t4 / t1).toFixed(2)} 倍时间`);

console.log(`\n① 输入长度 1s vs 4s 的音高差（${lenDiff.length} 个可比）：中位 ${med(lenDiff).toFixed(0)}¢，`
  + `>50¢ 有 ${over(lenDiff, 50)} 个，>100¢ 有 ${over(lenDiff, 100)} 个`);
if (over(lenDiff, 50) > 0) {
  console.log('   分歧清单：' + lenDiff.filter((x) => x.c > 50).map((x) => `${x.f}(${x.c.toFixed(0)}¢)`).join(' '));
}

console.log(`② 聚合口径 amp vs durMed（${aggDiff.length} 个可比）：中位 ${med(aggDiff).toFixed(0)}¢，`
  + `>50¢ 有 ${over(aggDiff, 50)} 个`);
if (over(aggDiff, 50) > 0) {
  console.log('   分歧清单：' + aggDiff.filter((x) => x.c > 50).map((x) => `${x.f}(${x.c.toFixed(0)}¢)`).join(' '));
}

const absCents = vsYin.map((x) => ({ f: x.f, c: Math.abs(x.c) }));
console.log(`③ AI(4s,amp) vs YIN（${absCents.length} 个双方都有值）：中位 ${med(absCents).toFixed(0)}¢，`
  + `>50¢ 有 ${over(absCents, 50)} 个`);
if (over(absCents, 50) > 0) {
  console.log('   分歧清单：' + absCents.filter((x) => x.c > 50).map((x) => `${x.f}(${x.c.toFixed(0)}¢)`).join(' '));
}
console.log();
