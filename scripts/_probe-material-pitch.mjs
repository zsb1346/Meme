// 真素材诊断：装配面板「Shift+↑ 部分素材没变调」到底发生在哪些素材上、为什么。
//
//   node scripts/_probe-material-pitch.mjs [wasm路径]
//
// 判据不用 F0（鬼畜素材带伴奏/音效时 YIN 本来就测不准），而用**波形差异**：
// pitch=+5 半音、time=1 时，若合成真的做了变调，输出与源波形必然显著不同；
// 若输出逐样本等于源（diffRMS/源RMS ≈ 0），就是**静默没变调**。
//
// 同时跑 mode=2(SOLA) 作对照 —— 用来回答「降级链该不该救它」。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, 'public', 'hajimi_audio.wasm');

const SEMIS = 5;
const PITCH = 2 ** (SEMIS / 12);

// ---------------------------------------------------------------------------
// 加载 wasm
// ---------------------------------------------------------------------------
const bytes = readFileSync(wasmPath);
const mod = await WebAssembly.compile(bytes);
let memory = null;
const inst = await WebAssembly.instantiate(mod, {
  env: {
    memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536 }),
    __memory_base: 0,
    __table_base: 0,
  },
});
const ex = inst.exports;
memory = ex.memory;

const alloc = (n) => ex.hajimi_alloc(n) >>> 0;
const dealloc = (p, n) => ex.hajimi_dealloc(p, n);
const f32 = (ptr, len) => new Float32Array(memory.buffer, ptr, len);

function decodeMp3(buf) {
  const ptr = alloc(buf.length);
  new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
  const nch = ex.hajimi_decode(ptr, buf.length) | 0;
  dealloc(ptr, buf.length);
  if (nch <= 0) return null;
  const frames = ex.hajimi_decode_frames() | 0;
  const sr = ex.hajimi_decode_sample_rate() | 0;
  const chans = [];
  for (let c = 0; c < nch; c++) {
    const cp = ex.hajimi_decode_channel_ptr(c) >>> 0;
    chans.push(new Float32Array(f32(cp, frames))); // 拷贝
  }
  ex.hajimi_decode_free();
  return { nch, frames, sr, chans };
}

function txRun(mono, pitch, time, mode, sr) {
  const frames = mono.length;
  const ptr = alloc(frames * 4);
  f32(ptr, frames).set(mono);
  const outF = ex.hajimi_tx_run(ptr, frames, 1, pitch, time, mode, sr) | 0;
  dealloc(ptr, frames * 4);
  if (outF <= 0) return null;
  const cp = ex.hajimi_tx_channel_ptr(0) >>> 0;
  const out = new Float32Array(f32(cp, outF));
  ex.hajimi_tx_free();
  return out;
}

const rms = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

/**
 * 频谱质心（功率加权平均频率）。用于判别变调方式：
 *  - 重采样式变调（SOLA）：整个频谱平移 ratio 倍 → 质心比 ≈ ratio
 *  - PSOLA：谐波位置移动但共振峰包络不动 → 质心比明显小于 ratio
 * 所以「质心比 ≈ ratio」说明频谱被整体搬移（音色会随音高变，即所谓花栗鼠效应）。
 */
function centroid(x, from, len, sr) {
  const N = 1024;
  const lo = Math.max(0, from);
  if (lo + N > x.length) return NaN;
  // Goertzel 扫描 256 个等间距频点（约为 0–12kHz），避免引入完整 FFT
  let num = 0;
  let den = 0;
  for (let k = 2; k < 258; k++) {
    const w = (2 * Math.PI * k) / N;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const s0 = x[lo + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    const hz = (k * sr) / N;
    num += hz * p;
    den += p;
  }
  return den > 0 ? num / den : NaN;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nwasm = ${wasmPath.replace(root, '.')}`);
console.log(`素材 = 素材/ （${files.length} 个 mp3），变换 pitch=+${SEMIS} 半音, time=1\n`);
console.log(
  '素材'.padEnd(16),
  '时长ms'.padStart(7),
  'M1差异'.padStart(8),
  'M2差异'.padStart(8),
  '质心源'.padStart(8),
  'M1质心'.padStart(7),
  'M2质心'.padStart(7),
  '  结论',
);
console.log('-'.repeat(96));

let m1dead = 0;
let m2dead = 0;
let total = 0;
const deadList = [];

for (const f of files) {
  const dec = decodeMp3(new Uint8Array(readFileSync(join(dir, f))));
  if (!dec) {
    console.log(f.padEnd(16), '  解码失败');
    continue;
  }
  // 下混到单声道（wasm 内部只用通道 0 测 F0，这里统一成单声道更直观）
  const n = dec.frames;
  const mono = new Float32Array(n);
  for (const c of dec.chans) for (let i = 0; i < n; i++) mono[i] += c[i] / dec.chans.length;

  const srcRms = rms(mono);
  if (srcRms < 1e-4) {
    console.log(f.padEnd(16), `${((n / dec.sr) * 1000).toFixed(0).padStart(7)}`, '  近乎静音，跳过');
    continue;
  }

  total++;
  const out1 = txRun(mono, PITCH, 1.0, 1, dec.sr);
  const out2 = txRun(mono, PITCH, 1.0, 2, dec.sr);

  // 「差异度」= RMS(输出-源) / RMS(源)。真的变调了必然远大于 0。
  const diff = (out) => {
    if (!out) return NaN;
    const m = Math.min(out.length, mono.length);
    let s = 0;
    for (let i = 0; i < m; i++) {
      const d = out[i] - mono[i];
      s += d * d;
    }
    return Math.sqrt(s / m) / srcRms;
  };

  const d1 = diff(out1);
  const d2 = diff(out2);
  const dead1 = !Number.isFinite(d1) || d1 < 0.02;
  const dead2 = !Number.isFinite(d2) || d2 < 0.02;
  if (dead1) {
    m1dead++;
    deadList.push(f);
  }
  if (dead2) m2dead++;

  // 质心：取中段（避开起音与收尾包络）
  const cFrom = Math.floor(n * 0.35);
  const cLen = Math.floor(n * 0.3);
  const c0 = centroid(mono, cFrom, cLen, dec.sr);
  const c1 = out1 ? centroid(out1, cFrom, cLen, dec.sr) : NaN;
  const c2 = out2 ? centroid(out2, cFrom, cLen, dec.sr) : NaN;
  const r1 = c0 > 0 ? c1 / c0 : NaN;
  const r2 = c0 > 0 ? c2 / c0 : NaN;

  const verdict = dead1
    ? dead2
      ? 'NG M1/M2 都没变调'
      : 'NG M1 静默没变调（M2 可用）'
    : 'OK M1 已变调';

  console.log(
    f.padEnd(16),
    `${((n / dec.sr) * 1000).toFixed(0).padStart(7)}`,
    (Number.isFinite(d1) ? d1.toFixed(4) : ' fail ').padStart(8),
    (Number.isFinite(d2) ? d2.toFixed(4) : ' fail ').padStart(8),
    (Number.isFinite(c0) ? (c0 / 1000).toFixed(2) : '  --  ').padStart(8),
    (Number.isFinite(r1) ? r1.toFixed(3) : '  --  ').padStart(7),
    (Number.isFinite(r2) ? r2.toFixed(3) : '  --  ').padStart(7),
    '  ' + verdict,
  );
}

console.log('-'.repeat(78));
console.log(`\nmode=1(PSOLA) 静默没变调：${m1dead}/${total}`);
console.log(`mode=2(SOLA)  静默没变调：${m2dead}/${total}`);
if (deadList.length) {
  console.log(`\nmode=1 失效清单：\n  ${deadList.join('\n  ')}`);
}
console.log();
