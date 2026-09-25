/**
 * 全项目统一术语与类型定义（计划文档 §1 词汇表的代码化）。
 *
 * 本文件是 P1 定死的接口地基：P2 各 UI agent 只允许 import 这些类型，
 * 不允许自行发明同义结构。所有音乐时序字段一律来自 AudioContext 硬件时钟；
 * `createdAtMs` / `updatedAtMs` 仅为元数据展示，不参与任何音频调度。
 */

/** 素材唯一标识 */
export type SampleId = string;
/**
 * 空字符串 '' 为保留值：表示"未装配的槽位"（如 Key.sequence 中的空槽）。
 * 播放/导出遇到 '' 会静默跳过。真实素材 id 永远非空（uid() 不产生空串）。
 */
/** 键唯一标识 */
export type KeyId = string;
/** 录制唯一标识 */
export type TakeId = string;

/**
 * Sample 素材 —— 一段已解码音频的元数据。
 * 原始文件 Blob 不放在本结构里：Blob 存于 store.blobs 与 IndexedDB audio 库，
 * 解码后的 AudioBuffer 由 engine/sample-player 的运行时缓存持有。
 */
export interface Sample {
  id: SampleId;
  /** 展示名（切割器命名或上传文件名） */
  name: string;
  /** 时长（秒），解码后回填 */
  durationSec: number;
  /** YIN 检测到的原始音高（Hz）；检测失败为 null → UI 允许手动锚定 */
  detectedPitchHz: number | null;
  /** 用户手动微调的半音偏移（可为负/小数），归一关闭时是唯一变调来源 */
  manualSemitoneOffset: number;
  /** 元数据创建时间（仅展示排序用） */
  createdAtMs: number;
}

/** 序列槽位引用：Key.sequence 的元素 */
export interface SampleRef {
  sampleId: SampleId;
  /** 卷帘装配音符的目标 MIDI 音高；用于舞台演奏复现该音符音高。 */
  targetPitchMidi?: number;
  /** 此键槽位的装配移调覆盖；未设置时使用素材默认音高。 */
  pitchDelta?: number;
  /** 此键槽位的装配时长因子；未设置时为 1。 */
  timeFactor?: number;
}

/**
 * Key 键 —— 演奏台上的一个按钮。
 * 拥有有序素材槽位 sequence 与独立游标 cursor（键与键之间完全隔离）。
 */
export interface Key {
  id: KeyId;
  /** 展示标签（默认 = 音名如 C4 / D#3；用户可自定义） */
  label: string;
  /**
   * 键的固定音高（MIDI 音号）—— **键的身份字段，与位置无关**。
   * 写入后不再变：删除/截断其他键不影响它；半音开关也不改它（保住音）。
   * 可选仅为兼容「未经 migrateProject 的旧数据」；正常路径下 hydrate 后必有值。
   */
  pitchMidi?: number;
  /** 有序素材槽位；空序列 = 哑键（触发不出声，游标保持不动） */
  sequence: SampleRef[];
  /** 当前游标：trigger 后 cursor = (cursor+1) % sequence.length */
  cursor: number;
}

/** 单次按键事件。pressCount 为该键第几次按下（1 起计数）。 */
export interface TakeEvent {
  /** project.keys 的下标 */
  keyIndex: number;
  /** 该键第几次按（1-based），用于确定性重放 slot = (pressCount-1) % len */
  pressCount: number;
  /** 相对录制起点的秒数，取自 audioContext.currentTime */
  tSec: number;
  /** 可选力度 0..1 */
  velocity?: number;
  /** 此事件装配的素材；声音唯一来源。缺省/空串 = 空骨架（静音，最多电子参考音），
   *  不再回退全局 Key.sequence。 */
  sampleId?: SampleId;
  /**
   * MIDI 音高（0-127），独立于 keyIndex。
   * 录制时自动从 keyIndex 生成（do=C4=60），可在卷帘中上下拖拽修改。
   */
  pitch?: number;
  /**
   * 音符时长（秒）；点事件（录制默认）为 undefined。
   * 卷帘中可拖拽右边缘调整时长。
   */
  duration?: number;
  /**
   * 本放置（placement）专属的移调增量（带符号半音），叠加在
   * resolveSemitones(sample) 的基准之上；0/undefined = 无覆盖。
   * 由音符调色板按 Enter 提交到该事件；不写回 Sample。提交时同时镜像到
   * 对应 Key.sequence 槽位，使 Take 回放、导出与舞台实时演奏听感一致。
   */
  pitchDelta?: number;
  /**
   * 本放置专属的时长因子 τ（输出/输入时长比）；1/undefined = 无覆盖。
   * 作用域与提交方式同 pitchDelta，依赖 WASM 相位声码器解耦音高与时长。
   */
  timeFactor?: number;
}

/** Take 录制 —— 一次演奏会话的事件流 */
export interface Take {
  id: TakeId;
  name: string;
  events: TakeEvent[];
  /** 最后一个事件的 tSec（不含尾音）；导出/预览时会自动加尾音余量 */
  durationSec: number;
  createdAtMs: number;
}

/** FillItem 填词队列项 —— 把 Take 展开为线性队列后的一个待填槽 */
export interface FillItem {
  /** 对应 take.events 下标 */
  eventIndex: number;
  keyIndex: number;
  pressCount: number;
  /** 已装配进的素材；null = 待填（「下一个音」） */
  filledSampleId: SampleId | null;
}

// ---------------------------------------------------------------------------
// 效果链设置（主总线一条链：EQ → Compressor → Chorus → Reverb）
// ---------------------------------------------------------------------------

/**
 * 均衡器段类型（Web Audio BiquadFilterNode 的原生类型）。
 *
 * `freq` 的合法范围随类型变化，UI 需据此收敛：
 *   - 低通 / 低架：上限不该超过奈奎斯特（默认 48k → 24k）
 *   - 高通 / 高架：下限贴近 20Hz
 * 具体约束在 `EFFECT_UNITS` 的段定义里逐段声明（见 engine/effect-units/eq.ts）。
 */
export type EqBandType =
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'lowpass'
  | 'highpass'
  | 'notch'
  | 'allpass';

/** 均衡器单段 */
export interface EqBand {
  enabled: boolean;
  type: EqBandType;
  /** 中心/截止频率 Hz */
  frequencyHz: number;
  /** 增益 dB。`lowpass` / `highpass` / `notch` / `allpass` 无增益语义，UI 应禁用该旋钮 */
  gainDb: number;
  /** 品质因数 Q */
  q: number;
}

/**
 * 均衡器（多段参数均衡）。
 *
 * 相对旧实现（`Tone.EQ3` 三段固定 low/mid/high）的升级：段数、类型、
 * 频率、Q 全部可调，频响曲线由各段 `getFrequencyResponse` 逐点相乘得到
 * （不手写双二阶 —— 见 engine/effect-units/eq.ts 的注释）。
 *
 * 段数固定为 5，顺序即信号流顺序，**不可重排**（导出=预览依赖此序）。
 */
export interface EqSettings {
  enabled: boolean;
  bands: EqBand[];
}

export interface CompressorSettings {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackSec: number;
  releaseSec: number;
}

export interface ChorusSettings {
  enabled: boolean;
  /** LFO 频率 Hz */
  rateHz: number;
  /** 延迟基准 ms */
  delayTimeMs: number;
  /** 深度 0..1 */
  depth: number;
  /** 立体声展开角度 0..180 */
  spreadDegrees: number;
  /** 湿度 0..1 */
  wet: number;
}

/**
 * 混响（自研 IR 合成，见 engine/effect-units/prototype-reverb.ts）。
 *
 * 前三个字段沿用旧实现（尾长 / 预延迟 / 干湿）；后四个是本次新增，
 * 对应 IR 合成算法里另外四个物理环节。IR 由**全部**这些字段共同决定，
 * 所以任意一个变化都需要重新生成脉冲响应（上层已有 400ms 防抖合并）。
 */
export interface ReverbSettings {
  enabled: boolean;
  /** 混响尾长（秒）—— IR 总长 */
  decaySec: number;
  /** 预延迟（秒）—— 干声与混响之间的间隔，越大空间感越远 */
  preDelaySec: number;
  /** 干湿比 0..1 */
  wet: number;
  /**
   * 高频阻尼 0..1。
   * 真实空间里高频衰减更快，这个参数控制衰减速度：
   *   0 → 截止 18.3kHz（几乎不吸高频，明亮发硬）
   *   1 → 约 500Hz（暗、闷，像石造大厅）
   * 0.35 是「房间」的中性点。
   */
  damping: number;
  /**
   * 扩散 0..1。
   * 控制噪声尾巴被「抹开」的程度（0~3 次单极点低通）：
   *   0 → 只听见离散早期反射，颗粒感强、像弹簧混响
   *   1 → 完全弥散成一片，像大空间
   */
  diffusion: number;
  /**
   * 空间尺寸系数，缩放早期反射的到达时间。
   * 1 = 原型基准（首次反射 4ms）；2 = 反射时间翻倍，听感上空间大一倍。
   */
  size: number;
  /** 早期反射强度 0..1。它才是人脑判断「空间形状」的依据，不是尾巴 */
  early: number;
  /** 湿声低切（Hz）—— 去掉混响里的低频堆积，避免糊底 */
  lowCutHz: number;
  /** 湿声高切（Hz）—— 让混响尾巴变柔，不刺耳 */
  highCutHz: number;
  /**
   * 立体声宽度 0..2。
   *   0 = 单声道；1 = 原始；2 = 左右声道差分量加倍（极宽）。
   * 用 M/S 矩阵实现：`out_L = a·L + b·R`，`out_R = a·R + b·L`，其中
   * `a = (1+w)/2`、`b = (1-w)/2`。
   */
  width: number;
}

/** 主总线效果链全部参数 */
export interface EffectSettings {
  eq: EqSettings;
  compressor: CompressorSettings;
  chorus: ChorusSettings;
  reverb: ReverbSettings;
  /** 主输出增益 dB */
  masterGainDb: number;
}

// ---------------------------------------------------------------------------
// 全局设置 & 工程
// ---------------------------------------------------------------------------

/** 全局设置（非效果器） */
export interface Settings {
  /**
   * 音高归一总开关（LibraryPage 全局控制）。
   * 开启：playbackRate 按「检测音高 → referencePitchHz」的整数半音差计算；
   * 关闭：以素材原声为准，仅应用 manualSemitoneOffset。
   */
  pitchNormalizationEnabled: boolean;
  /** 归一目标基准音高，默认 C4 = 261.6256 Hz（do） */
  referencePitchHz: number;
  /**
   * 音域**格数**（半音格），1..61。
   *
   * 键集恒为「从键域起点（C3 = 48）起的**连续半音序列**」，所以这个数字
   * 同时也是键数组长度；它与半音键开关**完全无关**（开关只决定露出多少键）。
   */
  keyCount: number;
  /** 键盘绑定：keyIndex → KeyboardEvent.key。两页共享，随工程持久化。 */
  keyBindings: Record<number, string>;
  /** 全局自动修音：开 = 播放/导出时把素材对齐到事件音高；关 = 只用手动偏移 */
  autoTuneEnabled: boolean;
  /**
   * **半音键（黑键）显示开关** —— 纯视图状态。
   *
   * 开 = 键盘上摆出全部黑键（每八度 12 键）；关 = 只摆白键（每八度 7 键）。
   *
   * ⚠️ 半音键**默认就在后台铺好了**（键集本来就是连续半音序列），
   * 这个开关不添加、不删除、不移动任何键 —— 不改音高、不改键数、
   * 不改 Take 里的音符、不改按键绑定。关掉再打开，一个音都不跑。
   *
   * （旧语义是「追加键取哪条序列」，于是关掉开关后已存在的黑键会被当白键
   *   挤掉别人的位置 —— 那是布局层读了开关导致的，已废弃。）
   */
  semitoneModeEnabled: boolean;
}

/** Project 工程 —— 全部状态容器、持久化单位 */
export interface Project {
  /**
   * 存档结构版本。
   *   1 → 2（2026-09-25）：键集从「用户攒出来的键」升级为
   *   「后台铺好的连续半音序列」，Take 事件的 keyIndex 与按键绑定
   *   必须按音高重新编号（否则音符会整体错位到隔壁键）。
   */
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  samples: Sample[];
  keys: Key[];
  takes: Take[];
  effects: EffectSettings;
  settings: Settings;
  updatedAtMs: number;
}

/**
 * 页面标识（App 导航）：素材（素材箱）/ 演奏 / 制作 / 混音。
 * 旧 'library' / 'slicer' 子标签已下线：切片能力并入素材箱，
 * 双击任意波形弹出 SampleEditorModal 完成选区切割与入库。
 */
export type PageId = 'material' | 'stage' | 'studio' | 'mix';
