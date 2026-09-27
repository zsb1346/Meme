/**
 * `setPatch` 去重：**增量补写必须与全量重写等价**。
 *
 * ## 为什么需要这个守卫
 *
 * `SynthEngine.setPatch` 原实现对 117 个键**无条件** `writeParam`，一份一个值都
 * 没变的 patch 实测要 275ms（8× 节流）。改成「值没变就跳过」之后性能问题解决，
 * 但换来一个新的失败模式：**跳过建立在「节点已经等于 patch」这个假设上**。
 * 假设一旦在某条分支上不成立，症状是「面板显示 A、耳朵听到 B」，而且
 * **不会自愈**（下一次 setPatch 又跳过）。这类静默发散只能靠等价性对拍钉住。
 *
 * ## 对拍怎么做的
 *
 * ### 效果链（每个预设一组）
 *
 *   A （全量）：构造 → setPatch(P)
 *   B1（空转）：A 之后同一台引擎再套一份「同内容新对象」→ 必须**零写入**、终态不变
 *   B2（增量）：构造 → setPatch(A0) → setPatch(P)          A0 ≠ P
 *
 *   断言 `终态(A) === 终态(B1) === 终态(B2)`，且 `写入数(B2) < 117`。
 *
 * ### 声部级（每个预设一组）
 *
 * 同一个初始声部（先 `setPatch(A0)` 再 `noteOn`，所以两条路的声部**逐节点同源**），
 * 然后：
 *
 *   X：一次 `setPatch(P)`
 *   Y：对每个「A0 与 P 不同」的键，逐个 `applyParam(k, P[k])`   ← 不含去重的朴素写法
 *
 *   断言两者的**声部节点终态**一致。
 *
 * ## 六条「不这么写就测错」的规矩
 *
 *  ① 比的是**终态**，不是**排程历史**。B2 / Y 天然多写几笔 `setTargetAtTime`，
 *     但都收敛到同一个值 —— 那才是「等价」该有的含义。所以快照**排除
 *     `MockParam.calls`**。
 *  ② 混响 IR 的内容**必须是随机的**（`makeIR` 里 `Math.random()`），所以只比
 *     `numberOfChannels / length / sampleRate`。长度足以揭示 `reverbSize` 变没变。
 *  ③ 声部构造会 `rand(-2, 2)`（unison 失谐微抖）、`rand(-1, 1)`（起振相位），
 *     粒子更甚 —— 这些**会写进 `MockParam.value`**，所以必须种子化。
 *     ⛔ 但**只在按音那一段**装 mock：`makeIR` 每个采样都要调一次 `Math.random`，
 *     全程套着 vitest 的 spy 包装会让每台引擎构造慢一个数量级（实测整套从
 *     5s 涨到 79s），而这个代价换不来任何确定性（IR 内容本来就排除在快照外）。
 *  ④ `engineType` / `osc*` / `env*` / `str*` / `gran*` 是**声部级**键，
 *     `writeParam` 的 `default:` 分支不为它们碰效果链 → 效果链快照**看不见**它们，
 *     所以声部那一组不是可选项。
 *  ⑤ ⛔ 声部**不能**用「setPatch 之后再按音」来测。那条路里声部读的是 `eng.patch`
 *     （已经整体换新成 P），压根不经过 `updateParam` —— 于是无论去重写得多烂
 *     都测不出来。**第一版就是这么写的：27 条全绿，等于把守卫的牙齿拔了。**
 *     必须让声部**先存在**，再改参数，才踩得到 `updateParam`。
 *  ⑥ 声部快照只取 `mark` 之后的节点（= 声部自己的节点）。这样「混响防抖 vs 立即
 *     重建」那个 `bulk` 差异不会干扰它 —— 那属于效果链，第一组已经在管。
 *
 * ## 已知未覆盖
 *
 *   · `mod*` 矩阵的**全局目标**推进依赖 `tickMod` 定时器，而定时器只在
 *     `realtime`（真机）下开 —— 单测里那条路根本不跑。它由
 *     `scripts/probe-synth.mjs` 的离线渲染覆盖。
 *
 * ⚠️ 单测**量不到声音**。这里只管**节点终态**；声音对不对由
 * `scripts/probe-synth.mjs`（离线渲染量 rms 绝对量）负责。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SynthEngine } from './engine';
import {
  DEFAULT_SYNTH_PATCH,
  SYNTH_PRESETS,
  patchFromPreset,
  sanitizeSynthPatch,
  synthValueEqual,
  type SynthPatch,
} from './patch';
import { MockAudioContextBase, MockNode, MockParam, asCtx } from './mock-audio-context';

// ---------------------------------------------------------------------------
// 确定性随机（规矩 ③）
// ---------------------------------------------------------------------------

let rngState = 0;

/** xorshift32：够快够平，关键是**可复现** */
function seedRng(seed: number): void {
  rngState = seed >>> 0 || 0x9e3779b9;
}

function nextRng(): number {
  let x = rngState;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x;
  return x / 4294967296;
}

/** 只在这段里替换 `Math.random`（原因见文件头规矩 ③） */
function withSeededRandom<T>(seed: number, fn: () => T): T {
  seedRng(seed);
  const spy = vi.spyOn(Math, 'random').mockImplementation(nextRng);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// 终态快照
// ---------------------------------------------------------------------------

/** FNV-1a over raw bytes —— 曲线 / 波表内容必须参与比较 */
function hashF32(a: Float32Array): string {
  let h = 0x811c9dc5;
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * 把任意值折成可比的字符串。
 * `idx` 把节点 / 参数映射成「在本上下文里的序号」—— 两个不同 ctx 的图因此可比。
 */
function fold(v: unknown, idx: Map<unknown, number>, depth = 0): string {
  if (depth > 8) return '<deep>';
  if (v instanceof MockParam) return `p${idx.get(v) ?? '?'}@${v.value}`;
  if (v instanceof MockNode) return `n${idx.get(v) ?? '?'}`;
  if (v instanceof Set) {
    return `{${[...v].map((x) => fold(x, idx, depth + 1)).sort().join(',')}}`;
  }
  if (v instanceof Float32Array) return `f32[${v.length}]#${hashF32(v)}`;
  if (Array.isArray(v)) return `[${v.map((x) => fold(x, idx, depth + 1)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // mock 版 AudioBuffer（规矩 ②：内容随机，只比形状）
    if (typeof o.numberOfChannels === 'number' && typeof o.length === 'number') {
      return `buf(ch=${o.numberOfChannels},len=${o.length},rate=${String(o.sampleRate)})`;
    }
    // createPeriodicWave 的产物：内容可比
    if (o.real instanceof Float32Array && o.imag instanceof Float32Array) {
      return `pw(${hashF32(o.real)},${hashF32(o.imag)})`;
    }
    return '<obj>';
  }
  return String(v);
}

/**
 * 节点终态快照（规矩 ①：排除 `calls`）。
 * `from` 之后新建的节点才进快照（规矩 ⑥）。
 */
function snapshot(c: MockAudioContextBase, from = 0): string[] {
  const nodes = c.nodes.slice(from);
  const idx = new Map<unknown, number>();
  for (const n of nodes) idx.set(n, idx.size);
  // 参数按「节点顺序 × 自有键顺序」编号 —— 确定，且跨引擎可比
  for (const n of nodes) {
    const o = n as unknown as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v instanceof MockParam && !idx.has(v)) idx.set(v, idx.size);
    }
  }
  const lines: string[] = [];
  nodes.forEach((n, i) => {
    const o = n as unknown as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k === 'calls') continue;
      lines.push(`#${i} ${n.kind}.${k} = ${fold(o[k], idx)}`);
    }
  });
  return lines;
}

/** 逐行比对，只报前几条差异 —— 不然 vitest 会把几万行快照全糊在脸上 */
function diffLines(a: string[], b: string[], limit = 8): string[] {
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (a[i] !== b[i]) out.push(`第 ${i} 行：A「${a[i] ?? '<缺>'}」≠ B「${b[i] ?? '<缺>'}」`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function mk(c: MockAudioContextBase, patch: unknown = DEFAULT_SYNTH_PATCH): SynthEngine {
  return new SynthEngine(asCtx(c), patch);
}

/** 计数 `writeParam` 调用次数 —— 「跳过」有没有真的发生只能这么看 */
function countWrites(eng: SynthEngine): () => number {
  let n = 0;
  const self = eng as unknown as {
    writeParam: (name: unknown, value: unknown, bulk: boolean) => void;
  };
  const orig = self.writeParam.bind(eng);
  self.writeParam = (name, value, bulk) => {
    n++;
    orig(name, value, bulk);
  };
  return () => n;
}

function mutate(p: SynthPatch, key: keyof SynthPatch, value: unknown): SynthPatch {
  return sanitizeSynthPatch({ ...p, [key]: value });
}

/** P 相对 A0 真正变了的键（Y 路径要逐个 applyParam 的那些） */
function changedKeys(a0: SynthPatch, p: SynthPatch): Array<keyof SynthPatch> {
  return (Object.keys(p) as Array<keyof SynthPatch>).filter(
    (k) => !synthValueEqual(a0[k], p[k]),
  );
}

const ROWS = Object.keys(SYNTH_PRESETS).map((name, i) => ({
  i,
  name,
  p: patchFromPreset(name),
}));

const NAMES = ROWS.map((r) => r.name);

/** ⛔ 规矩：中间态逐预设错开。固定用一个 A0 会在它自己那一档退化成 B1 */
function a0Of(i: number): SynthPatch {
  return ROWS[(i + 1) % ROWS.length].p;
}

/** 键数（= 首次 setPatch 期望的写入次数） */
const KEY_COUNT = Object.keys(DEFAULT_SYNTH_PATCH).length;

// ---------------------------------------------------------------------------
// 一、跳过判据本身
// ---------------------------------------------------------------------------

describe('synthValueEqual：跳过判据（不许容差）', () => {
  it('数字 / 字符串 / 布尔走严格相等', () => {
    expect(synthValueEqual(0.5, 0.5)).toBe(true);
    expect(synthValueEqual('saw', 'saw')).toBe(true);
    expect(synthValueEqual(true, true)).toBe(true);
    expect(synthValueEqual(true, false)).toBe(false);
    expect(synthValueEqual('saw', 'square')).toBe(false);
  });

  it('⛔ 1e-6 的改动必须判成「变了」—— 容差 = 静默发散', () => {
    // 若这条变红：有人给判等加了 epsilon。后果是 this.patch 记新值、
    // 音频节点留旧值，面板与声音不一致且**永不自愈**。
    expect(synthValueEqual(0.25, 0.25 + 1e-6)).toBe(false);
    expect(synthValueEqual(0, -0)).toBe(true); // === 认 +0/-0 相等，无副作用
  });

  it('addHarm 数组：引用不同但内容相同 = 相等（唯一需要逐元素比的参数）', () => {
    const a = [1, 0.5, 0.25];
    const b = [1, 0.5, 0.25];
    expect(a).not.toBe(b); // 前提：身份确实不同
    expect(synthValueEqual(a, b)).toBe(true);
    expect(synthValueEqual(a, [1, 0.5, 0.26])).toBe(false);
    expect(synthValueEqual(a, [1, 0.5])).toBe(false);
  });

  it('数组与标量不互等；NaN 一律不等（宁可多写，不可漏写）', () => {
    expect(synthValueEqual([1], 1)).toBe(false);
    expect(synthValueEqual(undefined, undefined)).toBe(true);
    expect(synthValueEqual(NaN, NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 二、跳过闸门：收益 + 「第一次不许省」
// ---------------------------------------------------------------------------

describe('appliedOnce 闸门', () => {
  const name = NAMES[0];

  it('第一次 setPatch 必须**全量**写（地基不能被「值没变」省掉）', () => {
    const c = new MockAudioContextBase();
    const eng = mk(c);
    const writes = countWrites(eng);
    eng.setPatch(patchFromPreset(name));
    expect(writes()).toBe(KEY_COUNT);
    eng.dispose();
  });

  it('同一份 patch 再来一次 → 一次都不写（被优化掉的就是这一段）', () => {
    const c = new MockAudioContextBase();
    const eng = mk(c);
    const p = patchFromPreset(name);
    eng.setPatch(p);
    const writes = countWrites(eng);
    eng.setPatch(p);
    expect(writes()).toBe(0);
    eng.dispose();
  });

  it('⛔ 内容相同但**身份不同**的 patch（新建的 addHarm 数组）也必须零写入', () => {
    const c = new MockAudioContextBase();
    const eng = mk(c);
    eng.setPatch(patchFromPreset(name));
    const writes = countWrites(eng);
    // 面板每次落库都会重新构造 patchFromPreset → 全新对象 + 全新数组
    eng.setPatch(patchFromPreset(name));
    expect(writes()).toBe(0);
    eng.dispose();
  });

  it('只改一个参数 → 只写一次（成本跟「改了多少」有关，不再跟「有多少键」有关）', () => {
    const c = new MockAudioContextBase();
    const eng = mk(c);
    const p = patchFromPreset(name);
    eng.setPatch(p);
    const q = mutate(p, 'volume', p.volume >= 0.5 ? 0.2 : 0.8);
    expect(q.volume).not.toBe(p.volume); // 前提：确实变了
    const writes = countWrites(eng);
    eng.setPatch(q);
    expect(writes()).toBe(1);
    eng.dispose();
  });
});

// ---------------------------------------------------------------------------
// 三、等价性对拍（每个预设一组效果链 + 一组声部级）
// ---------------------------------------------------------------------------

interface Pair {
  termA: string[];
  termB1: string[];
  termB2: string[];
  liveX: string[];
  liveY: string[];
  writes1: number;
  writes2: number;
  changed: number;
}

function buildPair(name: string, p: SynthPatch, a0: SynthPatch): Pair {
  // ---- 效果链 A ----
  const cA = new MockAudioContextBase();
  const eA = mk(cA);
  eA.setPatch(p);
  const termA = snapshot(cA);

  // ---- 效果链 B1：同一台引擎再套一份「同内容新对象」 ----
  const w1 = countWrites(eA);
  eA.setPatch(patchFromPreset(name)); // 新对象 + 新 addHarm 数组
  const writes1 = w1();
  const termB1 = snapshot(cA);
  eA.dispose();

  // ---- 效果链 B2：先套别的预设，再增量补到 P ----
  const cB = new MockAudioContextBase();
  const eB = mk(cB);
  eB.setPatch(a0);
  const w2 = countWrites(eB);
  eB.setPatch(p);
  const writes2 = w2();
  const termB2 = snapshot(cB);
  eB.dispose();

  // ---- 声部级：一次 setPatch  vs  逐键 applyParam（规矩 ⑤：声部必须先存在）----
  const changed = changedKeys(a0, p);

  const cX = new MockAudioContextBase();
  const eX = mk(cX);
  eX.setPatch(a0);
  const markX = cX.nodes.length;
  withSeededRandom(7, () => eX.noteOn(60));
  eX.setPatch(p);
  const liveX = snapshot(cX, markX);
  eX.dispose();

  const cY = new MockAudioContextBase();
  const eY = mk(cY);
  eY.setPatch(a0);
  const markY = cY.nodes.length;
  withSeededRandom(7, () => eY.noteOn(60));
  for (const k of changed) eY.applyParam(k, p[k]);
  const liveY = snapshot(cY, markY);
  eY.dispose();

  return {
    termA,
    termB1,
    termB2,
    liveX,
    liveY,
    writes1,
    writes2,
    changed: changed.length,
  };
}

describe.each(ROWS.map((r) => [r.name, r.i, r.p] as const))('预设「%s」', (name, i, p) => {
  let f: Pair;

  beforeAll(() => {
    f = buildPair(name, p, a0Of(i));
  });

  it('B1 空转：内容相同 → 零写入，终态逐行不变', () => {
    expect(f.writes1, '同一份 patch 又写了一轮 —— 去重没生效').toBe(0);
    expect(diffLines(f.termA, f.termB1)).toEqual([]);
  });

  it('B2 增量：先套别的预设再补回来，写入次数必须少于全量', () => {
    // ⛔ 前提：这一趟真的走了「增量」分支（否则后面的等价是空转的等价）
    expect(f.writes2, 'A0 与本预设内容相同？用例退化').toBeGreaterThan(0);
    expect(f.writes2, '增量补写的次数不比全量少，优化白做了').toBeLessThan(KEY_COUNT);
  });

  it('效果链：A 与 B2 的节点终态完全一致', () => {
    expect(diffLines(f.termA, f.termB2)).toEqual([]);
  });

  it('声部级：一次 setPatch ≡ 逐键 applyParam（踩得到 updateParam）', () => {
    expect(f.changed, '前提：A0 与 P 必须有键不同').toBeGreaterThan(0);
    expect(f.liveX.length, '前提：按音真的建了节点').toBeGreaterThan(0);
    expect(
      diffLines(f.liveX, f.liveY),
      '⛔ 增量 setPatch 对**已存在的声部**的作用与逐键 applyParam 不等价',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 四、反向对照：证明快照**能**分辨差异
// ---------------------------------------------------------------------------

describe('反向对照（防止上面全是假绿）', () => {
  const base = patchFromPreset('主音 · 超宽锯齿');

  const terminalFrom = (q: SynthPatch): string[] => {
    const c = new MockAudioContextBase();
    const eng = mk(c);
    eng.setPatch(q);
    eng.dispose();
    return snapshot(c);
  };

  const ref = terminalFrom(base);

  /** 每条只动一个**效果链级**键，并附上「sanitize 之后确实变了」的前提 */
  const cases: Array<[keyof SynthPatch, unknown]> = [
    ['volume', base.volume >= 0.5 ? 0.2 : 0.8],
    ['delayFb', base.delayFb >= 0.45 ? 0.1 : 0.85],
    ['drive', base.drive >= 0.5 ? 0.05 : 0.95],
    ['reverbSize', base.reverbSize > 4 ? 1 : 8],
    ['reverbMix', base.reverbMix >= 0.5 ? 0.05 : 0.9],
    ['chorusMix', base.chorusMix >= 0.5 ? 0.05 : 0.9],
    ['bitDepth', base.bitDepth >= 8 ? 4 : 15],
    ['stereoWidth', base.stereoWidth >= 0 ? -0.8 : 0.8],
    ['masterFilterType', base.masterFilterType === 'lowpass' ? 'highpass' : 'lowpass'],
  ];

  it.each(cases)('改 %s 必须在终态上可见', (key, value) => {
    const q = mutate(base, key, value);
    // 前提：sanitize 之后确实是个不同的值（否则这条用例什么也没测）
    expect(q[key]).not.toEqual(base[key]);
    const lines = terminalFrom(q);
    expect(lines.length).toBe(ref.length); // 节点数不该变
    expect(
      diffLines(ref, lines),
      `⛔ 改了 ${String(key)}，快照却一模一样 —— 说明这个快照分辨不出差异，上面几组用例的「一致」不可信`,
    ).not.toEqual([]);
  });
});
