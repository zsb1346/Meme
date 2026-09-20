// 降级链级验收：复现 `playSample` 的模式循环 [1, 2]，逐素材报告**最终生效的模式**。
//
//   node scripts/_probe-degradation-chain.mjs [wasm路径]
//
// 与 `_probe-material-pitch.mjs` 的区别：那个只看内核（mode=1 单独跑），
// 这个看**用户实际听到的那条路** —— 因为「部分素材没变调」的机制正是
// 「内核静默空转 + 降级链误判成功」，只看内核测不出降级链有没有救回来。
//
// 判据与 `src/engine/rush/transform.ts::isPsolaSilentNoop` 保持一致，
// 任何漂移都会让这个脚本和前端行为对不上，所以两边的条件必须同源对照。
//
// 期望（修复后）：没有任何素材停在「mode=1 且没变调」，即 effective 一栏不出现 NG。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, 'public', 'hajimi_audio.wasm');

const SEMIS = 5;
const PITCH = 2 ** (SEMIS / 12);

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
    chans.push(new Float32Array(f32(ex.hajimi_decode_channel_ptr(c) >>> 0, frames)));
  }
  ex.hajimi_decode_free();
  return { nch, frames, sr, chans };
}

/** 一次 txRun + 读回诊断计数（与 loader 的 txMarks()/txVoicedFrames() 同一 ABI）。 */
function txRun(mono, pitch, time, mode, sr) {
  const frames = mono.length;
  const ptr = alloc(frames * 4);
  f32(ptr, frames).set(mono);
  const outF = ex.hajimi_tx_run(ptr, frames, 1, pitch, time, mode, sr) | 0;
  dealloc(ptr, frames * 4);
  if (outF <= 0) return { outF, voiced: -1, marks: -1, out: null };
  const voiced = ex.hajimi_tx_voiced_frames() | 0;
  const marks = ex.hajimi_tx_marks() | 0;
  const out = new Float32Array(f32(ex.hajimi_tx_channel_ptr(0) >>> 0, outF));
  ex.hajimi_tx_free();
  return { outF, voiced, marks, out };
}

/** 与 transform.ts::isPsolaSilentNoop 同源 —— 改动任何一边都要同步另一边。 */
function isPsolaSilentNoop(mode, pitch, marks, voicedFrames) {
  if (mode !== 1) return false;
  if (Math.abs(pitch - 1) < 1e-4) return false;
  if (marks < 0) return false;
  return marks === 0 || voicedFrames === 0;
}

const rms = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

const dir = join(root, '素材');
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();

console.log(`\nwasm = ${wasmPath.replace(root, '.')}`);
console.log(`复现 playSample 降级链：pitch=+${SEMIS} 半音，模式顺序 [1(PSOLA), 2(SOLA)]\n`);
console.log(
  '素材'.padEnd(16),
  'voiced'.padStart(7),
  'marks'.padStart(6),
  'M1差异'.padStart(8),
  '生效模式'.padStart(9),
  '  结论',
);
console.log('-'.repeat(80));

let fellBack = 0;
let stillDead = 0;
let total = 0;
const fallbackList = [];

for (const f of files) {
  const dec = decodeMp3(new Uint8Array(readFileSync(join(dir, f))));
  if (!dec) {
    console.log(f.padEnd(16), '  解码失败');
    continue;
  }
  const n = dec.frames;
  const mono = new Float32Array(n);
  for (const c of dec.chans) for (let i = 0; i < n; i++) mono[i] += c[i] / dec.chans.length;
  const srcRms = rms(mono);
  if (srcRms < 1e-4) continue;
  total++;

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

  // ---- playSample 的模式循环 ----
  let effective = 0;
  let chosen = null;
  let reason = '';
  for (const m of [1, 2]) {
    const r = txRun(mono, PITCH, 1.0, m, dec.sr);
    if (r.outF <= 0) {
      reason = `mode=${m} 抛异常(code=${r.outF})`;
      continue;
    }
    if (isPsolaSilentNoop(m, PITCH, r.marks, r.voiced)) {
      reason = `mode=1 静默空转(marks=${r.marks})`;
      continue;
    }
    chosen = r;
    effective = m;
    break;
  }

  if (effective === 0) {
    stillDead++;
    console.log(f.padEnd(16), '  整条链都没出声');
    continue;
  }

  const d = diff(chosen.out);
  const dead = !Number.isFinite(d) || d < 0.02;
  if (effective === 2) {
    fellBack++;
    fallbackList.push(f);
  }

  console.log(
    f.padEnd(16),
    String(chosen.voiced).padStart(7),
    String(chosen.marks).padStart(6),
    (Number.isFinite(d) ? d.toFixed(4) : ' fail ').padStart(8),
    `mode=${effective}`.padStart(9),
    dead ? '  NG 仍然没变调' : `  OK 已变调${effective === 1 ? '' : '（降级 SOLA）'}`,
  );
}

console.log('-'.repeat(80));
console.log(`\n素材 ${total} 个：`);
console.log(`  最终停在 PSOLA（mode=1）：${total - fellBack - stillDead}`);
console.log(`  降级到 SOLA（mode=2）  ：${fellBack}`);
console.log(`  整条链都失效          ：${stillDead}`);
if (fallbackList.length) console.log(`\n降级清单：\n  ${fallbackList.join('\n  ')}`);

// ---------------------------------------------------------------------------
// 合成素材：逼出 PSOLA 的静默空转，验证**降级网**本身是活的
// ---------------------------------------------------------------------------
//
// 真素材上降级网 0 次触发（检测修复已经覆盖了它们），所以「网有没有破」只能靠
// 合成素材来证明：噪声与打击点列没有可同步的周期 → PSOLA 无 mark → 必须降级到
// SOLA。若这一段显示 mode=1，说明网破了（降级判据没生效），真遇上非周期素材
// 就会重新退化回「按了没反应」。
{
  const sr = 48000;
  const n = sr; // 1 秒
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rnd() * 0.5;

  // 鼓点型：每 100ms 一个衰减脉冲串（有节拍但无周期音高）
  const drums = new Float32Array(n);
  for (let k = 0; k < 10; k++) {
    const at = k * (sr / 10);
    for (let i = 0; i < 1200; i++) {
      drums[(at + i) | 0] = rnd() * 0.9 * Math.exp(-i / 200);
    }
  }

  console.log('\n' + '-'.repeat(80));
  console.log('合成素材（非周期，逼出 PSOLA 静默空转）：\n');
  console.log('素材'.padEnd(16), 'voiced'.padStart(7), 'marks'.padStart(6), 'M1差异'.padStart(8), '生效模式'.padStart(9), '  结论');

  for (const [name, sig] of [
    ['白噪声', noise],
    ['鼓点列', drums],
  ]) {
    const srcRms = rms(sig);
    const diff = (out) => {
      const m = Math.min(out.length, sig.length);
      let s = 0;
      for (let i = 0; i < m; i++) {
        const d = out[i] - sig[i];
        s += d * d;
      }
      return Math.sqrt(s / m) / srcRms;
    };

    const r1 = txRun(sig, PITCH, 1.0, 1, sr);
    const d1 = r1.out ? diff(r1.out) : NaN;
    const noop = isPsolaSilentNoop(1, PITCH, r1.marks, r1.voiced);

    // 降级链
    let effective = 0;
    let chosenDiff = NaN;
    if (!noop && r1.outF > 0) {
      effective = 1;
      chosenDiff = d1;
    } else {
      const r2 = txRun(sig, PITCH, 1.0, 2, sr);
      if (r2.outF > 0) {
        effective = 2;
        chosenDiff = diff(r2.out);
      }
    }

    const ok = effective === 2 && chosenDiff > 0.02;
    console.log(
      name.padEnd(16),
      String(r1.voiced).padStart(7),
      String(r1.marks).padStart(6),
      (Number.isFinite(d1) ? d1.toFixed(4) : '  --  ').padStart(8),
      `mode=${effective}`.padStart(9),
      ok
        ? '  OK 正确降级到 SOLA，音高真的动了'
        : effective === 1
          ? '  NG 降级网破了：PSOLA 没做事却被当成成功'
          : '  NG 降级后仍然没变调',
    );
  }
}

console.log(
  stillDead === 0
    ? '\nOK 没有任何素材停在「成功但没变调」—— 「Shift+↑ 部分素材没反应」已消除。\n'
    : '\nNG 仍有素材拿不到变调结果，需要继续排查。\n',
);
