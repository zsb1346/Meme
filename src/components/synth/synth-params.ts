/**
 * 音色设计面板的**布局定义**：分组、中文名、读数格式、哪个引擎才用得上。
 *
 * ⚠️ 范围（min / max / def / 手感曲线）**不在这里**，一律从
 * `engine/synth/patch.ts` 的 `SYNTH_NUMERIC_SPECS` 取（面板侧只调 `specOf()`）。
 * 面板只声明「哪几个参数放一组、叫什么名字、读数怎么显示」——
 * 两处各写一份范围是「旋钮拧到头读数还在涨」这类静默故障的固定来源。
 *
 * ══ 与原型 `VFX.html` 的对应关系 ══
 *
 * 原型是「引擎不同 → 卡片不同」：选波表才长出波表卡，选 FM 才长出算子卡。
 * 这里保留这条语义（`engines` 字段），但**参数本身一个不少**：
 * 原型 102 个旋钮 + 引擎选择器 + 调制矩阵，这里一一对应。
 * 单元测试 `synth-params.test.ts` 会断言：
 *   ① **每一个数值参数都恰好出现在某一个分组里**；
 *   ② **每一个非数值参数要么是段控、要么有专用编辑器**（即 `SynthPatch` 的
 *      每一个键都能在界面上找到入口）—— 新增参数忘了挂上去，测试会红。
 *
 * ══ 关于 `hidden` ══
 *
 * `wtTable`（波表）与 `fmAlgo`（FM 算法）由**专用编辑器**控制（波表浏览器、
 * 算法矩阵图），在网格里再画一个旋钮是重复且难用的。它们仍然声明在这里
 * —— 声明 = 覆盖度算数，`hidden` = 网格不画。
 * 二者必须成对出现：`CUSTOM_EDITOR_PARAMS` 是唯一的白名单，测试会双向校验。
 */

import {
  CLASSIC_WAVE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  ENGINE_OPTIONS,
  FILTER_TYPE_OPTIONS,
  GRAN_TEX_OPTIONS,
  LFO_WAVE_OPTIONS,
  MOD_DST_OPTIONS,
  MOD_SRC_OPTIONS,
  MONO_MODE_OPTIONS,
  NOISE_COLOR_OPTIONS,
  SYNTH_NUMERIC_PARAMS,
  SYNTH_NUMERIC_SPECS,
  WT_CAT_OPTIONS,
  type EngineType,
  type NumericSpec,
  type SynthNumericParam,
  type SynthPatch,
} from '../../engine/synth/patch';

/** 面板上的一个旋钮 */
export interface SynthKnobDef {
  p: SynthNumericParam;
  label: string;
  /** 数值文案（不含单位小字） */
  fmt(value: number): string;
  /** 单位小字；缺省无 */
  unitText?: string;
  /** 由专用编辑器控制：声明只为覆盖度，网格里不重复画旋钮 */
  hidden?: boolean;
}

/** 面板上的一组段控（枚举参数） */
export interface SynthSegDef {
  p: keyof SynthPatch;
  label: string;
  options: ReadonlyArray<readonly [string | number, string]>;

  /**
   * 分段值回写时是否转成数字。
   * `monoMode` 的选项值是 0/1（数字），其余枚举都是字符串 ——
   * 用一个显式开关表达，比在每个调用点 `Number(x)` 猜类型可靠。
   */
  numeric?: boolean;
}

export interface SynthGroup {
  id: string;
  title: string;
  hint: string;
  /** 弧色（沿用原型的配色语言；缺省用设计令牌的强调色） */
  accent?: string;
  segs: SynthSegDef[];
  knobs: SynthKnobDef[];
  /**
   * 只在这些引擎下有意义（缺省 = 所有引擎都显示）。
   *
   * ⛔ 这不是「省地方」：像 `granSize` 这种参数在经典引擎下**根本不进图**，
   * 摆出来拧只会得到「拧了没反应」。分组按引擎过滤，与原型一致。
   */
  engines?: EngineType[];
}

/** 需要专用编辑器的**数值**参数（波表选择 / FM 算法矩阵） */
export const CUSTOM_EDITOR_PARAMS: ReadonlyArray<SynthNumericParam> = ['wtTable', 'fmAlgo'];

/**
 * 需要专用编辑器的**非数值**参数（32 谐波数组）。
 *
 * 它不在 `SYNTH_NUMERIC_PARAMS` 里（value 是 `number[]`，一条曲线而不是一个数），
 * 所以覆盖度测试单独认这个清单 —— 否则「32 谐波编辑器」漏掉都没人发现。
 */
export const CUSTOM_ARRAY_PARAMS: ReadonlyArray<keyof SynthPatch> = ['addHarm'];

// ---------------------------------------------------------------------------
// 读数格式
// ---------------------------------------------------------------------------

const num0 = (v: number): string => String(Math.round(v));
const num1 = (v: number): string => v.toFixed(1);
const num2 = (v: number): string => v.toFixed(2);
const signed = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;
/** 半音数：`+12st` / `−7st`（音高包络与粒化音高用） */
const st = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v)}st`;

/** 频率：1k 以上折算成 k（旋钮直径只有 48px，读数越短越好） */
const hz = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : num0(v));

/** 时间：≥1s 显示秒，<1s 显示毫秒（对「起音 4ms」和「释放 3s」都可读） */
const time = (v: number): string =>
  v >= 1 ? num2(v) : Math.round(v * 1000).toString();

/** 声像：C / L50 / R50 */
const pan = (v: number): string =>
  v === 0 ? 'C' : v > 0 ? `R${Math.round(v * 100)}` : `L${Math.round(-v * 100)}`;

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

/** 振荡器类引擎（有真正的振荡器组、才有齐奏与音高包络可谈） */
const OSC_ENGINES: EngineType[] = ['classic', 'wavetable', 'additive', 'fm'];

export const SYNTH_GROUPS: SynthGroup[] = [
  {
    id: 'osc',
    title: '振荡器 · 引擎',
    accent: '#06b6d4',
    hint: '音色的「肉体」全在这里。切换引擎会换掉下面长出的专用分组（波表 / FM / 加法 / 弦鸣 / 粒子 / 噪声）',
    segs: [
      { p: 'engineType', label: '引擎', options: ENGINE_OPTIONS },
      // ⛔ 必须用 `CLASSIC_WAVE_OPTIONS`（比 `OSC_WAVE_OPTIONS` 多一个「脉冲」）：
      //    经典引擎的三个振荡器都吃脉宽，用少一项的那张表会让「脉宽」旋钮
      //    永远没有波形可作用 —— 表现为「这个旋钮拧了没反应」。
      { p: 'osc1Wave', label: '波形 1', options: CLASSIC_WAVE_OPTIONS },
      { p: 'osc2Wave', label: '波形 2', options: CLASSIC_WAVE_OPTIONS },
      { p: 'osc3Wave', label: '波形 3', options: CLASSIC_WAVE_OPTIONS },
    ],
    knobs: [
      { p: 'osc1Oct', label: '八度', fmt: signed, unitText: 'oct' },
      { p: 'osc1Detune', label: '微调', fmt: signed, unitText: 'cent' },
      { p: 'osc1Level', label: '音量', fmt: pct },
      { p: 'osc1Pan', label: '声像', fmt: pan },
      { p: 'osc2Oct', label: '八度', fmt: signed, unitText: 'oct' },
      { p: 'osc2Detune', label: '微调', fmt: signed, unitText: 'cent' },
      { p: 'osc2Level', label: '音量', fmt: pct },
      { p: 'osc2Pan', label: '声像', fmt: pan },
      { p: 'osc3Oct', label: '八度', fmt: signed, unitText: 'oct' },
      { p: 'osc3Detune', label: '微调', fmt: signed, unitText: 'cent' },
      { p: 'osc3Level', label: '音量', fmt: pct },
      { p: 'osc3Pan', label: '声像', fmt: pan },
      { p: 'noiseLevel', label: '噪声', fmt: pct },
      { p: 'oscPW', label: '脉宽', fmt: pct },
    ],
  },
  {
    id: 'wt',
    title: '波表',
    accent: '#8b5cf6',
    hint: '5 类 × 4 表 × 16 帧。用「波表浏览器」挑表，再拖「帧位置」在表内扫过去 —— 扫的过程就是音色的变化',
    engines: ['wavetable'],
    segs: [{ p: 'wtCat', label: '分类', options: WT_CAT_OPTIONS }],
    knobs: [
      // 表本身由「波表浏览器」选（4 张表的名字各不相同，旋钮读数放不下）
      { p: 'wtTable', label: '波表', fmt: num0, hidden: true },
      { p: 'wtPos', label: '帧位置', fmt: pct },
    ],
  },
  {
    id: 'fm',
    title: 'FM 算阵',
    accent: '#ec4899',
    hint: '4 算子 + 8 种算法。1 号恒为主载波；「算子 2」的调制指数就是「调制」组里的 FM 深度（经典引擎也用它）',
    engines: ['fm'],
    segs: [],
    knobs: [
      // 算法由矩阵图选（8 个名字塞不进旋钮读数）
      { p: 'fmAlgo', label: '算法', fmt: num0, hidden: true },
      // ⛔ 标签一律 ≤4 个字形：旋钮格在 7 列布局下只有 ~78px 宽，
      //    再长就被截成「算子 3…」—— 四个算子分不清哪个是哪个。
      { p: 'fmCar', label: '载波', fmt: pct },
      { p: 'fmSub', label: '次低音', fmt: pct },
      { p: 'fmRatio', label: '比 2', fmt: num2 },
      { p: 'fmDepth3', label: '深度 3', fmt: pct },
      { p: 'fmRatio3', label: '比 3', fmt: num2 },
      { p: 'fmDepth4', label: '深度 4', fmt: pct },
      { p: 'fmRatio4', label: '比 4', fmt: num2 },
    ],
  },
  {
    id: 'add',
    title: '加法合成',
    accent: '#a855f7',
    hint: '32 条谐波由「谐波编辑器」直接画。倾斜决定底色明暗，泛音衰减让高次谐波随时间先掉下去',
    engines: ['additive'],
    segs: [],
    knobs: [
      { p: 'addTilt', label: '频谱倾斜', fmt: pct },
      { p: 'addEnvAmt', label: '泛音衰减', fmt: pct },
      { p: 'addEnvDecay', label: '衰减时间', fmt: time, unitText: 'ms' },
    ],
  },
  {
    id: 'string',
    title: '弦鸣',
    accent: '#f59e0b',
    hint: 'Karplus-Strong：一段噪声「拨」进延迟环，环里的低通决定音色、反馈量决定能响多久',
    engines: ['string'],
    segs: [],
    knobs: [
      { p: 'strDamp', label: '阻尼', fmt: hz, unitText: 'Hz' },
      { p: 'strDecay', label: '延音', fmt: (v) => `${(v * 100).toFixed(1)}%` },
      { p: 'strLevel', label: '音量', fmt: pct },
    ],
  },
  {
    id: 'gran',
    title: '粒子',
    accent: '#14b8a6',
    hint: '把一段合成素材切碎、随机取位置与音高，撒成一片云。密度 × 粒径决定「颗粒感」还是「糊成一片」',
    engines: ['granular'],
    segs: [{ p: 'granTex', label: '素材', options: GRAN_TEX_OPTIONS }],
    knobs: [
      { p: 'granSize', label: '粒径', fmt: time, unitText: 'ms' },
      { p: 'granDensity', label: '密度', fmt: num0, unitText: '/s' },
      { p: 'granPos', label: '位置', fmt: pct },
      { p: 'granRand', label: '随机', fmt: pct },
      { p: 'granPitch', label: '音高', fmt: st },
      { p: 'granLevel', label: '音量', fmt: pct },
    ],
  },
  {
    id: 'noiseEng',
    title: '噪声引擎',
    accent: '#64748b',
    hint: '整段循环噪声直接当音源（噪声打击乐 / 风 / 嘶声的底子）',
    engines: ['noise'],
    segs: [{ p: 'noiseColor', label: '颜色', options: NOISE_COLOR_OPTIONS }],
    knobs: [{ p: 'noiseEngLevel', label: '音量', fmt: pct }],
  },
  {
    id: 'unison',
    title: '齐奏 Unison',
    accent: '#f43f5e',
    hint: '同一个音叠 N 个失谐副本 → 超锯 / 铺底。声部数进来就是 N 倍振荡器，别在弱机器上开到 16',
    engines: OSC_ENGINES,
    segs: [],
    knobs: [
      { p: 'unison', label: '声部数', fmt: (v) => `${Math.round(v)}×` },
      { p: 'unisonDetune', label: '失谐', fmt: (v) => `${Math.round(v)}c` },
      { p: 'unisonSpread', label: '立体声', fmt: pct },
    ],
  },
  {
    id: 'pitchenv',
    title: '音高包络',
    accent: '#0ea5e9',
    hint: '起音时偏 N 个半音再滑回来。底鼓、激光、拨弦的「啪」都是它；量给 0 就完全不作用',
    engines: OSC_ENGINES,
    segs: [],
    knobs: [
      { p: 'pitchEnvAmt', label: '量', fmt: st },
      { p: 'pitchEnvDecay', label: '衰减', fmt: time, unitText: 'ms' },
    ],
  },
  {
    id: 'mod',
    title: '调制',
    accent: '#eab308',
    hint: 'FM / 环形调制 + 两个 LFO。让静态音色「活起来」的那部分',
    segs: [
      { p: 'lfoWave', label: 'LFO 1', options: LFO_WAVE_OPTIONS },
      { p: 'lfo2Wave', label: 'LFO 2', options: LFO_WAVE_OPTIONS },
    ],
    knobs: [
      { p: 'fmDepth', label: 'FM 深度', fmt: pct },
      { p: 'rmDepth', label: '环形调制', fmt: pct },
      /*
        ⛔ 两个 LFO 的四个目标必须带序号前缀（`1 速率` / `2 音量`）。
        原先写成「LFO1 速率 / →音高 / →滤波 / →音量」——「LFO1 速率」被截成
        「LFO1 …」，而后面那六个「→音高 / →滤波 / →音量」**没法区分是哪个 LFO 的**：
        想调 LFO2 的音高量，只能靠数格子。
      */
      { p: 'lfoRate', label: '1 速率', fmt: num2, unitText: 'Hz' },
      { p: 'lfoPitchAmt', label: '1 音高', fmt: signed, unitText: 'cent' },
      { p: 'lfoFilterAmt', label: '1 滤波', fmt: hz, unitText: 'Hz' },
      { p: 'lfoAmpAmt', label: '1 音量', fmt: pct },
      { p: 'lfo2Rate', label: '2 速率', fmt: num2, unitText: 'Hz' },
      { p: 'lfo2PitchAmt', label: '2 音高', fmt: signed, unitText: 'cent' },
      { p: 'lfo2FilterAmt', label: '2 滤波', fmt: hz, unitText: 'Hz' },
      { p: 'lfo2AmpAmt', label: '2 音量', fmt: pct },
    ],
  },
  {
    id: 'matrix',
    title: '调制矩阵',
    accent: '#eab308',
    hint: '四槽「源 → 目标 → 深度」。深度可负；把量拖回 0 就等于关掉这一槽（槽全关时引擎的节拍定时器会自己停）',
    segs: [
      { p: 'mod1Src', label: '槽 1 源', options: MOD_SRC_OPTIONS },
      { p: 'mod1Dst', label: '槽 1 目标', options: MOD_DST_OPTIONS },
      { p: 'mod2Src', label: '槽 2 源', options: MOD_SRC_OPTIONS },
      { p: 'mod2Dst', label: '槽 2 目标', options: MOD_DST_OPTIONS },
      { p: 'mod3Src', label: '槽 3 源', options: MOD_SRC_OPTIONS },
      { p: 'mod3Dst', label: '槽 3 目标', options: MOD_DST_OPTIONS },
      { p: 'mod4Src', label: '槽 4 源', options: MOD_SRC_OPTIONS },
      { p: 'mod4Dst', label: '槽 4 目标', options: MOD_DST_OPTIONS },
    ],
    knobs: [
      { p: 'mod1Amt', label: '深度 1', fmt: signed },
      { p: 'mod2Amt', label: '深度 2', fmt: signed },
      { p: 'mod3Amt', label: '深度 3', fmt: signed },
      { p: 'mod4Amt', label: '深度 4', fmt: signed },
    ],
  },
  {
    id: 'macro',
    title: '宏',
    accent: '#6366f1',
    hint: '一次拖多个参数的快捷方式。手动拧过的参数会立刻成为新基准，宏不会把它拽回去',
    segs: [],
    knobs: [
      { p: 'macroComplex', label: '复杂度', fmt: pct },
      { p: 'macroBright', label: '亮度', fmt: pct },
      { p: 'macroThick', label: '厚度', fmt: pct },
      { p: 'macroSpace', label: '空间', fmt: pct },
    ],
  },
  {
    id: 'filter',
    title: '滤波 + 滤波包络',
    accent: '#f59e0b',
    hint: '决定「亮 / 暗」与「哇音」的形状。斜率 24dB 会在声部里串上第二级；共振拧过头会自己唱起来，后面有线内限幅兜着',
    segs: [{ p: 'filterType', label: '类型', options: FILTER_TYPE_OPTIONS }],
    knobs: [
      { p: 'filterCutoff', label: '截止', fmt: hz, unitText: 'Hz' },
      { p: 'filterReso', label: '共振', fmt: num1 },
      { p: 'filterEnv', label: '包络量', fmt: hz, unitText: 'Hz' },
      { p: 'filterKey', label: '键跟随', fmt: pct },
      { p: 'filterSlope', label: '斜率', fmt: (v) => `${Math.round(v)}dB` },
      { p: 'filterDrive', label: '前级驱动', fmt: pct },
      { p: 'fAttack', label: '起音', fmt: time, unitText: 'ms' },
      { p: 'fDecay', label: '衰减', fmt: time, unitText: 'ms' },
      { p: 'fSustain', label: '保持', fmt: pct },
      { p: 'fRelease', label: '释放', fmt: time, unitText: 'ms' },
    ],
  },
  {
    id: 'play',
    title: '音量包络 + 演奏',
    accent: '#06b6d4',
    hint: '音量包络决定「怎么响完」；演奏控制决定连弹时的行为（单音 + 滑音 = 贝斯味）',
    segs: [{ p: 'monoMode', label: '演奏模式', options: MONO_MODE_OPTIONS, numeric: true }],
    knobs: [
      { p: 'ampAttack', label: '起音', fmt: time, unitText: 'ms' },
      { p: 'ampDecay', label: '衰减', fmt: time, unitText: 'ms' },
      { p: 'ampSustain', label: '保持', fmt: pct },
      { p: 'ampRelease', label: '释放', fmt: time, unitText: 'ms' },
      { p: 'glideTime', label: '滑音', fmt: time, unitText: 'ms' },
      { p: 'velSens', label: '力度', fmt: pct },
    ],
  },
  {
    id: 'fx',
    title: '效果',
    accent: '#fb7185',
    hint: '过载 → 合唱 → 延迟 → 混响。当跟弹参考音时请保持「干」，否则尾巴会糊住拍点',
    segs: [{ p: 'driveType', label: '过载类型', options: DRIVE_TYPE_OPTIONS }],
    knobs: [
      { p: 'drive', label: '过载', fmt: pct },
      { p: 'chorusMix', label: '合唱深度', fmt: pct },
      { p: 'chorusRate', label: '合唱速率', fmt: num2, unitText: 'Hz' },
      { p: 'delayTime', label: '延迟时间', fmt: time, unitText: 'ms' },
      { p: 'delayFb', label: '反馈', fmt: pct },
      { p: 'delayMix', label: '延迟干湿', fmt: pct },
      { p: 'delayPan', label: '延迟声像', fmt: pan },
      { p: 'delayHP', label: '延迟高通', fmt: hz, unitText: 'Hz' },
      { p: 'delayLP', label: '延迟低通', fmt: hz, unitText: 'Hz' },
      { p: 'reverbSize', label: '空间', fmt: num1, unitText: 's' },
      { p: 'reverbMix', label: '混响干湿', fmt: pct },
      { p: 'reverbPre', label: '预延迟', fmt: time, unitText: 'ms' },
      { p: 'reverbDamp', label: '阻尼', fmt: hz, unitText: 'Hz' },
    ],
  },
  {
    id: 'master',
    title: '主输出',
    accent: '#0ea5e9',
    hint: '最后一道着色。总截止是「一键变闷」的好用旋钮',
    segs: [{ p: 'masterFilterType', label: '总滤波', options: FILTER_TYPE_OPTIONS }],
    knobs: [
      { p: 'volume', label: '主音量', fmt: pct },
      { p: 'bitDepth', label: '比特', fmt: num0, unitText: 'bit' },
      { p: 'stereoWidth', label: '立体声', fmt: pct },
      { p: 'masterPan', label: '总声像', fmt: pan },
      { p: 'masterFilterCutoff', label: '总截止', fmt: hz, unitText: 'Hz' },
      { p: 'masterFilterReso', label: '总共振', fmt: num1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 当前引擎下应当显示的分组（原型语义：引擎决定了长出哪些专用卡） */
export function visibleGroups(engineType: EngineType): SynthGroup[] {
  return SYNTH_GROUPS.filter((g) => !g.engines || g.engines.indexOf(engineType) >= 0);
}

/** 网格里真正要画的旋钮（`hidden` 的由专用编辑器负责） */
export function visibleKnobs(g: SynthGroup): SynthKnobDef[] {
  return g.knobs.filter((k) => !k.hidden);
}

/**
 * 面板里出现过的全部参数（含段控、含只由专用编辑器控制的那些）。
 *
 * **这是「界面上到底能不能碰到这个参数」的唯一口径** ——
 * 测试拿它跟 `SynthPatch` 的全部键比对，差一个就红。
 */
export function paramsCoveredByPanel(): Array<keyof SynthPatch> {
  const out: Array<keyof SynthPatch> = [];
  for (const g of SYNTH_GROUPS) {
    for (const s of g.segs) out.push(s.p);
    for (const k of g.knobs) out.push(k.p);
  }
  out.push(...CUSTOM_ARRAY_PARAMS);
  return out;
}

/** 面板里出现过的数值参数（含 `hidden`，含自定义编辑器） */
export function numericParamsCoveredByPanel(): SynthNumericParam[] {
  const out = SYNTH_GROUPS.flatMap((g) => g.knobs.map((k) => k.p));
  return [...new Set(out)];
}

/** 某个数值参数的 spec（面板直接拿来喂给 Knob） */
export function specOf(p: SynthNumericParam): NumericSpec {
  return SYNTH_NUMERIC_SPECS[p];
}

// ---------------------------------------------------------------------------
// 标签宽度（实测出来的硬约束）
// ---------------------------------------------------------------------------

/**
 * 旋钮标签的估算宽度，单位 = 一个汉字的宽度。
 *
 * ⛔ 这条约束必须机器化。实测（1440 宽的弹层、7 列旋钮格、Knob 直径 48px）：
 *   · 「延迟时间」（4.0 个汉字宽）**刚好不截断**；
 *   · 「LFO1 速率」（4.5）被截成「LFO1 …」；
 *   · 「算子3 指数」（5.5）被截成「算子 3…」。
 * 而截断之后的表现是**两个不同的参数看起来一样**（比如 LFO1/LFO2 的「→音高」），
 * 用户只能靠数格子判断谁是谁 —— 这正是「面板像半成品」的来源。
 */
export function knobLabelWidth(label: string): number {
  let w = 0;
  for (const ch of label) {
    // 拉丁字母 / 数字 / 常见标点比汉字窄得多（'FM' 只占一个汉字的量级）
    if (/[A-Za-z0-9.]/.test(ch)) w += 0.55;
    else if (ch === ' ') w += 0.3;
    else w += 1;
  }
  return w;
}

/** 旋钮标签宽度上限（见 `knobLabelWidth` 的实测数据） */
export const KNOB_LABEL_MAX_WIDTH = 4.2;

/** 未被面板覆盖的数值参数（应为空；测试用） */
export function uncoveredNumericParams(): SynthNumericParam[] {
  const covered = new Set(numericParamsCoveredByPanel());
  return SYNTH_NUMERIC_PARAMS.filter((p) => !covered.has(p));
}

/** 声明为 `hidden` 但不在白名单里的参数（应为空；测试用） */
export function misdeclaredHiddenKnobs(): SynthNumericParam[] {
  const allow = new Set<string>(CUSTOM_EDITOR_PARAMS);
  return SYNTH_GROUPS.flatMap((g) => g.knobs.filter((k) => k.hidden))
    .map((k) => k.p)
    .filter((p) => !allow.has(p));
}

/** 在白名单里、却没被任何分组声明为 `hidden` 的参数（应为空；测试用） */
export function unboundCustomEditorParams(): SynthNumericParam[] {
  const declared = new Set<string>(
    SYNTH_GROUPS.flatMap((g) => g.knobs.filter((k) => k.hidden)).map((k) => k.p),
  );
  return CUSTOM_EDITOR_PARAMS.filter((p) => !declared.has(p));
}
