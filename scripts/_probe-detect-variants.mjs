// 决定性实验：能不能用「比 YIN 更稳健的检测」救回那批漏检素材？
//
//   node scripts/_probe-detect-variants.mjs
//
// 背景：真素材上 YIN 漏检 14/41（自动修音静默无效、PSOLA 取不到 mark）。
// 神经检测能救回 11/14，但 CPU 上 4.3s/文件，不能作为同步步骤。
//
// 这里只在**主音高检测**（给 detectedPitchHz 用、单值）上试三种更宽松的策略。
// 注意：放宽阈值只对「整段取一个音高」安全；对 PSOLA 的逐帧 mark 不安全
// （F0 错一个八度会让颗粒几何整体错，比不处理更糟），所以两者要分开判断。
//
// 策略：
//   ① YIN 严格（现有实现，threshold 0.12）
//   ② YIN 宽松（threshold 0.30，并允许在 min_tau 附近取全局最小 CMND）
//   ③ 自相关 + 谐波性：取归一化自相关峰值最大、且峰值 lag 处的谐波和占优者

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
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
  const mono = new Float32Array(frames);
  for (let c = 0; c < nch; c++) {
    const cp = ex.hajimi_decode_channel_ptr(c) >>> 0;
    const ch = new Float32Array(memory.buffer, cp, frames);
    for (let i = 0; i < frames; i++) mono[i] += ch[i] / nch;
  }
  ex.hajimi_decode_free();
  return { mono, sr };
}

const WIN = 2048;

/** YIN：返回 {freq, cmnd, tau}；cmnd 越小越可信。threshold=null 时不设阈值，取全局最小。 */
function yin(x, off, sr, minHz, maxHz, threshold) {
  const minTau = Math.ceil(sr / maxHz);
  const maxTau = Math.min(Math.floor(sr / minHz), WIN - 2);
  if (off + WIN + maxTau > x.length) return null;
  const diff = new Float64Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let j = 0; j < WIN; j++) {
      const d = x[off + j] - x[off + j + tau];
      s += d * d;
    }
    diff[tau] = s;
  }
  const cmnd = new Float64Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }
  let bestTau = -1;
  if (threshold === null) {
    let best = Infinity;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < best) {
        best = cmnd[tau];
        bestTau = tau;
      }
    }
  } else {
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
        bestTau = tau;
        break;
      }
    }
  }
  if (bestTau < 0) return null;
  let tau = bestTau;
  if (tau > minTau && tau < maxTau) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const den = 2 * (a + c - 2 * b);
    if (den !== 0) tau = tau + (a - c) / den;
  }
  return { freq: sr / tau, cmnd: cmnd[bestTau] };
}

/** 「多帧取高置信中位数」与 yin.rs 同构，只是换成给定阈值。 */
function detectYin(x, sr, threshold) {
  const stride = Math.max(1, Math.floor((x.length - WIN) / 24));
  const out = [];
  let off = 0;
  while (off + WIN + Math.floor(sr / 65) <= x.length) {
    const r = yin(x, off, sr, 65, 1200, threshold);
    if (r) out.push(r);
    off += stride;
  }
  if (!out.length) return null;
  out.sort((a, b) => a.cmnd - b.cmnd);
  const top = out.slice(0, Math.max(1, Math.ceil(out.length / 2)));
  const hz = top.map((r) => r.freq).sort((a, b) => a - b);
  return hz[Math.floor(hz.length / 2)];
}

/** 自相关 + 谐波性：在 lag 域找「自相关强 且 其谐波 lag 也强」的周期。 */
function detectAutocorr(x, sr) {
  const minTau = Math.ceil(sr / 1200);
  const maxTau = Math.min(Math.floor(sr / 65), WIN - 2);
  let best = { hz: null, score: -Infinity };
  const frames = [];
  const stride = Math.max(1, Math.floor((x.length - WIN) / 24));
  for (let off = 0; off + WIN + maxTau <= x.length; off += stride) {
    let e0 = 0;
    for (let j = 0; j < WIN; j++) e0 += x[off + j] * x[off + j];
    if (e0 < 1e-9) continue;
    const ac = new Float64Array(maxTau + 1);
    for (let tau = minTau; tau <= maxTau; tau++) {
      let s = 0;
      for (let j = 0; j < WIN; j++) s += x[off + j] * x[off + j + tau];
      ac[tau] = s / e0;
    }
    let bi = -1;
    let bs = 0;
    for (let tau = minTau; tau <= maxTau; tau++) {
      const v = ac[tau];
      if (v > bs) {
        bs = v;
        bi = tau;
      }
    }
    if (bi < 0) continue;
    // 谐波性：2×lag、3×lag 处的相关也应较高
    let harm = 0;
    let cnt = 0;
    for (let k = 2; k <= 3; k++) {
      const t = bi * k;
      if (t <= maxTau) {
        harm += ac[t];
        cnt++;
      }
    }
    const harmAvg = cnt ? harm / cnt : 0;
    frames.push({ freq: sr / bi, score: bs * 0.5 + harmAvg * 0.5 });
  }
  if (!frames.length) return null;
  frames.sort((a, b) => a.score - b.score);
  const top = frames.slice(Math.floor(frames.length / 2));
  const hz = top.map((f) => f.freq).sort((a, b) => a - b);
  return { hz: hz[Math.floor(hz.length / 2)], score: top[0].score };
}

// ---------------------------------------------------------------------------
const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log('\n素材'.padEnd(16), '时长ms'.padStart(7), 'YIN严'.padStart(8), 'YIN宽'.padStart(8), '自相关'.padStart(9), '  一致性');
console.log('-'.repeat(80));

let strictMiss = 0;
let looseHit = 0;
let acHit = 0;
const rows = [];
for (const f of files) {
  const d = decodeMono(new Uint8Array(readFileSync(join(dir, f))));
  if (!d) continue;
  const ms = (d.mono.length / d.sr) * 1000;
  const a = detectYin(d.mono, d.sr, 0.12);
  const b = detectYin(d.mono, d.sr, 0.3);
  const c = detectAutocorr(d.mono, d.sr);
  const acHz = c?.hz ?? null;
  const acScore = c?.score ?? null;
  if (!a) strictMiss++;
  if (!a && b) looseHit++;
  if (!a && acHz) acHit++;
  rows.push({ f, ms, a, b, c: acHz });

  const agree =
    a && acHz && Math.abs(1200 * Math.log2(acHz / a)) < 50
      ? 'YIN≈自相关'
      : a && acHz
        ? `相差 ${Math.abs(1200 * Math.log2(acHz / a)).toFixed(0)}音分`
        : '';
  console.log(
    f.padEnd(16),
    ms.toFixed(0).padStart(7),
    (a ? a.toFixed(1) : '  --').padStart(8),
    (b ? b.toFixed(1) : '  --').padStart(8),
    (acHz ? acHz.toFixed(1) : '  --').padStart(9),
    (acScore !== null ? acScore.toFixed(3) : '  --  ').padStart(7),
    '  ' + (a ? agree : 'YIN漏 · 自相关分 ' + (acScore ?? 0).toFixed(3)),
  );
}

console.log('-'.repeat(80));
console.log(`YIN 严格漏检        : ${strictMiss}/${files.length}`);
console.log(`放宽到 0.30 救回    : ${looseHit}/${strictMiss}`);
console.log(`自相关谐波性救回    : ${acHit}/${strictMiss}`);
console.log();
