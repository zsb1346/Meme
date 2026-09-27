/**
 * 假 AudioContext —— 把 Web Audio 的**节点层**变成可断言的数字。
 *
 * ## 为什么它是一个独立模块
 *
 * 原本这段 mock 长在 `voice-lifecycle.test.ts` 里。后来 `set-patch-dedup.test.ts`
 * 也需要「看节点终态」，只有两条路：复制一份，或者抽出来。
 *
 * ⛔ **抽出来是唯一选择。** 复制会让两份假实现各自演化 —— 而假实现比真实现
 * 「宽容」的地方正是 mock 的盲区（见下面 `guardStart` 的原委）。一份 mock、
 * 一处保真度，是这类测试唯一守得住的形态。
 *
 * ## mock 刻意实现的三条真实语义
 *
 *   ① `disconnect(dest)` 对**没连过**的目的地要**抛错**（`InvalidAccessError`）。
 *      引擎的 `quietly()` 正是为它存在的；mock 不抛，就测不出「重复断连不会炸」。
 *   ② 传进 `AudioParam` 的信号是**叠加**在 `value` 上的。这条是「一直发声」
 *      的物理成因：`amp.gain` 的 release 斜坡把 value 拉到 1e-4，
 *      而 LFO 仍往上面加 ±0.22 —— 所以「释放 ≠ 静音」。
 *   ③ `start()` **只能调一次**，第二次抛 `InvalidStateError`。见 `guardStart`。
 *
 * ## 记账能力（两类断言都从这里出发）
 *
 *   · `MockNode.out` / `MockParam.inputs` —— 图结构：谁连着谁。
 *   · `MockParam.value` / `.calls` —— 值历史：现在是多少、排过哪些程。
 *   · `MockAudioContextBase.nodes` —— **建过的全部节点**，用来数「漏没漏拆」。
 *   · `MockShaper.curve` / `MockFilter.type` / `MockOsc.periodicWave` —— 非
 *     AudioParam 的「结构属性」，`setPatch` 的等价性守卫也要比它们。
 *
 * ⚠️ 单测**量不到声音**（那是 `scripts/probe-synth.mjs` /
 * `probe-synth-lifecycle.mjs` 的活，用离线渲染量 rms 绝对量）。这里只管
 * **图结构、账目、以及节点终态**。
 */

/** AudioParam：记录内置值、排程、以及**连进来的信号源**（②的载体） */
export class MockParam {
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

export class MockNode {
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
export function guardStart(node: { started: boolean }, kind: string): void {
  if (node.started) {
    throw new Error(`InvalidStateError: cannot call start more than once (${kind})`);
  }
}

export class MockOsc extends MockNode {
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
export class MockConstSource extends MockNode {
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

export class MockSource extends MockNode {
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

export class MockGain extends MockNode {
  readonly gain = new MockParam(1);
  constructor() {
    super('gain');
  }
}

export class MockPanner extends MockNode {
  readonly pan = new MockParam(0);
  constructor() {
    super('panner');
  }
}

export class MockFilter extends MockNode {
  type = 'lowpass';
  readonly frequency = new MockParam(350);
  readonly Q = new MockParam(1);
  readonly gain = new MockParam(0);
  constructor() {
    super('filter');
  }
}

export class MockShaper extends MockNode {
  curve: Float32Array | null = null;
  oversample = 'none';
  constructor() {
    super('shaper');
  }
}

export class MockDelay extends MockNode {
  readonly delayTime = new MockParam(0);
  constructor() {
    super('delay');
  }
}

export class MockConvolver extends MockNode {
  buffer: unknown = null;
  constructor() {
    super('convolver');
  }
}

export class MockSplitter extends MockNode {
  constructor(kind = 'splitter') {
    super(kind);
  }
}

export class MockCompressor extends MockNode {
  readonly threshold = new MockParam(-24);
  readonly knee = new MockParam(30);
  readonly ratio = new MockParam(12);
  readonly attack = new MockParam(0.003);
  readonly release = new MockParam(0.25);
  constructor() {
    super('compressor');
  }
}

export class MockAnalyser extends MockNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor() {
    super('analyser');
  }
}

export class MockAudioContextBase {
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
   *
   * ⚠️ 正因为这样，`MockOsc.periodicWave` 是**引用同一个对象**就判等 ——
   * 等价性守卫若发现「两个引擎拿到的 PeriodicWave 不是同一个引用」，
   * 那只说明缓存命中与否不同，**不代表声音不同**，不要据此写死断言。
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
export class MockAudioContext extends MockAudioContextBase {}

/** 免去每处 `as unknown as BaseAudioContext` */
export const asCtx = (c: MockAudioContextBase) => c as unknown as BaseAudioContext;
