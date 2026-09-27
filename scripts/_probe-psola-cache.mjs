// PSOLA 变换「分析结果复用」的 A/B 探针。
//
//   node scripts/_probe-psola-cache.mjs [--a=<oldWasm>] [--b=<newWasm>] [--sec=<长素材秒数>]
//
// 同一个进程里加载两份 wasm（A = 改前，B = 改后），喂完全相同的输入，做两件事：
//   ① 性能：模拟真实弹奏的场景，逐次计时；
//   ② 等价性：逐样本比对两边的输出，报告最大绝对差与差异样点数。
//
// 为什么必须同进程、同一批输入：
//   「缓存」这类改动的正确性判据只有一条 —— 输出不许变。跨进程比对要序列化整段
//   音频，而同进程比对能直接给出「差在哪一个样点、差多少」，定位成本低一个量级。
//
// 为什么按「场景」为单位先跑完 A 再跑完 B，而不是逐步交替：
//   交替会让 B 每次都紧跟在 A 之后（CPU 缓存、内存带宽都偏袒后跑的那一侧），
//   而且缓存类改动的耗时本身就依赖「前一步做过什么」。分场景各跑一遍，
//   两侧的冷热历史才完全一致。
//
// 为什么用真实素材（ffmpeg 解 mp3）而不是合成信号：
//   合成元音是完美周期的，永远走「颗粒重排」那条路；真素材里有一批没有周期结构
//   （`psolaNoopBuffers` 记的就是它们），整段落到固定颗粒路径 —— 两条路的
//   frames/marks 用法不同，只测一条会漏。而且真素材的长度（0.15~0.75s）才是我
//   们实际要优化的工作量级。
//
// ⚠️ 本探针直接调 wasm 导出，**绕过 JS 侧 `transformBuffer` 的那层缓存** ——
//   它量的是 Rust 内部复用分析结果的收益。JS 侧缓存容量与预热的收益要在浏览器里
//   跑端到端探针才看得到（两层的责任不同，别用一个探针代替另一个）。
//
// ⛔ 必须显式传 `--a=` 指向**改动前**的 wasm。`--a` 与 `--b` 的默认值都是
//   `public/hajimi_audio.wasm`，不传参时两边是同一个文件 → 加速比恒等于 1.00×、
//   逐样本比对恒等于「完全一致」。**这是会伪装成全绿的假结果**，不是「这次没改好」。
//
//   node scripts/_probe-psola-cache.mjs --a=.workbuddy/tmp/hajimi_before.wasm
//
//   ⚠️ 改动前的 wasm 不进库（`.workbuddy/tmp/` 被 .gitignore 排除），要复现得自己在
//   改动前留一份；也可以把 `--a` 指向旧的构建产物或另一分支编出来的同名 wasm。

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const SR = 48000;
const A_PATH = resolve(opt('a', join(root, 'public', 'hajimi_audio.wasm')));
const B_PATH = resolve(opt('b', join(root, 'public', 'hajimi_audio.wasm')));
const LONG_SEC = Number(opt('sec', '4'));

// ---------------------------------------------------------------------------
// wasm 装载
// ---------------------------------------------------------------------------

function load(path) {
  const mod = new WebAssembly.Module(readFileSync(path));
  const instance = new WebAssembly.Instance(mod, {});
  const ex = instance.exports;
  return {
    path,
    ex,
    mem: () => ex.memory.buffer,
    /** 整段变换。返回 { ms, out } —— out 是逐通道的 Float32Array 拷贝。 */
    tx(chans, pitch, time, mode) {
      const frames = chans[0].length;
      const nch = chans.length;
      const total = frames * nch;
      const ptr = ex.hajimi_alloc(total * 4) >>> 0;
      const flat = new Float32Array(total);
      for (let c = 0; c < nch; c++) flat.set(chans[c], c * frames);
      new Float32Array(this.mem(), ptr, total).set(flat);
      const t0 = performance.now();
      const outF = ex.hajimi_tx_run(ptr, frames, nch, pitch, time, mode, SR) | 0;
      const ms = performance.now() - t0;
      let out = null;
      if (outF > 0) {
        const oc = ex.hajimi_tx_channels();
        out = [];
        for (let c = 0; c < oc; c++) {
          const p = ex.hajimi_tx_channel_ptr(c) >>> 0;
          out.push(new Float32Array(this.mem(), p, outF).slice());
        }
        ex.hajimi_tx_free();
      }
      ex.hajimi_dealloc(ptr, total * 4);
      return { ms, out };
    },
  };
}

// 两份**独立实例**：共用同一个实例会让 A 享受 B 的缓存，测出来的「改前」是假的。
const A = load(A_PATH);
const B = load(B_PATH);

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

/** 解一段素材成逐通道 Float32Array（-ac 1 单声道 / 2 立体声）。 */
function decode(rel, ac) {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', join(root, rel), '-f', 'f32le', '-acodec', 'pcm_f32le',
     '-ar', String(SR), '-ac', String(ac), '-'],
    { maxBuffer: 1 << 28 },
  );
  const frames = Math.floor(buf.length / 4 / ac);
  const chans = [];
  for (let c = 0; c < ac; c++) {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; i++) a[i] = buf.readFloatLE((i * ac + c) * 4);
    chans.push(a);
  }
  return chans;
}

/** 合成元音 —— 只用来造一段「够长」的素材，放大单次变换的量级。 */
function makeVowel(f0, seconds, ac) {
  const n = Math.round(SR * seconds);
  const base = new Float32Array(n);
  for (let k = 1; k * f0 < SR * 0.45; k++) {
    const f = k * f0;
    const a = (1 / (k * k)) * (1 / (1 + (f / 4000) ** 1.6));
    for (let i = 0; i < n; i++) base[i] += a * Math.sin((2 * Math.PI * f * i) / SR + k);
  }
  return Array.from({ length: ac }, () => base);
}

const mp3s = readdirSync(join(root, '素材')).filter((f) => f.endsWith('.mp3')).sort();
const CLIPS = mp3s.slice(0, 3).map((f) => decode(join('素材', f), 2));
const LONG = makeVowel(180, LONG_SEC, 2);

// ---------------------------------------------------------------------------
// 场景（模拟键位映射下的弹奏）
// ---------------------------------------------------------------------------

/**
 * 12 个键、3 个素材轮换、每个键一个不同的音高比。
 * 这正是「填词后自动音高」的形态：每个键的 semitones 都不同，
 * 于是每个键都是缓存里的一条独立记录。
 *
 * ⛔ 音高比不许取到 **1.0**：`apply_planar_inner` 对「pitch≈1 且 time≈1」
 * 有恒等短路（逐样本拷贝），那种调用 0.01ms 就返回了，会把场景变成
 * 「在测短路」而不是「在测变换」。前一版用 `2^((i*2-6)/12)`，i=3 时正好是 0，
 * 于是场景③整段 0.01ms —— 看起来像「优化后极快」，其实是根本没进内核。
 * 所以这里取 +1..+6 / -1..-6 半音两段，两端都避开 0。
 */
const KEY_PITCHES = Array.from({ length: 12 }, (_, i) =>
  i < 6 ? 2 ** ((i + 1) / 12) : 2 ** (-(i - 5) / 12),
);
const KEYS_12 = Array.from({ length: 12 }, (_, i) => [CLIPS[i % 3], KEY_PITCHES[i], 1.0, 1]);

function runAll(inst, steps) {
  const ms = [];
  const outs = [];
  for (const [chans, pitch, time, mode] of steps) {
    const r = inst.tx(chans, pitch, time, mode);
    ms.push(r.ms);
    outs.push(r.out);
  }
  return { ms, outs };
}

function compare(aOuts, bOuts) {
  let diffCount = 0;
  let maxAbsDiff = 0;
  let firstDiff = null;
  const n = Math.min(aOuts.length, bOuts.length);
  for (let s = 0; s < n; s++) {
    const a = aOuts[s];
    const b = bOuts[s];
    if (!a || !b) {
      if (!!a !== !!b) {
        diffCount++;
        firstDiff ??= { step: s, why: 'null-mismatch' };
      }
      continue;
    }
    if (a.length !== b.length) {
      diffCount++;
      firstDiff ??= { step: s, why: 'channel-count', a: a.length, b: b.length };
      continue;
    }
    for (let c = 0; c < a.length; c++) {
      const x = a[c];
      const y = b[c];
      if (x.length !== y.length) {
        diffCount++;
        firstDiff ??= { step: s, ch: c, why: 'length', a: x.length, b: y.length };
        continue;
      }
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - y[i]);
        if (d !== 0) {
          diffCount++;
          if (d > maxAbsDiff) maxAbsDiff = d;
          firstDiff ??= { step: s, ch: c, i, a: x[i], b: y[i] };
        }
      }
    }
  }
  return { bitExact: diffCount === 0, diffCount, maxAbsDiff, firstDiff };
}

const SCENARIOS = [
  ['① 顺序按 12 个键（首轮，分析全冷）', KEYS_12],
  ['② 再按一遍那 12 个键（分析应全命中）', KEYS_12],
  ['③ 同一个键连按 20 次', Array.from({ length: 20 }, () => [CLIPS[0], KEY_PITCHES[3], 1.0, 1])],
  [
    '④ 两个键来回 20 次（隔次使用）',
    Array.from({ length: 20 }, (_, i) => [CLIPS[0], KEY_PITCHES[i % 2], 1.0, 1]),
  ],
  [
    `⑤ 长素材 ${LONG_SEC}s × 4 个音高（放大单次量级）`,
    [0.7, 0.85, 1.0, 1.2].map((p) => [LONG, p, 1.0, 1]),
  ],
  [
    '⑥ 短素材、音高×1 + 时长×1.4（另一条映射）',
    Array.from({ length: 4 }, (_, i) => [CLIPS[0], i % 2 ? 0.9 : 1.0, 1.4, 1]),
  ],
];

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const results = [];
for (const [name, steps] of SCENARIOS) {
  const a = runAll(A, steps);
  const b = runAll(B, steps);
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  const aSum = sum(a.ms);
  const bSum = sum(b.ms);
  results.push({
    name,
    n: steps.length,
    aSum,
    bSum,
    speedup: bSum > 0 ? aSum / bSum : Infinity,
    perA: a.ms.map((v) => +v.toFixed(2)),
    perB: b.ms.map((v) => +v.toFixed(2)),
    ...compare(a.outs, b.outs),
  });
}

const secs = CLIPS.map((c) => (c[0].length / SR).toFixed(3)).join(' / ');
console.log(`\nA（改前）= ${A.path}`);
console.log(`B（改后）= ${B.path}`);
console.log(`短素材   = 素材/${mp3s.slice(0, 3).join(', ')}  ${secs}s × 2ch`);
console.log(`长素材   = 合成元音 ${LONG_SEC}s × 2ch`);

const W = 40;
console.log(
  `\n${'场景'.padEnd(W)}${'步数'.padStart(6)}${'A 合计'.padStart(11)}${'B 合计'.padStart(11)}${'加速'.padStart(9)}   等价`,
);
console.log('-'.repeat(W + 52));
for (const s of results) {
  const eq = s.bitExact ? '逐样本相同' : `✗ 差 ${s.diffCount} 点(max ${s.maxAbsDiff.toExponential(2)})`;
  console.log(
    `${s.name.padEnd(W)}${String(s.n).padStart(6)}${(s.aSum.toFixed(1) + 'ms').padStart(11)}${(s.bSum.toFixed(1) + 'ms').padStart(11)}${(s.speedup.toFixed(2) + '×').padStart(9)}   ${eq}`,
  );
}

console.log('\n逐次耗时（ms）');
for (const s of results) {
  console.log(`  ${s.name}`);
  console.log(`    A: ${s.perA.join(' ')}`);
  console.log(`    B: ${s.perB.join(' ')}`);
}

const bad = results.filter((s) => !s.bitExact);
if (bad.length) {
  console.log('\n⛔ 输出不等价：');
  for (const s of bad) console.log(`  ${s.name} → ${JSON.stringify(s.firstDiff)}`);
  process.exit(1);
}
console.log('\n✅ 全部场景逐样本相同');
