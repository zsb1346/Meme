/**
 * 临时探针 2：量化 basic-pitch 推理耗时（冷启动 / 热启动 / 不同输入长度）。
 * 用来判断 pitch-async.ts 的 TIMEOUT_MS=15000 是否会误杀 AI 检测。
 * 用完即删。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs';
import { BasicPitch } from '@spotify/basic-pitch';

const root = process.cwd();
const modelJson = JSON.parse(fs.readFileSync(path.join(root, 'public/model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(root, 'public/group1-shard1of1.bin'));
const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const handler = {
  load: async () => ({
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest[0].weights,
    weightData,
  }),
};

await tf.setBackend('cpu');
await tf.ready();

const SR = 22050;
const AUDIO_N_SAMPLES = 22050 * 2 - 256; // 43844
const OVERLAP = 30 * 256; // 7680
const HOP = AUDIO_N_SAMPLES - OVERLAP; // 36164

function sine(sec) {
  const n = Math.round(SR * sec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return x;
}

function batches(sec) {
  const n = Math.round(SR * sec) + Math.floor(OVERLAP / 2);
  return Math.ceil(n / HOP);
}

const t0 = Date.now();
const bp = new BasicPitch(tf.loadGraphModel(handler));
await bp.model;
const modelLoadMs = Date.now() - t0;
console.log(`[timing] 模型加载(tf.loadGraphModel + 权重反序列化) = ${modelLoadMs} ms`);

for (const sec of [1, 2, 4, 4]) {
  const pcm = sine(sec);
  const t = Date.now();
  await bp.evaluateModel(pcm, () => {}, () => {});
  const ms = Date.now() - t;
  console.log(
    `[timing] 输入 ${sec.toFixed(1)}s  -> ${batches(sec)} 个模型批次  -> ${ms} ms  (${(ms / batches(sec)).toFixed(0)} ms/批次)`,
  );
}

console.log(
  '\n[timing] pitch-async.ts TIMEOUT_MS = 15000 —— 上面任何一次超过它，UI 就会走 reject 分支显示「未检出音高」。',
);
