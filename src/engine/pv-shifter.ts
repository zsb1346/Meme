/**
 * 相位声码器（Phase Vocoder）离线/流式变调模块。
 *
 * 来源真相：`原型/算法参考.html` 里的 `class FFT`（L489-537）与
 * `class PitchShifter`（L539-643）。本文件是它们的**逐行忠实移植**（TS 版），
 * 目的是让 PV 引擎能与既有的 WASM 引擎（PSOLA / SOLA / vocoder）做 A/B 试听对比。
 *
 * 算法要点（与 HTML 逐式一致，不做重设计）：
 *   - 迭代 radix-2 FFT + 位反转置换，cos/sin 预计算表；
 *   - Hann 分析/合成窗，4x 重叠（oversampling）；
 *   - 逐 bin 相位差 → 真实频率估计，含「奇数象限修正」：
 *       q = trunc(pd/π); q += (q&1) (q≥0) / q -= (q&1) (q<0); pd -= π·q
 *     使 pd 落到 [-π, π]，避免跨帧相位差 ±2π 歧义；
 *   - 谱 bin 映射 k → round(k·ratio)，同 bin 幅度累加 + 最大幅度跟踪频率；
 *     高频倾斜 hfTilt = 1 + 0.65·t²（t=k/(bins-1)）补偿变调后的高频能量缺失；
 *   - 相位累加合成、共轭镜像、×2·window·(1/O) 的 overlap-add（outputAccum）；
 *   - fifo/rover 逐样本流式；延迟 fifoLatency = fftSize - stepSize；
 *   - ratio 夹取 [0.5, 2.0]（同来源）。
 *
 * 依赖规则（见 engine/README.md）：纯函数、零新依赖、无 WASM、无 AudioWorklet，
 * 核心 `pvShiftChannels` 只吃 Float32Array，可在 node/vitest 直接跑，不需要 AudioContext。
 *
 * 移植扩展（非来源所有，均加注释说明）：
 *   1. fftSize / oversampling 变为构造参数（来源硬编码 1024/4，此处按参数推导 FFT 阶数）；
 *   2. 变调比除「常量」外还支持「逐帧曲线」Float32Array（自动调音控制环未来可能驱动 PV）；
 *      常量比例路径与来源逐式一致，曲线路径为附加能力。
 */

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// FFT：迭代 radix-2（位反转 + 蝶形），与算法参考.html L489-537 一致
// ---------------------------------------------------------------------------

/** 就地 radix-2 复数 FFT。构造时预计算位反转表与旋转因子 cos/sin 表。 */
class FFT {
  readonly n: number;
  private readonly logN: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(order: number) {
    this.n = 1 << order;
    this.logN = order;
    const n = this.n;
    // 位反转表
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.logN; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r >>> 0;
    }
    // 旋转因子表（负角 = 正向 DFT 约定）
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-TWO_PI * i) / n);
      this.sin[i] = Math.sin((-TWO_PI * i) / n);
    }
  }

  /** 正向变换：re/im 为长度 n 的就地缓冲。 */
  forward(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    const rev = this.rev;
    const cos = this.cos;
    const sin = this.sin;
    // 位反转置换
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    // 蝶形：size = 2,4,...,n
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k];
          const s = sin[k];
          const tr = c * re[l] - s * im[l];
          const ti = s * re[l] + c * im[l];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }

  /** 逆向变换：共轭 → forward → 共轭并 ÷n。 */
  inverse(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] = -im[i] * inv;
    }
  }
}

// ---------------------------------------------------------------------------
// PvPitchShifter：逐样本流式相位声码器（对应算法参考.html L539-643）
// ---------------------------------------------------------------------------

export interface PvOptions {
  /** FFT 窗长，必须为 2 的幂（默认 1024，与来源一致） */
  fftSize?: number;
  /** 重叠因子 = fftSize / stepSize（默认 4，与来源一致） */
  oversampling?: number;
}

/** 将变调比夹取到来源规定的 [0.5, 2.0]。 */
function clampRatio(r: number): number {
  return Math.max(0.5, Math.min(2.0, r));
}

/** 向上取到最近的 2 的幂的阶数；非 2 的幂直接抛错（保持来源 radix-2 前提）。 */
function fftOrderOf(fftSize: number): number {
  if (fftSize >= 2 && (fftSize & (fftSize - 1)) === 0) {
    return Math.round(Math.log2(fftSize));
  }
  throw new Error(`pv-shifter: fftSize 必须为 2 的幂（得到 ${fftSize}）`);
}

/**
 * 流式相位声码器变调器。
 *
 * 用法（流式，如 worklet）：每块 `processBlock(input, output, ratio)`，128 样本或任意块长皆可。
 * 用法（离线整段）：优先用 {@link pvShiftChannels} / {@link pvShiftBuffer}，它们封装了逐帧曲线。
 */
export class PvPitchShifter {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly oversampling: number;
  /** 每帧步进（hop）样本数 = fftSize / oversampling */
  readonly stepSize: number;
  /** fifo 延迟样本数 = fftSize - stepSize（来源行为，保持不变） */
  readonly fifoLatency: number;

  private readonly fft: FFT;
  private readonly fRe: Float32Array;
  private readonly fIm: Float32Array;
  private readonly inputFifo: Float32Array;
  private readonly outputFifo: Float32Array;
  private readonly outputAccum: Float32Array;
  private readonly window: Float32Array;
  // 谱分析/合成缓冲（长度 bins = fftSize/2 + 1）
  private readonly lastPhase: Float32Array;
  private readonly sumPhase: Float32Array;
  private readonly aMag: Float32Array;
  private readonly aFreq: Float32Array;
  private readonly sMag: Float32Array;
  private readonly sFreq: Float32Array;
  private readonly sMax: Float32Array;

  /** 写指针（rover），初值 = fifoLatency（来源行为） */
  private rover: number;

  constructor(sampleRate: number, opts: PvOptions = {}) {
    const F = opts.fftSize ?? 1024;
    const O = opts.oversampling ?? 4;
    if (!(O >= 1) || !Number.isFinite(O)) {
      throw new Error(`pv-shifter: oversampling 非法（得到 ${O}）`);
    }
    const S = F / O;
    if (!Number.isInteger(S) || S < 1) {
      throw new Error(`pv-shifter: fftSize(${F}) 需能被 oversampling(${O}) 整除`);
    }
    this.sampleRate = sampleRate;
    this.fftSize = F;
    this.oversampling = O;
    this.stepSize = S;
    this.fifoLatency = F - S;
    this.rover = this.fifoLatency;

    this.fft = new FFT(fftOrderOf(F));
    this.fRe = new Float32Array(F);
    this.fIm = new Float32Array(F);
    this.inputFifo = new Float32Array(F);
    this.outputFifo = new Float32Array(S);
    this.outputAccum = new Float32Array(F * 2);

    this.window = new Float32Array(F);
    for (let i = 0; i < F; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / F);

    const bins = F / 2 + 1;
    this.lastPhase = new Float32Array(bins);
    this.sumPhase = new Float32Array(bins);
    this.aMag = new Float32Array(bins);
    this.aFreq = new Float32Array(bins);
    this.sMag = new Float32Array(bins);
    this.sFreq = new Float32Array(bins);
    this.sMax = new Float32Array(bins);
  }

  /** 复位全部累积状态（等价来源 reset()）。 */
  reset(): void {
    this.inputFifo.fill(0);
    this.outputFifo.fill(0);
    this.outputAccum.fill(0);
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.sMax.fill(0);
    this.rover = this.fifoLatency;
  }

  /**
   * 流式逐块处理。input / output 为等长 Float32Array（块长任意，如 worklet 的 128）。
   * ratio 在本块内为常量（夹取到 [0.5,2]）；内部 fifo/rover 状态跨块保留。
   * 对应来源 `process(input, output, n, ratio)`。
   */
  processBlock(input: Float32Array, output: Float32Array, ratio: number): void {
    const F = this.fftSize;
    const S = this.stepSize;
    const L = this.fifoLatency;
    const r = clampRatio(ratio);
    const n = input.length;
    for (let i = 0; i < n; i++) {
      this.inputFifo[this.rover] = input[i];
      output[i] = this.outputFifo[this.rover - L];
      if (++this.rover >= F) {
        this.rover = L;
        this.processFrame(r);
        this.inputFifo.copyWithin(0, S, F);
      }
    }
  }

  /**
   * 单帧：分析 → 频率重映射 → 相位累加合成 → overlap-add。逐式对应来源 processFrame。
   */
  private processFrame(ratio: number): void {
    const F = this.fftSize;
    const S = this.stepSize;
    const O = this.oversampling;
    const freqPerBin = this.sampleRate / F;
    const expectedPhase = (TWO_PI * S) / F;
    const bins = F / 2 + 1;

    // ---- 分析：加窗 → 正向 FFT ----
    for (let k = 0; k < F; k++) {
      this.fRe[k] = this.inputFifo[k] * this.window[k];
      this.fIm[k] = 0;
    }
    this.fft.forward(this.fRe, this.fIm);

    // ---- 逐 bin 相位差 → 真实频率（含奇数象限修正）----
    for (let k = 0; k < bins; k++) {
      const re = this.fRe[k];
      const im = this.fIm[k];
      const mag = 2 * Math.hypot(re, im);
      const phase = Math.atan2(im, re);
      let pd = phase - this.lastPhase[k];
      this.lastPhase[k] = phase;
      pd -= k * expectedPhase;
      let q = Math.trunc(pd / Math.PI);
      if (q >= 0) q += q & 1;
      else q -= q & 1;
      pd -= Math.PI * q;
      this.aMag[k] = mag;
      this.aFreq[k] = (k + (pd * O) / TWO_PI) * freqPerBin;
    }

    // ---- 频率重映射：k → round(k·ratio)，幅度累加 + 最大幅度跟踪 + 高频倾斜 ----
    this.sMag.fill(0);
    this.sFreq.fill(0);
    this.sMax.fill(0);
    for (let k = 0; k < bins; k++) {
      const sb = Math.trunc(k * ratio + 0.5);
      if (sb < bins) {
        const t = k / (bins - 1);
        const tilt = 1 + 0.65 * t * t;
        const m = this.aMag[k] * tilt;
        this.sMag[sb] += m;
        if (m > this.sMax[sb]) {
          this.sMax[sb] = m;
          this.sFreq[sb] = this.aFreq[k] * ratio;
        }
      }
    }

    // ---- 合成：相位累加 → 复数谱 ----
    this.fRe.fill(0);
    this.fIm.fill(0);
    for (let k = 0; k < bins; k++) {
      const m = this.sMag[k];
      let pd = (this.sFreq[k] - k * freqPerBin) / freqPerBin;
      pd = (TWO_PI * pd) / O;
      pd += k * expectedPhase;
      this.sumPhase[k] += pd;
      const ph = this.sumPhase[k];
      this.fRe[k] = m * Math.cos(ph);
      this.fIm[k] = m * Math.sin(ph);
    }
    // ---- 共轭镜像（负频率）----
    for (let k = 1; k < F / 2; k++) {
      this.fRe[F - k] = this.fRe[k];
      this.fIm[F - k] = -this.fIm[k];
    }

    // ---- 逆向 FFT → 加窗 ×2·(1/O) → overlap-add ----
    this.fft.inverse(this.fRe, this.fIm);
    const scale = 1 / O;
    for (let k = 0; k < F; k++) {
      this.outputAccum[k] += 2 * this.window[k] * this.fRe[k] * scale;
    }
    for (let k = 0; k < S; k++) this.outputFifo[k] = this.outputAccum[k];
    this.outputAccum.copyWithin(0, S, F * 2);
    this.outputAccum.fill(0, F * 2 - S, F * 2);
  }
}

// ---------------------------------------------------------------------------
// 离线整段：纯核心（node/vitest 直接可用，不需要 AudioContext）
// ---------------------------------------------------------------------------

/** 变调比：常量（全帧相同）或逐帧曲线（Float32Array，一个 hop 一个值）。 */
export type PvRatio = number | Float32Array;

/**
 * 在归一化位置 p∈[0,1] 上对曲线做线性插值并夹取到 [0.5,2]。
 * 曲线 curve[k] 视为在整段信号上均匀分布的 H 个控制点（k/(H-1) ↔ 时间位置）。
 */
function sampleCurve(curve: Float32Array, p: number): number {
  const H = curve.length;
  if (H === 0) return 1; // 空曲线退化为不变调（防御；调用方保证非空）
  if (H === 1) return clampRatio(curve[0]);
  const f = Math.max(0, Math.min(1, p)) * (H - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(H - 1, i0 + 1);
  const frac = f - i0;
  return clampRatio(curve[i0] * (1 - frac) + curve[i1] * frac);
}

/**
 * 【纯核心】对多声道 Float32Array 做离线相位声码器变调。
 *
 * - 完全在 node 可测，不触碰任何 Web Audio 类型；
 * - 每声道用同一 ratio / 同一曲线采样点（曲线按归一化时间位置对齐，立体声声像一致）；
 * - 输出总长 == 输入总长（来源行为：头部为 fifo 延迟的静音，尾部不足一帧的部分被丢弃）；
 * - 常量比例与流式 processBlock 逐样本状态机等价；曲线路径按 hop 逐帧喂入并在帧内做线性插值。
 *
 * @param channels 每声道一条 Float32Array（单元素数组即单声道）
 * @param sampleRate 采样率
 * @param ratioOrCurve 常量变调比，或每 hop 一个值的曲线
 * @param opts fftSize / oversampling（默认 1024 / 4）
 */
export function pvShiftChannels(
  channels: Float32Array[],
  sampleRate: number,
  ratioOrCurve: PvRatio,
  opts: PvOptions = {},
): Float32Array[] {
  return channels.map((ch) => {
    const n = ch.length;
    const out = new Float32Array(n);
    const shifter = new PvPitchShifter(sampleRate, opts);
    if (typeof ratioOrCurve === 'number') {
      // 常量：一次喂满，与来源 process 逐式一致（块边界无关紧要，状态机纯逐样本）
      shifter.processBlock(ch, out, ratioOrCurve);
      return out;
    }
    // 曲线：逐 hop 喂入，一个 hop 恰好触发一次 processFrame；帧生效比 = 该帧中心位置的插值
    const curve = ratioOrCurve;
    const S = shifter.stepSize;
    // 完整帧数 = 会触发 processFrame 的次数（每 S 样本一次；末尾不足 S 的尾巴不触发 → 丢弃）
    const totalFrames = Math.max(1, Math.floor(n / S));
    for (let pos = 0; pos < n; pos += S) {
      const j = pos / S; // 帧序号（0-based）
      const end = Math.min(pos + S, n);
      // 帧中心落在整段的归一化位置：(j + 0.5) / totalFrames
      const p = (j + 0.5) / totalFrames;
      const r = sampleCurve(curve, p);
      shifter.processBlock(ch.subarray(pos, end), out.subarray(pos, end), r);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// AudioBuffer 包装（注入式工厂，vitest 无需真实 AudioContext）
// ---------------------------------------------------------------------------

/** 结果缓冲创建工厂（结构上兼容 BaseAudioContext.createBuffer）。 */
export interface PvBufferFactory {
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): PvAudioBufferLike;
}

/** 结构上兼容 AudioBuffer 的最小接口（仅需这四样）。 */
export interface PvAudioBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
  readonly context?: PvBufferFactory;
}

/**
 * 离线整段变调（AudioBuffer → 新 AudioBuffer）。
 *
 * 结果缓冲由注入的 ctx 工厂创建；ctx 省略时取 `buffer.context`（真实 AudioBuffer 自带）。
 * 核心计算全部委托给 {@link pvShiftChannels}，本函数只做「取声道数据 → 变调 → 写回新缓冲」。
 *
 * @param buffer 输入（只读其 length/numberOfChannels/sampleRate/getChannelData）
 * @param ratioOrCurve 常量或逐帧曲线
 * @param ctx 结果缓冲创建工厂（省略则用 buffer.context）
 */
export function pvShiftBuffer(
  buffer: PvAudioBufferLike,
  ratioOrCurve: PvRatio,
  ctx?: PvBufferFactory,
): PvAudioBufferLike {
  const factory = ctx ?? buffer.context;
  if (!factory) {
    throw new Error('pvShiftBuffer: 需要 ctx（buffer.context 不可用时请显式传入 createBuffer 工厂）');
  }
  const chCount = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < chCount; c++) channels.push(buffer.getChannelData(c));

  const shifted = pvShiftChannels(channels, buffer.sampleRate, ratioOrCurve);

  const result = factory.createBuffer(chCount, buffer.length, buffer.sampleRate);
  for (let c = 0; c < chCount; c++) result.getChannelData(c).set(shifted[c]);
  return result;
}
