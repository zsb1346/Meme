/**
 * EQ 效果单元 —— 多段参数均衡器。
 *
 * ══ 为什么需要 EqUnitNode（Tone.ToneAudioNode 子类）══
 *
 * BypassableStage（effects.ts）假设 `in → node → out` 就等于"经过这个效果"。
 * 对 ReverbUnit 成立：它是 Tone.ToneAudioNode 子类，暴露分离的 input / output。
 * 对旧 EQ 不成立：旧 `create` 返回单个 Tone.Gain，input 和 output 是同一个
 * 原生节点 → 信号流 in → Gain → out 绕过了 EQ 处理 → EQ 永远不生效。
 *
 * 解决：EqUnitNode extends Tone.ToneAudioNode，与 ReverbUnit 同款拓扑：
 *   input(Tone.Gain) → rawIn(GainNode) → [biquad 串联] → rawOut(GainNode) → output(Tone.Gain)
 *
 * ══ 频响曲线不手写双二阶 ══
 *
 * 段类型有 7 种，每种的双二阶系数公式都不同。手写既易错，也必然与浏览器的
 * 实际实现产生偏差（可视化和听感对不上）。正确做法是调
 * `biquad.getFrequencyResponse(freqs, mag, phase)`，让浏览器用它自己的实现算，
 * 再把各段幅度**逐点相乘**得到级联响应 —— 见 `computeEqResponse()`。
 */
import * as Tone from 'tone';
import type { EqBand, EqSettings } from '../../model/types';
import type { EffectUnit } from './types';

/** 曲线采样点数（固定，便于缓存 Float32Array） */
export const EQ_CURVE_POINTS = 240;
/** 可视化频率范围 */
export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 20000;
/** 增益显示范围（与段参数范围一致） */
export const EQ_GAIN_RANGE = 24;

/** 无增益语义的段类型：这些类型的 gainDb 被浏览器忽略，UI 必须禁用对应旋钮 */
const NO_GAIN_TYPES = new Set(['lowpass', 'highpass', 'notch', 'allpass']);

/** 该类型是否响应 gainDb */
export function eqTypeHasGain(type: EqBand['type']): boolean {
  return !NO_GAIN_TYPES.has(type);
}

/** 中文类型名（UI 与画布共用） */
export const EQ_TYPE_LABEL: Record<EqBand['type'], string> = {
  peaking: '峰值',
  lowshelf: '低架',
  highshelf: '高架',
  lowpass: '低通',
  highpass: '高通',
  notch: '陷波',
  allpass: '全通',
};

/** 循环切换的类型顺序 */
export const EQ_TYPE_ORDER: ReadonlyArray<EqBand['type']> = [
  'peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'allpass',
];

/**
 * 段配色 —— 唯一事实来源。
 *
 * 为什么这里必须引入多个色相（违反「单一强调色」原则）：
 * 多段 EQ 的曲线与节点叠在同一张图上，若都用强调蓝就无法对应
 * 「哪个节点是哪一段」—— 颜色在此承担**分类信息**，不是装饰。
 * 节点上同时标注段序号，保证色觉障碍用户也能对应。
 */
export const EQ_BAND_COLORS = [
  '#FF6B8A', '#FFA94D', '#FFD43B', '#51CF66', '#4DABF7',
] as const;

/** 取第 i 段的配色（自动取模） */
export function eqBandColor(index: number): string {
  return EQ_BAND_COLORS[index % EQ_BAND_COLORS.length];
}

/**
 * 把一段的配置写进它的 biquad（幂等，可高频调用）
 */
function applyBandToNode(node: BiquadFilterNode, band: EqBand): void {
  if (node.type !== band.type) node.type = band.type;
  node.frequency.value = band.frequencyHz;
  node.Q.value = band.q;
  if (eqTypeHasGain(band.type)) node.gain.value = band.gainDb;
}

/**
 * EqUnitNode —— Tone.ToneAudioNode 子类。
 *
 * 与 ReverbUnit 同款拓扑：input/output 分离，BypassableStage 的
 * in → node → out 自动走对路。
 */
export class EqUnitNode extends Tone.ToneAudioNode {
  readonly name = 'EqUnitNode';
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;
  private readonly _ctx: BaseAudioContext;
  private readonly _rawIn: GainNode;
  private readonly _rawOut: GainNode;
  private readonly _nodes: BiquadFilterNode[] = [];
  private _bands: EqBand[] = [];

  constructor(settings: EqSettings) {
    super();
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);
    this._ctx = (this.input.context.rawContext ?? this.input.context) as BaseAudioContext;
    this._rawIn = this._ctx.createGain();
    this._rawOut = this._ctx.createGain();

    // 桥接：Tone 包装 → 原生端点（同 ReverbUnit._bridgeToNative）
    const inRaw = this.input.input as unknown;
    const outRaw = this.output.input as unknown;
    if (inRaw instanceof AudioNode) inRaw.connect(this._rawIn);
    if (outRaw instanceof AudioNode) this._rawOut.connect(outRaw);

    this._syncChain(settings.bands);
  }

  /** 更新段配置（幂等） */
  applyBands(bands: EqBand[]): void {
    this._bands = bands;
    this._syncChain(bands);
  }

  /** 取段节点快照（供 computeEqResponse 用） */
  get nodes(): readonly BiquadFilterNode[] {
    return this._nodes;
  }

  /** 取段配置快照 */
  get bands(): readonly EqBand[] {
    return this._bands;
  }

  /** 按配置重建/更新串联链路（只在节点数不足时创建新节点，其余只改 value） */
  private _syncChain(bands: EqBand[]): void {
    this._bands = bands;
    const ctx = this._rawIn.context;

    while (this._nodes.length < bands.length) {
      this._nodes.push(ctx.createBiquadFilter());
    }

    // 断开旧接线，再按当前段数重新串联
    try { this._rawIn.disconnect(); } catch { /* 未连接 */ }
    for (const n of this._nodes) {
      try { n.disconnect(); } catch { /* 未连接 */ }
    }

    let prev: AudioNode = this._rawIn;
    for (let i = 0; i < bands.length; i++) {
      const node = this._nodes[i];
      applyBandToNode(node, bands[i]);
      prev.connect(node);
      prev = node;
    }
    prev.connect(this._rawOut);
  }
}

/**
 * EQ 效果单元。
 *
 * `params` 为空数组是有意的：EQ 的参数是**嵌套**的（5 段 × 4 字段），
 * 用扁平的 `AnyParamSpec[]` 表达需要拼 `bands.0.gainDb` 这类复合 key，
 * 既丑陋也无法被通用滑杆 UI 正确渲染。EQ 因此使用**专属 UI**
 * （`EqRackPanel`：左可交互曲线 + 右按段旋钮），走 store 的 `setEqBand()` 写入。
 */
export const eqUnit: EffectUnit<EqSettings, EqUnitNode> = {
  id: 'eq',
  label: '均衡器',
  en: 'Parametric EQ',
  flowLabel: 'EQ',
  create: (s) => new EqUnitNode(s),
  apply: (node, s) => node.applyBands(s.bands),
  readValue: () => 0,
  params: [],
};

// ---------------------------------------------------------------------------
// 辅助函数（供 EqCanvas / EffectPopup 消费）
// ---------------------------------------------------------------------------

/**
 * 取当前 EQ 链的段节点快照（可能为空数组）。
 *
 * 从主链单例的 mounted stage 拿 —— 不再用模块级 activeChain，
 * 彻底修掉"导出覆盖 activeChain"导致 EQ 失灵的 bug。
 *
 * 用动态 import 避免循环依赖：effects → eq → effects。
 */
export function getEqNodes(): readonly BiquadFilterNode[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const effects = require('../../engine/effects') as typeof import('../../engine/effects');
    const chain = effects.getMasterChain();
    const eq = chain.getStageNode<EqUnitNode>('eq');
    return eq?.nodes ?? [];
  } catch {
    return [];
  }
}

/**
 * 取当前 EQ 的段配置（由最近一次 apply 记录），UI 兜底用。
 * 从主链 mounted stage 的 EqUnitNode.bands 取。
 */
export function getActiveEqBands(): readonly EqBand[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const effects = require('../../engine/effects') as typeof import('../../engine/effects');
    const chain = effects.getMasterChain();
    const eq = chain.getStageNode<EqUnitNode>('eq');
    return eq?.bands ?? [];
  } catch {
    return [];
  }
}

/**
 * 计算级联频响曲线（dB）。
 *
 *   1. 生成对数分布的采样频率；
 *   2. 对每一段调用浏览器自己的 `getFrequencyResponse`；
 *   3. **逐点相乘**（级联 = 幅度相乘）得到总幅度；4. 转 dB。
 */
export function computeEqResponse(
  nodes: readonly BiquadFilterNode[],
  bands: readonly EqBand[],
  points = EQ_CURVE_POINTS,
): Float32Array {
  const freqs = new Float32Array(points);
  const ratio = EQ_FREQ_MAX / EQ_FREQ_MIN;
  for (let i = 0; i < points; i++) {
    freqs[i] = EQ_FREQ_MIN * Math.pow(ratio, i / (points - 1));
  }
  const total = new Float32Array(points).fill(1);
  const mag = new Float32Array(points);
  const phase = new Float32Array(points);
  for (let b = 0; b < bands.length; b++) {
    const node = nodes[b];
    if (!node || !bands[b].enabled) continue;
    node.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < points; i++) total[i] *= mag[i];
  }
  const db = new Float32Array(points);
  for (let i = 0; i < points; i++) db[i] = 20 * Math.log10(Math.max(1e-7, total[i]));
  return db;
}

/** 频率 → 归一化 x（0..1，对数轴） */
export function eqFreqToNorm(f: number): number {
  return Math.log10(Math.max(f, EQ_FREQ_MIN) / EQ_FREQ_MIN) / Math.log10(EQ_FREQ_MAX / EQ_FREQ_MIN);
}
/** 归一化 x（0..1）→ 频率 */
export function eqNormToFreq(x: number): number {
  return EQ_FREQ_MIN * Math.pow(EQ_FREQ_MAX / EQ_FREQ_MIN, Math.min(1, Math.max(0, x)));
}
/** 增益 → 归一化 y（0..1，0 = 顶部 +24dB） */
export function eqGainToNorm(db: number): number {
  return (EQ_GAIN_RANGE - Math.min(EQ_GAIN_RANGE, Math.max(-EQ_GAIN_RANGE, db))) / (EQ_GAIN_RANGE * 2);
}
/** 归一化 y（0..1）→ 增益 */
export function eqNormToGain(y: number): number {
  return EQ_GAIN_RANGE - Math.min(1, Math.max(0, y)) * EQ_GAIN_RANGE * 2;
}
