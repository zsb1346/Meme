// 为「自相关兜底」定阈值：在自相关选中的 lag 处再回查 YIN 的 CMND。
//
//   node scripts/_probe-detect-gate.mjs
//
// 只用自相关**分数**定阈值不够：YIN 本来能检出的「西.mp3」分数只有 0.116，
// 而 YIN 漏检的「米.001.mp3」有 0.600 —— 两类在分数上重叠。
//
// 所以加第二个判据：拿到自相关选的 lag 后，回查该 lag 处的 YIN CMND。
// 真周期处 CMND 不会太高；噪声处必然高。两者组合才是可用的闸门。
//
// 另外测两个对照组，用来确定阈值的下界：
//   - 白噪声（应该是"无音高"）
//   - 白噪声 + 弱周期性脉冲（应该能检出）

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

/**
 * 单帧：同时算差分/CMND 与归一化自相关，返回自相关选的 lag 及其 CMND。
 * 这样闸门可以同时看「自相关有多强」和「YIN 在该 lag 处有多勉强」。
 */
function frameGate(x, off, sr, minHz, maxHz) {
  const minTau = Math.ceil(sr / maxHz);
  const maxTau = Math.min(Math.floor(sr / minHz), WIN - 2);
  if (off + WIN + maxTau > x.length) return null;
  let e0 = 0;
  for (let j = 0; j < WIN; j++) e0 += x[off + j] * x[off + j];
  if (e0 <= 1e-12) return null;

  const diff = new Float64Array(maxTau + 1);
  const ac = new Float64Array(maxTau + 1);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let d = 0;
    let s = 0;
    for (let j = 0; j < WIN; j++) {
      const a = x[off + j];
      const b = x[off + j + tau];
      const dd = a - b;
      d += dd * dd;
      s += a * b;
    }
    diff[tau] = d;
    ac[tau] = s / e0;
  }
  // CMND 需要从 tau=1 起累加，这里 minTau 之前的用前向差分近似补上
  const cmnd = new Float64Array(maxTau + 1);
  let running = 0;
  // tau < minTau 段：用相同公式补齐（这些 lag 不在候选内，但参与 running）
  for (let tau = 1; tau < minTau; tau++) {
    let d = 0;
    for (let j = 0; j < WIN; j++) {
      const dd = x[off + j] - x[off + j + tau];
      d += dd * dd;
    }
    running += d;
  }
  for (let tau = minTau; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }

  let bi = minTau;
  let bs = -Infinity;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (ac[tau] > bs) {
      bs = ac[tau];
      bi = tau;
    }
  }
  if (bs <= 0) return null;
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
  const score = 0.5 * bs + 0.5 * harmAvg;

  // ---- 并列裁决：自相关常见「基频/二次谐波/三次次谐波」几乎同高 ----
  // 在「ac 达到峰值 90% 以上」的候选 lag 里，改由 YIN 的 CMND 选最小者。
  // CMND 对二倍频/三倍频这类错位是敏感的，正好用来在这几个并列峰之间定夺。
  let pick = bi;
  let bestCmnd = cmnd[bi];
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (ac[tau] >= bs * 0.9 && cmnd[tau] < bestCmnd) {
      bestCmnd = cmnd[tau];
      pick = tau;
    }
  }
  const pickHz = sr / pick;
  return {
    freq: sr / bi,
    pickedFreq: pickHz,
    acPeak: bs,
    score,
    cmndAtLag: cmnd[bi],
    cmndPicked: bestCmnd,
  };
}

/** 多帧聚合：自相关选的 lag 的分数中位数 + 该 lag 处 CMND 的中位数。 */
function gate(x, sr) {
  const stride = Math.max(1, Math.floor((x.length - WIN) / 24));
  const rows = [];
  for (let off = 0; off + WIN + Math.floor(sr / 65) <= x.length; off += stride) {
    const r = frameGate(x, off, sr, 65, 1200);
    if (r) rows.push(r);
  }
  if (!rows.length) return null;
  const med = (f) => {
    const v = rows.map(f).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return {
    score: med((r) => r.score),
    cmnd: med((r) => r.cmndAtLag),
    hz: med((r) => r.freq),
    pickedHz: med((r) => r.pickedFreq),
    cmndPicked: med((r) => r.cmndPicked),
  };
}

function yinStrict(x, sr) {
  const stride = Math.max(1, Math.floor((x.length - WIN) / 24));
  const out = [];
  for (let off = 0; off + WIN + Math.floor(sr / 65) <= x.length; off += stride) {
    const minTau = Math.ceil(sr / 1200);
    const maxTau = Math.min(Math.floor(sr / 65), WIN - 2);
    let e = 0;
    const diff = new Float64Array(maxTau + 1);
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let j = 0; j < WIN; j++) {
        const d = x[off + j] - x[off + j + tau];
        s += d * d;
      }
      diff[tau] = s;
    }
    void e;
    const cmnd = new Float64Array(maxTau + 1);
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      run += diff[tau];
      cmnd[tau] = run === 0 ? 1 : (diff[tau] * tau) / run;
    }
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < 0.12) {
        let t = tau;
        while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
        out.push(sr / t);
        break;
      }
    }
  }
  if (!out.length) return null;
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

// ---------------------------------------------------------------------------
const SR = 22050;

function synthNoise(sec, amp) {
  const n = Math.round(SR * sec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (Math.random() * 2 - 1) * amp;
  return x;
}
function synthPulseTrain(f0, sec, amp) {
  const n = Math.round(SR * sec);
  const x = new Float32Array(n);
  const p = SR / f0;
  for (let i = 0; i < n; i++) {
    const ph = i % p;
    x[i] = (Math.random() * 2 - 1) * amp * Math.exp(-ph / (p * 0.06));
  }
  return x;
}

console.log('\n===== 对照组（用来定阈值下界）=====');
for (const [label, sig] of [
  ['白噪声 0.5s', synthNoise(0.5, 0.3)],
  ['白噪声 1.5s', synthNoise(1.5, 0.3)],
  ['脉冲串 200Hz + 强噪声', (() => {
    const a = synthPulseTrain(200, 1.0, 0.3);
    const b = synthNoise(1.0, 0.25);
    for (let i = 0; i < a.length; i++) a[i] += b[i];
    return a;
  })()],
  ['纯脉冲串 300Hz', synthPulseTrain(300, 1.0, 0.5)],
]) {
  const g = gate(sig, SR);
  console.log(
    label.padEnd(22),
    g ? `score=${g.score.toFixed(3)}  CMND@lag=${g.cmnd.toFixed(3)}  hz=${g.hz.toFixed(1)}` : '  (无帧)',
  );
}

console.log('\n===== 真素材 =====');
const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();
console.log('素材'.padEnd(16), 'YIN严'.padStart(8), '自相关分'.padStart(8), 'CMND@lag'.padStart(9), '峰值Hz'.padStart(9), '裁决Hz'.padStart(9), ' 裁决CMND', '  分类');
console.log('-'.repeat(76));

const rows = [];
for (const f of files) {
  const d = decodeMono(new Uint8Array(readFileSync(join(dir, f))));
  if (!d) continue;
  const a = yinStrict(d.mono, d.sr);
  const g = gate(d.mono, d.sr);
  rows.push({ f, a, ...(g ?? {}) });
  console.log(
    f.padEnd(16),
    (a ? a.toFixed(1) : '  --').padStart(8),
    (g ? g.score.toFixed(3) : '  --').padStart(8),
    (g ? g.cmnd.toFixed(3) : '  --').padStart(9),
    (g ? g.hz.toFixed(1) : '  --').padStart(9),
    '  ' + (g ? g.pickedHz.toFixed(1).padStart(9) + ' ' + g.cmndPicked.toFixed(3).padStart(6) : '  --  '),
    '  ' + (a ? 'YIN命中' : 'YIN漏'),
  );
}

const miss = rows.filter((r) => !r.a);
const hit = rows.filter((r) => r.a);
console.log('-'.repeat(76));
const stat = (arr, k) => {
  const v = arr.map((r) => r[k]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? `min ${v[0].toFixed(3)} / med ${v[Math.floor(v.length / 2)].toFixed(3)} / max ${v[v.length - 1].toFixed(3)}` : '--';
};
console.log(`YIN 漏检 (${miss.length})： score ${stat(miss, 'score')}`);
console.log(`                        CMND  ${stat(miss, 'cmnd')}`);
console.log(`YIN 命中 (${hit.length})： score ${stat(hit, 'score')}`);
console.log(`                        CMND  ${stat(hit, 'cmnd')}`);
console.log();
