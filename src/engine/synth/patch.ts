/**
 * 合成声部音色 —— Patch 数据模型（音色设计面板的**唯一事实来源**）。
 *
 * ══ 为什么要有这一层 ══
 *
 * 面板上有 ~64 个参数，它们同时活在三个地方：引擎图、面板读数、工程存档。
 * 如果范围（min/max/default）在三个地方各写一遍，迟早分叉 —— 而分叉的表现
 * 是「存档里的值引擎不认」或「旋钮拧到头读数还在涨」这类**静默故障**。
 * 所以范围只在这里声明一次，引擎、面板、校验函数全部从 `SYNTH_NUMERIC_SPECS`
 * 取。
 *
 * ══ 为什么校验函数是硬要求，不是「防御性编程」══
 *
 * 本项目已经因为「存档里是 `undefined`」栽过一次：`AudioParam.setTargetAtTime`
 * 收到非有限值会抛 `TypeError`，而抛点在**渲染期** → React 卸载整棵树 →
 * 用户看到的是一整片黑屏（见 `store.ts::migrateProject` 的注释）。
 * 音色 patch 有 64 个数字参数，任何一个是 `NaN` 都能复现同一个事故。
 * 因此：**进引擎前一律过 `sanitizeSynthPatch`，它保证输出永远是「完整的、
 * 有限数、且在范围内」的形状**，输入是什么都行（缺键 / 多键 / 字符串 /
 * `null` / 别的软件的 patch JSON）。
 *
 * 纯 TS，不 import 任何 DOM/React/store —— 可在 vitest 里直接跑。
 */

// ---------------------------------------------------------------------------
// 枚举参数
// ---------------------------------------------------------------------------

export type OscWave = 'sawtooth' | 'square' | 'triangle' | 'sine';
/** 经典引擎的真实波形（`pulse` 才吃脉宽）*/
export type ClassicWave = 'sawtooth' | 'square' | 'triangle' | 'sine' | 'pulse';
export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'notch';
export type LfoWave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type DriveType = 'soft' | 'hard' | 'fold';
/** 演奏模式：0 = 复音，1 = 单音（与音源器惯例一致，存档里是数字） */
export type MonoMode = 0 | 1;

/** 声音引擎 —— 原型的「多引擎」体系，决定 Voice 怎么搭振荡器图 */
export type EngineType =
  | 'classic'
  | 'wavetable'
  | 'fm'
  | 'additive'
  | 'string'
  | 'granular'
  | 'noise';
/** 波表大类（每类 4 张表 × 16 帧，见 `wavetables.ts`） */
export type WtCat = 'analog' | 'digital' | 'bass' | 'pad' | 'fx';
/** 噪声引擎的噪声色 */
export type NoiseColor = 'white' | 'pink' | 'brown';
/** 粒子引擎的粒子素材 */
export type GranTex = 'saw' | 'bell' | 'vox' | 'air';
/** 调制矩阵：源 */
export type ModSrc =
  | 'none'
  | 'lfo1'
  | 'lfo2'
  | 'env'
  | 'fenv'
  | 'vel'
  | 'key'
  | 'rand'
  | 'm1'
  | 'm2'
  | 'm3'
  | 'm4';
/** 调制矩阵：目标 */
export type ModDst =
  | 'none'
  | 'pitch'
  | 'cutoff'
  | 'reso'
  | 'amp'
  | 'pan'
  | 'fm'
  | 'wtpos'
  | 'pw'
  | 'drive'
  | 'reverb'
  | 'delay'
  | 'bit';

export const OSC_WAVE_OPTIONS: ReadonlyArray<readonly [OscWave, string]> = [
  ['sawtooth', '锯齿'],
  ['square', '方波'],
  ['triangle', '三角'],
  ['sine', '正弦'],
];
/** 经典引擎可选波形（多一个「脉冲」，只有它吃脉宽）*/
export const CLASSIC_WAVE_OPTIONS: ReadonlyArray<readonly [ClassicWave, string]> = [
  ['sawtooth', '锯齿'],
  ['pulse', '脉冲'],
  ['square', '方波'],
  ['triangle', '三角'],
  ['sine', '正弦'],
];
export const ENGINE_OPTIONS: ReadonlyArray<readonly [EngineType, string]> = [
  ['classic', '经典'],
  ['wavetable', '波表'],
  ['fm', 'FM'],
  ['additive', '加法'],
  ['string', '弦鸣'],
  ['granular', '粒子'],
  ['noise', '噪声'],
];
export const WT_CAT_OPTIONS: ReadonlyArray<readonly [WtCat, string]> = [
  ['analog', '模拟'],
  ['digital', '数码'],
  ['bass', '贝斯'],
  ['pad', '铺底'],
  ['fx', '特效'],
];
export const NOISE_COLOR_OPTIONS: ReadonlyArray<readonly [NoiseColor, string]> = [
  ['white', '白噪'],
  ['pink', '粉噪'],
  ['brown', '棕噪'],
];
export const GRAN_TEX_OPTIONS: ReadonlyArray<readonly [GranTex, string]> = [
  ['saw', '锯齿团'],
  ['bell', '钟铃'],
  ['vox', '人声'],
  ['air', '气流'],
];
export const MOD_SRC_OPTIONS: ReadonlyArray<readonly [ModSrc, string]> = [
  ['none', '—'],
  ['lfo1', 'LFO 1'],
  ['lfo2', 'LFO 2'],
  ['env', '音量包络'],
  ['fenv', '滤波包络'],
  ['vel', '力度'],
  ['key', '键位'],
  ['rand', '随机'],
  ['m1', '宏·复杂度'],
  ['m2', '宏·亮度'],
  ['m3', '宏·厚度'],
  ['m4', '宏·空间'],
];
export const MOD_DST_OPTIONS: ReadonlyArray<readonly [ModDst, string]> = [
  ['none', '—'],
  ['pitch', '音高'],
  ['cutoff', '滤波截止'],
  ['reso', '滤波共振'],
  ['amp', '音量'],
  ['pan', '声像'],
  ['fm', 'FM 深度'],
  ['wtpos', '波表位置'],
  ['pw', '脉冲宽度'],
  ['drive', '过载'],
  ['reverb', '混响干湿'],
  ['delay', '延迟干湿'],
  ['bit', '比特'],
];
/**
 * FM 的 4 算子算法矩阵。
 *
 * `edges` 里 `[a, b]` 表示「算子 a 的输出**调制**算子 b 的频率」；
 * `out` 是直接送进混音器的算子 —— 1 号恒为主载波，其余作为额外载波。
 *
 * ⚠️ 算法 0（链式 4→3→2→1）在 `fmDepth3 = fmDepth4 = 0` 时**等价于原来的两算子 FM**
 * （调制器的调制量是 0，链子断了）—— 所以加上这套矩阵不会改变旧预设的音色。
 *
 * ⚠️ 放在 `patch.ts` 而不是引擎里：**面板要按它画算法矩阵图**
 * （`components/synth/fm-algo.ts`）。这张表是「数据」不是「信号处理」，
 * 放这里之后 UI 侧不必 import 整个引擎模块。
 */
export interface FmAlgo {
  name: string;
  edges: ReadonlyArray<readonly [number, number]>;
  out: readonly number[];
}

export const FM_ALGOS: ReadonlyArray<FmAlgo> = [
  { name: '链式 4→3→2→1', edges: [[4, 3], [3, 2], [2, 1]], out: [1] },
  { name: '并联 2·3·4→1', edges: [[2, 1], [3, 1], [4, 1]], out: [1] },
  { name: '4→3→1, 2→1', edges: [[4, 3], [3, 1], [2, 1]], out: [1] },
  { name: '3·4→2→1', edges: [[3, 2], [4, 2], [2, 1]], out: [1] },
  { name: '孪生 2→1, 4→3', edges: [[2, 1], [4, 3]], out: [1, 3] },
  { name: '3→2→1, 4→1', edges: [[3, 2], [2, 1], [4, 1]], out: [1] },
  { name: '2·3→1, 4 直出', edges: [[2, 1], [3, 1]], out: [1, 4] },
  { name: '双链 3→1, 4→2', edges: [[3, 1], [4, 2]], out: [1, 2] },
];

export const LFO_WAVE_OPTIONS: ReadonlyArray<readonly [LfoWave, string]> = [
  ['sine', '正弦'],
  ['triangle', '三角'],
  ['square', '方波'],
  ['sawtooth', '锯齿'],
];
export const FILTER_TYPE_OPTIONS: ReadonlyArray<readonly [FilterType, string]> = [
  ['lowpass', '低通'],
  ['highpass', '高通'],
  ['bandpass', '带通'],
  ['notch', '陷波'],
];
export const DRIVE_TYPE_OPTIONS: ReadonlyArray<readonly [DriveType, string]> = [
  ['soft', '软削波'],
  ['hard', '硬削波'],
  ['fold', '波形折叠'],
];
export const MONO_MODE_OPTIONS: ReadonlyArray<readonly [MonoMode, string]> = [
  [0, '复音'],
  [1, '单音'],
];


// ---------------------------------------------------------------------------
// 数值参数规格（范围 + 默认值 + 手感曲线）—— 全项目唯一声明处
// ---------------------------------------------------------------------------

export interface NumericSpec {
  min: number;
  max: number;
  def: number;
  /**
   * 面板手感曲线。
   * `log` 用于**跨数量级**的参数（截止频率 40→18k、起音 1ms→4s）：
   * 线性映射会把 90% 的行程挤在听不出差别的高频端，是「旋钮拧半天没反应」
   * 的固定来源。`min` 必须 > 0（对数需要正数，sanitize 不负责救这个）。
   */
  curve?: 'linear' | 'log';
  /** 量化步进（面板读数与存档都按它对齐）；缺省 0.001（三位小数） */
  step?: number;
}

/**
 * 数值参数规格表 —— **引擎、面板、校验、测试全部读这里**。
 * 键名即 patch 的键名，不再有第二份清单。
 *
 * ⚠️ 振荡器八度的范围是 `−3 … +4`，比 VFX 旋钮上写的 `±2` 宽。
 * 理由：`原型/效果器/VFX.html` 的旋钮上限是 ±2，但它的预设里写着
 * `osc3Oct: 3`（钟琴 / 水晶铃 / 钢片琴）与 `osc3Oct: -3`（低吼 Bass）——
 * 而 VFX 的 `applyPreset` 是 `Object.assign(params, preset)`，**没有夹取**，
 * 所以那些值当年确实进了引擎、也确实是那个音色，只是旋钮永远拧不到。
 * 若这里按旋钮的 ±2 夹，这四款预设会当场变声（高八度的铃音层被砍掉），
 * 表现成「预设名没变、声音变了」这种最难查的偏差。
 * 结论：**范围以数据实际用到的为准，旋钮跟着放宽**（±4 个八度对泛音层是常规做法）。
 */
const RAW_NUMERIC_SPECS = {
  // 振荡器 1
  osc1Oct: { min: -3, max: 4, def: 0, step: 1 },
  osc1Detune: { min: -50, max: 50, def: 0, step: 1 },
  osc1Level: { min: 0, max: 1, def: 0.6 },
  osc1Pan: { min: -1, max: 1, def: 0 },
  // 振荡器 2
  osc2Oct: { min: -3, max: 4, def: -1, step: 1 },
  osc2Detune: { min: -50, max: 50, def: 8, step: 1 },
  osc2Level: { min: 0, max: 1, def: 0.32 },
  osc2Pan: { min: -1, max: 1, def: 0 },
  // 振荡器 3
  osc3Oct: { min: -3, max: 4, def: 1, step: 1 },
  osc3Detune: { min: -50, max: 50, def: -6, step: 1 },
  osc3Level: { min: 0, max: 1, def: 0.16 },
  osc3Pan: { min: -1, max: 1, def: 0 },
  noiseLevel: { min: 0, max: 1, def: 0 },
  /** 脉冲波脉宽（0.5 = 方波；扫动即 PWM）—— 只对 `pulse` 波形生效 */
  oscPW: { min: 0.05, max: 0.95, def: 0.5 },

  // 调制路由
  fmDepth: { min: 0, max: 1, def: 0 },
  rmDepth: { min: 0, max: 1, def: 0 },

  // 波表引擎
  wtTable: { min: 0, max: 3, def: 0, step: 1 },
  wtPos: { min: 0, max: 1, def: 0.35 },

  // 齐奏 Unison（每个振荡器条目开 n 个声部，失谐 + 立体声铺开）
  unison: { min: 1, max: 16, def: 1, step: 1 },
  unisonDetune: { min: 0, max: 50, def: 14 },
  unisonSpread: { min: 0, max: 1, def: 0.75 },

  // 音高包络（起音瞬间从 ±n 半音滑到本音，打击乐/低吼的来源）
  pitchEnvAmt: { min: -48, max: 48, def: 0, step: 1 },
  pitchEnvDecay: { min: 0.005, max: 2, def: 0.15, curve: 'log' },

  // FM 4 算子
  fmAlgo: { min: 0, max: 7, def: 0, step: 1 },
  fmRatio: { min: 0.25, max: 12, def: 2 },
  fmRatio3: { min: 0.25, max: 12, def: 1 },
  fmDepth3: { min: 0, max: 1, def: 0 },
  fmRatio4: { min: 0.25, max: 12, def: 3 },
  fmDepth4: { min: 0, max: 1, def: 0 },
  fmCar: { min: 0, max: 1, def: 0.7 },
  fmSub: { min: 0, max: 1, def: 0.3 },

  // 加法引擎
  addTilt: { min: 0, max: 1, def: 0.35 },
  addEnvAmt: { min: 0, max: 1, def: 0 },
  addEnvDecay: { min: 0.02, max: 6, def: 0.5, curve: 'log' },

  // 弦鸣 Karplus-Strong
  strDamp: { min: 500, max: 12000, def: 4500, curve: 'log' },
  strDecay: { min: 0.94, max: 0.999, def: 0.985 },
  strLevel: { min: 0, max: 1, def: 0.8 },

  // 粒子引擎
  granSize: { min: 0.015, max: 0.35, def: 0.09 },
  granDensity: { min: 1, max: 50, def: 16, curve: 'log' },
  granPos: { min: 0, max: 1, def: 0.3 },
  granRand: { min: 0, max: 1, def: 0.5 },
  granPitch: { min: -24, max: 24, def: 0, step: 1 },
  granLevel: { min: 0, max: 1, def: 0.7 },

  // 噪声引擎
  noiseEngLevel: { min: 0, max: 1, def: 0.55 },

  // 滤波器
  filterCutoff: { min: 40, max: 18000, def: 2800, curve: 'log' },
  filterReso: { min: 0.1, max: 24, def: 5 },
  filterEnv: { min: 0, max: 12000, def: 4500 },
  filterKey: { min: 0, max: 1, def: 0.35 },
  /** 阶梯滤波斜率：12 = 只用一级，24 = 串上第二级（`step: 12` 让它只有两档） */
  filterSlope: { min: 12, max: 24, def: 12, step: 12 },
  /** 滤波前饱和：0 时曲线是直线（真直通），阶梯那点「脏」味来自这里 */
  filterDrive: { min: 0, max: 1, def: 0 },

  // 滤波器包络
  fAttack: { min: 0.001, max: 4, def: 0.004, curve: 'log' },
  fDecay: { min: 0.005, max: 6, def: 0.35, curve: 'log' },
  fSustain: { min: 0, max: 1, def: 0.25 },
  fRelease: { min: 0.005, max: 8, def: 0.35, curve: 'log' },

  // 音量包络
  ampAttack: { min: 0.001, max: 4, def: 0.004, curve: 'log' },
  ampDecay: { min: 0.005, max: 6, def: 0.28, curve: 'log' },
  ampSustain: { min: 0, max: 1, def: 0.72 },
  ampRelease: { min: 0.005, max: 8, def: 0.32, curve: 'log' },

  // 演奏控制
  glideTime: { min: 0.001, max: 2, def: 0.02, curve: 'log' },
  velSens: { min: 0, max: 1, def: 1 },

  // LFO 1
  lfoRate: { min: 0.02, max: 24, def: 5, curve: 'log' },
  lfoPitchAmt: { min: 0, max: 200, def: 0, step: 1 },
  lfoFilterAmt: { min: 0, max: 6000, def: 0, step: 1 },
  lfoAmpAmt: { min: 0, max: 0.45, def: 0 },
  // LFO 2
  lfo2Rate: { min: 0.02, max: 24, def: 0.5, curve: 'log' },
  lfo2PitchAmt: { min: 0, max: 200, def: 0, step: 1 },
  lfo2FilterAmt: { min: 0, max: 6000, def: 0, step: 1 },
  lfo2AmpAmt: { min: 0, max: 0.45, def: 0 },

  // 失真 / 合唱
  drive: { min: 0, max: 1, def: 0 },
  chorusMix: { min: 0, max: 1, def: 0 },
  chorusRate: { min: 0.05, max: 8, def: 0.6, curve: 'log' },

  // 延迟
  delayTime: { min: 0.01, max: 1.5, def: 0.3 },
  delayFb: { min: 0, max: 0.92, def: 0.3 },
  delayMix: { min: 0, max: 1, def: 0 },
  delayPan: { min: -1, max: 1, def: 0 },
  delayHP: { min: 20, max: 2000, def: 20, curve: 'log' },
  delayLP: { min: 500, max: 16000, def: 8000, curve: 'log' },

  // 混响
  reverbSize: { min: 0.3, max: 6, def: 2.2 },
  reverbMix: { min: 0, max: 1, def: 0.12 },
  reverbPre: { min: 0, max: 0.2, def: 0.01 },
  reverbDamp: { min: 500, max: 16000, def: 5000, curve: 'log' },

  // 主输出
  bitDepth: { min: 4, max: 16, def: 16, step: 1 },
  stereoWidth: { min: 0, max: 2, def: 1 },
  masterPan: { min: -1, max: 1, def: 0 },
  masterFilterCutoff: { min: 100, max: 20000, def: 20000, curve: 'log' },
  masterFilterReso: { min: 0.1, max: 16, def: 0.7 },
  volume: { min: 0, max: 1, def: 0.75 },

  // 宏 —— 每个宏在 `MACRO_MAP` 里联动一组参数（0 = 不干预）
  macroComplex: { min: 0, max: 1, def: 0 },
  macroBright: { min: 0, max: 1, def: 0 },
  macroThick: { min: 0, max: 1, def: 0 },
  macroSpace: { min: 0, max: 1, def: 0 },

  // 调制矩阵（4 槽；`modNamt` = 0 表示该槽不启用）
  mod1Amt: { min: -1, max: 1, def: 0 },
  mod2Amt: { min: -1, max: 1, def: 0 },
  mod3Amt: { min: -1, max: 1, def: 0 },
  mod4Amt: { min: -1, max: 1, def: 0 },
} as const satisfies Record<string, NumericSpec>;

export type SynthNumericParam = keyof typeof RAW_NUMERIC_SPECS;

/**
 * 对外暴露的规格表：**每个键都归一成完整的 `NumericSpec`**。
 *
 * 为什么不直接暴露上面那张 `as const` 的表：`as const` 会把「没写 curve/step
 * 的那一项」推成一个不含这两个属性的类型，于是 `SPECS[p].curve` 在联合类型上
 * 直接编译报错（属性必须存在于全部成员）。这里的映射类型抹平这个差异，
 * 而 `keyof` 一字不差 —— 键名既不会多也不会少，也就不可能与实现分叉。
 */
export const SYNTH_NUMERIC_SPECS: { [K in SynthNumericParam]: NumericSpec } =
  RAW_NUMERIC_SPECS;

/** 全部数值参数的键名（顺序稳定，供测试与遍历） */
export const SYNTH_NUMERIC_PARAMS = Object.keys(
  SYNTH_NUMERIC_SPECS,
) as SynthNumericParam[];

// ---------------------------------------------------------------------------
// Patch 类型
// ---------------------------------------------------------------------------

/** 完整音色 —— 全部参数，无一处可选（可选性只存在于「输入」，不存在于「状态」） */
export interface SynthPatch {
  // 引擎选择
  engineType: EngineType;
  // 振荡器
  osc1Wave: ClassicWave;
  osc1Oct: number;
  osc1Detune: number;
  osc1Level: number;
  osc1Pan: number;
  osc2Wave: ClassicWave;
  osc2Oct: number;
  osc2Detune: number;
  osc2Level: number;
  osc2Pan: number;
  osc3Wave: ClassicWave;
  osc3Oct: number;
  osc3Detune: number;
  osc3Level: number;
  osc3Pan: number;
  noiseLevel: number;
  oscPW: number;
  // 调制
  fmDepth: number;
  rmDepth: number;
  // 波表
  wtCat: WtCat;
  wtTable: number;
  wtPos: number;
  // 齐奏 / 音高包络
  unison: number;
  unisonDetune: number;
  unisonSpread: number;
  pitchEnvAmt: number;
  pitchEnvDecay: number;
  // FM 4 算子
  fmAlgo: number;
  fmRatio: number;
  fmRatio3: number;
  fmDepth3: number;
  fmRatio4: number;
  fmDepth4: number;
  fmCar: number;
  fmSub: number;
  // 加法（32 条谐波 + 频谱包络）
  addHarm: number[];
  addTilt: number;
  addEnvAmt: number;
  addEnvDecay: number;
  // 弦鸣
  strDamp: number;
  strDecay: number;
  strLevel: number;
  // 粒子
  granTex: GranTex;
  granSize: number;
  granDensity: number;
  granPos: number;
  granRand: number;
  granPitch: number;
  granLevel: number;
  // 噪声引擎
  noiseColor: NoiseColor;
  noiseEngLevel: number;
  // 滤波
  filterType: FilterType;
  filterCutoff: number;
  filterReso: number;
  filterEnv: number;
  filterKey: number;
  filterSlope: number;
  filterDrive: number;
  fAttack: number;
  fDecay: number;
  fSustain: number;
  fRelease: number;
  // 音量包络
  ampAttack: number;
  ampDecay: number;
  ampSustain: number;
  ampRelease: number;
  // 演奏
  glideTime: number;
  monoMode: MonoMode;
  velSens: number;
  // 调制轮
  lfoWave: LfoWave;
  lfoRate: number;
  lfoPitchAmt: number;
  lfoFilterAmt: number;
  lfoAmpAmt: number;
  lfo2Wave: LfoWave;
  lfo2Rate: number;
  lfo2PitchAmt: number;
  lfo2FilterAmt: number;
  lfo2AmpAmt: number;
  // 效果
  drive: number;
  driveType: DriveType;
  chorusMix: number;
  chorusRate: number;
  delayTime: number;
  delayFb: number;
  delayMix: number;
  delayPan: number;
  delayHP: number;
  delayLP: number;
  reverbSize: number;
  reverbMix: number;
  reverbPre: number;
  reverbDamp: number;
  // 主输出
  bitDepth: number;
  stereoWidth: number;
  masterPan: number;
  masterFilterType: FilterType;
  masterFilterCutoff: number;
  masterFilterReso: number;
  volume: number;
  // 宏
  macroComplex: number;
  macroBright: number;
  macroThick: number;
  macroSpace: number;
  // 调制矩阵（4 槽）
  mod1Src: ModSrc;
  mod1Dst: ModDst;
  mod1Amt: number;
  mod2Src: ModSrc;
  mod2Dst: ModDst;
  mod2Amt: number;
  mod3Src: ModSrc;
  mod3Dst: ModDst;
  mod3Amt: number;
  mod4Src: ModSrc;
  mod4Dst: ModDst;
  mod4Amt: number;
}

/** `Partial<SynthPatch>` 的别名 —— 面板/存档里流进来的都是这个形状 */
export type SynthPatchInput = Partial<Record<keyof SynthPatch, unknown>>;

// ---------------------------------------------------------------------------
// 基准 patch 与出厂默认
// ---------------------------------------------------------------------------

/** 加法引擎的谐波条数（原型是 16，后来扩到 32 —— 高次泛音被截掉就没有「尾巴」） */
export const ADD_HARMONICS = 32;
/** 加法引擎的默认谐波幅度：第 1 条最强，往后平滑衰减 */
export const DEFAULT_HARM: readonly number[] = [
  1, 0.5, 0.34, 0.25, 0.2, 0.16, 0.13, 0.11,
  0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.035, 0.03,
  0.027, 0.024, 0.022, 0.02, 0.018, 0.016, 0.015, 0.014,
  0.013, 0.012, 0.011, 0.01, 0.0095, 0.009, 0.0085, 0.008,
];
/** Unison 声部上限 */
export const MAX_UNISON = 16;

/**
 * 谐波数组归一：长度向上取齐 32，逐条夹到 `[0,1]`，非有限值补 0。
 *
 * ⚠️ 「数组参数」不能走 `pickNumber` 那条路 —— 它是 patch 里唯一的非数字，
 * 存档里可能出现 16 条（旧版）、33 条、`null`、带字符串的数组。
 * 长度不一致会让 `patchEquals` 判成不同 patch（预设名永远显示「自定义」），
 * 所以这里**先定长再比对**。
 */
export function fitHarm(raw: unknown): number[] {
  const out = new Array<number>(ADD_HARMONICS).fill(0);
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < Math.min(raw.length, ADD_HARMONICS); i++) {
    const v = raw[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
  return out;
}

/**
 * 预设的**作曲基准**（来自 `原型/效果器/VFX声音设计/VFX.html` 的 DEFAULTS）。
 *
 * ⚠️ 它与「出厂默认」是两件事，不能合并：
 * 27 款预设全部是「在 VFX 的初始参数上只改写少数几项」写出来的，
 * 所以套用预设必须 `{...SYNTH_BASE_PATCH, ...preset}` —— 拿别的底去套，
 * 没被预设提到的那些参数会带着当前值/出厂值进来，音色就不是当初调的那个了。
 */
export const SYNTH_BASE_PATCH: SynthPatch = {
  engineType: 'classic',
  osc1Wave: 'sawtooth',
  osc1Oct: 0,
  osc1Detune: 0,
  osc1Level: 0.6,
  osc1Pan: 0,
  osc2Wave: 'square',
  osc2Oct: -1,
  osc2Detune: 8,
  osc2Level: 0.32,
  osc2Pan: 0,
  osc3Wave: 'sine',
  osc3Oct: 1,
  osc3Detune: -6,
  osc3Level: 0.16,
  osc3Pan: 0,
  noiseLevel: 0,
  oscPW: 0.5,
  fmDepth: 0,
  rmDepth: 0,
  // 波表
  wtCat: 'analog',
  wtTable: 0,
  wtPos: 0.35,
  // 齐奏 / 音高包络
  unison: 1,
  unisonDetune: 14,
  unisonSpread: 0.75,
  pitchEnvAmt: 0,
  pitchEnvDecay: 0.15,
  // FM 4 算子
  fmAlgo: 0,
  fmRatio: 2,
  fmRatio3: 1,
  fmDepth3: 0,
  fmRatio4: 3,
  fmDepth4: 0,
  fmCar: 0.7,
  fmSub: 0.3,
  // 加法
  addHarm: DEFAULT_HARM.slice(),
  addTilt: 0.35,
  addEnvAmt: 0,
  addEnvDecay: 0.5,
  // 弦鸣
  strDamp: 4500,
  strDecay: 0.985,
  strLevel: 0.8,
  // 粒子
  granTex: 'saw',
  granSize: 0.09,
  granDensity: 16,
  granPos: 0.3,
  granRand: 0.5,
  granPitch: 0,
  granLevel: 0.7,
  // 噪声引擎
  noiseColor: 'pink',
  noiseEngLevel: 0.55,
  filterType: 'lowpass',
  filterCutoff: 2800,
  filterReso: 5,
  filterEnv: 4500,
  filterKey: 0.35,
  filterSlope: 12,
  filterDrive: 0,
  fAttack: 0.004,
  fDecay: 0.35,
  fSustain: 0.25,
  fRelease: 0.35,
  ampAttack: 0.004,
  ampDecay: 0.28,
  ampSustain: 0.72,
  ampRelease: 0.32,
  glideTime: 0.02,
  monoMode: 0,
  velSens: 1,
  lfoWave: 'sine',
  lfoRate: 5,
  lfoPitchAmt: 0,
  lfoFilterAmt: 0,
  lfoAmpAmt: 0,
  lfo2Wave: 'triangle',
  lfo2Rate: 0.5,
  lfo2PitchAmt: 0,
  lfo2FilterAmt: 0,
  lfo2AmpAmt: 0,
  drive: 0,
  driveType: 'soft',
  chorusMix: 0,
  chorusRate: 0.6,
  delayTime: 0.3,
  delayFb: 0.3,
  delayMix: 0,
  delayPan: 0,
  delayHP: 20,
  delayLP: 8000,
  reverbSize: 2.2,
  reverbMix: 0.12,
  reverbPre: 0.01,
  reverbDamp: 5000,
  bitDepth: 16,
  stereoWidth: 1,
  masterPan: 0,
  masterFilterType: 'lowpass',
  masterFilterCutoff: 20000,
  masterFilterReso: 0.7,
  volume: 0.75,
  // 宏 & 调制矩阵
  macroComplex: 0,
  macroBright: 0,
  macroThick: 0,
  macroSpace: 0,
  mod1Src: 'lfo1',
  mod1Dst: 'wtpos',
  mod1Amt: 0,
  mod2Src: 'env',
  mod2Dst: 'cutoff',
  mod2Amt: 0,
  mod3Src: 'vel',
  mod3Dst: 'amp',
  mod3Amt: 0,
  mod4Src: 'key',
  mod4Dst: 'pan',
  mod4Amt: 0,
};

// ---------------------------------------------------------------------------
// 预设
// ---------------------------------------------------------------------------

/**
 * 音色预设表。**键名即基准**：套用一律走 `{...SYNTH_BASE_PATCH, ...preset}`。
 *
 * 全部沿用 `原型/效果器/VFX.html` 的调音结果（那是用户自己调出来的），
 * 只把「参考音 · 清铃」新增为出厂默认。
 */
export const SYNTH_PRESETS: Readonly<Record<string, SynthPatchInput>> = {
  /* ---------- 出厂默认 ---------- */
  /**
   * 「参考音 · 清铃」—— 出厂默认**刻意做成干、短、单薄**。
   *
   * 理由：这个声部最主要的工作是**录制时的跟弹参考音**（以及空槽键的兜底声）。
   * 参考音一旦带长混响/延迟尾巴，拍点会被尾巴糊住，录到第 3、4 个音就听不清
   * 「我按对了没有」—— 而这正是参考音的全部意义。
   * 想要氛围音色，面板里有 27 款，随手换。
   *
   * ⛔ **`osc1Oct` 必须是 0 —— 参考音必须与按下的键同音高。**
   * 实测教训：这版最初照抄了原型「清铃」的 `osc1Oct: 1 / osc2Oct: 2`，
   * 于是按 C4 实际响 C5。而「跟弹参考音」的全部价值就是让你听出**自己按的音对不对**，
   * 高一个八度直接让这个判据失效。回归：`patch.test.ts` 的「出厂参考音必须与按键同音高」。
   * 想保留「清铃」的八度叠色，就把两个振荡器**一起**下移一个八度（本预设即如此）。
   */
  '参考音 · 清铃': {
    osc1Wave: 'sine',
    osc1Oct: 0,
    osc1Detune: 0,
    osc1Level: 0.62,
    osc2Wave: 'sine',
    osc2Oct: 1,
    osc2Detune: 4,
    osc2Level: 0.2,
    osc3Level: 0,
    noiseLevel: 0,
    fmDepth: 0.06,
    filterType: 'lowpass',
    filterCutoff: 6200,
    filterReso: 2,
    filterEnv: 1600,
    filterKey: 0.3,
    fAttack: 0.001,
    fDecay: 0.5,
    fSustain: 0,
    fRelease: 0.5,
    ampAttack: 0.001,
    ampDecay: 0.95,
    ampSustain: 0,
    ampRelease: 1,
    drive: 0,
    chorusMix: 0.16,
    chorusRate: 0.5,
    delayMix: 0,
    reverbSize: 1.6,
    reverbMix: 0.1,
    reverbPre: 0.01,
    reverbDamp: 6000,
    stereoWidth: 1.15,
    volume: 0.72,
  },

  /* ---------- 基础 ---------- */
  '基础锯齿 · 初始': {},

  /* ---------- 主音 / 低音 ---------- */
  '主音 · 超宽锯齿': {
    osc1Wave: 'sawtooth', osc1Detune: -12, osc1Level: 0.55, osc1Pan: -0.4,
    osc2Wave: 'sawtooth', osc2Detune: 14, osc2Level: 0.5, osc2Pan: 0.4,
    osc3Wave: 'square', osc3Oct: 1, osc3Level: 0.18,
    noiseLevel: 0.02, fmDepth: 0.08,
    filterType: 'lowpass', filterCutoff: 3600, filterReso: 9, filterEnv: 5200, filterKey: 0.5,
    fAttack: 0.006, fDecay: 0.5, fSustain: 0.35, fRelease: 0.5,
    ampAttack: 0.006, ampDecay: 0.9, ampSustain: 0.75, ampRelease: 0.45,
    lfoRate: 5.6, lfoPitchAmt: 7,
    drive: 0.18, driveType: 'soft', chorusMix: 0.35, chorusRate: 0.55,
    delayTime: 0.28, delayFb: 0.34, delayMix: 0.22, delayPan: 0.3,
    reverbSize: 2.4, reverbMix: 0.2, reverbPre: 0.02, reverbDamp: 6000,
    stereoWidth: 1.5, volume: 0.72,
  },
  '低音 · 神经质': {
    osc1Wave: 'sawtooth', osc1Oct: -2, osc1Level: 0.75,
    osc2Wave: 'square', osc2Oct: -1, osc2Detune: 22, osc2Level: 0.45,
    osc3Wave: 'sine', osc3Oct: -1, osc3Level: 0.35,
    noiseLevel: 0.06, fmDepth: 0.35, rmDepth: 0.15,
    filterType: 'lowpass', filterCutoff: 620, filterReso: 14, filterEnv: 3800, filterKey: 0.6,
    fAttack: 0.002, fDecay: 0.22, fSustain: 0.12, fRelease: 0.2,
    ampAttack: 0.002, ampDecay: 0.4, ampSustain: 0.85, ampRelease: 0.18,
    lfoWave: 'square', lfoRate: 8.2, lfoFilterAmt: 900,
    lfo2Wave: 'sine', lfo2Rate: 0.3, lfo2PitchAmt: 18,
    drive: 0.55, driveType: 'hard', chorusMix: 0.12,
    delayTime: 0.16, delayFb: 0.2, delayMix: 0.08,
    reverbSize: 1.2, reverbMix: 0.06, bitDepth: 12,
    monoMode: 1, glideTime: 0.03, volume: 0.7,
  },
  '铺底 · 梦幻氛围': {
    osc1Wave: 'sawtooth', osc1Detune: -9, osc1Level: 0.4, osc1Pan: -0.5,
    osc2Wave: 'triangle', osc2Oct: 1, osc2Detune: 11, osc2Level: 0.3, osc2Pan: 0.5,
    osc3Wave: 'sine', osc3Oct: 2, osc3Detune: -4, osc3Level: 0.14,
    noiseLevel: 0.03,
    filterType: 'lowpass', filterCutoff: 1800, filterReso: 3, filterEnv: 2600, filterKey: 0.25,
    fAttack: 1.2, fDecay: 2.2, fSustain: 0.5, fRelease: 2.6,
    ampAttack: 1.1, ampDecay: 2.5, ampSustain: 0.78, ampRelease: 2.8,
    lfoWave: 'sine', lfoRate: 0.28, lfoPitchAmt: 5, lfoFilterAmt: 1200, lfoAmpAmt: 0.05,
    lfo2Wave: 'triangle', lfo2Rate: 0.12, lfo2FilterAmt: 800,
    drive: 0.05, chorusMix: 0.55, chorusRate: 0.3,
    delayTime: 0.52, delayFb: 0.48, delayMix: 0.32, delayPan: -0.4,
    reverbSize: 5, reverbMix: 0.48, reverbPre: 0.06, reverbDamp: 4000,
    stereoWidth: 1.6, volume: 0.68,
  },
  '拨弦 · 明亮 Pluck': {
    osc1Wave: 'sawtooth', osc1Oct: 1, osc1Level: 0.5,
    osc2Wave: 'square', osc2Detune: 6, osc2Level: 0.3,
    osc3Wave: 'sine', osc3Oct: 2, osc3Level: 0.12,
    filterType: 'lowpass', filterCutoff: 900, filterReso: 8, filterEnv: 8000, filterKey: 0.4,
    fAttack: 0.001, fDecay: 0.18, fSustain: 0, fRelease: 0.2,
    ampAttack: 0.001, ampDecay: 0.28, ampSustain: 0, ampRelease: 0.24,
    lfoRate: 4,
    drive: 0.1, chorusMix: 0.25, chorusRate: 0.8,
    delayTime: 0.24, delayFb: 0.42, delayMix: 0.34, delayPan: 0.5, delayHP: 200,
    reverbSize: 2.8, reverbMix: 0.3, reverbPre: 0.03,
    stereoWidth: 1.3, volume: 0.72,
  },
  '酸性 · 303 贝斯': {
    osc1Wave: 'sawtooth', osc1Oct: -1, osc1Level: 0.85,
    osc3Wave: 'sine', osc3Oct: -2, osc3Level: 0.2,
    filterType: 'lowpass', filterCutoff: 380, filterReso: 18, filterEnv: 6200, filterKey: 0.5,
    fAttack: 0.001, fDecay: 0.24, fSustain: 0, fRelease: 0.16,
    ampAttack: 0.002, ampDecay: 0.35, ampSustain: 0.6, ampRelease: 0.14,
    lfoWave: 'sawtooth', lfoRate: 6.4, lfoFilterAmt: 400,
    drive: 0.42, driveType: 'soft', chorusMix: 0.1,
    delayTime: 0.22, delayFb: 0.3, delayMix: 0.18,
    reverbSize: 1.4, reverbMix: 0.1,
    monoMode: 1, glideTime: 0.05, volume: 0.72,
  },

  /* ---------- 铃音家族 ---------- */
  '钟琴 · 清亮铃音': {
    osc1Wave: 'sine', osc1Oct: 1, osc1Level: 0.6,
    osc2Wave: 'sine', osc2Oct: 2, osc2Detune: 12, osc2Level: 0.28,
    osc3Wave: 'triangle', osc3Oct: 3, osc3Detune: -8, osc3Level: 0.1,
    filterType: 'lowpass', filterCutoff: 6500, filterReso: 2, filterEnv: 2000, filterKey: 0.3,
    fAttack: 0.001, fDecay: 1.4, fSustain: 0.15, fRelease: 1.6,
    ampAttack: 0.001, ampDecay: 2.2, ampSustain: 0.08, ampRelease: 2.4,
    lfoRate: 3.2, lfoPitchAmt: 3, lfoAmpAmt: 0.04,
    drive: 0, chorusMix: 0.3, chorusRate: 0.5,
    delayTime: 0.36, delayFb: 0.4, delayMix: 0.3, delayPan: 0.4,
    reverbSize: 4.2, reverbMix: 0.44, reverbPre: 0.02,
    stereoWidth: 1.4, volume: 0.7,
  },
  '音乐盒 · 甜梦': {
    osc1Wave: 'sine', osc1Oct: 2, osc1Level: 0.55, osc1Pan: -0.15,
    osc2Wave: 'sine', osc2Oct: 3, osc2Detune: 4, osc2Level: 0.2, osc2Pan: 0.15,
    osc3Wave: 'triangle', osc3Oct: 1, osc3Detune: -3, osc3Level: 0.12,
    fmDepth: 0.05,
    filterType: 'lowpass', filterCutoff: 8000, filterReso: 1.5, filterEnv: 1500, filterKey: 0.2,
    fAttack: 0.001, fDecay: 1, fSustain: 0.1, fRelease: 1.5,
    ampAttack: 0.001, ampDecay: 1.8, ampSustain: 0.05, ampRelease: 2,
    lfoWave: 'sine', lfoRate: 5.2, lfoPitchAmt: 2, lfoAmpAmt: 0.03,
    chorusMix: 0.25, chorusRate: 0.5,
    delayTime: 0.33, delayFb: 0.35, delayMix: 0.28, delayPan: 0.35, delayHP: 200, delayLP: 8000,
    reverbSize: 3.8, reverbMix: 0.4, reverbPre: 0.02, reverbDamp: 6500,
    stereoWidth: 1.35, volume: 0.7,
  },
  '水晶铃 · 闪烁': {
    osc1Wave: 'sine', osc1Oct: 2, osc1Detune: 0, osc1Level: 0.5, osc1Pan: -0.5,
    osc2Wave: 'sine', osc2Oct: 3, osc2Detune: 12, osc2Level: 0.32, osc2Pan: 0.5,
    osc3Wave: 'sine', osc3Oct: 4, osc3Detune: -6, osc3Level: 0.15,
    noiseLevel: 0.015, fmDepth: 0.15,
    filterType: 'highpass', filterCutoff: 400, filterReso: 2, filterEnv: 2000, filterKey: 0.3,
    fAttack: 0.001, fDecay: 0.9, fSustain: 0.05, fRelease: 1.2,
    ampAttack: 0.001, ampDecay: 1.6, ampSustain: 0.03, ampRelease: 2.2,
    lfoRate: 6.8, lfoPitchAmt: 3, lfoAmpAmt: 0.06,
    lfo2Wave: 'sine', lfo2Rate: 0.18, lfo2FilterAmt: 3000,
    chorusMix: 0.4, chorusRate: 0.7,
    delayTime: 0.28, delayFb: 0.5, delayMix: 0.4, delayPan: 0.6, delayHP: 300, delayLP: 12000,
    reverbSize: 4.8, reverbMix: 0.5, reverbPre: 0.03, reverbDamp: 8000,
    stereoWidth: 1.7, volume: 0.68,
  },
  'FM 钟 · 金属': {
    osc1Wave: 'sine', osc1Oct: 0, osc1Level: 0.65,
    osc2Wave: 'sine', osc2Oct: 2, osc2Detune: 7, osc2Level: 0,
    osc3Wave: 'sine', osc3Oct: 3, osc3Detune: -5, osc3Level: 0.1,
    fmDepth: 0.55,
    filterType: 'lowpass', filterCutoff: 7000, filterReso: 2, filterEnv: 2000, filterKey: 0.2,
    fAttack: 0.001, fDecay: 1.5, fSustain: 0.08, fRelease: 1.8,
    ampAttack: 0.001, ampDecay: 2.4, ampSustain: 0.04, ampRelease: 2.6,
    lfoRate: 4.2, lfoPitchAmt: 4, lfoAmpAmt: 0.04,
    drive: 0.05, driveType: 'soft', chorusMix: 0.3, chorusRate: 0.45,
    delayTime: 0.38, delayFb: 0.42, delayMix: 0.32, delayPan: -0.4,
    reverbSize: 4.5, reverbMix: 0.45, reverbPre: 0.02, reverbDamp: 6000,
    stereoWidth: 1.5, volume: 0.7,
  },
  '颤音琴 · 流动': {
    osc1Wave: 'sine', osc1Oct: 1, osc1Level: 0.62, osc1Pan: -0.2,
    osc2Wave: 'sine', osc2Oct: 2, osc2Detune: 5, osc2Level: 0.22, osc2Pan: 0.2,
    osc3Wave: 'triangle', osc3Oct: 0, osc3Level: 0.1,
    fmDepth: 0.08,
    filterType: 'lowpass', filterCutoff: 5500, filterReso: 2, filterEnv: 1500, filterKey: 0.25,
    fAttack: 0.005, fDecay: 1.2, fSustain: 0.2, fRelease: 1.5,
    ampAttack: 0.005, ampDecay: 2, ampSustain: 0.15, ampRelease: 2.2,
    lfoWave: 'sine', lfoRate: 5.5, lfoPitchAmt: 0, lfoFilterAmt: 0, lfoAmpAmt: 0.22,
    chorusMix: 0.28, chorusRate: 0.55,
    delayTime: 0.35, delayFb: 0.38, delayMix: 0.28, delayPan: 0.3,
    reverbSize: 4, reverbMix: 0.42, reverbPre: 0.02, reverbDamp: 5500,
    stereoWidth: 1.4, volume: 0.7,
  },
  '马林巴 · 木质': {
    osc1Wave: 'triangle', osc1Oct: 1, osc1Level: 0.65, osc1Pan: -0.15,
    osc2Wave: 'sine', osc2Oct: 2, osc2Detune: 8, osc2Level: 0.18, osc2Pan: 0.15,
    osc3Wave: 'sine', osc3Oct: 0, osc3Level: 0.15,
    noiseLevel: 0.02, fmDepth: 0.1,
    filterType: 'lowpass', filterCutoff: 3200, filterReso: 3, filterEnv: 3500, filterKey: 0.3,
    fAttack: 0.001, fDecay: 0.35, fSustain: 0, fRelease: 0.4,
    ampAttack: 0.001, ampDecay: 0.55, ampSustain: 0, ampRelease: 0.5,
    lfoRate: 3,
    drive: 0.08, driveType: 'soft', chorusMix: 0.15, chorusRate: 0.7,
    delayTime: 0.22, delayFb: 0.25, delayMix: 0.15,
    reverbSize: 2.2, reverbMix: 0.25, reverbPre: 0.01, reverbDamp: 4000,
    stereoWidth: 1.2, volume: 0.72,
  },
  '管钟 · 教堂': {
    osc1Wave: 'sine', osc1Oct: 0, osc1Level: 0.6,
    osc2Wave: 'sine', osc2Oct: 1, osc2Detune: 12, osc2Level: 0.3,
    osc3Wave: 'sine', osc3Oct: 2, osc3Detune: -7, osc3Level: 0.12,
    fmDepth: 0.2,
    filterType: 'lowpass', filterCutoff: 3500, filterReso: 1.5, filterEnv: 1000, filterKey: 0.15,
    fAttack: 0.008, fDecay: 2.5, fSustain: 0.15, fRelease: 3,
    ampAttack: 0.008, ampDecay: 3.5, ampSustain: 0.1, ampRelease: 4,
    lfoRate: 2.8, lfoPitchAmt: 3, lfoAmpAmt: 0.04,
    chorusMix: 0.3, chorusRate: 0.3,
    delayTime: 0.55, delayFb: 0.45, delayMix: 0.3, delayPan: -0.5,
    reverbSize: 6, reverbMix: 0.55, reverbPre: 0.08, reverbDamp: 4500,
    stereoWidth: 1.5, volume: 0.68,
  },
  '电钢琴 · 温暖': {
    osc1Wave: 'sine', osc1Oct: 0, osc1Level: 0.55, osc1Pan: -0.1,
    osc2Wave: 'sine', osc2Oct: 1, osc2Detune: 3, osc2Level: 0.2, osc2Pan: 0.1,
    osc3Wave: 'triangle', osc3Oct: 0, osc3Detune: -2, osc3Level: 0.18,
    fmDepth: 0.35,
    filterType: 'lowpass', filterCutoff: 2800, filterReso: 2, filterEnv: 2200, filterKey: 0.35,
    fAttack: 0.002, fDecay: 0.9, fSustain: 0.25, fRelease: 1,
    ampAttack: 0.002, ampDecay: 1.5, ampSustain: 0.18, ampRelease: 1.4,
    lfoRate: 4.5, lfoPitchAmt: 2, lfoAmpAmt: 0.05,
    drive: 0.1, driveType: 'soft', chorusMix: 0.45, chorusRate: 0.35,
    delayTime: 0.32, delayFb: 0.3, delayMix: 0.22, delayPan: 0.2,
    reverbSize: 3.2, reverbMix: 0.35, reverbPre: 0.02, reverbDamp: 5000,
    stereoWidth: 1.3, volume: 0.72,
  },
  '空灵铃 · 飘渺': {
    osc1Wave: 'sine', osc1Oct: 2, osc1Level: 0.45, osc1Pan: -0.55,
    osc2Wave: 'sine', osc2Oct: 3, osc2Detune: 14, osc2Level: 0.3, osc2Pan: 0.55,
    osc3Wave: 'sine', osc3Oct: 4, osc3Detune: -9, osc3Level: 0.12,
    noiseLevel: 0.025, fmDepth: 0.1,
    filterType: 'bandpass', filterCutoff: 2800, filterReso: 3, filterEnv: 1200, filterKey: 0.2,
    fAttack: 0.02, fDecay: 1.8, fSustain: 0.15, fRelease: 2.2,
    ampAttack: 0.02, ampDecay: 2.6, ampSustain: 0.1, ampRelease: 3,
    lfoWave: 'sine', lfoRate: 0.22, lfoPitchAmt: 6, lfoFilterAmt: 2500, lfoAmpAmt: 0.08,
    lfo2Wave: 'triangle', lfo2Rate: 0.1, lfo2FilterAmt: 1500,
    chorusMix: 0.55, chorusRate: 0.25,
    delayTime: 0.48, delayFb: 0.52, delayMix: 0.38, delayPan: 0.5, delayHP: 400, delayLP: 10000,
    reverbSize: 5.5, reverbMix: 0.55, reverbPre: 0.05, reverbDamp: 7000,
    stereoWidth: 1.8, volume: 0.66,
  },
  '玻璃竖琴 · 通透': {
    osc1Wave: 'sine', osc1Oct: 2, osc1Level: 0.5, osc1Pan: -0.3,
    osc2Wave: 'sine', osc2Oct: 1, osc2Detune: 8, osc2Level: 0.25, osc2Pan: 0.3,
    osc3Wave: 'triangle', osc3Oct: 3, osc3Detune: -5, osc3Level: 0.12,
    fmDepth: 0.06,
    filterType: 'highpass', filterCutoff: 300, filterReso: 1.5, filterEnv: 1500, filterKey: 0.25,
    fAttack: 0.003, fDecay: 1.2, fSustain: 0.1, fRelease: 1.5,
    ampAttack: 0.003, ampDecay: 1.8, ampSustain: 0.06, ampRelease: 1.8,
    lfoRate: 4.8, lfoPitchAmt: 2, lfoAmpAmt: 0.04,
    chorusMix: 0.35, chorusRate: 0.6,
    delayTime: 0.4, delayFb: 0.45, delayMix: 0.32, delayPan: -0.35,
    reverbSize: 4.6, reverbMix: 0.45, reverbPre: 0.03, reverbDamp: 7500,
    stereoWidth: 1.5, volume: 0.7,
  },
  '八音盒 Pad · 梦境': {
    osc1Wave: 'sine', osc1Oct: 2, osc1Detune: -4, osc1Level: 0.4, osc1Pan: -0.35,
    osc2Wave: 'sine', osc2Oct: 1, osc2Detune: 6, osc2Level: 0.28, osc2Pan: 0.35,
    osc3Wave: 'triangle', osc3Oct: 3, osc3Level: 0.1,
    noiseLevel: 0.01, fmDepth: 0.08,
    filterType: 'lowpass', filterCutoff: 3200, filterReso: 2.5, filterEnv: 1800, filterKey: 0.2,
    fAttack: 0.6, fDecay: 1.8, fSustain: 0.4, fRelease: 2.5,
    ampAttack: 0.5, ampDecay: 2.2, ampSustain: 0.5, ampRelease: 2.8,
    lfoWave: 'sine', lfoRate: 0.35, lfoPitchAmt: 4, lfoFilterAmt: 800, lfoAmpAmt: 0.06,
    lfo2Wave: 'triangle', lfo2Rate: 0.15, lfo2PitchAmt: 3, lfo2FilterAmt: 600,
    chorusMix: 0.5, chorusRate: 0.35,
    delayTime: 0.45, delayFb: 0.48, delayMix: 0.35, delayPan: 0.4,
    reverbSize: 5.2, reverbMix: 0.5, reverbPre: 0.04, reverbDamp: 6000,
    stereoWidth: 1.65, volume: 0.66,
  },
  '铃铛 Pad · 圣咏': {
    osc1Wave: 'sine', osc1Oct: 0, osc1Detune: -6, osc1Level: 0.35, osc1Pan: -0.5,
    osc2Wave: 'sine', osc2Oct: 1, osc2Detune: 6, osc2Level: 0.3, osc2Pan: 0.5,
    osc3Wave: 'sine', osc3Oct: 2, osc3Detune: -3, osc3Level: 0.15,
    noiseLevel: 0.02, fmDepth: 0.12,
    filterType: 'lowpass', filterCutoff: 2400, filterReso: 2, filterEnv: 1800, filterKey: 0.25,
    fAttack: 0.5, fDecay: 2, fSustain: 0.45, fRelease: 2.8,
    ampAttack: 0.45, ampDecay: 2.5, ampSustain: 0.55, ampRelease: 3,
    lfoWave: 'sine', lfoRate: 0.28, lfoPitchAmt: 5, lfoFilterAmt: 1000, lfoAmpAmt: 0.05,
    lfo2Wave: 'triangle', lfo2Rate: 0.12, lfo2PitchAmt: 3, lfo2FilterAmt: 700,
    chorusMix: 0.5, chorusRate: 0.3,
    delayTime: 0.5, delayFb: 0.5, delayMix: 0.35, delayPan: -0.45,
    reverbSize: 5.8, reverbMix: 0.55, reverbPre: 0.06, reverbDamp: 5000,
    stereoWidth: 1.75, volume: 0.65,
  },
  '闪烁 Pluck · 星光': {
    osc1Wave: 'square', osc1Oct: 1, osc1Level: 0.3, osc1Pan: -0.4,
    osc2Wave: 'sine', osc2Oct: 3, osc2Detune: 10, osc2Level: 0.4, osc2Pan: 0.4,
    osc3Wave: 'sine', osc3Oct: 2, osc3Detune: -6, osc3Level: 0.2,
    fmDepth: 0.25,
    filterType: 'lowpass', filterCutoff: 2200, filterReso: 6, filterEnv: 7000, filterKey: 0.4,
    fAttack: 0.001, fDecay: 0.22, fSustain: 0, fRelease: 0.25,
    ampAttack: 0.001, ampDecay: 0.3, ampSustain: 0, ampRelease: 0.3,
    lfoRate: 7,
    drive: 0.05, driveType: 'soft', chorusMix: 0.3, chorusRate: 0.9,
    delayTime: 0.25, delayFb: 0.55, delayMix: 0.4, delayPan: 0.5, delayHP: 400,
    reverbSize: 3.8, reverbMix: 0.4, reverbPre: 0.02, reverbDamp: 8000,
    stereoWidth: 1.6, volume: 0.7,
  },
  '钢片琴 · 星尘': {
    osc1Wave: 'sine', osc1Oct: 3, osc1Level: 0.45, osc1Pan: -0.3,
    osc2Wave: 'sine', osc2Oct: 4, osc2Detune: 10, osc2Level: 0.25, osc2Pan: 0.3,
    osc3Wave: 'sine', osc3Oct: 2, osc3Detune: -4, osc3Level: 0.18,
    fmDepth: 0.12,
    filterType: 'highpass', filterCutoff: 500, filterReso: 1.5, filterEnv: 1200, filterKey: 0.3,
    fAttack: 0.001, fDecay: 0.8, fSustain: 0.03, fRelease: 1,
    ampAttack: 0.001, ampDecay: 1.3, ampSustain: 0.02, ampRelease: 1.6,
    lfoRate: 5.8, lfoPitchAmt: 2, lfoAmpAmt: 0.05,
    chorusMix: 0.35, chorusRate: 0.55,
    delayTime: 0.3, delayFb: 0.45, delayMix: 0.35, delayPan: 0.45, delayHP: 350,
    reverbSize: 4.4, reverbMix: 0.48, reverbPre: 0.03, reverbDamp: 9000,
    stereoWidth: 1.65, volume: 0.68,
  },
  '玩具钢琴 · 童年': {
    osc1Wave: 'triangle', osc1Oct: 1, osc1Level: 0.6, osc1Pan: -0.2,
    osc2Wave: 'sine', osc2Oct: 2, osc2Detune: 6, osc2Level: 0.22, osc2Pan: 0.2,
    osc3Wave: 'square', osc3Oct: 0, osc3Level: 0.08,
    noiseLevel: 0.03,
    filterType: 'lowpass', filterCutoff: 4200, filterReso: 3, filterEnv: 2500, filterKey: 0.35,
    fAttack: 0.001, fDecay: 0.5, fSustain: 0.05, fRelease: 0.6,
    ampAttack: 0.001, ampDecay: 0.7, ampSustain: 0.03, ampRelease: 0.8,
    lfoRate: 4.2, lfoPitchAmt: 2,
    drive: 0.08, driveType: 'soft', chorusMix: 0.2, chorusRate: 0.65,
    delayTime: 0.2, delayFb: 0.3, delayMix: 0.22, delayPan: 0.3,
    reverbSize: 2.4, reverbMix: 0.3, reverbPre: 0.01, reverbDamp: 5500,
    stereoWidth: 1.25, volume: 0.72,
  },

  /* ---------- 特殊质感 ---------- */
  '硬核 · 主音下坠': {
    osc1Wave: 'sawtooth', osc1Detune: -18, osc1Level: 0.6, osc1Pan: -0.6,
    osc2Wave: 'sawtooth', osc2Detune: 18, osc2Level: 0.6, osc2Pan: 0.6,
    osc3Wave: 'square', osc3Oct: -1, osc3Level: 0.25,
    noiseLevel: 0.04, fmDepth: 0.12,
    filterType: 'lowpass', filterCutoff: 2200, filterReso: 11, filterEnv: 6000, filterKey: 0.4,
    fAttack: 0.004, fDecay: 0.6, fSustain: 0.3, fRelease: 0.5,
    ampAttack: 0.004, ampDecay: 0.8, ampSustain: 0.8, ampRelease: 0.4,
    lfoWave: 'triangle', lfoRate: 7.5, lfoFilterAmt: 1500,
    lfo2Wave: 'sine', lfo2Rate: 0.25, lfo2FilterAmt: 2200,
    drive: 0.35, driveType: 'fold', chorusMix: 0.4, chorusRate: 0.7,
    delayTime: 0.34, delayFb: 0.36, delayMix: 0.25, delayPan: -0.3,
    reverbSize: 2.6, reverbMix: 0.24, reverbPre: 0.04, reverbDamp: 5000,
    stereoWidth: 1.8, volume: 0.7,
  },
  '环调 · 金属质感': {
    osc1Wave: 'square', osc1Oct: 0, osc1Level: 0.6,
    osc2Wave: 'sine', osc2Oct: 1, osc2Level: 0,
    rmDepth: 0.85, fmDepth: 0.2,
    filterType: 'bandpass', filterCutoff: 1800, filterReso: 6, filterEnv: 3000,
    fAttack: 0.005, fDecay: 0.8, fSustain: 0.4, fRelease: 0.6,
    ampAttack: 0.005, ampDecay: 1.2, ampSustain: 0.5, ampRelease: 0.8,
    lfoRate: 2.3, lfoPitchAmt: 12,
    drive: 0.25, driveType: 'fold', chorusMix: 0.4,
    delayTime: 0.4, delayFb: 0.5, delayMix: 0.35, delayPan: 0.6,
    reverbSize: 3.5, reverbMix: 0.4, reverbPre: 0.05,
    bitDepth: 10, stereoWidth: 1.5, volume: 0.68,
  },
  '比特 · 复古 8bit': {
    osc1Wave: 'square', osc1Oct: 0, osc1Level: 0.7,
    osc2Wave: 'square', osc2Oct: -1, osc2Detune: 5, osc2Level: 0.35,
    noiseLevel: 0.05,
    filterType: 'lowpass', filterCutoff: 4500, filterReso: 2, filterEnv: 2000,
    fAttack: 0.001, fDecay: 0.15, fSustain: 0.3, fRelease: 0.15,
    ampAttack: 0.001, ampDecay: 0.2, ampSustain: 0.7, ampRelease: 0.15,
    drive: 0.3, driveType: 'hard',
    delayTime: 0.14, delayFb: 0.28, delayMix: 0.18,
    reverbSize: 1.2, reverbMix: 0.12,
    bitDepth: 4, stereoWidth: 0.4, volume: 0.7,
  },
  '上升 Riser · 紧张': {
    osc1Wave: 'sawtooth', osc1Oct: -1, osc1Level: 0.5, osc1Pan: -0.3,
    osc2Wave: 'sawtooth', osc2Detune: 22, osc2Level: 0.45, osc2Pan: 0.3,
    osc3Wave: 'square', osc3Oct: 1, osc3Level: 0.2,
    noiseLevel: 0.15, fmDepth: 0.2,
    filterType: 'bandpass', filterCutoff: 600, filterReso: 12, filterEnv: 9000, filterKey: 0.3,
    fAttack: 2.5, fDecay: 2, fSustain: 1, fRelease: 0.3,
    ampAttack: 2, ampDecay: 1.5, ampSustain: 1, ampRelease: 0.4,
    lfoWave: 'sine', lfoRate: 0.5, lfoPitchAmt: 0, lfoFilterAmt: 3500, lfoAmpAmt: 0,
    lfo2Wave: 'triangle', lfo2Rate: 0.25, lfo2FilterAmt: 2500,
    drive: 0.25, driveType: 'soft', chorusMix: 0.4, chorusRate: 0.3,
    delayTime: 0.25, delayFb: 0.5, delayMix: 0.35, delayPan: 0.5,
    reverbSize: 4, reverbMix: 0.45, reverbPre: 0.04, reverbDamp: 6000,
    stereoWidth: 1.7, volume: 0.68,
  },
  '低吼 Bass · 工业': {
    osc1Wave: 'sawtooth', osc1Oct: -2, osc1Level: 0.7,
    osc2Wave: 'square', osc2Oct: -2, osc2Detune: 15, osc2Level: 0.35,
    osc3Wave: 'sine', osc3Oct: -3, osc3Level: 0.3,
    noiseLevel: 0.04, fmDepth: 0.4,
    filterType: 'lowpass', filterCutoff: 420, filterReso: 10, filterEnv: 2800, filterKey: 0.5,
    fAttack: 0.001, fDecay: 0.3, fSustain: 0.15, fRelease: 0.25,
    ampAttack: 0.001, ampDecay: 0.5, ampSustain: 0.7, ampRelease: 0.2,
    lfoWave: 'square', lfoRate: 3.5, lfoFilterAmt: 600,
    drive: 0.6, driveType: 'hard', chorusMix: 0.1,
    delayTime: 0.18, delayFb: 0.22, delayMix: 0.1,
    reverbSize: 1.4, reverbMix: 0.1,
    bitDepth: 11, monoMode: 1, glideTime: 0.04, volume: 0.7,
  },
};

/** 预设名列表（顺序稳定 = 声明顺序），供面板下拉与键盘导航 */
export const SYNTH_PRESET_NAMES = Object.keys(SYNTH_PRESETS);

/** 出厂默认音色的预设名 */
export const SYNTH_DEFAULT_PRESET_NAME = '参考音 · 清铃';

/**
 * 套用预设 —— **必须先垫基准 patch**，理由见 `SYNTH_BASE_PATCH` 的注释。
 * 结果经过 sanitize（预设数据里的笔误会在测试里先被抓住，这里是第二道闸）。
 */
export function patchFromPreset(name: string): SynthPatch {
  const preset = SYNTH_PRESETS[name];
  if (!preset) return sanitizeSynthPatch(SYNTH_BASE_PATCH);
  return sanitizeSynthPatch({ ...SYNTH_BASE_PATCH, ...preset });
}

/** 出厂默认 patch */
export const DEFAULT_SYNTH_PATCH: SynthPatch = patchFromPreset(
  SYNTH_DEFAULT_PRESET_NAME,
);

// ---------------------------------------------------------------------------
// 校验 / 归一
// ---------------------------------------------------------------------------

function pickEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  def: T,
): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : def;
}

function pickNumber(raw: unknown, spec: NumericSpec): number {
  // 只接受真正的有限数字：字符串 "0.5"、null、undefined、NaN、Infinity
  // 一律回落到默认值 —— 「猜用户想填多少」比直接给默认值更危险。
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.def;
  if (raw < spec.min) return spec.min;
  if (raw > spec.max) return spec.max;
  return raw;
}

/**
 * 把任意输入归一成**完整、有限、在范围内**的 patch。
 *
 * 保证：
 *   ① 缺键 → 默认值（不是 undefined）；
 *   ② 非有限数 / 非数字 / 越界 → 默认值 / 夹取；
 *   ③ 未知键 → 丢弃（不写进结果，避免脏键随存档来回传播）；
 *   ④ **幂等**：`sanitize(sanitize(x)) === sanitize(x)`；
 *   ⑤ 输出永远可以通过 `SYNTH_NUMERIC_PARAMS` 逐键喂给 `AudioParam`
 *      而不抛 `TypeError`。
 */
export function sanitizeSynthPatch(raw: unknown): SynthPatch {
  const src = (raw ?? {}) as SynthPatchInput;
  const out = {} as SynthPatch;

  for (const key of SYNTH_NUMERIC_PARAMS) {
    // 逐键写：TS 在这里无法做键级的交叉推断，故用一次受控断言（先过 unknown，
    // 因为 SynthPatch 没有索引签名 —— 直接断到 Record 会被判定为「无重叠」）
    (out as unknown as Record<string, number>)[key] = pickNumber(
      src[key as keyof SynthPatch],
      SYNTH_NUMERIC_SPECS[key],
    );
  }

  out.osc1Wave = pickEnum(
    src.osc1Wave,
    ['sawtooth', 'square', 'triangle', 'sine', 'pulse'],
    'sawtooth',
  );
  out.osc2Wave = pickEnum(
    src.osc2Wave,
    ['sawtooth', 'square', 'triangle', 'sine', 'pulse'],
    'square',
  );
  out.osc3Wave = pickEnum(
    src.osc3Wave,
    ['sawtooth', 'square', 'triangle', 'sine', 'pulse'],
    'sine',
  );
  out.engineType = pickEnum(
    src.engineType,
    ['classic', 'wavetable', 'fm', 'additive', 'string', 'granular', 'noise'],
    'classic',
  );
  out.wtCat = pickEnum(src.wtCat, ['analog', 'digital', 'bass', 'pad', 'fx'], 'analog');
  out.noiseColor = pickEnum(src.noiseColor, ['white', 'pink', 'brown'], 'pink');
  out.granTex = pickEnum(src.granTex, ['saw', 'bell', 'vox', 'air'], 'saw');

  const MOD_SRCS = [
    'none', 'lfo1', 'lfo2', 'env', 'fenv', 'vel', 'key', 'rand', 'm1', 'm2', 'm3', 'm4',
  ] as const;
  const MOD_DSTS = [
    'none', 'pitch', 'cutoff', 'reso', 'amp', 'pan', 'fm', 'wtpos', 'pw', 'drive',
    'reverb', 'delay', 'bit',
  ] as const;
  out.mod1Src = pickEnum(src.mod1Src, MOD_SRCS, 'lfo1');
  out.mod1Dst = pickEnum(src.mod1Dst, MOD_DSTS, 'wtpos');
  out.mod2Src = pickEnum(src.mod2Src, MOD_SRCS, 'env');
  out.mod2Dst = pickEnum(src.mod2Dst, MOD_DSTS, 'cutoff');
  out.mod3Src = pickEnum(src.mod3Src, MOD_SRCS, 'vel');
  out.mod3Dst = pickEnum(src.mod3Dst, MOD_DSTS, 'amp');
  out.mod4Src = pickEnum(src.mod4Src, MOD_SRCS, 'key');
  out.mod4Dst = pickEnum(src.mod4Dst, MOD_DSTS, 'pan');

  // 唯一的数组参数：定长 + 逐条夹取（见 fitHarm 注释）
  out.addHarm = fitHarm(src.addHarm);
  out.filterType = pickEnum(
    src.filterType,
    ['lowpass', 'highpass', 'bandpass', 'notch'],
    'lowpass',
  );
  out.masterFilterType = pickEnum(
    src.masterFilterType,
    ['lowpass', 'highpass', 'bandpass', 'notch'],
    'lowpass',
  );
  out.lfoWave = pickEnum(src.lfoWave, ['sine', 'triangle', 'square', 'sawtooth'], 'sine');
  out.lfo2Wave = pickEnum(src.lfo2Wave, ['sine', 'triangle', 'square', 'sawtooth'], 'triangle');
  out.driveType = pickEnum(src.driveType, ['soft', 'hard', 'fold'], 'soft');
  out.monoMode = src.monoMode === 1 || src.monoMode === '1' ? 1 : 0;

  return out;
}

/**
 * 按 spec 的 `step` 量化（面板与存档共用）。
 * 缺省步进 0.001 —— 比它更细的差别在听感上不存在，却会让存档字符串无限长。
 */
export function quantizeSynthParam(name: SynthNumericParam, value: number): number {
  const spec = SYNTH_NUMERIC_SPECS[name];
  const step = spec.step ?? 0.001;
  const decimals = (String(step).split('.')[1] ?? '').length;
  const snapped = Number((Math.round(value / step) * step).toFixed(decimals));
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

/**
 * 单参数校验 —— 引擎侧的唯一入口。
 *
 * 实现刻意复用 `sanitizeSynthPatch`（**只有一条校验路径**）：`{...patch, [name]: raw}`
 * 过一遍完整归一，再取回那一个键。64 次夹取的代价在拖动频率下可以忽略，
 * 换来的是「数值键和枚举键走同一套规则、不会有一类被漏掉」。
 */
export function sanitizeSynthParamValue(
  name: keyof SynthPatch,
  raw: unknown,
  current: SynthPatch,
): SynthPatch[keyof SynthPatch] {
  return sanitizeSynthPatch({ ...current, [name]: raw })[name];
}

/**
 * 出厂默认 patch 的「有声」下限检查 —— 面板/引擎两侧都靠它兜底。
 *
 * ⚠️ 用**绝对量**而不是相对量：`Σ level > 0` 这种判据在「所有 level 都是 0」
 * 时才会失败，而那是唯一真正「按下去没声」的配置。相对指标（占比之类）
 * 在静音时是 0/0，永远判不出来。
 */
export function patchIsAudible(patch: SynthPatch): boolean {
  /*
    ⛔ 判据必须**按引擎**分派。曾经的写法是「三个振荡器的音量之和 > 0」——
    那在经典引擎上成立，但在波表 / FM / 加法 / 弦鸣 / 粒子 / 噪声上是
    **永远为假**：这些引擎压根不读 `osc1Level`~`osc3Level`（波表读 osc1Level，
    FM 读 fmCar/fmSub，弦鸣读 strLevel…）。
    后果是「切到粒子引擎之后，面板上所有预设都被判成静音」——
    而它并不静音。这正是「相对指标测不出输出全零」那条规矩的反面教材：
    判据必须落在**真正喂声音的那个参数**上。
  */
  const common = patch.noiseLevel;
  switch (patch.engineType) {
    case 'wavetable':
      return patch.osc1Level + common > 0.001;
    case 'fm':
      return patch.fmCar + patch.fmSub + common > 0.001;
    case 'additive':
      return patch.osc1Level + common > 0.001;
    case 'string':
      return patch.strLevel + common > 0.001;
    case 'granular':
      return patch.granLevel + common > 0.001;
    case 'noise':
      return patch.noiseEngLevel + common > 0.001;
    default:
      return patch.osc1Level + patch.osc2Level + patch.osc3Level + common > 0.001;
  }
}

// ---------------------------------------------------------------------------
// 宏系统
// ---------------------------------------------------------------------------

/** 四个宏的名字（宏是「一次拧动带动一串参数」的组合旋钮） */
export type MacroName = 'macroComplex' | 'macroBright' | 'macroThick' | 'macroSpace';

export const MACRO_NAMES: readonly MacroName[] = [
  'macroComplex',
  'macroBright',
  'macroThick',
  'macroSpace',
];

/**
 * 宏 → 参数映射。
 *
 * ⛔ 每一条映射都必须**从基准 `b` 出发**，不能在函数里忽略 `b` 直接算。
 * 原型在这里栽过：`macroThick → unison` 原本写成 `1 + round(m*7)`，
 * 完全忽略 `b` —— 于是「厚度 = 0」时任何预设里写好的 Unison 都被强行打回 1，
 * 全部超锯 / 铺底音色变成单声部。这类「宏旋钮在 0 位反而破坏音色」的 bug
 * 从界面上完全看不出来（用户会以为「这个预设本来就是单声部」）。
 */
export const MACRO_MAP: Record<
  MacroName,
  ReadonlyArray<{ p: NumericSpecKey; f(b: number, m: number): number }>
> = {
  macroComplex: [
    { p: 'fmDepth', f: (b, m) => clampNum(b + m * 0.55, 0, 1) },
    { p: 'wtPos', f: (b, m) => (b + m * 0.6) % 1 },
    { p: 'noiseLevel', f: (b, m) => clampNum(b + m * 0.12, 0, 1) },
    { p: 'filterReso', f: (b, m) => clampNum(b + m * 6, 0.1, 24) },
    { p: 'filterDrive', f: (b, m) => clampNum(b + m * 0.45, 0, 1) },
    { p: 'granRand', f: (b, m) => clampNum(b + m * 0.5, 0, 1) },
  ],
  macroBright: [
    { p: 'filterCutoff', f: (b, m) => clampNum(b * (1 + m * 4), 40, 18000) },
    { p: 'drive', f: (b, m) => clampNum(b + m * 0.2, 0, 1) },
    { p: 'reverbDamp', f: (b, m) => clampNum(b + m * 5000, 500, 16000) },
  ],
  macroThick: [
    { p: 'unison', f: (b, m) => clampNum(Math.round(b + m * (MAX_UNISON - 1)), 1, MAX_UNISON) },
    { p: 'unisonDetune', f: (b, m) => clampNum(b + m * 18, 0, 50) },
    { p: 'chorusMix', f: (b, m) => clampNum(b + m * 0.4, 0, 1) },
    { p: 'stereoWidth', f: (b, m) => clampNum(b + m * 0.5, 0, 2) },
  ],
  macroSpace: [
    { p: 'reverbMix', f: (b, m) => clampNum(b + m * 0.5, 0, 1) },
    { p: 'reverbSize', f: (b, m) => clampNum(b + m * 2.5, 0.3, 6) },
    { p: 'delayMix', f: (b, m) => clampNum(b + m * 0.35, 0, 1) },
    { p: 'delayFb', f: (b, m) => clampNum(b + m * 0.25, 0, 0.92) },
  ],
};

/** 宏能改到的数值参数键（`MACRO_MAP` 的并集） */
export type NumericSpecKey = SynthNumericParam;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function isMacroName(name: string): name is MacroName {
  return (MACRO_NAMES as readonly string[]).includes(name);
}

/**
 * 计算「宏 = `value` 时，各被联动参数应该取什么值」。
 *
 * ⚠️ 这是一个**纯函数**，基准 `base` 由调用方给（见 `engine/synth/index.ts`
 * 的 `macroBase`）。宏必须是「相对基准的偏移」而不是「绝对赋值」——
 * 否则每款预设里辛苦调好的 `filterCutoff` / `unison` 会被宏旋钮一律抹平。
 *
 * 返回值只包含**需要改动的键**，调用方负责合并与推送（保持「一次 patch 写入
 * 走一条路径」）。
 */
export function applyMacroToPatch(
  base: SynthPatch,
  macro: MacroName,
  value: number,
): Partial<SynthPatch> {
  const m = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const out: Record<string, number> = {};
  for (const { p, f } of MACRO_MAP[macro]) {
    const b = base[p];
    if (typeof b !== 'number') continue;
    out[p] = quantizeSynthParam(p, f(b, m));
  }
  return out as Partial<SynthPatch>;
}
