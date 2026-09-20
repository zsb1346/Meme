/**
 * 音高检测主线程侧 —— 统一走 pitch-worker（YIN + AI 两路）。
 *
 * 职责：
 *  - 调用 worker 并缓存结果（store / 内存双层）
 *  - 暴露 status 事件（AI 模型加载中 → UI 提示）
 *  - 超时兜底（worker 卡死不会让调用方永远挂起）
 *  - AI 失败时**回退 YIN**（AI 是更强的检测器，不是唯一路径）
 *
 * 与旧版差异：
 *  - AI 检测已并入 worker（旧 pitch-ai.ts 主线程路径已删）
 *  - PCM 拷贝用 slice（原生 memcpy），不再逐个 for
 *  - 传 4 秒 PCM 上限（AI 与 YIN 相同），真正的算力成本由 worker 侧的
 *    `AI_SECONDS`（1 秒）决定；多传一点是为了让 worker 能挑「最响的那一秒」
 *  - 超时改成**两级 + 按检测器分级**（旧的单一 15000ms 让 AI 必然超时，
 *    见 TIMEOUT_MS 的注释），并从 worker 回过 ack 之后才起算
 */
import { useStore } from '../model/store';
import type { SampleId } from '../model/types';
import { type YinOptions, detectPitchYinCore } from './pitch';
import {
  PITCH_ACK_WATCHDOG_MS,
  PITCH_TIMEOUT_MS,
  centsBetween,
  shouldRejectAiPitch,
} from './pitch-ai-budget';
import {
  PitchWorkerUnavailableError,
  WORKER_RESPAWN_COOLDOWN_MS,
  classifyWorkerFailure,
  isWorkerUnavailable,
  shouldSpawnWorker,
  type WorkerFailure,
} from './pitch-worker-health';
import { type Detector, isDefaultYinOpts } from './pitch-settings';

// ---- 状态事件（AI 模型加载 / worker 存活） ----

/**
 * `'unavailable'` = **worker 整个起不来**（脚本没加载 / 崩了），
 * 与「AI 模型加载中」是两件事：
 *  - `'loading_model'` 会通向 `'ready'`，只是慢；
 *  - `'unavailable'` **不会自己恢复**到 `'ready'`（要么等冷却后重生成功，要么修环境）。
 *
 * 混在一起的代价：worker 死掉时 UI 会永远停在「首次加载 AI 模型…」，
 * 把一个「这里坏了」显示成「再等等」。
 */
export type PitchWorkerStatus = 'loading_model' | 'ready' | 'unavailable';
const statusTarget = new EventTarget();

/**
 * 最近一次的 worker 存活状态。
 *
 * 为什么要能在订阅**之前**取到：`PitchDisplay` 是挂载时才订阅的，
 * 而 worker 可能在它挂载**之前**就已经死了（例如用户在别的面板待了一会儿）。
 * 只靠事件的话，那个组件会从 `'ready'` 起步，等于谎报「一切正常」。
 */
let workerStatus: PitchWorkerStatus = 'ready';

/** 读当前状态（供挂载晚于事件的组件取初值）。 */
export function getPitchWorkerStatus(): PitchWorkerStatus {
  return workerStatus;
}

/** 订阅 worker 状态变化。返回取消函数。 */
export function subscribePitchStatus(
  cb: (status: PitchWorkerStatus) => void,
): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<PitchWorkerStatus>).detail);
  statusTarget.addEventListener('pitch-status', handler);
  return () => statusTarget.removeEventListener('pitch-status', handler);
}

function emitStatus(status: PitchWorkerStatus): void {
  workerStatus = status;
  statusTarget.dispatchEvent(new CustomEvent('pitch-status', { detail: status }));
}

// ---- 内存缓存 ----

/** 一次检测的结果，连同**实际产出它的检测器**。 */
export interface PitchLookup {
  hz: number | null;
  /**
   * 真正给出这个值的检测器。
   * 请求 `'ai'` 但 AI 弃权 / 硬失败 / 与 YIN 冲突而由 YIN 兜底时，这里是 `'yin'`
   * —— UI 据此把「AI 音高」标成「AI 音高 · YIN 兜底」，不谎报来源。
   */
  detector: Detector;
}

function cacheKey(id: SampleId, detector: Detector, opts?: YinOptions): string {
  if (detector === 'ai') return `ai:${id}`;
  if (!opts) return id;
  return `${id}|t${opts.threshold ?? 0.12}|n${opts.minHz ?? 65}|m${opts.maxHz ?? 1200}`;
}

const cache = new Map<string, PitchLookup>();

// ---- Worker 单例 ----

let worker: Worker | null = null;
let reqId = 0;

/**
 * 上一次 worker 失败的时刻与原因（`null` = 没失败过）。
 *
 * 两个用途：
 *  ① **冷却窗** —— 避免「每个请求都生成一个注定失败的 worker」（见 `shouldSpawnWorker`）；
 *  ② **报错文案** —— 冷却窗内立刻失败时，必须把上一次的**真原因**带上；
 *     否则用户只会看到「暂时不可用」，又回到了「不知道为什么」。
 */
let failedAt: number | null = null;
let lastFailure: WorkerFailure | null = null;

/** 本会话一共 `new` 过几个 worker。仅诊断用（探针据此断言「没有重生风暴」）。 */
let spawnCount = 0;

/** worker 侧的诊断快照（探针 / 排错用）。 */
export function getPitchWorkerDiagnostics(): {
  status: PitchWorkerStatus;
  spawnCount: number;
  failedAt: number | null;
  lastFailure: WorkerFailure | null;
} {
  return { status: workerStatus, spawnCount, failedAt, lastFailure };
}

interface PendingEntry {
  resolve: (hz: number | null) => void;
  reject: (e: Error) => void;
  detector: Detector;
  /** 当前生效的那个定时器（见下面两级超时的说明）。 */
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingEntry>();

/**
 * 两级超时（数值在 `pitch-ai-budget.ts`，与 worker 的输入长度同源）。
 *
 * ══ ① 收到 ack 之前：只防「worker 整个死了」 ══
 *
 * AI 一次推理要好几秒，模型加载可能更久。若从 postMessage 起就算超时，
 * **排队等待的时间会被算进推理预算** —— 用户快速切换素材时，后一条请求
 * 可能在还没轮到执行时就先超时（表现为「有些素材能测出来，有些不行」）。
 * worker 收到消息立刻回 ack，超时从那一刻才起算；ack 之前只用看门狗兜底。
 *
 * ══ ② 收到 ack 之后：按检测器给预算 ══
 *
 * 见 `PITCH_TIMEOUT_MS` 的注释 —— 旧的单一 15000ms 让 4 秒输入的 AI 必然超时，
 * 那就是「AI 检测永远未检出」的直接原因。
 */
const ACK_WATCHDOG_MS = PITCH_ACK_WATCHDOG_MS;

function armTimeout(id: number, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.reject(new Error(`音高检测超时（${ms}ms）`));
  }, ms);
  return t;
}

function clearPending(id: number): PendingEntry | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  pending.delete(id);
  return entry;
}

/**
 * 取 worker 单例；**起不来时抛 `PitchWorkerUnavailableError`**（而不是返回半死的对象）。
 *
 * 「抛异常」是有意的：`getSamplePitchHzDetailed` 据此区分
 * 「整个 worker 没了」（→ 走主线程 JS 应急退路）
 * 与「这一条请求本身出错」（→ 照旧往上抛）。
 * 返回一个能 postMessage 但永远不回话的对象，会让调用方一直等到超时才失败 ——
 * 那正是 4 秒一格的卡顿来源。
 */
function ensureWorker(): Worker {
  if (worker) return worker;

  const now = Date.now();
  if (!shouldSpawnWorker(now, failedAt)) {
    // 冷却窗内不再赌一次：立刻失败，并把**上一次的真原因**带出去。
    throw new PitchWorkerUnavailableError(
      lastFailure ?? { kind: 'unknown', reason: '音高 worker 当前不可用' },
    );
  }

  const w = new Worker(new URL('./pitch-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker = w;
  spawnCount++;

  w.onmessage = (e: MessageEvent) => {
    // 已被替换掉的旧 worker 的消息不再理会（否则会用过期消息改全局状态）。
    if (worker !== w) return;

    /*
      收到**任何**一条消息都说明 worker 活着 —— 包括第一条 ack。
      所以在这里解除「不可用」，并通知 UI 从「不可用」回到正常。
      放在这里而不是「请求成功后」：ack 就是最早的存活证据，早一点解除，
      UI 就少显示一帧「不可用」。
    */
    if (failedAt !== null) {
      failedAt = null;
      lastFailure = null;
      emitStatus('ready');
    }

    const msg = e.data;
    // 非结果消息（status / ack）先分流，别让它们掉进下面按 id 取 pending 的分支。
    if (msg.type === 'status') {
      emitStatus(msg.status);
      return;
    }
    if (msg.type === 'ack') {
      // 真正开始跑了 → 换成该检测器的实际预算
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        entry.timer = armTimeout(msg.id, PITCH_TIMEOUT_MS[entry.detector]);
      }
      return;
    }
    // 只认「有 hz 或 error」的消息为结果。协议以后再加控制类消息时，
    // 漏改这里会把控制消息误当成 hz=undefined 的结果（=「未检出音高」），
    // 那是最难查的一类静默失效。
    if (!('hz' in msg) && !('error' in msg)) return;
    const entry = clearPending(msg.id);
    if (!entry) return;
    if ('error' in msg) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg.hz);
    }
  };

  w.onerror = (e) => {
    /*
      ⚠️ 先把**这个** worker 摘掉，再决定要不要动全局状态。
      旧实现是无条件 `worker?.terminate(); worker = null;` ——
      若此刻 `worker` 已经指向**新**实例（上一次失败后重生过），
      它就会把好的那个一起 terminate 掉，而且不留痕迹（表现为「时好时坏」）。
    */
    w.onerror = null;
    try {
      w.terminate();
    } catch {
      // 已经死透的 worker 上 terminate 可能抛，忽略
    }
    if (worker !== w) return;

    worker = null;
    failedAt = Date.now();
    lastFailure = classifyWorkerFailure(e);
    emitStatus('unavailable');

    /*
      这句话必须**自己带上原因和下一步**，不能只说「worker 异常退出」。
      用户实测拿到的原始报错就是前者，结果一路往 DSP / 模型 / wasm 方向查，
      而真因是本地 dev server 已经退出（`ERR_CONNECTION_REFUSED`）。
    */
    console.warn(
      `[pitch-async] 音高 worker 不可用（${lastFailure.kind}）：${lastFailure.reason}；` +
        `${WORKER_RESPAWN_COOLDOWN_MS}ms 内不再重试，其间 YIN 走主线程 JS 应急退路`,
    );

    const err = new PitchWorkerUnavailableError(lastFailure);
    // 先快照 key 再逐个清理：遍历中删条目虽然合法，但读起来容易误判。
    for (const id of Array.from(pending.keys())) clearPending(id)?.reject(err);
  };

  return w;
}

// ---- Worker 调用 ----

/** 单次传给 worker 的 PCM 长度上限（秒）。 */
const YIN_SECONDS = 4;
/**
 * AI 的传输长度仍是 4 秒：这里的 `slice` 只是 memcpy（768KB ≈ 0.1ms），
 * transfer 是零拷贝，真正决定成本的是**worker 里跑几批模型** ——
 * 那由 `pitch-worker.ts::AI_SECONDS` 控制在 1 秒。两者刻意分开：
 * 多传一点让 worker 有挑选「最响的那一秒」的余地。
 */
const AI_SECONDS = 4;

function sendToWorker(
  pcm: Float32Array,
  sampleRate: number,
  detector: Detector,
  opts?: YinOptions,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    const id = ++reqId;
    const timer = armTimeout(id, ACK_WATCHDOG_MS);
    pending.set(id, { resolve, reject, detector, timer });

    const seconds = detector === 'ai' ? AI_SECONDS : YIN_SECONDS;
    const maxSamples = Math.min(pcm.length, Math.floor(sampleRate * seconds));
    const copy = pcm.slice(0, maxSamples);

    w.postMessage(
      { id, detector, data: copy.buffer, sampleRate, opts },
      [copy.buffer],
    );
  });
}

// ---- 对外 API ----

/**
 * worker 起不来时的 YIN 应急退路：直接在**主线程**跑 JS 版 YIN。
 *
 * 为什么不干脆让音高检测整体不可用：那样 `PitchDisplay` 会对**所有**素材显示
 * 「未检出音高」，而素材其实是有音高的 —— 用户失去的不只是 AI，
 * 连最基本的音高读数都没了（自动修音的基准也跟着没了）。
 *
 * ══ 代价：实测**单次约 300ms 的主线程同步占用**（别再说「毫秒级」）══
 *
 * 成本**有界**（`maxFrames: 24`，帧数与素材长度无关 —— 见 `pitch.ts`），
 * 但「有界」不等于「很小」。实测（`_probe-palette.mjs` §16g-2，1.0s @48k 素材）：
 *
 *     主线程 JS YIN：307 / 293 / 295 ms
 *     同一素材走 worker 的 wasm：约 200ms，**且不冻主线程**
 *
 * 也就是说这条退路会让主线程冻 ~300ms。为什么仍然选它：
 *
 *  ① **触发时机很稀**：`PitchDisplay` 只在「目标素材 / 检测器 / 检测参数」变化时取数，
 *     **不是**跟着 Shift+↑ 的按键重复跑（那个「手感粘滞」是另一条路径，已在
 *     `NotePalette` 侧修掉）。所以它不是可感知到的持续 jank。
 *  ② **对照组太差**：没有它，故障态下**所有**素材都显示「未检出音高」，
 *     自动修音连基准都没有。冻 300ms 换回一个可用读数，这个交换划算。
 *
 * ⛔ 所以**别把这条退路变成常态路径**。它是给「worker 起不来」用的，
 * 不是「主线程也能算，那就别用 worker 了」的理由 —— 后者是拿 300ms 的
 * 主线程冻结去换一个本来能在后台免费做的事。
 *
 * ⚠️ 三条纪律（都是踩过的坑的对应面）：
 *
 *  ① **不写 store 缓存**（`detectedPitchHz`）。JS 版与 wasm 版是两份实现，
 *     JS 版实测漏检明显更多（41 个真素材：JS 未检出 15 个 / wasm 2 个）。
 *     把降级值写进工程 = 把一次**暂态故障**永久固化进数据里。
 *  ② **不写内存缓存**。同理：worker 恢复后不该继续拿降级值，
 *     否则要等下一次 `invalidatePitchCache` 才回得来。
 *     代价是每次取数重算一遍 —— 就是上面那 ~300ms，这也是为什么 ① 里
 *     「触发时机很稀」是这个方案成立的前提。
 *  ③ **降级要出声**（console.warn），但**不弹 toast**：
 *     它确实比正常路径差，日志里必须有据可查；而这个故障用户多半无能为力
 *     （dev server 没了），弹窗只会挡着他看别的。
 */
function yinOnMainThread(
  data: Float32Array,
  sampleRate: number,
  opts: YinOptions | undefined,
  reason: string,
): PitchLookup {
  console.warn(
    `[pitch-async] 音高 worker 不可用（${reason}）→ YIN 改走主线程 JS 应急退路。` +
      '该结果不如 wasm 版（漏检更多），故不写入工程缓存与内存缓存。',
  );
  return { hz: detectPitchYinCore(data, sampleRate, opts), detector: 'yin' };
}

export async function getSamplePitchHz(
  sampleId: SampleId,
  detector: Detector = 'yin',
  opts?: YinOptions,
): Promise<number | null> {
  return (await getSamplePitchHzDetailed(sampleId, detector, opts)).hz;
}

/**
 * 同 [`getSamplePitchHz`]，但额外告知**实际用了哪个检测器**。
 *
 * 面板要显示「AI 音高」，而 AI 弃权/失败时我们是拿 YIN 的值兜的 ——
 * 不带来源的返回值会让 UI 谎报。
 *
 * ══ 三种「AI 不给可信结果」要分开处理 ══
 *
 * | 情形 | 判据 | 处理 | 缓存？ |
 * |---|---|---|---|
 * | 硬失败 | 抛异常（权重没下下来 / 后端不可用 / 超时） | 退 YIN | **不缓存** —— 条件恢复后应当能重试 |
 * | 弃权 | 正常返回 `null`（没给任何音符） | 退 YIN | 缓存（对同一输入是确定性的，省掉每次重渲染的 4 秒） |
 * | 错八度 | 与 YIN 相差 > 1200 音分 | 退 YIN | 缓存（同上） |
 * | 正常 | 有值且与 YIN 不冲突 | 直接用 | 缓存 |
 *
 * 「弃权」这一档实测很常见：短切片（120~264ms）上 basic-pitch 经常一个音符都不给，
 * 而这些素材 YIN 是有值的。旧实现把 `null` 直接交给 UI → 显示「未检出音高」，
 * 而素材明明有音高 —— 换成 AI 反而更差，这显然不对。
 *
 * 「错八度」那档见 `PITCH_CROSSCHECK_REJECT_CENTS`：AI 在 2/35 个真素材上给出
 * 差一个八度的答案（`豆.mp3` 698.5Hz vs YIN 360Hz），而错八度会让自动修音
 * 把素材移调整整一个八度。YIN 在这里几乎不花时间（结果通常已在 store 里）。
 */
export async function getSamplePitchHzDetailed(
  sampleId: SampleId,
  detector: Detector = 'yin',
  opts?: YinOptions,
): Promise<PitchLookup> {
  const key = cacheKey(sampleId, detector, opts);

  // store 缓存（仅默认 YIN 参数）
  const useStoreCache = detector === 'yin' && (!opts || isDefaultYinOpts(opts));
  if (useStoreCache) {
    const sample = useStore.getState().project.samples.find((s) => s.id === sampleId);
    if (sample?.detectedPitchHz != null) {
      return { hz: sample.detectedPitchHz, detector: 'yin' };
    }
  }

  const hit = cache.get(key);
  if (hit) return hit;

  // 从缓存 buffer 拿 PCM
  const { getCachedBuffer } = await import('./sample-player');
  const buffer = getCachedBuffer(sampleId);
  if (!buffer) return { hz: null, detector };

  const ch0 = buffer.getChannelData(0);
  let hz: number | null;
  try {
    hz = await sendToWorker(ch0, buffer.sampleRate, detector, opts);
  } catch (err) {
    /*
      ══ AI 只是「更强的检测器」，不该是唯一路径 ══

      AI 会因为一串与素材无关的原因失败：模型权重没下下来、tfjs 后端在该浏览器
      不可用、推理超过预算……而这些情况下**素材本身是有 YIN 值的**（导入时
      `hajimi_detect_pitch` 已经算过并写进 store）。旧实现让异常直接冒到 UI，
      于是「AI 出问题」被显示成「未检出音高」。这里退回 YIN，让降级对用户不可见。
    */
    if (detector === 'ai') {
      console.warn('[pitch-async] AI 检测硬失败，回退 YIN', err);
      return getSamplePitchHzDetailed(sampleId, 'yin', opts);
    }
    /*
      ══ YIN 也不该因为「worker 整个没了」就跟着死 ══

      注意这里区分的两类失败**处置相反**：
        · 「这一条请求本身出错」（参数不对、超时）→ 照旧往上抛，别掩盖；
        · 「worker 起不来了」→ 走主线程 JS 应急退路（见 `yinOnMainThread`）。
      不区分的话，dev server 一退出，整个音高面板对**所有**素材都显示
      「未检出音高」—— 用户以为素材坏了，其实是几百米外的进程没了。
    */
    if (isWorkerUnavailable(err)) {
      return yinOnMainThread(ch0, buffer.sampleRate, opts, err.failure.reason);
    }
    throw err;
  }

  // AI 弃权 → 用 YIN 兜底（见上面表格）
  if (detector === 'ai' && hz == null) {
    const fallback = await getSamplePitchHzDetailed(sampleId, 'yin', opts);
    if (fallback.hz != null) {
      cache.set(key, fallback);
      return fallback;
    }
  }

  // AI 与 YIN 相差超过一个八度 → 采用 YIN（错八度会毁掉移调，见常量的注释）
  if (detector === 'ai' && hz != null) {
    const yin = await getSamplePitchHzDetailed(sampleId, 'yin', opts);
    if (shouldRejectAiPitch(hz, yin.hz)) {
      console.warn(
        `[pitch-async] AI 与 YIN 相差 ${Math.round(centsBetween(hz, yin.hz!))} 音分` +
          `（AI ${hz.toFixed(1)}Hz / YIN ${yin.hz!.toFixed(1)}Hz），超出八度闸门 → 采用 YIN`,
      );
      cache.set(key, yin);
      return yin;
    }
  }

  const out: PitchLookup = { hz, detector };
  cache.set(key, out);

  if (useStoreCache && hz != null) {
    useStore.getState().updateSample(sampleId, { detectedPitchHz: hz });
  }
  return out;
}

export function invalidatePitchCache(sampleId?: SampleId, opts?: YinOptions): void {
  if (sampleId === undefined) {
    cache.clear();
    return;
  }
  if (!opts) {
    for (const k of cache.keys()) {
      if (k === sampleId || k.startsWith(sampleId + '|') || k === `ai:${sampleId}`) {
        cache.delete(k);
      }
    }
    return;
  }
  // 清 YIN 指纹 + AI 缓存
  cache.delete(cacheKey(sampleId, 'yin', opts));
}
