/**
 * 第三方变调引擎适配层 —— **实验分支 `feat/lib-engines` 专用**。
 *
 * 背景：项目长期的听感问题是「低音越降越沙」（升调侧用户认可）。在我们自己的
 * wasm PSOLA 上做了多轮尝试（含被实听否决的 mode 3 谐波/噪声分离）之后，
 * 这一层的目的是**把这个问题交给别的实现去回答**：候选同台，用户在装配面板
 * 里一键 A/B，用耳朵投票，而不是继续在单一内核上猜。
 *
 * 现役 **18 个**：`@audio/shift` 的 **15 个算法全部接入**（频域 7 / 时域 6 /
 * 源-滤波与混合 2），加 SoundTouchJS 的 3 个。清单与实测数字见下面的
 * `EXTERNAL_ENGINES`。
 *
 * ── 五条设计约束，决定了它长这样 ──
 *
 * 1. **默认零行为变化**。偏好默认 `'wasm'`，即完全走原来的 wasm 降级链
 *    （`playSample` 里的 mode 1 → 2 → 原声）。只有用户显式点选某个第三方引擎，
 *    才会启用外部路径。回退 = 切回「我们的 PSOLA」，或 `git checkout master`
 *    （本分支从存档点 bb2fc05 分叉）。
 *
 * 2. **不进首屏包**。19 个库全部走动态 `import()`，Vite 各自切 chunk；
 *    只有真正点到某个引擎时才下载那一个。想彻底摘掉这套东西，
 *    删掉本文件 + `playSample` 里那一个分支 + 面板上的控件即可。
 *
 * 3. **同步取用**。`playSample` 是同步函数，不能被 `await` 打断。所以拆成两半：
 *    `ensureEngine()`（异步预加载）由用户在面板上点选时完成，
 *    `getActiveShift()`（同步）给 `playSample` 用；没加载好就**回退 wasm**，
 *    绝不静默失败。
 *
 * 4. **「保不保共振峰」必须写在 UI 上**。这是用户听之前就该知道的事：
 *    - 频域那一族里只有 `formant`（倒谱包络）保共振峰；
 *    - 时域那一族（`psola`/`wsola`/`ola`/`sample`）内部都是
 *      「时间伸缩 + sinc 重采样回原长」，重采样把**整个频谱**乘以 ratio
 *      ——共振峰跟着 f0 一起走（降调变闷变厚）。`shift-psola` 自己的源码注释
 *      就写着 `formants move with f0 same as wsola`，它赢在基音边界的颗粒伪影更少，
 *      **不是**保共振峰；
 *    - `lpc`（源-滤波）与 `formant` 才保共振峰，路子完全不同。
 *      鬼畜素材常常不在乎「是不是同一个人」，所以这未必是缺点 —— 但用户
 *      必须知道自己听到的差别里，有多少是算法类别，有多少是共振峰。
 *
 * 5. **`durationSafe` 必须显式标出来**。`lib-sample` 的长度契约是满足的，
 *    但内容是播放速率式重采样 —— 降调时尾巴整段丢掉。只查长度/电平/HNR
 *    都发现不了，所以列成字段让 UI 能警告（详见 `EngineMeta.durationSafe`）。
 *
 * ⚠️ 与项目既有约定的一致性：这些库只做**变调**（输出时长 == 输入时长）。
 *    时长因子 τ 由 `@audio/stretch-*` 单独处理（音高不变），两者串联 =
 *    「先变调、再伸缩」，与 wasm 里 `hajimi_tx_run(pitch, time)` 的语义等价。
 */

/**
 * 可选的第三方引擎。
 *
 * **`@audio/shift` 的 15 个算法全部接入**（= 那个 meta 包 `@audio/shift@1.1.4`
 * dependencies 里列的 15 个算法包，逐个独立安装、逐个独立 `import()`），
 * 外加 SoundTouchJS 的 3 个，共 18 个。
 *
 * 为什么不用 meta 包一次全拿：`@audio/shift` 自己还导出一个 `pitchShift`
 * 「按内容自动选」的包装器（README 表格第 16 行，不是算法）。它的 `index.js`
 * 静态 re-export 全部 15 个子包 —— 而 Vite 只对**字面量** `import()` 切 chunk，
 * 一旦 import 它就等于把 15 个算法打进同一个 chunk，按需加载就没了。
 * 所以这 15 个走**子包**，`pitchShift` 刻意不接。
 */
export type ExternalEngineId =
  // ── @audio/shift · 频域 STFT（7）──
  | 'lib-vocoder'
  | 'lib-phaselock'
  | 'lib-transient'
  | 'lib-formant'
  | 'lib-hpss'
  | 'lib-sms'
  | 'lib-paulstretch'
  // ── @audio/shift · 时域（6）──
  | 'lib-psola'
  | 'lib-wsola'
  | 'lib-ola'
  | 'lib-delay'
  | 'lib-granular'
  | 'lib-sample'
  // ── @audio/shift · 源-滤波 / 混合（2）──
  | 'lib-lpc'
  | 'lib-hybrid'
  // ── SoundTouchJS（3）──
  | 'st-wsola'
  | 'st-long'
  | 'st-pvoc';

/**
 * 引擎属于哪一组 —— **只用于 UI 分组**，不参与计算。
 *
 * 18 个 chip 按「项目」分组已经不够用了：15 个都来自 `@audio/shift`，
 * 挤成一排看不出该点哪个。改成按**算法域**分（与该库 README 的分类一致），
 * 因为那才是听感差异的来源：频域（相位声码器一族）的 artifact 是「拖尾/phasiness」，
 * 时域（颗粒拼接一族）的 artifact 是「颗粒感/打断」，源-滤波那一支才是保共振峰的。
 */
export type EngineFamily = 'freq' | 'time' | 'other' | 'soundtouchjs';


/** 当前生效的引擎：`'wasm'` = 项目原有链路（默认） */
export type EngineChoice = 'wasm' | ExternalEngineId;

/**
 * 整段变调签名（`@audio/shift-*`：ratio 只改音高，不改时长）。
 *
 * 类型写成 `Float32Array<ArrayBufferLike>` 而不是裸 `Float32Array`：
 * TS 5.7 起 `Float32Array` 带了缓冲区类型参数，裸写法等价于
 * `Float32Array<ArrayBuffer>`，而 `AudioBuffer.getChannelData().slice()`
 * 返回的是 `Float32Array<ArrayBufferLike>`（含 SharedArrayBuffer 情形），
 * 两者不互相赋值。这里参数放宽，出口交给调用方断言。
 */
export type ShiftFn = (
  data: Float32Array<ArrayBufferLike>[],
  options?: ShiftOptions,
) => Float32Array<ArrayBufferLike>[];

export interface ShiftOptions {
  /** 目标音高比（1.5 = +7 半音） */
  ratio?: number;
  sampleRate?: number;
  minFreq?: number;
  maxFreq?: number;
}

/** 整段时间伸缩签名（`@audio/stretch-*`：factor 只改时长，不改音高） */
export type StretchFn = (
  data: Float32Array<ArrayBufferLike>,
  options?: { factor?: number; sampleRate?: number; minFreq?: number; maxFreq?: number },
) => Float32Array<ArrayBufferLike>;

export interface EngineMeta {
  id: ExternalEngineId;
  /** 面板 chip 上的短名 */
  label: string;
  /** 一句话：算法类别 + 会不会动共振峰（用户听之前就该知道） */
  note: string;
  /** 是否保共振峰 —— 只用于 UI 分组/着色，不参与计算 */
  keepsFormant: boolean;
  /** 属于哪一组（UI 分组用） */
  family: EngineFamily;
  /**
   * 输出的**内容**时间轴是否与输入一致。
   *
   * 为什么必须单独一个字段：`lib-sample` 的长度契约是满足的（输出数组长度 == 输入），
   * 但它是播放速率式重采样 —— 降调时只读到源的前 `ratio` 比例，**尾巴整段丢掉**
   * （标记实验实测：尾巴能量 0.000，而其余 17 个都在 0.95~1.0）。
   * 只查长度 / 电平 / HNR 全都发现不了它，所以只能显式标出来让 UI 警告。
   */
  durationSafe: boolean;
}

/**
 * 18 个引擎的清单。`note` 里的数字都是本项目真实素材上的实测，不是抄 README：
 *   · HNR(dB) —— 本项目衡量「沙沙」的判据，越高越干净；
 *   · 质心(Hz) —— 源 3855(龙.001) / 5141(高北)，掉了就说明听感变闷；
 *   · 耗时 —— 点一下 chip 就要出声，超过 ~200ms 会明显卡；
 *   · 包络 a —— 内容时间比，只有 `sample` 偏离 1（数值见该条）。
 *
 * 两个基准档（`龙.001` 是常规素材、`高北` 是最坏档）：
 *   我们 mode1：−8.23 半音 9.07 / 质心 3837；−12 半音 **2.02** / 质心 5045。
 * 提醒：HNR 高不等于好听（它奖励「频谱被抹平」，纯正弦能到 +∞）；
 * 这些数字只用来**排除**，选优必须靠耳朵。
 */
export const EXTERNAL_ENGINES: readonly EngineMeta[] = [
  // ───────────────────────── @audio/shift · 频域 STFT ─────────────────────────
  {
    id: 'lib-vocoder',
    label: 'vocoder',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-pvoc · SMB/Bernsee 分箱搬移相位声码器（每箱独立累积相位）。' +
      '实测 −8 半音 HNR 10.17、−12 只有 5.93（比我们 2.02 好）但质心掉到 2431 ≈ 源的一半 → 听感闷、有拖尾。',
  },
  {
    id: 'lib-phaselock',
    label: 'phaseLock',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-pvoc-lock · Laroche-Dolson 峰值锁定声码器：峰搬到新箱，其余箱的相位相对最近的峰锁定。' +
      '⚠️ 各素材上明显是最差的一档：−12 半音 HNR 0.91（我们 2.02）。包络 a=0.995 → 不截断，纯粹难听。',
  },
  {
    id: 'lib-transient',
    label: 'transient',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-transient · 峰值锁定 + 谱通量瞬态检测（瞬态帧把合成相位重置回分析相位，保住起音）。' +
      '该库自述在它的测试集上与 phaseLock 逐字节相同（门限从未触发）—— 实测两者数字也完全一致。',
  },
  {
    id: 'lib-formant',
    label: 'formant',
    family: 'freq',
    keepsFormant: true,
    durationSafe: true,
    note:
      '@audio/shift-formant · 倒谱包络保持：抹平频谱 → 峰值锁定变调残差 → 把原共振峰包络贴回去。' +
      '保共振峰（该库自测 formant dist 0.765 全场最佳）。−12 半音 HNR 1.02，保了共振峰但没保住「干净」。',
  },
  {
    id: 'lib-hpss',
    label: 'hpss',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-hpss · 中值滤波谐波/打击分离：只对谐波成分做声码器变调，打击成分**原相位**搬过去。' +
      '实测大降调最稳的一档之一（−8 11.02、−12 7.19），且质心 3560 只掉一点 → 不闷。鼓点类素材优先试它。',
  },
  {
    id: 'lib-sms',
    label: 'sms',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-sms · 正弦建模（抛物线插值找峰 → 正弦轨 + 随机残差）。' +
      '该库自测保共振峰（lobe 随峰自由缩放），但 −12 只有 HNR 2.06、质心 2311 → 听感会「合成器」。',
  },
  {
    id: 'lib-paulstretch',
    label: 'paulstretch',
    family: 'freq',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-paulstretch · 16k 大窗 + 每帧相位随机化。**按设计**摧毁时间结构（该库自测 formant dist 7.371，全场最差）。' +
      '实测 −12 HNR −1.64、电平 +4.6dB、包络 a=1.096 → 别当变调器用，它是「把素材揉成雾」的效果器。',
  },
  // ───────────────────────── @audio/shift · 时域 ─────────────────────────
  {
    id: 'lib-psola',
    label: 'psola',
    family: 'time',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-psola · PSOLA 时间伸缩 + sinc 重采样（两段式）。' +
      '与其源码注释一致（formants move with f0）——**不保共振峰**。实测 −8 HNR 11.19 超过我们 9.07，但质心 2278 只有源六成。',
  },
  {
    id: 'lib-wsola',
    label: 'wsola',
    family: 'time',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-wsola · 颗粒位置按波形互相关搜索 + 重采样。−8 HNR 13.76、−12 8.62，都远超我们；' +
      '代价同样是质心掉到 2192（源 3855）→ 偏闷。不保共振峰。',
  },
  {
    id: 'lib-ola',
    label: 'ola',
    family: 'time',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-ola · 朴素重叠相加 + 重采样，**没有相似搜索** —— 该库自己的基线。' +
      '实测 −8 HNR 3.32（我们 9.07）、电平 −5dB、正弦上尾巴能量 0.494。留着当「下限参照」。',
  },
  {
    id: 'lib-delay',
    label: 'delay',
    family: 'time',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-delay · 延时线（硬件和声器一路）：两个读头扫过被调制的延时窗，靠 Hann 交叉淡化接力。' +
      '⚠️ **本次实测的最大发现**：−12 半音 HNR **10.40**（我们 2.02，全场最高），质心 2447。',
  },
  {
    id: 'lib-granular',
    label: 'granular',
    family: 'time',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-granular · 定长 Hann 颗粒 + sinc 步进读（无独立伸缩级）。默认 grainSize=398。' +
      '实测 −8 HNR **−0.01**、−12 0.82 —— 数字极差，且该库明确说「和弦上的碎裂是特性不是 bug」。耳朵可能反而喜欢。',
  },
  {
    id: 'lib-sample',
    label: 'sample ⚠',
    family: 'time',
    keepsFormant: false,
    durationSafe: false,
    note:
      '⚠️ **不保时长**：@audio/shift-sample 是播放速率式纯重采样，输出长度合规但内容时间轴被压 ' +
      '(ratio 倍，实测包络 a=0.616) → 降调时**尾巴整段丢掉**（标记实验尾巴能量 0.000，其余 17 个均 0.95~1.0）。' +
      '只用来听「纯重采样是什么声」这条既有对照，别用它出成品。',
  },
  // ───────────────────────── @audio/shift · 源-滤波 / 混合 ─────────────────────────
  {
    id: 'lib-lpc',
    label: 'lpc',
    family: 'other',
    keepsFormant: true,
    durationSafe: true,
    note:
      '@audio/shift-lpc · LPC 源-滤波（RELP 一系）：逐帧最小二乘拟合声道全极点滤波器，激励重定音高后过**同一个**滤波器。' +
      '保共振峰（质心 3551 最接近源 5141 的降调档）。该库自述纯正弦上会退化，实测正弦尾巴 0.124 / 噪声 0.952 印证。',
  },
  {
    id: 'lib-hybrid',
    label: 'hybrid',
    family: 'other',
    keepsFormant: false,
    durationSafe: true,
    note:
      '@audio/shift-hybrid · phaseLock 与 wsola 并行跑，按谱通量瞬态置信度逐样点交叉淡化（音调段走声码器、起音走 WSOLA）。' +
      '实测数字与 phaseLock 完全一致（−8 8.40 / −12 0.91）—— 门限在我们这类素材上同样没怎么触发。',
  },
  // ───────────────────────── SoundTouchJS ─────────────────────────
  {
    id: 'st-wsola',
    label: 'ST-WSOLA',
    family: 'soundtouchjs',
    keepsFormant: false,
    durationSafe: true,
    note:
      'SoundTouchJS · SoundTouch 出厂链路：WSOLA 找最佳拼接点 + **Lanczos** 插值重采样。' +
      '实测 −8 HNR 12.73、质心 2281，耗时约为我们的一半；不保共振峰。',
  },
  {
    id: 'st-long',
    label: 'ST-长窗',
    family: 'soundtouchjs',
    keepsFormant: false,
    durationSafe: true,
    note:
      'SoundTouchJS · 同一链路但把 WSOLA 分析窗拉长到 120ms / 搜索窗 25ms。' +
      '**大降调才划算**：−12 半音 HNR 9.95 → 12.04，−8 半音两档持平。',
  },
  {
    id: 'st-pvoc',
    label: 'ST-声码器',
    family: 'soundtouchjs',
    keepsFormant: false,
    durationSafe: true,
    note:
      'SoundTouchJS · 把伸缩级换成**相位声码器**（频域相位累积，非颗粒拼接）。' +
      '算法族与上面所有都不同，artifact 性质也不同（颗粒感 ↔ 频域拖尾），听感最"合成"。',
  },
];

// ---------------------------------------------------------------------------
// 惰性加载表
// ---------------------------------------------------------------------------

/**
 * ⚠️ 这里必须写**静态字符串路径**：Vite 只对字面量 `import()` 才做静态分析并切 chunk。
 * 换成变量（`import(path)`）会让它退化成「运行时才知道要加载谁」，既打不出包、
 * 也可能在浏览器里直接失败。
 *
 * SoundTouchJS 那三个都指向**同一个** `soundtouch-engine` 模块 —— 谁先被点选就加载谁，
 * 之后另两个直接命中同一份已加载模块（Vite 的模块缓存），不会重复下载。
 */
const LOADERS: Record<ExternalEngineId, () => Promise<ShiftFn>> = {
  // ── @audio/shift · 频域 STFT ──
  'lib-vocoder': () => import('@audio/shift-pvoc').then((m) => m.default as unknown as ShiftFn),
  'lib-phaselock': () =>
    import('@audio/shift-pvoc-lock').then((m) => m.default as unknown as ShiftFn),
  'lib-transient': () =>
    import('@audio/shift-transient').then((m) => m.default as unknown as ShiftFn),
  'lib-formant': () => import('@audio/shift-formant').then((m) => m.default as unknown as ShiftFn),
  'lib-hpss': () => import('@audio/shift-hpss').then((m) => m.default as unknown as ShiftFn),
  'lib-sms': () => import('@audio/shift-sms').then((m) => m.default as unknown as ShiftFn),
  'lib-paulstretch': () =>
    import('@audio/shift-paulstretch').then((m) => m.default as unknown as ShiftFn),
  // ── @audio/shift · 时域 ──
  'lib-psola': () => import('@audio/shift-psola').then((m) => m.default as unknown as ShiftFn),
  'lib-wsola': () => import('@audio/shift-wsola').then((m) => m.default as unknown as ShiftFn),
  'lib-ola': () => import('@audio/shift-ola').then((m) => m.default as unknown as ShiftFn),
  'lib-delay': () => import('@audio/shift-delay').then((m) => m.default as unknown as ShiftFn),
  'lib-granular': () =>
    import('@audio/shift-granular').then((m) => m.default as unknown as ShiftFn),
  'lib-sample': () => import('@audio/shift-sample').then((m) => m.default as unknown as ShiftFn),
  // ── @audio/shift · 源-滤波 / 混合 ──
  'lib-lpc': () => import('@audio/shift-lpc').then((m) => m.default as unknown as ShiftFn),
  'lib-hybrid': () => import('@audio/shift-hybrid').then((m) => m.default as unknown as ShiftFn),
  // ── SoundTouchJS（三个共用一个模块，不会重复下载）──
  'st-wsola': () =>
    import('./soundtouch-engine').then((m) => m.soundTouchWsola as unknown as ShiftFn),
  'st-long': () =>
    import('./soundtouch-engine').then((m) => m.soundTouchWsolaLong as unknown as ShiftFn),
  'st-pvoc': () => import('./soundtouch-engine').then((m) => m.soundTouchPvoc as unknown as ShiftFn),
};

/** 已加载完成的引擎（同步取用） */
const loadedShift = new Map<ExternalEngineId, ShiftFn>();
/** 在途加载（防重复 import） */
const pendingShift = new Map<ExternalEngineId, Promise<void>>();
/**
 * 加载**失败过**的引擎。
 *
 * 为什么需要它：`pendingShift` 在 finally 里被删掉，所以「失败」和「还没开始」
 * 在状态上是同一个样子 —— 而这两者对用户的意义完全相反：
 * 前者要提示「点一下可重试」，后者只是「稍等一下」。
 * 早先没有这个集合，失败后面板照旧高亮那个引擎、什么也不说，
 * 用户只能听到「切了没反应」。
 */
const failedShift = new Set<ExternalEngineId>();

let stretchModule: StretchFn | null = null;
let stretchPending: Promise<StretchFn> | null = null;
let stretchFailed = false;

/**
 * 预加载某个引擎。面板上点选时 await 它；失败不抛到 UI 之外 ——
 * 调用方按返回的 false 处理（提示 + 保持原引擎）。
 *
 * 幂等：已加载直接返回 true；在途则复用同一个 promise；
 * **失败过可以再调**（`pendingShift` 已清空，会重新走一遍）。
 */
export async function ensureEngine(id: ExternalEngineId): Promise<boolean> {
  if (loadedShift.has(id)) return true;
  let p = pendingShift.get(id);
  if (!p) {
    p = LOADERS[id]()
      .then((fn) => {
        loadedShift.set(id, fn);
        failedShift.delete(id);
      })
      .catch((err) => {
        failedShift.add(id);
        console.warn(`[external-shift] 引擎 ${id} 加载失败`, err);
        throw err;
      })
      .finally(() => {
        pendingShift.delete(id);
        emit();
      });
    pendingShift.set(id, p);
  }
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

/** 惰性取时间伸缩内核（τ ≠ 1 时才需要）。 */
async function ensureStretch(): Promise<StretchFn | null> {
  if (stretchModule) return stretchModule;
  if (!stretchPending) {
    stretchPending = import('@audio/stretch-psola')
      .then((m) => {
        stretchModule = m.default as unknown as StretchFn;
        stretchFailed = false;
        return stretchModule;
      })
      .catch((err) => {
        stretchFailed = true;
        console.warn('[external-shift] stretch-psola 加载失败', err);
        stretchPending = null;
        emit();
        throw err;
      });
  }
  try {
    return await stretchPending;
  } catch {
    return null;
  }
}

/**
 * 切换引擎的**唯一权威状态**。
 *
 * 「用户选了谁」(`choice`) 与「库真的能用了吗」(`ready`) 是两件独立的事：
 * 前者存在 localStorage 里能活过刷新，后者只是模块内存。
 * 任何**只看 choice 就下结论**的地方（尤其是 UI 高亮）都可能与实际播放不一致 ——
 * `playSample` 只认 `getActiveShift()`，它为 null 时整个外部分支被静默跳过。
 *
 * 所以 UI 一律读这个函数，而不是读 `getEngineChoice()`。
 */
export interface EngineStatus {
  /** 用户选中的引擎 */
  choice: EngineChoice;
  /** 选中的引擎**真的可以用了**（`'wasm'` 恒为 true） */
  ready: boolean;
  /** 正在下载 */
  loading: boolean;
  /** 上一次加载失败（可重试） */
  failed: boolean;
  /** τ ≠ 1 需要的时间伸缩内核是否就绪（`'wasm'` 恒为 true） */
  stretchReady: boolean;
  /**
   * 时间伸缩内核**加载失败**了。
   *
   * 单独报出来的理由：它坏了以后 `getStretchIfNeeded()` 返回 null，
   * `playSample` 会**整体**回退 wasm —— 于是用户「把时长拉了一下」却发现
   * 音色也变回了我们的内核，而面板上那个引擎还高亮着。
   * 这是和「库没加载好」同一类的静默失败，必须能显示出来。
   */
  stretchFailed: boolean;
}

export function getEngineStatus(): EngineStatus {
  const choice = preference;
  if (choice === 'wasm') {
    return {
      choice,
      ready: true,
      loading: false,
      failed: false,
      stretchReady: true,
      stretchFailed: false,
    };
  }
  return {
    choice,
    ready: loadedShift.has(choice),
    loading: pendingShift.has(choice),
    failed: failedShift.has(choice),
    stretchReady: stretchModule !== null,
    stretchFailed,
  };
}

/**
 * **实际**会用来出声的引擎 —— 界面必须显示这个值，而不是用户选的那个。
 *
 * 与 `playSample` 的判据严格一致（那里是 `if (getActiveShift())`）。
 * 未就绪时它返回 `'wasm'`，因为那正是用户耳朵里正在发生的事。
 */
export function getEffectiveEngine(): EngineChoice {
  return getEngineStatus().ready ? preference : 'wasm';
}

/** 同步给 `playSample`：当前偏好的引擎已就绪吗？未就绪返回 null（→ 回退 wasm）。 */
export function getActiveShift(): ShiftFn | null {
  const p = preference;
  if (p === 'wasm') return null;
  return loadedShift.get(p) ?? null;
}

/**
 * 同步给 `playSample`：**当前真的会用来出声**的引擎 id（未就绪则 null）。
 *
 * 与 `getActiveShift()` 的判据逐字一致（`loadedShift.has(p)`）——
 * 存在的唯一理由是 `playSample` 的**结果缓存键**需要引擎身份：
 * 换引擎后同一段素材必须重算，不能命中上一个引擎的缓存。
 * 用 `getEffectiveEngine()` 也能得到同样的值，但那个函数每次都要
 * 构造一个 `EngineStatus` 对象；这里是热路径（每次放音），单独给一个。
 */
export function getActiveEngineId(): ExternalEngineId | null {
  const p = preference;
  if (p === 'wasm') return null;
  return loadedShift.has(p) ? p : null;
}

/**
 * 同步给 `playSample`：若当前需要时间伸缩且内核已就绪，返回它；否则 null。
 * τ ≠ 1 且 stretch 未加载时，调用方应**整体回退 wasm**（而不是只做变调、
 * 悄悄丢掉变速 —— 那会以「听着像对了」的方式骗过用户）。
 */
export function getStretchIfNeeded(needStretch: boolean): StretchFn | null {
  if (!needStretch) return null;
  return stretchModule;
}

/** 预热时间伸缩内核（用户在面板上改 τ 时调）。 */
export function ensureStretchReady(): Promise<void> {
  return ensureStretch().then(() => undefined);
}

/** 加载状态（UI 显示 loading 用） */
export function isEngineLoading(id: ExternalEngineId): boolean {
  return pendingShift.has(id);
}

// ---------------------------------------------------------------------------
// 偏好（localStorage 持久化；默认 'wasm' = 项目原有行为）
// ---------------------------------------------------------------------------

const PREF_KEY = 'hajimi.transformEngine';

/** 合法性校验：白名单之外的存量值（旧版本写入 / 手改）一律回落 'wasm' */
function isEngineChoice(v: unknown): v is EngineChoice {
  if (v === 'wasm') return true;
  return EXTERNAL_ENGINES.some((e) => e.id === v);
}

function readPreference(): EngineChoice {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return isEngineChoice(raw) ? raw : 'wasm';
  } catch {
    // 无 localStorage（隐私模式 / 非浏览器环境）→ 用默认值，不影响功能
    return 'wasm';
  }
}

let preference: EngineChoice = readPreference();

export function getEngineChoice(): EngineChoice {
  return preference;
}

export function setEngineChoice(next: EngineChoice): void {
  if (next === preference) return;
  preference = next;
  try {
    localStorage.setItem(PREF_KEY, next);
  } catch {
    /* 存不下就算了，本次会话内仍然生效 */
  }
  emit();
}

export function getEngineMeta(id: EngineChoice): EngineMeta | null {
  return EXTERNAL_ENGINES.find((e) => e.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 订阅（React 用 useSyncExternalStore 订阅；零依赖、不引状态库）
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeEngine(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 把 localStorage 里存的偏好重新加载回来（**含时间伸缩内核**）。
 *
 * 为什么必须由模块自己做这件事，而不是交给某个组件的 `useEffect`：
 * 偏好活在 localStorage、能过刷新，但 `loadedShift` 只是模块内存，刷新就没了。
 * 于是「已选中」与「已加载」当场分家 —— 面板高亮着第三方引擎，
 * `playSample` 却因为 `getActiveShift()` 为 null 而**静默**走 wasm。
 * 2026-09-20 用探针实测到过这个状态：刷新后 `choice='st-long'` 而
 * `shiftReady=false`、`willUseExternal=false`（连加载都没发起）。
 *
 * 挂在模块级（而不是面板挂载时）的理由：`sample-player.ts` **静态 import** 本模块，
 * 所以任何入口启动都会走到这一行 —— 不依赖「用户这一会话打开过装配面板」。
 * 否则「从导出对话框直接导出」这种路径会拿 wasm 渲出来，
 * 正是最该避免的「听着是一个声、导出来是另一个声」。
 *
 * 失败不影响启动：静默记在 `failedShift` 上，由面板显示「未就绪 + 可点一下重试」。
 */
export function restoreEngine(): Promise<void> {
  const choice = preference;
  if (choice === 'wasm') return Promise.resolve();
  return ensureEngine(choice)
    .then((ok) => (ok ? ensureStretch().then(() => undefined) : undefined))
    .catch(() => undefined);
}

// 启动即恢复。动态 import 永远是异步的，所以这里不会拖慢首屏，也不会抛。
void restoreEngine();
