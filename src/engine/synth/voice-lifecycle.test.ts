/**
 * 声部生命周期：**建出来的节点必须被拆掉**。
 *
 * ## 为什么需要这个文件
 *
 * 这是一类「不报错、不崩溃，只是越用越差」的 bug —— vitest 跑在 node 环境，
 * 没有 Web Audio，所以过去整个回收路径在单测里是**盲区**。而它造成的
 * 两个症状都在用户耳朵里：
 *
 *   · 松手后**音还在响**（声部没拆 → 幅度 LFO 还连着 → 增益停在 ±lfoAmpAmt）；
 *   · 连按几十次后**卡顿 → 没声**（每个声部漏约 20 个节点）。
 *
 * 这里用一个**假 AudioContext** 把节点层变成可断言的数字：记录每个节点被创建、
 * 被连接、被 start/stop 的事实，于是「有没有拆干净」就是一道算术题。
 *
 * ## 这个 mock 刻意实现的两条真实语义
 *
 *   ① `disconnect(dest)` 对**没连过**的目的地要**抛错**（`InvalidAccessError`）。
 *      引擎的 `quietly()` 正是为它存在的；mock 不抛，就测不出「重复断连不会炸」。
 *   ② 传进 `AudioParam` 的信号是**叠加**在 `value` 上的。这条是「一直发声」
 *      的物理成因：`amp.gain` 的 release 斜坡把 value 拉到 1e-4，
 *      而 LFO 仍往上面加 ±0.22 —— 所以「释放 ≠ 静音」。
 *
 * ⚠️ 单测**量不到声音**（那是 `scripts/probe-synth-lifecycle.mjs` 的活，
 * 用离线渲染量 rms 绝对量）。这里只管**图结构与账目**。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SYNTH_PATCH, patchFromPreset, sanitizeSynthPatch } from './patch';
import { SynthEngine } from './engine';

// ---------------------------------------------------------------------------
// 假 AudioContext
// ---------------------------------------------------------------------------

/** AudioParam：记录内置值、排程、以及**连进来的信号源**（②的载体） */
class MockParam {
  value: number;
  /** 往这个 param 里灌信号的节点集合 —— 释放后必须为空（对幅度参数而言） */
  readonly inputs = new Set<MockNode>();
  readonly calls: string[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push(`set@${t}=${v}`);
    return this;
  }

  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push(`linear@${t}=${v}`);
    return this;
  }

  exponentialRampToValueAtTime(v: number, t: number) {
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime 不能到 0');
    this.value = v;
    this.calls.push(`exp@${t}=${v}`);
    return this;
  }

  setTargetAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push(`target@${t}=${v}`);
    return this;
  }

  cancelScheduledValues(t: number) {
    this.calls.push(`cancel@${t}`);
    return this;
  }

  cancelAndHoldAtTime(t: number) {
    this.calls.push(`hold@${t}`);
    return this;
  }
}

class MockNode {
  readonly kind: string;
  readonly out = new Set<MockNode | MockParam>();
  destroyed = false;

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(dest: MockNode | MockParam): typeof dest {
    this.out.add(dest);
    if (dest instanceof MockParam) dest.inputs.add(this);
    return dest;
  }

  disconnect(dest?: MockNode | MockParam): void {
    if (dest === undefined) {
      for (const d of this.out) if (d instanceof MockParam) d.inputs.delete(this);
      this.out.clear();
      return;
    }
    // ① 真实语义：没连过就要抛
    if (!this.out.has(dest)) throw new Error('InvalidAccessError: destination is not connected');
    this.out.delete(dest);
    if (dest instanceof MockParam) dest.inputs.delete(this);
  }
}

/**
 * 真机的 `start()` **只能调一次**，第二次抛 `InvalidStateError`。
 *
 * ⛔ 这条语义必须 mock 出来。之前 `MockOsc.start()` / `MockSource.start()` 只是
 * 把 `started = true` 置位（幂等），于是「同一个源被 start 两次」在单测里
 * **完全隐形** —— 弦鸣引擎的起振脉冲正是这样被 start 了两次，真机上整条声部
 * 一个音都发不出来，而这批用例当时 29 条全绿。那次是靠
 * `scripts/probe-synth.mjs` 的七引擎离线渲染才抓到的。
 *
 * 教训：假实现比真实现「宽容」的地方，就是这个 mock 的盲区。
 */
function guardStart(node: { started: boolean }, kind: string): void {
  if (node.started) {
    throw new Error(`InvalidStateError: cannot call start more than once (${kind})`);
  }
}

class MockOsc extends MockNode {
  type = 'sine';
  readonly frequency = new MockParam(440);
  readonly detune = new MockParam(0);
  started = false;
  stopped = false;
  /** `start(when)` 的入参；没传（= 立刻）则 null */
  startedAt: number | null = null;
  /** 带限波形（经典 / 波表 / 加法引擎都走它，而不是 `type`） */
  periodicWave: unknown = null;

  constructor() {
    super('osc');
  }

  setPeriodicWave(w: unknown) {
    this.periodicWave = w;
  }

  start(when?: number) {
    guardStart(this, 'osc');
    this.started = true;
    this.startedAt = when ?? null;
  }

  stop() {
    this.stopped = true;
  }

  /** 还在音频线程上跑 = 占 CPU */
  get running() {
    return this.started && !this.stopped;
  }
}

/** 常数源（音高调制的专用信号源） */
class MockConstSource extends MockNode {
  readonly offset = new MockParam(0);
  started = false;
  stopped = false;
  startedAt: number | null = null;

  constructor() {
    super('const');
  }

  start(when?: number) {
    guardStart(this, 'const');
    this.started = true;
    this.startedAt = when ?? null;
  }

  stop() {
    this.stopped = true;
  }

  get running() {
    return this.started && !this.stopped;
  }
}

class MockSource extends MockNode {
  buffer: unknown = null;
  loop = false;
  /** 粒子引擎用它变速（`playbackRate`） */
  readonly playbackRate = new MockParam(1);
  started = false;
  stopped = false;
  startedAt: number | null = null;

  constructor() {
    super('source');
  }

  /** 真实签名是 `start(when?, offset?, duration?)` —— 粒子引擎三个都用 */
  start(when?: number, _offset?: number, _duration?: number) {
    guardStart(this, 'source');
    this.started = true;
    this.startedAt = when ?? null;
  }

  stop() {
    this.stopped = true;
  }

  get running() {
    return this.started && !this.stopped;
  }
}

class MockGain extends MockNode {
  readonly gain = new MockParam(1);
  constructor() {
    super('gain');
  }
}

class MockPanner extends MockNode {
  readonly pan = new MockParam(0);
  constructor() {
    super('panner');
  }
}

class MockFilter extends MockNode {
  type = 'lowpass';
  readonly frequency = new MockParam(350);
  readonly Q = new MockParam(1);
  readonly gain = new MockParam(0);
  constructor() {
    super('filter');
  }
}

class MockShaper extends MockNode {
  curve: Float32Array | null = null;
  oversample = 'none';
  constructor() {
    super('shaper');
  }
}

class MockDelay extends MockNode {
  readonly delayTime = new MockParam(0);
  constructor() {
    super('delay');
  }
}

class MockConvolver extends MockNode {
  buffer: unknown = null;
  constructor() {
    super('convolver');
  }
}

class MockSplitter extends MockNode {
  constructor(kind = 'splitter') {
    super(kind);
  }
}

class MockCompressor extends MockNode {
  readonly threshold = new MockParam(-24);
  readonly knee = new MockParam(30);
  readonly ratio = new MockParam(12);
  readonly attack = new MockParam(0.003);
  readonly release = new MockParam(0.25);
  constructor() {
    super('compressor');
  }
}

class MockAnalyser extends MockNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor() {
    super('analyser');
  }
}

class MockAudioContextBase {
  sampleRate = 48000;
  /** 可写：测试直接推时间去驱动清扫 */
  currentTime = 0;
  readonly destination = new MockNode('destination');
  /** 创建过的全部节点 —— 所有断言都从它出发 */
  readonly nodes: MockNode[] = [];

  private track<T extends MockNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  createOscillator() {
    return this.track(new MockOsc());
  }
  createGain() {
    return this.track(new MockGain());
  }
  createStereoPanner() {
    return this.track(new MockPanner());
  }
  createBiquadFilter() {
    return this.track(new MockFilter());
  }
  createWaveShaper() {
    return this.track(new MockShaper());
  }
  createDelay() {
    return this.track(new MockDelay());
  }
  createConvolver() {
    return this.track(new MockConvolver());
  }
  createChannelSplitter() {
    return this.track(new MockSplitter('splitter'));
  }
  createChannelMerger() {
    return this.track(new MockSplitter('merger'));
  }
  createDynamicsCompressor() {
    return this.track(new MockCompressor());
  }
  createAnalyser() {
    return this.track(new MockAnalyser());
  }
  createBufferSource() {
    return this.track(new MockSource());
  }
  createConstantSource() {
    return this.track(new MockConstSource());
  }
  /**
   * `createPeriodicWave` 只需要「返回一个东西」——引擎把它塞给
   * `osc.setPeriodicWave` / 记进缓存，不会读它的内容。
   * 单测断言的是**图结构与账目**，波形对不对由离线渲染的探针听。
   */
  createPeriodicWave(real: Float32Array, imag: Float32Array) {
    return { real, imag };
  }

  createBuffer(channels: number, length: number, rate: number) {
    const data: Float32Array[] = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: (c: number) => data[c],
      copyFromChannel: () => {},
      copyToChannel: () => {},
    };
  }
}

/** realtime 判定要求 `ctx instanceof AudioContext`（见 SynthEngine 构造函数） */
class MockAudioContext extends MockAudioContextBase {}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

const asCtx = (c: MockAudioContextBase) => c as unknown as BaseAudioContext;

/** 还在跑的振荡器数。引擎自带 3 个常驻 LFO，所以用「与基线相等」来判，不写死常量。 */
function runningOscillators(c: MockAudioContextBase): number {
  return c.nodes.filter((n): n is MockOsc => n instanceof MockOsc && n.running).length;
}

/** 引擎调制 LFO 下游的节点 —— 就是各声部私有的「调制深度级」 */
function depthStages(eng: SynthEngine, group: 'amp' | 'filter'): MockGain[] {
  const lfos =
    group === 'amp' ? [eng.lfoAmp, eng.lfo2Amp] : [eng.lfoFilter, eng.lfo2Filter];
  const out: MockGain[] = [];
  for (const lfo of lfos) {
    for (const d of (lfo as unknown as { out: Set<unknown> }).out) {
      if (d instanceof MockGain && !out.includes(d)) out.push(d);
    }
  }
  return out;
}

/** 该增益级最后一次「排程到 0」的时刻（秒）；从没排过则 null */
function zeroAt(g: MockGain): number | null {
  const hits = g.gain.calls
    .map((s) => /^set@([\d.]+)=0$/.exec(s))
    .filter((m): m is RegExpExecArray => m !== null);
  return hits.length ? Number(hits[hits.length - 1][1]) : null;
}

function makeEngine(c: MockAudioContextBase, preset = DEFAULT_SYNTH_PATCH) {
  return new SynthEngine(asCtx(c), preset);
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

// ---------------------------------------------------------------------------
// 自检：先证明 mock 真的在抓东西（否则后面全绿也没有意义）
// ---------------------------------------------------------------------------

describe('假 AudioContext 自检（防止下面的用例空洞通过）', () => {
  it('按一个音确实建了节点、接了线、起了振荡器', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    const baselineNodes = c.nodes.length;
    const baselineOsc = runningOscillators(c);

    eng.noteOn(60);

    expect(c.nodes.length).toBeGreaterThan(baselineNodes + 5);
    expect(runningOscillators(c)).toBeGreaterThan(baselineOsc);
    expect(eng.voiceStats.created).toBe(1);
    expect(eng.voiceStats.live).toBe(1);
  });

  it('mock 的 disconnect 会拒绝未连接的目的地（引擎的 quietly 才有意义）', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60);
    const g = c.nodes.find((n): n is MockGain => n instanceof MockGain)!;
    const other = new MockGain();
    expect(() => g.disconnect(other.gain)).toThrow(/InvalidAccessError/);
  });

  /*
    ⭐ 这条是「守卫的守卫」：上面那条 fidelity 修复（start 只许调一次）如果哪天
    被人改回幂等，下面「七引擎不重复起振」的用例就会**一起变回空洞通过**，
    而它恰恰是唯一能拦住弦鸣血案重演的东西。所以先把 guard 本身钉住。
  */
  it('mock 的 start 只许调一次，stop 可以重复调（真机语义）', () => {
    const osc = new MockOsc();
    osc.start(0.5);
    expect(osc.startedAt).toBe(0.5);
    expect(() => osc.start(0.5)).toThrow(/InvalidStateError/);

    const src = new MockSource();
    src.start(0, 0, 0.1);
    expect(() => src.start(0, 0, 0.1)).toThrow(/InvalidStateError/);

    const cs = new MockConstSource();
    cs.start();
    expect(() => cs.start()).toThrow(/InvalidStateError/);

    // ⛔ 但 stop 允许重复调（真机「最后一次生效」）—— 别把释放路径误判成 bug
    osc.stop();
    expect(() => osc.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 核心不变式
// ---------------------------------------------------------------------------

describe('声部账目：建了多少，就必须拆多少', () => {
  it('松手（noteOff）之后，声部必须进入回收流程并被拆掉', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    const baselineOsc = runningOscillators(c);

    eng.noteOn(60);
    eng.noteOff(60, true);
    // 离线（realtime=false）刻意不开清扫定时器，所以手动推时间
    eng.sweepVoices(1e6);

    const s = eng.voiceStats;
    expect(s.live).toBe(0);
    expect(s.dying).toBe(0);
    // ⛔ 修复前这里会是 created=1 / disposed=0 —— 松手等于把声部丢进黑洞
    expect(s.disposed).toBe(s.created);
    expect(runningOscillators(c)).toBe(baselineOsc);
  });

  it('连按 60 次（每次松手）不漏一个节点', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    const baselineOsc = runningOscillators(c);

    for (let i = 0; i < 60; i++) {
      const midi = 48 + (i % 24);
      eng.noteOn(midi, { durationSec: 5 }); // 长音：全靠 noteOff 收
      eng.noteOff(midi, true);
    }
    eng.sweepVoices(1e6);

    const s = eng.voiceStats;
    expect(s.created).toBe(60);
    expect(s.disposed).toBe(60);
    expect(s.live + s.dying).toBe(0);
    // 这条是用户听到的「卡顿 → 没声」的量化版本
    expect(runningOscillators(c)).toBe(baselineOsc);
  });

  it('releaseAll（切页面 / 停止）之后同样不漏', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    const baselineOsc = runningOscillators(c);

    for (const m of [60, 64, 67, 71]) eng.noteOn(m, { durationSec: 5 });
    eng.releaseAll();
    eng.sweepVoices(1e6);

    expect(eng.voiceStats.created).toBe(4);
    expect(eng.voiceStats.disposed).toBe(4);
    expect(runningOscillators(c)).toBe(baselineOsc);
  });

  it('同一个音重按：旧声部进 dying，且最终被拆（不拖尾、不泄漏）', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);

    eng.noteOn(60, { durationSec: 5 }); // 第 1 个：在响
    eng.noteOn(60, { durationSec: 5 }); // 第 2 个：抢占第 1 个
    expect(eng.voiceStats.live).toBe(1);
    expect(eng.voiceStats.dying).toBe(1);

    eng.sweepVoices(1e6);
    expect(eng.voiceStats.disposed).toBe(2);
    expect(eng.voiceStats.dying).toBe(0);
  });

  it('自动释放（durationSec 到点）的声部也会被拆', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 0.2 });
    eng.sweepVoices(1e6);
    expect(eng.voiceStats.disposed).toBe(1);
    expect(eng.voiceStats.live).toBe(0);
  });

  it('引擎 dispose() 会连带清掉正在等回收的那批', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 5 });
    eng.noteOff(60, true); // → dying
    eng.dispose();
    expect(eng.voiceStats.disposed).toBe(1);
    expect(eng.voiceStats.dying).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 「一直发声」的成因：幅度 LFO 挂在 AudioParam 上
// ---------------------------------------------------------------------------

describe('释放必须真的静音，而不是把包络交给 LFO 摆布', () => {
  it('调制 LFO（幅度 + 滤波）都只能进声部私有的深度级，不许直连 AudioParam', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 5 });

    const lfos = [eng.lfoAmp, eng.lfo2Amp, eng.lfoFilter, eng.lfo2Filter];
    for (const lfo of lfos) {
      const outs = [...(lfo as unknown as { out: Set<unknown> }).out];
      expect(outs.length).toBeGreaterThan(0);
      for (const d of outs) {
        // ⛔ 连到 AudioParam 上就等着「释放不静音」：AudioParam 的实际值是
        //    「内置值 + 连入信号之和」，包络归零也压不住 LFO。
        //    滤波器那一侧更狠：它在包络**之前**，包络根本管不住它的自激
        //    （实测「酸性 · 303 贝斯」filterReso=18 时滤波器自身电平到 20）。
        expect(d instanceof MockParam).toBe(false);
        expect(d instanceof MockGain).toBe(true);
      }
    }
    // 音高 LFO 是例外，它直连 osc.detune —— 但振荡器被包络门控，产生不了输出，
    // 所以那一条**不该**有深度级（有的话就是白多一个节点）
    const pitchOuts = [...(eng.lfoPitch as unknown as { out: Set<unknown> }).out];
    expect(pitchOuts.every((d) => d instanceof MockParam)).toBe(true);
  });

  it('归零排在「释放真正开始」的时刻：自动释放排在未来，松手把它提前到当下', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);

    eng.noteOn(60, { durationSec: 5 });
    const ampDepth = depthStages(eng, 'amp');
    const filterDepth = depthStages(eng, 'filter');
    expect(ampDepth.length).toBe(1);
    expect(filterDepth.length).toBe(1);
    /*
     * ⛔ 这一条是防「把 disconnect 塞进 release()」的。
     * `noteOn` 内部会立刻调 release 来**排程** 5 秒后的自动释放 —— 那时候音
     * 还在响。所以正确行为是「排一条 5 秒后的归零」，而不是「现在就归零」。
     * 第一版修复正是在这里写错了：depth 一建出来就被摘，所有带 lfoAmpAmt 的
     * 预设当场失去颤音。
     */
    expect(zeroAt(ampDepth[0])).toBe(5);
    expect(zeroAt(filterDepth[0])).toBe(5);

    eng.noteOff(60, true);
    // 松手 = 抢占式快速释放：归零必须被提前到当下
    expect(zeroAt(ampDepth[0])).toBe(0);
    expect(zeroAt(filterDepth[0])).toBe(0);
  });

  it('自动释放（durationSec）路径同样会把深度归零（排在未来的那个时刻）', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 0.2 });
    // 归零必须排在「释放开始那一刻」（0.2s），不是 0（当前时刻）
    expect(zeroAt(depthStages(eng, 'amp')[0])).toBe(0.2);
    expect(zeroAt(depthStages(eng, 'filter')[0])).toBe(0.2);
  });

  it('带 lfoAmpAmt 的预设（颤音琴 · 流动）同样成立', () => {
    const c = new MockAudioContextBase();
    const patch = patchFromPreset('颤音琴 · 流动');
    expect(patch.lfoAmpAmt).toBeGreaterThan(0); // 前提：这个预设确实靠 LFO 调幅
    const eng = makeEngine(c, patch);

    eng.noteOn(60, { durationSec: 5 });
    const ampDepth = depthStages(eng, 'amp');
    expect(zeroAt(ampDepth[0])).toBe(5); // 响着的这 5 秒颤音必须在
    eng.noteOff(60, true);
    expect(zeroAt(ampDepth[0])).toBe(0); // 松手后才归零

    eng.sweepVoices(1e6);
    expect(eng.voiceStats.disposed).toBe(eng.voiceStats.created);
  });

  it('高共振预设（酸性 · 303 贝斯）也把滤波调制一起归零', () => {
    const c = new MockAudioContextBase();
    const patch = patchFromPreset('酸性 · 303 贝斯');
    expect(patch.filterReso).toBeGreaterThan(10);
    expect(patch.lfoFilterAmt).toBeGreaterThan(0);
    const eng = makeEngine(c, patch);

    eng.noteOn(60, { durationSec: 5 });
    expect(zeroAt(depthStages(eng, 'filter')[0])).toBe(5);
    eng.noteOff(60, true);
    expect(zeroAt(depthStages(eng, 'filter')[0])).toBe(0);
  });

  it('释放以精确的 0 收尾（不能停在 1e-4，否则高 Q 共振会把它抬回可闻）', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 5 });
    eng.noteOff(60, true);

    // 找到声部的包络增益：它的 gain 上挂着那个私有的幅度深度级
    const ampDepth = depthStages(eng, 'amp')[0];
    const envelope = c.nodes
      .filter((n): n is MockGain => n instanceof MockGain)
      .find((g) => g.gain.inputs.has(ampDepth));
    expect(envelope).toBeDefined();
    // 必须有一条「排到精确 0」的调用（exponentialRamp 到不了 0）
    const calls = envelope!.gain.calls;
    expect(calls.some((s) => /^set@[\d.]+=0$/.test(s))).toBe(true);
    expect(calls.some((s) => /^exp@/.test(s))).toBe(true);
  });

  it('release 是幂等的：重复松手不会抛，也不会重复排程', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c);
    eng.noteOn(60, { durationSec: 5 });
    expect(() => {
      eng.noteOff(60);
      eng.noteOff(60);
      eng.releaseAll();
      eng.releaseAll();
    }).not.toThrow();
    eng.sweepVoices(1e6);
    expect(eng.voiceStats.disposed).toBe(1);
  });

  it('已被自动释放的长尾，被 fast 抢占时必须允许缩短释放（否则重按会拖尾）', () => {
    const c = new MockAudioContextBase();
    const eng = makeEngine(c, { ...DEFAULT_SYNTH_PATCH, ampRelease: 6 });

    eng.noteOn(60, { durationSec: 0.1 }); // 0.1s 后进入 6 秒长释放（在 voices 里）
    const first = c.nodes.filter((n): n is MockOsc => n instanceof MockOsc);
    expect(eng.voiceStats.live).toBe(1);

    const before = eng.voiceStats.dying;
    eng.noteOn(60, { durationSec: 6 }); // 同音重按 → fast 抢占
    expect(eng.voiceStats.dying).toBe(before + 1);

    eng.sweepVoices(1e6);
    expect(eng.voiceStats.disposed).toBe(2);
    expect(first.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 清扫定时器：只能有一个，且该收工的时候必须收工
// ---------------------------------------------------------------------------

describe('清扫定时器（realtime 路径）', () => {
  it('dying 里还有声部时不许停表 —— 停了就没人收', () => {
    vi.useFakeTimers();
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;

    const c = new MockAudioContext();
    const eng = makeEngine(c);
    /*
      基线 = 引擎构造时排的那**一个**一次性预热定时器（粒子纹理，800ms 后自清）。
      断言写成「回到基线」而不是「等于 0」：前者同时守住两件事 ——
      ① 声部路径不许再凭空多出定时器；② 收工之后必须回到构造时的状态。
    */
    const baseline = vi.getTimerCount();
    expect(baseline).toBe(1);

    eng.noteOn(60, { durationSec: 5 });
    eng.noteOff(60, true);
    expect(eng.voiceStats.live).toBe(0);
    expect(eng.voiceStats.dying).toBe(1);

    c.currentTime = 100; // 推过 disposeAtSec
    vi.advanceTimersByTime(400);

    // 只有「清扫器还活着」才能把 dying 收干净
    expect(eng.voiceStats.dying).toBe(0);
    expect(eng.voiceStats.disposed).toBe(1);
    // 收干净之后定时器必须自己停掉 —— 别留一个永久 setInterval
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('常驻 LFO 之外不留任何定时器（一个声部一个 timer 是禁止的）', () => {
    vi.useFakeTimers();
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;

    const c = new MockAudioContext();
    const eng = makeEngine(c);
    const baseline = vi.getTimerCount(); // 同上：一次性预热

    for (let i = 0; i < 8; i++) eng.noteOn(60 + i, { durationSec: 0.05 });
    c.currentTime = 100;
    vi.advanceTimersByTime(400);

    expect(eng.voiceStats.disposed).toBe(8);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('矩阵全部关掉时不留控制速率定时器；开了就只留一个', () => {
    vi.useFakeTimers();
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;

    const c = new MockAudioContext();
    const eng = makeEngine(c);
    const baseline = vi.getTimerCount();

    // 默认矩阵四个槽量值都是 0 → 有且只有「清扫器」那一个定时器
    eng.noteOn(60, { durationSec: 0.05 });
    expect(vi.getTimerCount()).toBe(baseline + 1);

    // 开一个槽 → 多出**一个**控制速率节拍（绝不是每个声部一个）
    eng.applyParam('mod1Amt', 0.5);
    expect(vi.getTimerCount()).toBe(baseline + 2);
    eng.noteOn(64, { durationSec: 0.05 });
    eng.noteOn(67, { durationSec: 0.05 });
    expect(vi.getTimerCount()).toBe(baseline + 2);

    // 关回去 → 节拍自己停表（清扫器还在，因为声部还在）
    eng.applyParam('mod1Amt', 0);
    expect(vi.getTimerCount()).toBe(baseline + 1);
  });
});

// ---------------------------------------------------------------------------
// 六个引擎 + 齐奏 + 音高包络：每个都必须能建出声部、并在回收时拆干净
// ---------------------------------------------------------------------------
//
// 这一组是「全量移植」的结构守卫。移植过来的图比原来复杂得多
// （波表要 2N 个振荡器、FM 有 4 个算子与算法矩阵、弦鸣有延迟反馈环、
// 粒子要按控制速率补发源），而**任何一处漏接都是同一个症状**：
// 按下去没声，或者按多了卡顿。单测量不到声音，但能钉住两件事：
//   ① 建图不抛（非有限值 / 少接一个节点都可能抛）；
//   ② 建的每一个源都在拆节点时被 stop。

const ALL_ENGINES = [
  'classic',
  'wavetable',
  'fm',
  'additive',
  'string',
  'granular',
  'noise',
] as const;

describe('六个引擎（全量移植的结构守卫）', () => {
  for (const engineType of ALL_ENGINES) {
    it(`${engineType}：能建出声部、有声源在跑、回收后全部停掉`, () => {
      const c = new MockAudioContext();
      const patch = sanitizeSynthPatch({ ...DEFAULT_SYNTH_PATCH, engineType });
      // 粒子的源是**排在未来**的，`currentTime` 得推过调度窗口才会出现
      const eng = makeEngine(c, patch);
      const oscBaseline = runningOscillators(c);

      expect(() => eng.noteOn(60, { durationSec: 0.1 })).not.toThrow();
      expect(eng.voiceStats.created).toBe(1);

      const sources = c.nodes.filter((n): n is MockSource => n instanceof MockSource);
      c.currentTime = 0.2;
      eng.tickMod(); // 离线渲染没有定时器，粒子/频谱靠手动驱使
      const anyOsc = runningOscillators(c) > oscBaseline;
      const anySrc = sources.some((s) => s.started);
      expect(anyOsc || anySrc, `${engineType} 一个源都没起 —— 按下去不会出声`).toBe(true);

      c.currentTime = 100;
      eng.sweepVoices();
      expect(eng.voiceStats.disposed).toBe(1);
      // 声部拆掉之后不许还有东西在音频线程上跑
      expect(runningOscillators(c)).toBe(oscBaseline);
      expect(sources.filter((s) => s.running).length).toBe(0);
    });
  }

  it('齐奏：声部数直接乘出振荡器个数（波表是 2 个/声部）', () => {
    const c = new MockAudioContext();
    const mono = sanitizeSynthPatch({ ...DEFAULT_SYNTH_PATCH, engineType: 'wavetable', unison: 1 });
    const engMono = makeEngine(c, mono);
    engMono.noteOn(60, { durationSec: 0.1 });
    const monoCount = c.nodes.filter((n) => n instanceof MockOsc).length;
    c.currentTime = 100;
    engMono.sweepVoices();

    const c2 = new MockAudioContext();
    const uni = sanitizeSynthPatch({ ...DEFAULT_SYNTH_PATCH, engineType: 'wavetable', unison: 4 });
    const engUni = makeEngine(c2, uni);
    engUni.noteOn(60, { durationSec: 0.1 });
    const uniCount = c2.nodes.filter((n) => n instanceof MockOsc).length;

    // 引擎 2 个常驻 LFO 抵消掉，剩下的差就是声部自己建的
    expect(uniCount - monoCount).toBe((4 - 1) * 2);
  });

  it('音高包络：amt 非 0 时必须排频率自动化（否则「啵」不会出现）', () => {
    const c = new MockAudioContext();
    const eng = makeEngine(c, {
      ...DEFAULT_SYNTH_PATCH,
      engineType: 'classic',
      pitchEnvAmt: 12,
      pitchEnvDecay: 0.2,
    });
    eng.noteOn(60, { durationSec: 0.1 });
    /*
      ⚠️ 不能取「第一个 started 的振荡器」—— 那是引擎自己那两个常驻 LFO
      （构造时就 start 了，而且它们的频率只被直接赋值，从不排自动化）。
      判据写成「**有**振荡器排了指数频率斜坡」。
      （条数不写死：出厂预设「参考音 · 清铃」只开两个振荡器。）
    */
    const withPitchEnv = c.nodes.filter(
      (n): n is MockOsc =>
        n instanceof MockOsc && n.frequency.calls.some((s) => s.startsWith('exp@')),
    );
    expect(withPitchEnv.length, '没有任何振荡器排音高包络 —— 「啵」不会出现').toBeGreaterThan(0);
  });

  it('滤波斜率：24dB 时第二级必须串进链路', () => {
    const c = new MockAudioContext();
    const eng12 = makeEngine(c, { ...DEFAULT_SYNTH_PATCH, filterSlope: 12 });
    eng12.noteOn(60, { durationSec: 0.1 });
    const filters12 = c.nodes.filter((n) => n instanceof MockFilter);
    // 12dB：两级都建了（代理要同时写两级），但**第二级没有任何出边**
    const second12 = filters12[filters12.length - 1];
    expect(second12.out.size).toBe(0);

    const c2 = new MockAudioContext();
    const eng24 = makeEngine(c2, { ...DEFAULT_SYNTH_PATCH, filterSlope: 24 });
    eng24.noteOn(60, { durationSec: 0.1 });
    const filters24 = c2.nodes.filter((n) => n instanceof MockFilter);
    const second24 = filters24[filters24.length - 1];
    expect(second24.out.size).toBeGreaterThan(0);
  });

  /**
   * 弦鸣血案的回归（成因见 engine.ts `extraStarts` 的注释）。
   *
   * `trigger` 里那两条起振清单一度是同一个数组，于是弦鸣的起振脉冲被
   * `extraStarts` 循环与弦鸣分支各 `start()` 一次 → 真机
   * `InvalidStateError: cannot call start more than once`，异常从 `trigger`
   * 里逃出去，`noteOn` 后半段（排自动释放 + 注册声部）被整段跳过 ——
   * **表现是「这个音色按下去完全没声」，而且只有 string 引擎中招。**
   *
   * ⚠️ 这条用例在「mock 的 start 幂等」时是绿的：单测量不到真机的异常。
   * 它红起来的前提就是上面那条 fidelity 修复 —— 这也是为什么探针
   * （`scripts/probe-synth.mjs` 的七引擎离线渲染）必须和单测并存。
   */
  it('七个引擎按下去都不许抛，且没有源被 start 两次', () => {
    for (const engineType of ALL_ENGINES) {
      const c = new MockAudioContext();
      const patch = sanitizeSynthPatch({ ...DEFAULT_SYNTH_PATCH, engineType });
      const eng = makeEngine(c, patch);
      expect(
        () => eng.noteOn(60, { durationSec: 0.1 }),
        `${engineType}：noteOn 抛了 —— 声部建到一半就断，按下去不会出声`,
      ).not.toThrow();

      // 同一个音重按：走 retire 路径（旧声部回收、新声部全新 trigger）
      c.currentTime += 0.3;
      expect(
        () => eng.noteOn(60, { durationSec: 0.1 }),
        `${engineType}：重按同一个音时抛了`,
      ).not.toThrow();

      // 再换个音，把「多声部并存」也带上（多声部各建各的源）
      c.currentTime += 0.3;
      expect(
        () => eng.noteOn(67, { durationSec: 0.1 }),
        `${engineType}：换一个音（多声部）时抛了`,
      ).not.toThrow();

      c.currentTime = 100;
      eng.sweepVoices();
    }
  });
});
