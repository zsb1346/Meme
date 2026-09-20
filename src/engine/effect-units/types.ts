/**
 * 效果单元注册表的类型契约（Wave 2 重构）。
 *
 * 设计要点：
 * - 每个效果单元（EQ3 / Compressor / Chorus / Reverb）用一个 `EffectUnit<S, N>`
 *   常量描述：如何创建 Tone 节点、如何幂等应用参数、参数规格表（供 UI 渲染）、
 *   可选的异步就绪（Reverb IR）。
 * - 注册表（registry.ts）把异构的各单元归并成同构数组。TS 无法直接表达
 *   「异构泛型列表」，故提供擦除视图 `AnyEffectUnit`：create/apply/readValue
 *   一律用**方法语法**声明 —— 方法参数是双变的（strictFunctionTypes 只约束
 *   函数属性），因此 `EffectUnit<EqSettings, Tone.EQ3>` 可以零断言地赋给
 *   `AnyEffectUnit`，而调用侧保持单态、完全类型安全。
 * - `NumericFieldKeys` 特意做成**分布式**条件类型：作用于四级设置的联合时
 *   给出全部成员数值键的并集，这正是参数规格在擦除视图中保持协变所需的性质。
 */
import type * as Tone from 'tone';
import type {
  ChorusSettings,
  CompressorSettings,
  EffectSettings,
  EqSettings,
  ReverbSettings,
} from '../../model/types';

/**
 * 注册表覆盖的四级节点 id。
 * 用 Extract 从 EffectSettings 的键里取 —— id 与 store 的 effects 结构
 * 由类型系统强制相关（新增/改名一级而不同步此处会直接编译失败）。
 * 标量 masterGainDb 不是节点级，不入注册表（由主增益段单独处理）。
 */
export type StageId = Extract<
  keyof EffectSettings,
  'eq' | 'compressor' | 'chorus' | 'reverb'
>;

/** 四级节点设置切片的联合（AnyEffectUnit 擦除 S/N 后的运行时形态） */
export type StageSettings =
  | EqSettings
  | CompressorSettings
  | ChorusSettings
  | ReverbSettings;

/**
 * 参数徽章单位（与 ui/Slider 的 SliderUnit 数值子集一致，可直接透传）。
 * `raw` = 无单位裸数字（如混响的「空间」系数 0.3~3、压缩比）。
 */
export type EffectParamUnit = 'db' | 'pct' | 'ms' | 'sec' | 'ratio' | 'hz' | 'deg' | 'raw';

/**
 * S 中值为 number 的字段名。
 * 滑条天然只绑数值字段；enabled 等布尔开关走旁路开关（PowerToggle），
 * 不进参数表。分布式：NumericFieldKeys<A | B> = NumericFieldKeys<A> | NumericFieldKeys<B>。
 */
export type NumericFieldKeys<S> = S extends unknown
  ? { [P in keyof S]-?: NonNullable<S[P]> extends number ? P : never }[keyof S]
  : never;

/** 单个滑条参数的规格（旧 MixPage ParamSpec 的引擎侧转写，字段一一对应） */
export interface EffectParamSpec<S> {
  /**
   * 本级设置对象的数值字段名。
   * NumericFieldKeys<S> 是 `keyof S & string` 的子集 —— 收窄的原因：
   * 满规格 key 必须能直接用于 readValue/写入漏斗而不需要运行时守卫。
   */
  key: NumericFieldKeys<S>;
  /** 滑条左侧标签 */
  label: string;
  /** 数值徽章格式；缺省按裸数字展示 */
  unit?: EffectParamUnit;
  min: number;
  max: number;
  step: number;
  /** 双击徽章时的重置默认值（镜像 model/store DEFAULT_EFFECTS 对应字段） */
  def: number;
  /**
   * 该参数的 store 写入防抖时长（默认由 MixPage 的 DEBOUNCE_MS 决定）。
   * reverb.decaySec 每次写入都会触发 Tone.Reverb 重建脉冲响应（IR），
   * 高频写入会造成可闻卡顿，故单独放宽到 400ms。
   */
  debounceMs?: number;
  /** 滑条下方的补充说明 */
  hint?: string;
}

/**
 * 效果单元：一个可挂上主总线的节点级 + 它的全部元数据。
 * S = 本级设置切片，N = 本级 Tone 节点类型（apply 处零断言拿到具体节点）。
 */
export interface EffectUnit<
  S extends StageSettings,
  N extends Tone.ToneAudioNode = Tone.ToneAudioNode,
> {
  readonly id: StageId;
  /** 卡片标题（中文，如「均衡器」） */
  readonly label: string;
  /** 卡片标题下的英文小字（如 'EQ3'）；缺省不渲染 */
  readonly en?: string;
  /** 信号流示意带上的短标签（如 'EQ'）；缺省不渲染 */
  readonly flowLabel?: string;
  /** 用初始设置创建 Tone 节点（Chorus 在此 start() LFO 等，语义与旧代码一致） */
  create(slice: S): N;
  /** 幂等应用最新参数（可高频调用；逐字段赋值，与旧 applyXxx 完全一致） */
  apply(node: N, slice: S): void;
  /**
   * 节点异步就绪（Reverb 的冲激响应生成等）。
   * buildEffectChain 会聚合所有单元的 ready()；离线渲染前必须 await。
   */
  ready?(node: N): Promise<void>;
  /** 读一个数值字段的实时值（UI 显示用；具体类型在各级定义处锁死，零断言） */
  readValue(slice: S, key: NumericFieldKeys<S>): number;
  /** 参数规格表（MixPage 据此渲染滑条；数组顺序即渲染顺序） */
  readonly params: ReadonlyArray<EffectParamSpec<S>>;
}

/**
 * 擦除后的参数规格：key 放宽为 string，其余字段与 EffectParamSpec 相同。
 * 不复用 EffectParamSpec<StageSettings> 的原因：TS 对泛型接口做结构变度
 * 分析时，穿过条件类型（NumericFieldKeys）无法证明协变，会把 S 判成
 * 不变，导致 EffectParamSpec<EqSettings> 无法赋给全联合实例化。
 * 独立的具体接口让每个属性各自平凡可判 —— 登记依旧零断言。
 */
export interface AnyParamSpec {
  key: string;
  label: string;
  unit?: EffectParamUnit;
  min: number;
  max: number;
  step: number;
  def: number;
  debounceMs?: number;
  hint?: string;
}

/**
 * 注册表运行时视图：S/N 已擦除，但方法语法的双变保证各具体单元可以
 * 零断言登记；消费方（effects.ts 链路组装 / MixPage 面板渲染）对本视图
 * 迭代时全部调用都是单态的。
 */
export interface AnyEffectUnit {
  readonly id: StageId;
  readonly label: string;
  readonly en?: string;
  readonly flowLabel?: string;
  create(slice: StageSettings): Tone.ToneAudioNode;
  apply(node: Tone.ToneAudioNode, slice: StageSettings): void;
  ready?(node: Tone.ToneAudioNode): Promise<void>;
  /**
   * 擦除视图里 key 放宽为 string：调用方（MixPage）传入的恒为同一单元
   * params 表里的 key，配对由「规格来自同一 unit」这一运行时事实保证；
   * 各具体单元的定义处仍是窄化的 NumericFieldKeys<S>。
   */
  readValue(slice: StageSettings, key: string): number;
  readonly params: ReadonlyArray<AnyParamSpec>;
}
