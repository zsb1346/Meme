import * as Tone from 'tone';
import { getAudioContext } from './core';
import { playbackRateForSemitones } from './pitch';
import { isRushReady, PsolaSilentNoopError, transformBuffer } from './rush/transform';
import {
  getActiveEngineId,
  getActiveShift,
  getStretchIfNeeded,
  type ExternalEngineId,
  type ShiftFn,
  type StretchFn,
} from './external-shift';
import { checkShiftOutput } from './shift-output-guard';

/**
 * 采样播放：原生 AudioBufferSourceNode + playbackRate 变调 + 防爆音包络。
 * 计划 §2 定稿：采样播放用原生节点（不用 Tone.Player），效果链才走 Tone。
 */

// ---------------------------------------------------------------------------
// 解码与运行时缓存
// ---------------------------------------------------------------------------

const bufferCache = new Map<string, AudioBuffer>();

/** 解码后的 AudioBuffer 放入运行时缓存（store.addSampleFromFile 已自动调用）。 */
export function cacheBuffer(id: string, buffer: AudioBuffer): void {
  bufferCache.set(id, buffer);
}

/** 取缓存；未命中返回 null（调用方可按需 decodeAudioBlob 后回填）。 */
export function getCachedBuffer(id: string): AudioBuffer | null {
  return bufferCache.get(id) ?? null;
}

/** 素材删除时清理缓存，防内存泄漏。 */
export function dropCachedBuffer(id: string): void {
  bufferCache.delete(id);
}

export function clearBufferCache(): void {
  bufferCache.clear();
}

/** Blob → AudioBuffer（用全局 AudioContext 解码；每次取全新 ArrayBuffer 防止 detach 复用问题）。 */
export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Worker 解码 —— 素材导入/预热/波形缩略的解码 + 音高检测全部走 Web Worker，
// 主线程零阻塞。失败自动回退主线程路径（decodeAudioBlob + detectPitchYin）。
// 共享入口 decodeAudioBlobShared：以 sampleId 去重，并发调用只真正解一次。
// ---------------------------------------------------------------------------

export interface DecodedAudio {
  buffer: AudioBuffer;
  detectedPitchHz: number | null;
}

interface DecodeWorkerSuccess {
  id: number;
  channels: ArrayBuffer[];
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  detectedPitchHz: number | null;
}

interface DecodeWorkerFailure {
  id: number;
  error: string;
}

type DecodeWorkerMessage = DecodeWorkerSuccess | DecodeWorkerFailure;

let decodeWorker: Worker | null = null;
let decodeWorkerSeq = 0;
const decodeWorkerPending = new Map<
  number,
  { resolve: (r: DecodeWorkerSuccess) => void; reject: (e: Error) => void }
>();

function getDecodeWorker(): Worker {
  if (!decodeWorker) {
    decodeWorker = new Worker(new URL('./audio-worker.ts', import.meta.url), {
      type: 'module',
    });
    decodeWorker.onmessage = (e: MessageEvent<DecodeWorkerMessage>) => {
      const msg = e.data;
      const entry = decodeWorkerPending.get(msg.id);
      if (!entry) return;
      decodeWorkerPending.delete(msg.id);
      if ('error' in msg) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg);
      }
    };
    decodeWorker.onerror = (e) => {
      // worker 未捕获异常：拒绝所有在途请求
      for (const [, p] of decodeWorkerPending) {
        p.reject(new Error(e.message || '解码 worker 异常退出'));
      }
      decodeWorkerPending.clear();
      decodeWorker?.terminate();
      decodeWorker = null;
    };
  }
  return decodeWorker;
}

/** 将 worker 返回的通道 ArrayBuffer 重建为主线程 AudioBuffer。 */
function reconstructAudioBuffer(msg: DecodeWorkerSuccess): AudioBuffer {
  /**
   * 意图：校验 worker 返回数据的合理性。
   * worker 报"成功"但数据可能是 0 帧（解码中断/传输错误），
   * new AudioBuffer({length: 0}) 会抛 NotSupportedError。
   * 而且这个错误在 try/catch 之外（decodeAudioBlobInWorker 的
   * 正常路径），直接崩到调用方且没有降级。提前检查 → 抛明确错误 →
   * 被外层 catch 捕获 → 自动降级到主线程解码。
   */
  if (
    msg.numberOfChannels <= 0 ||
    msg.length <= 0 ||
    !Number.isFinite(msg.sampleRate) ||
    msg.sampleRate <= 0
  ) {
    throw new Error(
      `[sample-player] worker 返回数据无效: channels=${msg.numberOfChannels} length=${msg.length} sr=${msg.sampleRate}`,
    );
  }
  const buffer = new AudioBuffer({
    numberOfChannels: msg.numberOfChannels,
    length: msg.length,
    sampleRate: msg.sampleRate,
  });
  for (let c = 0; c < msg.numberOfChannels; c++) {
    buffer.copyToChannel(new Float32Array(msg.channels[c]), c);
  }
  return buffer;
}

/**
 * Blob → AudioBuffer + 音高检测（Web Worker 内完成，主线程不卡）。
 * Blob 经结构化克隆进 worker（immutable 引用，无字节拷贝），文件读取
 * 发生在 worker 线程。兼容降级：worker 创建失败或解码报错时回退主线程
 * decodeAudioBlob + detectPitchYin（仅兜底路径，功能不丢）。
 */
export async function decodeAudioBlobInWorker(blob: Blob): Promise<DecodedAudio> {
  let msg: DecodeWorkerSuccess;
  try {
    const worker = getDecodeWorker();
    const id = ++decodeWorkerSeq;
    msg = await new Promise<DecodeWorkerSuccess>((resolve, reject) => {
      decodeWorkerPending.set(id, { resolve, reject });
      worker.postMessage({ id, blob });
    });
  } catch {
    // 降级：主线程解码 + 就地音高检测（保留原语义）
    const buffer = await decodeAudioBlob(blob);
    const { detectPitchYin } = await import('./pitch');
    return { buffer, detectedPitchHz: detectPitchYin(buffer) };
  }

  return {
    buffer: reconstructAudioBuffer(msg),
    detectedPitchHz: msg.detectedPitchHz,
  };
}

// ---------------------------------------------------------------------------
// 共享解码去重 —— 导入（store）/ 预热（buffer-cache-service）/ 波形缩略
// （SampleChip）统一走此入口：同一 sampleId 的并发解码只真正执行一次，
// 全应用共享同一次 worker 解码结果，杜绝重复解码导致的重复大拷贝。
// ---------------------------------------------------------------------------

/** 在途解码表：sampleId → Promise（成功后进运行时缓存由调用方负责） */
const sharedDecodes = new Map<string, Promise<DecodedAudio>>();

/**
 * 按 sampleId 共享的解码入口。同 id 并发调用返回同一个 Promise；
 * worker 解码失败时自动回退主线程路径（decodeAudioBlobInWorker 内部处理）。
 */
export function decodeAudioBlobShared(
  id: string,
  blob: Blob,
): Promise<DecodedAudio> {
  let pending = sharedDecodes.get(id);
  if (!pending) {
    pending = decodeAudioBlobInWorker(blob).finally(() => {
      sharedDecodes.delete(id);
    });
    sharedDecodes.set(id, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

export interface PlaySampleOptions {
  buffer: AudioBuffer;
  /** 输出目的地：原生 AudioNode 或 Tone 节点（内部用 Tone.connect 兼容两者） */
  destination: AudioNode | Tone.ToneAudioNode;
  /** 绝对开始时间（ctx 时钟秒）；缺省 = 立即 */
  when?: number;
  /** 半音偏移 → 音高因子 = 2^(n/12)；缺省 0。经 WASM 相位声码器解耦变调（不变时长）。 */
  semitones?: number;
  /** 时长因子 τ（输出/输入时长），缺省 1。与 semitones 独立，实现三模式播放。 */
  timeFactor?: number;
  /** 线性增益 0..1+；缺省 1 */
  gainLinear?: number;
  /** 最长播放秒数（含包络）；缺省播完整段 */
  durationSec?: number;
  /**
   * 在哪个上下文上创建源节点。默认全局实时上下文；
   * OfflineAudioContext 渲染（导出）必须传离线上下文！
   */
  sourceContext?: BaseAudioContext;
  /**
   * 变调/拉伸算法：`'psola'`（默认）、`'stretch'`（SOLA/FL 风格）或 `'vocoder'`。
   *
   * ══ 为什么默认是 PSOLA ══
   *
   * 本项目的主素材是**人声**（鬼畜调教）。按 48k 逐帧 YIN + 互相关精修 pitch mark
   * 的 PSOLA 是唯一同时做到「音高准确」「共振峰不动（不变声成花栗鼠）」「无相位
   * 声码器的水声」的路径 —— 代价是它依赖清浊音检测，对纯噪声/打击乐退化成按时间
   * 映射重采样（也就是不变调），这时由 SOLA 兜底。
   *
   * 相位声码器在人声上必然产生「电音 / 水声」（phasiness）：相位在相邻帧间被强行
   * 推进，瞬态被打散。这是算法性质，不是实现缺陷，所以它排最后。
   *
   * 曾经的 bug：`transformBuffer` 调用时**漏传 mode**，于是始终走默认的声码器
   * 路径 —— 用户听到的就是「装配变调产生电音」。后来默认又被写成 SOLA/Stretch，
   * 于是「拉伸」长期走的是 `resample + SOLA`（先重采样改变共振峰再拼回去）。
   *
   * ══ 实验分支 feat/lib-engines 补充 ══
   * 上面的 `transformMode` 只管**项目自己**那条链路的模式。若用户在装配面板里
   * 点选了第三方引擎（全局偏好存在 `engine/external-shift.ts`，localStorage 持久化），
   * `playSample` 会**优先**走那条路径 —— 试听（NotePalette）、舞台回放
   * （take-player / key-machine）、离线渲染导出（exporter）全部经过这里，
   * 所以三处自动同源，不会「听着一个声、导出来另一个声」。
   * 偏好默认 `'wasm'`，即本参数的行为与改动前完全一致；
   * 第三方路径失败、或选了引擎但时间伸缩内核未就绪时，都自动回退到这里。
   */
  transformMode?: 'stretch' | 'psola' | 'vocoder';
  /**
   * 起播前才去停掉的「上一段」。
   *
   * ══ 为什么不能由调用方在调用 `playSample` **之前**停掉（2026-09-20 实测）══
   *
   * 装配面板的试听原本就是这么写的：`previewRef.current?.stop(0.03)` 先停上一段、
   * 再调 `playSample` 播新的。而 `playSample` 是**先做整段变换、再调度源节点**的，
   * 变换是同步的（实测：1.0s 素材 / 我们的 PSOLA = **580ms**，
   * 见 `_probe-palette.mjs` 第 15 节）。于是「新的还没算完，旧的就先掐了」：
   *
   *   实测（同一节，按住 Shift+↑ 连按 5 次、1.0s 素材）：
   *     第 2~5 段试听各自只响 **69~240ms**（满长 1012ms），
   *     相邻两段之间还留着 **558~590ms 的空档** —— 用户听到的就是
   *     「声音响了，但只响一点点」。
   *
   * 把「停」挪到新一段**即将出声的那一刻**（本函数内 `src.start` 之前），
   * 就变成「旧的响到新的能接上为止」：既不留空档，也不把「还没算完」的等待
   * 记成上一段的寿命。代价是与新一段最多 `fadeSec` 的重叠（听感上无缝）。
   *
   * ⚠️ 只对「立即起播」（不传 `when`，或 `when` 已经到了）成立：
   * 若 `when` 是未来的调度时间，上一段会在新一段真正起播**之前**就淡出、中间留空。
   * **不要**把带未来 `when` 的排期播放（`take-player` / `exporter`）接到这个参数上。
   */
  replacePrevious?: PlayingSample | null;
}

export interface PlayingSample {
  readonly when: number;
  readonly durationSec: number;
  /** 提前停止（带快速淡出防咔哒）；已自然结束则为 no-op。 */
  stop(fadeSec?: number): void;
}

/**
 * WASM 无法完成独立变换时的保真降级。
 * 不能使用 playbackRate=pitch：那会把“变调”和“变速”重新耦合。
 * 因此失败时宁可播放原声，也不偷偷改变用户设置之外的维度。
 */
export function fallbackPlaybackRate(): number {
  return 1;
}

/**
 * 第三方引擎的音高检测范围。
 * 比库默认的 80–500Hz 更宽：鬼畜素材里既有低沉男声也有尖细音效，
 * 收窄会让音高标记检不出来 → 库内部回落到 WSOLA（听感会突然变一档，
 * 而用户不知道为什么）。探针 `probe.mjs` 用同一组值，两边可比。
 */
const EXT_MIN_FREQ = 60;
const EXT_MAX_FREQ = 900;

/**
 * 第三方路径的**结果缓存**。
 *
 * ── 为什么必须有（用户实报「变调 / 浏览素材变的很卡」）──
 *
 * 实测（`probe-silence-lag.mjs`，41 素材立体声、中位耗时）：
 *
 *   我们的 mode1      **283ms**      第三方：hybrid 246 / ST-声码器 278 /
 *                                     psola 266 / hpss 165 / lpc 116 / wsola 104
 *                                     —— 快的一档 18~56ms（ola / sample / vocoder）
 *
 * 也就是说**我们自己的内核单次也慢**（283ms 是同一量级）。区别不在谁快，而在
 * **谁只付一次**：`rush/transform.ts::transformBuffer` 有 WeakMap LRU 缓存，
 * 同一段素材的第二次试听、每一次重复按键、导出循环里的每个事件全都命中缓存；
 * 而这条第三方路径**原先一个缓存都没有** —— 每一个音符、每一次试听、
 * 导出循环的每一个事件都要把整段素材重算一遍，且是**同步跑在主线程上**。
 *
 * 于是症状完全对得上：`exporter.ts` / `take-player.ts` 是**逐事件**调
 * `playSample` 的（一个 200 事件的 take = 200 次全量变换），按键只要有一点
 * 音高差就是一次新的全量变换 —— 主线程被一段一段地卡住，
 * 连「浏览素材」（移动光标、滚列表）都跟着顿。
 *
 * ── 键为什么带引擎 id ──
 *
 * 换了引擎，同一段素材的产物就该重算 —— 不带 id 会命中上一个引擎的结果，
 * 表现是「切了引擎声音没变」，正是这个分支最该避免的那类错误。
 *
 * ── 为什么不直接缓存到 `rush/transform` 那份里 ──
 *
 * 那份的键是 `pitch|time|mode`，属于 wasm 内核的私有语义。两者共用会让
 * 「谁的缓存放谁的产物」纠缠不清，出问题时无法判断是引擎坏了还是缓存串了。
 */
const extCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();

/** 每段源素材最多缓存 8 条（与 `rush/transform` 同一约定：拖旋钮不该把内存拖爆） */
const MAX_EXT_CACHE_PER_BUFFER = 8;

/**
 * 用第三方引擎做整段变换（实验分支 feat/lib-engines）。
 *
 * 语义与 wasm 的 `hajimi_tx_run(.., pitch, time, ..)` 对齐 —— **音高 ×pitch、
 * 时长 ×time，两个维度互不牵连**。第三方库把这两件事分在了两个包里：
 *
 *   `@audio/shift-*`  只做 ratio（改音高，**时长不变**）
 *   `@audio/stretch-*` 只做 factor（改时长，**音高不变**）
 *
 * 所以这里是「先变调、再伸缩」的串联。τ === 1 时跳过第二步 ——
 * 这是装配面板里的常态，也就省掉一整轮分析合成。
 *
 * 通道处理：`@audio/shift-*` 原生支持 `Float32Array[]`（逐通道独立），
 * 直接整条交给它；伸缩那一步的包只声明了单通道，就逐通道调。
 * 注意输入的通道数据要**先复制**：源 buffer 可能正躺在 `bufferCache` 里被
 * 别的调用复用，不能让第三方库原地改写它。
 */
function transformByExternal(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  pitch: number,
  time: number,
  engineId: ExternalEngineId,
  shift: ShiftFn,
  stretch: StretchFn | null,
): AudioBuffer {
  const sr = input.sampleRate;
  const nch = input.numberOfChannels;

  // 类型用 Float32Array<ArrayBufferLike>：getChannelData().slice() 就是它，
  // 而裸 Float32Array 在 TS 5.7+ 等价于 Float32Array<ArrayBuffer>，两者不互相赋值。
  const channels: Float32Array<ArrayBufferLike>[] = [];
  for (let c = 0; c < nch; c++) channels.push(input.getChannelData(c).slice());

  const shiftOpts = {
    ratio: pitch,
    sampleRate: sr,
    minFreq: EXT_MIN_FREQ,
    maxFreq: EXT_MAX_FREQ,
  };
  // 多通道进 → 多通道出；个别实现在某些分支上只回一条，统一成数组再往下走
  const shiftedRaw = shift(channels, shiftOpts) as unknown;
  let out: Float32Array<ArrayBufferLike>[] = Array.isArray(shiftedRaw)
    ? (shiftedRaw as Float32Array<ArrayBufferLike>[])
    : [shiftedRaw as Float32Array<ArrayBufferLike>];
  if (!out.length || !out[0]) {
    throw new Error('第三方引擎返回空结果');
  }

  if (Math.abs(time - 1) > 1e-6) {
    if (!stretch) throw new Error('需要时间伸缩但内核未就绪');
    const stretchOpts = {
      factor: time,
      sampleRate: sr,
      minFreq: EXT_MIN_FREQ,
      maxFreq: EXT_MAX_FREQ,
    };
    out = out.map((ch) => stretch(ch, stretchOpts));
  }

  /*
    ══ 出口验收 ══

    放在**所有**变换步骤之后、写进 AudioBuffer 之前：验收的对象就是「马上要播出去
    的那串样点」。判据与实测依据见 `shift-output-guard.ts`。

    为什么必须抛异常而不是「修一下再用」：这是降级链的唯一推进方式
    （`isPsolaSilentNoop` 对 wasm 那一侧做的就是同一件事）。不抛 =
    用户听到一段静音或 32 倍爆音，而且**界面上完全看不出来**。
    这里**不做任何「补救」**（不归一化、不补零、不截幅）—— 一旦开始补救，
    就等于在替用户选「坏音频的哪种坏法」，那正是本项目禁止的。
  */
  for (let c = 0; c < out.length; c++) {
    const v = checkShiftOutput(channels[0], out[c] ?? out[0]);
    if (!v.ok) {
      throw new Error(
        `[sample-player] 引擎「${engineId}」输出未通过验收：${v.reason}` +
          `（ratio=${pitch.toFixed(4)}, τ=${time.toFixed(3)}）`,
      );
    }
  }

  // 各通道长度理论上一致；真出现 ±1 也以最短为准，好过让写入越界
  let len = Infinity;
  for (const ch of out) len = Math.min(len, ch.length);
  len = Math.max(1, len === Infinity ? 0 : len);

  const buf = ctx.createBuffer(nch, len, sr);
  for (let c = 0; c < nch; c++) {
    const src = out[c] ?? out[0];
    // 用 getChannelData().set() 而不是 copyToChannel()：前者无断言即可通过
    // 类型检查（copyToChannel 形参是 Float32Array<ArrayBuffer>），且不多一次拷贝。
    buf.getChannelData(c).set(len === src.length ? src : src.subarray(0, len));
  }
  return buf;
}

/**
 * 带缓存的第三方变换（`transformByExternal` 的唯一入口）。
 *
 * 缓存命中时零重算 —— 这是「卡」的主修：试听第二遍、重复按同一个键、
 * 导出循环里重复的 (素材, 音高) 组合全部免费。
 */
function transformByExternalCached(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  pitch: number,
  time: number,
  engineId: ExternalEngineId,
  shift: ShiftFn,
  stretch: StretchFn | null,
): AudioBuffer {
  let m = extCache.get(input);
  if (!m) {
    m = new Map();
    extCache.set(input, m);
  }
  const key = `${engineId}|${pitch.toFixed(4)}|${time.toFixed(4)}`;
  const hit = m.get(key);
  if (hit) {
    // Map 同时当 LRU 队列：命中后挪到末尾，别让常用的那条被淘汰
    m.delete(key);
    m.set(key, hit);
    return hit;
  }

  const out = transformByExternal(ctx, input, pitch, time, engineId, shift, stretch);
  m.set(key, out);
  if (m.size > MAX_EXT_CACHE_PER_BUFFER) {
    const firstKey = m.keys().next().value;
    if (firstKey !== undefined) m.delete(firstKey);
  }
  return out;
}

/**
 * 播放一段采样。
 * - 变调/变速：优先预渲染到新 buffer，源节点固定 playbackRate=1
 * - 包络：~4ms 起音 + ~12ms 收尾线性斜坡，杜绝起停爆音
 * - 自动清理：onended 后断开全部连接
 */
export function playSample(opts: PlaySampleOptions): PlayingSample {
  const ctx = opts.sourceContext ?? getAudioContext();
  /*
    ⚠️ 这里取到的是「**被请求的**起播时刻」，不是最终使用的那个。

    真用它去排包络是本函数一个长期潜伏的错：`when` 在整段变换**之前**取值，
    而变换是同步的（100~640ms），等排包络时时钟已经走过去一大截 ——
    整条包络时间线就被排在「过去」上。后果按素材长度分两档：

      · 素材比变换耗时**短** → 整条包络（含收尾）都在过去 → 增益停在收尾值
        （`linearRampToValueAtTime(0.0001, when + dur)` 的终点）= **一点声音都没有**。
        实测机制见 `__envStale`（`_probe-palette.mjs` 第 15 节）：
        把 `when` 放在 1200ms 前，1.0s 的源渲出来 RMS = 0。
      · 素材比变换耗时**长** → 增益落在平台段、声音还在，但起音的 4ms 斜坡
        （唯一的防咔哒手段）被跳过了 → 每次都带一个咔哒。

    实测到的落后量：1.0s 素材 / 我们的 PSOLA = **580ms** 落后；
    第三方引擎更慢（`_probe-palette.mjs` 第 13 节：444ms、483ms 甚至秒级）。

    所以**真正的起播时刻在变换之后才落定**（见下面的 `startAt`）。
    对「未来排期」的调用（`opts.when` 在未来）结果不变：`max` 仍取 `opts.when`。
  */
  const requestedWhen = Math.max(opts.when ?? ctx.currentTime, ctx.currentTime);
  const pitch = playbackRateForSemitones(opts.semitones ?? 0); // 音高因子 π
  const time = opts.timeFactor ?? 1; // 时长因子 τ
  const targetGain = Math.max(0, opts.gainLinear ?? 1);

  // WASM 离线整段变换出目标 buffer，原生源节点以 rate=1 精确调度。
  // 默认走 PSOLA（mode=1）；WASM 不可用时保持原声，不错误耦合参数。
  /*
    ══ 变调：带**降级链**，任何一步失败都还有声音 ══

    旧实现是一次尝试 + 零容错：
      `buffer = transformBuffer(...)` 一旦抛异常，整个 playSample 抛出，
      调用方（NotePalette 的试听）没有 try/catch → **静默无声**。
      这就是「装配好的变调声音不响」的直接原因：
      WASM 在个别素材上返回 `-2`（没算出有效帧）就会走到这一步。

    现在的顺序（每一步失败就退到下一步，绝不静默）：
      1. **PSOLA**（mode=1）—— 默认。人声素材音高准确、共振峰不动、无相位声码器的水声，
         拉伸与变调走同一条时间映射。
         （曾试过 mode=3 = 降调加谐波/噪声分离，把降调侧的 HNR 与 HF 分档都做"干净"了，
         但**实听更差**，已撤下 —— 见下面 modes 处的说明。）
      2. **SOLA**（mode=2）—— PSOLA 对该素材失效时的兜底：不依赖清浊判断，
         代价是变调要连带改变共振峰；
      3. **原声 rate=1** —— WASM 整体不可用时的保真退路；宁可暂时不变换，
         也不以 playbackRate 把音高和时长错误耦合。

 步 1 的失效有**两种**，第二种曾经完全不触发降级：
      - 抛异常（返回帧数 <= 0）—— 一直能正常推进到步 2；
      - **静默空转**：素材没有可同步的周期（打击乐 / 纯噪声 / 短到没有两个周期），
        颗粒全落固定颗粒路径，推进量是常量 → 输出等于「按时间映射重采样原声」，
        **音高一点没动**，但它返回合法音频、不抛异常。降级链于是永远停在步 1，
        用户看到的就是「装配面板 Shift+↑ 在部分素材上毫无反应」（实测 13/41）。
        现在由 `transformBuffer` 用 wasm 的 `hajimi_tx_marks` 计数识别这种状态，
        主动抛 `PsolaSilentNoopError`，降级链照常推进。
  */
  let buffer: AudioBuffer = opts.buffer;
  let rate = fallbackPlaybackRate();

  /*
    ══ ① 第三方引擎（实验分支 feat/lib-engines）══

    只有用户在**装配面板里显式点选**了某个第三方引擎、且那个库已经加载完成时，
    才走这条。默认偏好是 `'wasm'`（`getActiveShift()` 返回 null）→ 整段跳过，
    行为与存档点 bb2fc05 逐字节一致。

    未就绪的两种情况都**回退 wasm**，不做半吊子处理：
      · 库还在下载 / 加载失败 → 回退（面板上会显示 loading，正常不会撞上）；
      · 选了引擎但 τ≠1 且时间伸缩内核未就绪 → 回退，绝不「只变调、把变速丢掉」。
        后者是这里最需要防的坑：它输出合法音频、听上去还挺对，
        但用户设的变速被静默吃掉了 —— 与 `PsolaSilentNoopError` 同一类失败。

    ══ ② 「没什么可变换」时**不进引擎**（2026-09-20 加）══

    音高 ×1 且时长 ×1 时直接跳过整个外部分支：既不改音高也不改时长，
    正确答案就是源本身。wasm 那一侧本来就有这个短路
    （`transformBuffer` 开头 `pitch≈1 && τ≈1` 直接 return buffer），
    而这条路径早先没有 —— 于是**「没变调」也在跑满一整套分析合成**，
    而 ratio=1 恰恰是 App 里最常见的档（autoTune 关掉、又没手动移调时）。
    实测一次全量变换 100~640ms（见 `extCache` 的注释），白花得毫无道理。

    这条分支覆盖的不只是试听：`exporter.ts`（离线渲染导出）与
    `take-player.ts`（整段回放）同样经过 `playSample`，所以「试听 + 导出」
    会自动用同一个引擎 —— 不会出现「听着是一个声、导出来是另一个声」。
  */
  let transformed = false;
  const noTransform = Math.abs(pitch - 1) < 1e-4 && Math.abs(time - 1) < 1e-4;
  const extShift = noTransform ? null : getActiveShift();
  const extEngineId = noTransform ? null : getActiveEngineId();
  if (extShift && extEngineId) {
    const needStretch = Math.abs(time - 1) > 1e-6;
    const extStretch = getStretchIfNeeded(needStretch);
    if (!needStretch || extStretch) {
      try {
        buffer = transformByExternalCached(
          ctx,
          opts.buffer,
          pitch,
          time,
          extEngineId,
          extShift,
          extStretch,
        );
        rate = 1;
        transformed = true;
      } catch (err) {
        // 出口验收没过、库内部抛错、引擎返回空结果 —— 全部走这一条：
        // 退到 wasm 降级链，**绝不让坏音频播出去**。日志带上引擎名与比例，
        // 便于据此判断是「这个引擎做不了这个档位」还是「引擎坏了」。
        console.warn(
          `[sample-player] 第三方引擎「${extEngineId}」变换失败（ratio=${pitch.toFixed(4)}, τ=${time.toFixed(3)}），回退 wasm PSOLA`,
          err,
        );
      }
    } else {
      console.warn('[sample-player] 已选第三方引擎，但时间伸缩内核未就绪，回退 wasm');
    }
  }

  if (!transformed && isRushReady()) {
    const modes: ReadonlyArray<0 | 1 | 2 | 3> =
      opts.transformMode === 'vocoder'
        ? [0, 2]
        : opts.transformMode === 'stretch'
          ? [2, 1]
          : [1, 2];   // 默认走 PSOLA
    /*
      ⚠ mode 3（PSOLA + 降调谐波分离）**已从默认链路撤下**（2026-09-19 用户实听判定）。
      它把降调侧的 HNR 提上去了、HF 分档压到源以下、指标全面变「干净」，
      但听感反而更差：用户原话「噪音变成另一种形式了」。
      原因见 `transform.ts::transformBuffer` 的 mode 说明与
      `.workbuddy/memory/2026-09-19.md`「mode 3 被实听否决」一节：
      把源里的非周期成分抽掉之后，剩下的严格周期谐波在颗粒重排下变成
      **机械的嗡嗡/金属声**（TD-PSOLA 的固有 buzyness），而被抽掉的那部分
      恰恰是让声音像人声的气声与微抖动；再加回一半、且加在**原位频谱**上，
      两层不再属于同一个声音。指标奖励了「净化」，耳朵要的是「自然」。
      实现与探针保留（`hajimi_tx_run` mode=3 / `_probe-hnsep.mjs`），
      但**不要重新接回默认链路**，除非有听感证据翻转。
    */
    for (const m of modes) {
      try {
        buffer = transformBuffer(ctx, opts.buffer, pitch, time, m);
        rate = 1;
        break;
      } catch (err) {
        // 静默空转（PsolaSilentNoopError）走同一条降级路径 —— 它本来就是「成功但
        // 没做事」，对听众等价于失败。日志区分开，便于查素材。
        const why = err instanceof PsolaSilentNoopError ? ' PSOLA 静默空转' : '';
        console.warn(`[sample-player] 变调失败（mode=${m}）${why}，尝试降级`, err);
      }
    }
    // 两次都失败 → 原声 rate=1；绝不以错误的“变调同时变速”冒充成功。
  }

  const naturalDur = buffer.duration / rate;
  const dur = Math.min(opts.durationSec ?? naturalDur, naturalDur);

  /*
    ══ 起播时刻在这里才落定 ══

    整段变换已经算完，现在读的 `ctx.currentTime` 才是「真正能出声」的时刻。
    若请求的时刻已经过去（同步变换把它耗掉了），就把整条包络**平移到现在**，
    而不是留在过去 —— 留在过去 = 包络早已收尾 = 没有声音（见函数开头）。
    未来排期不受影响：此时 `startAt === requestedWhen`。
  */
  const startAt = Math.max(requestedWhen, ctx.currentTime);

  // 极短片段时收缩包络避免负时间
  const attack = Math.min(0.004, dur / 3);
  const release = Math.min(0.012, dur / 3);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, startAt);
  env.gain.linearRampToValueAtTime(targetGain, startAt + attack);
  env.gain.setValueAtTime(targetGain, Math.max(startAt + attack, startAt + dur - release));
  env.gain.linearRampToValueAtTime(0.0001, startAt + dur);

  src.connect(env);
  Tone.connect(env, opts.destination);
  /*
    上一段到**这一刻**才停 —— 新的一段已经算好、马上要出声，
    所以这是「交给下一段」而不是「把还没响完的那段掐掉」。
    详见 `PlaySampleOptions.replacePrevious` 的实测数据。
  */
  opts.replacePrevious?.stop();
  src.start(startAt, 0, dur + release);

  let stopped = false;
  /** 已自然结束（`onended` 到过）。 */
  let finished = false;
  const handle: PlayingSample = {
    when: startAt,
    durationSec: dur,
    stop(fadeSec = 0.02) {
      /*
        已经响完的段直接 no-op。
        从前只挡 `stopped`（重复手动停），于是「停一段自己已经播完的音频」
        会走到 `src.stop()` 上抛 InvalidState、被 catch 成一条 warn ——
        而 `replacePrevious` 这条路径**本来就常常**是「上一段已经响完」，
        于是每次调音都多一条「重复停止已结束节点」的噪声日志。
        噪声日志比不检查更坏：它会训练人忽略这一行（见探针 favicon 那条教训）。
      */
      if (stopped || finished) return;
      stopped = true;
      const now = ctx.currentTime;
      try {
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(env.gain.value, now);
        env.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
      } catch (err) {
        console.warn('[sample-player] 手动停止包络失败', err);
      }
      try {
        src.stop(now + fadeSec + 0.01);
      } catch (err) {
        // 已自然结束的源节点重复 stop 会抛 InvalidState，忽略即可
        console.warn('[sample-player] 重复停止已结束节点', err);
      }
    },
  };
  src.onended = () => {
    src.onended = null;
    finished = true;
    try {
      env.disconnect();
    } catch (err) {
      console.warn('[sample-player] 清理包络节点失败', err);
    }
  };
  return handle;
}
