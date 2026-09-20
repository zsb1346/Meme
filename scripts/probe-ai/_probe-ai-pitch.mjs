/**
 * 临时探针：离线验证 basic-pitch 模型 + 后处理链路是否可用。
 * 直接读 public/model.json / group1-shard1of1.bin 构造 IOHandler，绕过网络。
 * 用完即删。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs';
import {
  BasicPitch,
  outputToNotesPoly,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
} from '@spotify/basic-pitch';

const root = process.cwd();
const modelJson = JSON.parse(fs.readFileSync(path.join(root, 'public/model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(root, 'public/group1-shard1of1.bin'));
const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

const artifacts = {
  modelTopology: modelJson.modelTopology,
  weightSpecs: modelJson.weightsManifest[0].weights,
  weightData,
  format: 'graph-model',
  generatedBy: modelJson.generatedBy,
  convertedBy: modelJson.convertedBy,
};
const handler = { load: async () => artifacts };

await tf.setBackend('cpu');
await tf.ready();
console.log('[probe] backend =', tf.getBackend());

const loaded = tf.loadGraphModel(handler);
const bp = new BasicPitch(loaded);

const SR = 22050;

function sine(freq, durSec, amp = 0.6) {
  const n = Math.round(SR * durSec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

async function run(label, pcm) {
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
  console.log(
    `[probe] ${label}: ${(pcm.length / SR).toFixed(2)}s  audio -> frames=${frames.length}x${frames[0]?.length} onsets=${onsets.length}x${onsets[0]?.length} contours=${contours.length}x${contours[0]?.length}  (${ms}ms)`,
  );
  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)),
  );
  console.log(`[probe] ${label}: notes=${notes.length}`);
  for (const n of notes.slice(0, 6)) {
    const hz = 440 * Math.pow(2, (n.pitchMidi - 69) / 12);
    console.log(
      `         midi=${n.pitchMidi} hz=${hz.toFixed(1)} t=${n.startTimeSeconds.toFixed(2)}..${(n.startTimeSeconds + n.durationSeconds).toFixed(2)} amp=${(n.amplitude ?? 0).toFixed(3)}`,
    );
  }
  return notes;
}

// ① 纯 220Hz（A3）—— 期望检出 midi 57 附近
await run('A3 220Hz 3s', sine(220, 3));

// ② 纯 440Hz（A4）—— 期望检出 midi 69 附近
await run('A4 440Hz 3s', sine(440, 3));

// ③ 噪声 —— 期望无音符
const noise = new Float32Array(SR * 2);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
await run('white noise 2s', noise);
