/// <reference lib="webworker" />

/**
 * @spotify/basic-pitch (tfjs) 假设自己在主线程：
 * 内部用 `window.setTimeout` / `window.fetch` 等浏览器 API，
 * worker 里没有 `window`，一加载就 `ReferenceError: window is not defined`。
 *
 * worker 的 `self` 提供所有同名 API（setTimeout / fetch / performance…），
 * 所以把 self 挂成 window 就能兼容 —— 这是把「浏览器专用库跑在 worker」
 * 的最小代价（替代方案：改库，或放弃 worker）。
 */
(self as unknown as { window: typeof self }).window = self;

/**
 * 音高检测 Web Worker —— YIN 与 AI 两路统一入口。
 *
 * 职责：
 *  - yin：优先调 wasm `hajimi_yin_f32`（与导入时的 `hajimi_detect_pitch` 同一份
 *    实现）；wasm 不可用才退回 JS `detectPitchYinCore`（应急退路，不再补算法）
 *  - ai：懒加载 @spotify/basic-pitch 模型；重采样到 22050；推理
 *  - 模型只在第一次 ai 请求时加载，之后常驻复用；yin 请求永不触发模型加载
 *
 * 为什么要合并成一个 worker：
 *  - 主线程不再跑任何检测（AI 之前在主线程，几百 ms 阻塞）
 *  - 一份 worker 管理代码，不用维护两套消息协议
 *  - 模型懒加载：不用 AI 的用户零成本
 *
 * ══ 为什么 YIN 要改用 wasm 版（曾经的 13/41 面板漏检） ══
 * 面板此前走 JS `detectPitchYinCore`，与导入时的 wasm YIN 是**两份各自演化的
 * 实现**，而「自相关兜底 + 帧间一致性闸门」只加在了 Rust 侧。真素材 41 个上：
 * wasm 未检出 2/41、JS 未检出 15/41，且 JS 的可用结果全被 wasm 覆盖
 * （`scripts/probe-ai/probe-yin-parity.html`）。同一个素材「导入时有根音、
 * 面板里没有」就是这么来的。现在面板走 `hajimi_yin_f32`，两份合一。
 *
 * 协议：
 *   → { id, detector: 'yin', data: ArrayBuffer, sampleRate, opts? }
 *   → { id, detector: 'ai',  data: ArrayBuffer, sampleRate }
 *   ← { type: 'status', status: 'loading_model' | 'ready', backend? }  （仅 AI）
 *   ← { type: 'ack', id }       收到即回，主线程据此起算超时
 *   ← { id, hz: number | null }
 *   ← { id, error: string }
 *
 * 本文件由 tsconfig.worker.json 独立类型检查（WebWorker lib）。
 */
import { detectPitchYinCore, type YinOptions } from './pitch';
import {
  AI_NOTES_RELAXED,
  AI_NOTES_STRICT,
  AI_SECONDS,
  AI_TARGET_SR,
  AI_WINDOW_TRIES,
  type NoteExtraction,
} from './pitch-ai-budget';
import { candidateWindows } from './pitch-window';
import { loadHajimiWasm, type HajimiWasm } from './rush/loader';

// ---- 消息类型 ----

interface YinRequest {
  id: number;
  detector: 'yin';
  data: ArrayBuffer;
  sampleRate: number;
  opts?: YinOptions;
}

interface AiRequest {
  id: number;
  detector: 'ai';
  data: ArrayBuffer;
  sampleRate: number;
}

type PitchRequest = YinRequest | AiRequest;

interface SuccessResponse {
  id: number;
  hz: number | null;
}

interface ErrorResponse {
  id: number;
  error: string;
}

interface StatusMessage {
  type: 'status';
  status: 'loading_model' | 'ready';
  /** 仅 status='ready' 时给出，供诊断（模型跑在哪个 tfjs 后端上）。 */
  backend?: string;
}

/**
 * 「我已经开始处理这条请求了」。
 *
 * 为什么需要它：AI 一次推理要好几秒，而模型加载可能更久。主线程若从
 * `postMessage` 那一刻起就算超时，**排队等待的时间会被算进推理预算** ——
 * 用户连点两个素材，第二条可能在还没轮到执行时就先超时了。
 * 有了 ack，超时从「真正开始跑」那一刻才起算。
 */
interface AckMessage {
  type: 'ack';
  id: number;
}

// ---- AI 模型懒加载 ----

/**
 * AI 模型（tfjs）路径，同样只放 `public/` 下、只能走 BASE_URL。
 *
 * 写死 `/model.json` 时，站点部署到子目录会 404 → AI 音高一路直接失效
 * （UI 上表现为一直停在「首次加载 AI 模型…」）。权重清单里那个
 * `group1-shard1of1.bin` 是**相对 model.json** 解析的，所以只要这里对了，
 * shard 会自动跟上，不需要单独配。
 */
const MODEL_URL = `${import.meta.env.BASE_URL}model.json`;

// 动态 import 的类型，避免顶层静态引入拉进 bundle
type BasicPitchModule = typeof import('@spotify/basic-pitch');
type BasicPitchInstance = InstanceType<BasicPitchModule['BasicPitch']>;

let aiModule: BasicPitchModule | null = null;
let aiModel: BasicPitchInstance | null = null;
let aiLoading: Promise<BasicPitchInstance> | null = null;

function postStatus(status: StatusMessage['status'], backend?: string): void {
  (self as unknown as Worker).postMessage({
    type: 'status',
    status,
    backend,
  } satisfies StatusMessage);
}

/**
 * 当前 tfjs 后端名（仅用于诊断）。
 *
 * 为什么不主动 `setBackend`：实测浏览器 worker 里默认后端就能跑（模型能加载、
 * 220Hz 正弦测得出 220.0Hz），强行指定只会把「某些机器上 webgl 上下文创建失败」
 * 这类新问题引进来。所以这里只**读**不写 —— 出问题时日志里有据可查。
 */
async function currentBackend(): Promise<string | undefined> {
  try {
    const mod = await import('@tensorflow/tfjs');
    const tf = (mod as unknown as { default?: typeof mod }).default ?? mod;
    return (tf as unknown as { getBackend: () => string }).getBackend();
  } catch {
    return undefined;
  }
}

/**
 * 取（并按需加载）AI 模型。
 *
 * ══ 两条曾经让 AI 检测「永久失效」的路径，都在这里堵掉 ══
 *
 * ① **不等权重加载完就缓存实例**。`new BasicPitch(url)` 只是把
 *    `tf.loadGraphModel(url)` 的 promise 存进实例字段，构造本身不会失败；
 *    真正的失败（网络抖动、权重 404、后端不支持）发生在 `model.model` 被 await 时。
 *    若照旧把实例缓存下来，那个坏实例会被复用到 worker 生命周期结束 ——
 *    **一次网络抖动 = AI 检测再也回不来**。所以这里先 `await model.model`
 *    确认权重真的就绪，再写 `aiModel`。
 *
 * ② **失败的 promise 被缓存**。`aiLoading` 若留存一个已 reject 的 promise，
 *    后续每次调用都会立刻拿到同一个错误，同样永不恢复。catch 里把它清空，
 *    下一次请求就是一次干净的重试。
 */
async function getAiModel(): Promise<BasicPitchInstance> {
  if (aiModel) return aiModel;
  if (aiLoading) return aiLoading;

  aiLoading = (async () => {
    postStatus('loading_model');
    // 动态 import：YIN-only 用户不下载模型代码
    if (!aiModule) aiModule = await import('@spotify/basic-pitch');
    const model = new aiModule.BasicPitch(MODEL_URL);
    await model.model; // 权重真正就绪，失败在这里抛出（可重试）
    aiModel = model;
    postStatus('ready', await currentBackend());
    return model;
  })().catch((err: unknown) => {
    aiModel = null;
    aiLoading = null;
    throw err;
  });

  return aiLoading;
}

// ---- 重采样（线性插值，AI 对精度不敏感） ----

/**
 * 各档预算常量集中在 `pitch-ai-budget.ts`（worker 与主线程的唯一事实来源）。
 *
 * `AI_SECONDS` 决定跑几批模型、`AI_WINDOW_TRIES` 决定弃权后最多跑几次、
 * `PITCH_TIMEOUT_MS.ai` 决定主线程给多久 —— 这三者曾经不一致
 * （4 秒输入 = 3 批 ≈ 15s > 15000ms 预算），结果就是 AI 检测
 * **永远显示「未检出音高」**。要改输入长度或重试次数，先去
 * `pitch-ai-budget.test.ts` 看那条「最坏耗时 ≤ 预算」的算术。
 */

function resampleToAi(input: Float32Array, fromSr: number): Float32Array {
  if (fromSr === AI_TARGET_SR) return input;
  const ratio = fromSr / AI_TARGET_SR;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

// ---- AI 检测 ----

/** 在一个窗口上跑一次模型，返回音高 Hz；给不出任何音符返回 null（= 弃权）。 */
async function inferWindow(
  model: BasicPitchInstance,
  mod: BasicPitchModule,
  window: Float32Array,
  sampleRate: number,
): Promise<number | null> {
  const resampled = resampleToAi(window, sampleRate);

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await model.evaluateModel(
    resampled,
    (f: number[][], o: number[][], c: number[][]) => {
      // 逐个 push：单批数据可能很大，展开运算符会 RangeError
      for (const x of f) frames.push(x);
      for (const x of o) onsets.push(x);
      for (const x of c) contours.push(x);
    },
    () => {},
  );

  if (frames.length === 0) return null;

  /*
    ══ 先把音符「切」出来，切不出来再放宽门 ══

    模型只吐概率图，音符是 `outputToNotesPoly` 按阈值切出来的。实测 41 个真素材：
    **frames 从不为空**，而严格档下一个音符都切不出来的有 6 个 —— 即弃权全是
    「门太窄」，不是「模型不知道」（`probe-ai-threshold.html`）。

    放宽档只重跑这段纯 JS 后处理（微秒级），**模型不重跑** —— 所以这个兜底
    几乎不花钱，却能救回 6 个里的 5 个（见 `AI_NOTES_RELAXED` 的实测表）。
  */
  const pick = (rules: NoteExtraction) => {
    const notes = mod.noteFramesToTime(
      mod.addPitchBendsToNoteEvents(
        contours,
        mod.outputToNotesPoly(
          frames,
          onsets,
          rules.onsetThreshold,
          rules.frameThreshold,
          rules.minNoteFrames,
        ),
      ),
    );
    if (notes.length === 0) return null;
    let best = notes[0];
    for (const n of notes) {
      if ((n.amplitude ?? 0) > (best.amplitude ?? 0)) best = n;
    }
    return 440 * Math.pow(2, (best.pitchMidi - 69) / 12);
  };

  return pick(AI_NOTES_STRICT) ?? pick(AI_NOTES_RELAXED);
}

/**
 * AI 音高检测：**先换「门」再换「窗口」**。
 *
 * 两层兜底的顺序是有实测依据的：
 *
 *  1. `inferWindow` 内部先严格档、切不出音符再用放宽档 —— 这是主力。
 *     41 个真素材里 6 个的弃权全靠它救回（且只重跑纯 JS 后处理，模型不重跑）。
 *  2. 整个窗口都弃权，才换下一个候选窗口重跑模型。这一层对**短切片**不生效：
 *     实测 41 个真素材**全部只有 1 个候选窗口**（这批切片最长 1442ms、中位数
 *     约 260ms，比 1 秒窗口短的一大把）。它的价值在导入的长音频
 *     （最响的一秒可能落在鼓点/静音上，那才有「换一段」的余地）。
 *
 * 层级是「门 → 窗口 → 退 YIN」，**不是**「一次弃权就退 YIN」：只有当
 * `AI_WINDOW_TRIES` 个候选全部弃权时才返回 null，由 `pitch-async.ts` 接过 YIN。
 */
async function detectAi(
  pcm: Float32Array,
  sampleRate: number,
): Promise<number | null> {
  const model = await getAiModel();
  const mod = aiModule;
  if (!mod) throw new Error('basic-pitch 模块未加载');

  const windows = candidateWindows(pcm, sampleRate, AI_SECONDS, AI_WINDOW_TRIES);
  for (const w of windows) {
    const hz = await inferWindow(model, mod, w, sampleRate);
    if (hz != null) return hz;
  }
  return null;
}

// ---- YIN（wasm 优先，JS 应急退路） ----

/**
 * wasm 单例。加载失败时**清空 promise**，下一次请求是干净的重试 ——
 * 与 `getAiModel` 同一个道理：缓存一个已 reject 的 promise 会让
 * 「一次网络抖动」变成「YIN 永久失效」。
 */
let wasmPromise: Promise<HajimiWasm> | null = null;

function getWasm(): Promise<HajimiWasm> {
  if (!wasmPromise) {
    wasmPromise = loadHajimiWasm().catch((err: unknown) => {
      wasmPromise = null;
      throw err;
    });
  }
  return wasmPromise;
}

/**
 * 把单声道 f32 拷进 wasm 线性内存并跑 `hajimi_yin_f32`。
 *
 * 关于那 4 个字节的余量：`hajimi_alloc` 背后是 `Vec<u8>`（对齐 1），
 * 拿到的指针**不保证 4 字节对齐**，而 Rust 侧 `slice::from_raw_parts::<f32>`
 * 要求指针对齐。所以多申请 4 字节，把指针对齐到 4 的下取整再用 ——
 * 对齐后 + frames*4 一定仍在本次分配范围内（<= raw + 3 + frames*4）。
 * dealloc 用的还是 `alloc` 原样返回的指针，配对不破。
 */
function detectYinWasm(
  w: HajimiWasm,
  data: Float32Array,
  sampleRate: number,
  opts?: YinOptions,
): number | null {
  const bytes = data.length * 4;
  const raw = w.alloc(bytes + 4);
  if (raw === 0) return null;
  try {
    const ptr = (raw + 3) & ~3;
    new Float32Array(w.memory.buffer, ptr, data.length).set(data);
    // 传 0 = 让 Rust 侧用默认值（threshold 0.12 / 65Hz / 1200Hz）
    const hz = w.yinF32(
      ptr,
      data.length,
      sampleRate,
      opts?.threshold ?? 0,
      opts?.minHz ?? 0,
      opts?.maxHz ?? 0,
    );
    return hz > 0 && Number.isFinite(hz) ? hz : null;
  } finally {
    w.dealloc(raw, bytes + 4);
  }
}

/**
 * YIN 入口。
 *
 * wasm 只在「加载失败 / 老产物缺 `hajimi_yin_f32` 导出」时才让位给 JS 版 ——
 * wasm 返回 0（未检出）是**结论**，不是故障，绝不能因为「wasm 说没有音高」
 * 就去问 JS 版（那正是两份实现分歧的来源）。
 */
async function detectYin(
  data: Float32Array,
  sampleRate: number,
  opts?: YinOptions,
): Promise<number | null> {
  try {
    const w = await getWasm();
    if (w.hasYinF32()) return detectYinWasm(w, data, sampleRate, opts);
    console.warn('[pitch-worker] wasm 缺少 hajimi_yin_f32 导出，YIN 走 JS 应急退路');
  } catch (err) {
    console.warn('[pitch-worker] wasm 加载失败，YIN 走 JS 应急退路', err);
  }
  return detectPitchYinCore(data, sampleRate, opts);
}

// ---- 消息入口 ----

self.onmessage = async (e: MessageEvent<PitchRequest>) => {
  const req = e.data;
  // 第一件事就是回 ack，让主线程从此刻开始计时（见 AckMessage 的说明）。
  (self as unknown as Worker).postMessage({ type: 'ack', id: req.id } satisfies AckMessage);
  try {
    let hz: number | null;
    if (req.detector === 'yin') {
      hz = await detectYin(new Float32Array(req.data), req.sampleRate, req.opts);
    } else {
      hz = await detectAi(new Float32Array(req.data), req.sampleRate);
    }
    (self as unknown as Worker).postMessage({ id: req.id, hz } satisfies SuccessResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ErrorResponse);
  }
};
