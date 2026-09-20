/**
 * rush/transform —— 主线程「时间/音高」离线变换（调 hajimi-audio WASM）。
 *
 * 架构（用户定稿：静态参数 + 离线预渲染）：
 *  - 播放前把源 AudioBuffer 按 (pitchFactor π, timeFactor τ) 整段渲染成新的
 *    AudioBuffer，之后用原生 AudioBufferSourceNode 以 rate=1 精确调度播放。
 *  - 变换结果按 (源 buffer, π, τ) 用 WeakMap 缓存：同一素材反复触发零重算，
 *    源 buffer 被回收时缓存自动失效。
 *  - WASM 实例在主线程单独持有一份（与 worker 的解码实例互不干扰），启动时
 *    ensureRushLoaded() 预加载，之后 transformBuffer 为同步调用。
 */
import { loadHajimiWasm, type HajimiWasm } from './loader';

let wasm: HajimiWasm | null = null;
let loading: Promise<HajimiWasm> | null = null;

/** 预加载主线程 WASM 实例（App 启动时 await 一次；幂等）。 */
export async function ensureRushLoaded(): Promise<void> {
  if (wasm) return;
  if (!loading) loading = loadHajimiWasm();
  wasm = await loading;
}

/** WASM 是否已就绪（playSample 据此决定走变换还是原样播放）。 */
export function isRushReady(): boolean {
  return wasm !== null;
}

// 源 buffer → (key → 变换后 buffer)。WeakMap 让源 buffer 卸载后缓存自动回收。
const cache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();
/**
 * 意图：每个源 buffer 最多缓存 8 条变换结果。
 * 旧版无上限 —— 拖 pitch/tau 旋钮每动一下就存一条全长音频，
 * 3 分钟素材一条 66MB，几下就爆内存。
 * Map 插入序即时间序，超出时删最早的条目。
 */
const MAX_CACHE_PER_BUFFER = 8;

/**
 * 「这段源素材上 PSOLA 等于没做事」——记下来就不必每次重算再失败。
 *
 * 判定依据是**源素材自身**有没有周期性结构（通道 0 的清浊判决），与 pitch/tau 无关，
 * 所以一个 WeakSet 就够了；源 buffer 被回收时条目自动消失。
 */
const psolaNoopBuffers = new WeakSet<AudioBuffer>();

/**
 * PSOLA 的**静默空转** —— 返回了合法音频，但音高一动没动。
 *
 * ══ 为什么需要显式判定 ══
 *
 * PSOLA 只对**周期性**内容做「颗粒重排」；没有周期可同步时每颗颗粒都落到固定颗粒
 * 路径，而固定颗粒的推进量是常量（不随 ratio 变）→ 输出就是「按时间映射重采样原声」，
 * **音高完全不移动**。而它照样返回一段合法音频、**不抛异常**。
 *
 * `playSample` 的降级链（PSOLA → SOLA → 原声）是靠 catch 推进的，于是永远认为
 * mode=1 成功了 —— 用户看到的就是「装配面板 Shift+↑ 在部分素材上毫无反应」。
 * 实测真素材：**13/41 静默不变调**（输出与源逐样本相同，频谱质心比恰好 1.000）。
 *
 * ══ 判据为什么是 mark 数 ══
 *
 * 渲染时每颗颗粒要判 voiced，条件是「该处 voiced **且** marks 非空」——marks 空则
 * 整段都走固定颗粒路径。所以 `marks === 0` 就是「本次渲染没有一处真正做过颗粒重排」，
 * 与 voiced 帧数是否为 0 等价（voiced 全 0 ⇒ 必然没有 mark）。两个都看，是为了在
 * 只导出其中一个计数时仍能判定。
 *
 * ══ 为什么排除 pitch≈1 ══
 *
 * 纯拉伸（pitch=1）时固定颗粒路径**就是**预期行为：它按时间映射重采样，音高移动
 * 对纯噪声内容没有意义。那里不是 bug，不该触发降级。
 */
export function isPsolaSilentNoop(
  mode: number,
  pitch: number,
  marks: number,
  voicedFrames: number,
): boolean {
  // mode 3 是「PSOLA + 谐波/噪声分离」，颗粒编排与 mode 1 完全相同
  // （只在**降调**时多一道拆分），所以静默空转的判定对它一样成立。
  if (mode !== 1 && mode !== 3) return false;
  if (Math.abs(pitch - 1) < 1e-4) return false;
  if (marks < 0) return false; // 旧 wasm 未导出可观测点 → 不妄断，照旧走成功路径
  return marks === 0 || voicedFrames === 0;
}

/** PSOLA 静默空转时抛出的错误 —— 调用方降级链据此推进到 SOLA。 */
export class PsolaSilentNoopError extends Error {
  constructor(pitch: number) {
    super(
      `[rush] PSOLA 静默空转：该素材没有可同步的周期，变调比 ${pitch.toFixed(4)} 下音高不会移动 —— 降级到 SOLA`,
    );
    this.name = 'PsolaSilentNoopError';
  }
}

function keyOf(pitch: number, time: number, mode: number): string {
  return `${pitch.toFixed(4)}|${time.toFixed(4)}|${mode}`;
}

/**
 * 同步整段变换。要求 ensureRushLoaded() 已完成，否则抛错。
 * 返回新 AudioBuffer（采样率同源），π=τ=1 时直接返回源（不拷贝）。
 *
 * @param mode 0=声码器, 1=PSOLA, 2=SOLA/FL Stretch 风格, 3=PSOLA+谐波/噪声分离
 *
 * mode 3 与 mode 1 共用同一套颗粒编排，只在**明确降调**（pitch < 0.89，约 -2 半音）
 * 时多一道「谐波/噪声分离」：颗粒重叠区里非周期成分会被 Σw 除法放大成沙沙，
 * 拆分后那部分不走颗粒重排、按 β 保留回加。启用线以上的行为与 mode 1 **逐样本相同**
 * （所以升调侧不受影响），升降调都由内核自己判断，前端不需要分支。
 *
 * ⚠ mode 3 **已被实听否决、不在默认链路里**（2026-09-19）。它把 HNR 与 HF 分档都做
 * "干净"了，但听感更差 —— 用户原话「噪音变成另一种形式了」。原因是把源里的非周期
 * 成分抽掉后，剩下的严格周期谐波在颗粒重排下变成机械的嗡嗡/金属声（TD-PSOLA 固有的
 * buzzyness），而被抽掉的那部分恰恰是让声音像人声的气声与微抖动；残余又只加回一半、
 * 且加在**原位频谱**上，与已下移的谐波不再属于同一个声音。
 * 保留 mode 3 只为继续做实验（`scripts/_probe-hnsep.mjs`），**不要接回默认**。
 */
export function transformBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  pitch: number,
  time: number,
  mode: number = 2,
): AudioBuffer {
  if (Math.abs(pitch - 1) < 1e-4 && Math.abs(time - 1) < 1e-4) return buffer;
  const w = wasm;
  if (!w) throw new Error('[rush] WASM 未加载即调用 transformBuffer');

  let m = cache.get(buffer);
  if (!m) {
    m = new Map();
    cache.set(buffer, m);
  }
  const key = keyOf(pitch, time, mode);
  const hit = m.get(key);
  if (hit) {
    // Map 同时作为 LRU 队列：命中后移到末尾，避免常用装配结果被误淘汰。
    m.delete(key);
    m.set(key, hit);
    return hit;
  }

  // 已知这段素材在 PSOLA 下等于没做事：直接失败，省掉每次重放的一整轮无效重算。
  if ((mode === 1 || mode === 3) && Math.abs(pitch - 1) >= 1e-4 && psolaNoopBuffers.has(buffer)) {
    throw new PsolaSilentNoopError(pitch);
  }

  const ch = buffer.numberOfChannels;
  const frames = buffer.length;
  const sr = buffer.sampleRate;
  const bytes = ch * frames * 4;
  const ptr = w.alloc(bytes);
  let out: AudioBuffer;
  let hasTxOutput = false;
  try {
    const view = new Float32Array(w.memory.buffer, ptr, ch * frames);
    for (let c = 0; c < ch; c++) view.set(buffer.getChannelData(c), c * frames);

    const outF = w.txRun(ptr, frames, ch, pitch, time, mode, sr);
    if (outF <= 0) throw new Error(`[rush] 变换失败 code=${outF}`);
    hasTxOutput = true;

    // 静默空转必须显式转成异常 —— 见 isPsolaSilentNoop 的注释。
    if (isPsolaSilentNoop(mode, pitch, w.txMarks(), w.txVoicedFrames())) {
      psolaNoopBuffers.add(buffer);
      throw new PsolaSilentNoopError(pitch);
    }

    const outCh = w.txChannels();
    out = ctx.createBuffer(outCh, outF, sr);
    for (let c = 0; c < outCh; c++) {
      const cp = w.txChannelPtr(c);
      out.copyToChannel(new Float32Array(w.memory.buffer, cp, outF), c);
    }
  } finally {
    w.dealloc(ptr, bytes);
    if (hasTxOutput) w.txFree();
  }

  m.set(key, out);
  // 缓存上限：超出时删最早的条目（Map 插入序即时间序）
  if (m.size > MAX_CACHE_PER_BUFFER) {
    const firstKey = m.keys().next().value;
    if (firstKey !== undefined) m.delete(firstKey);
  }
  return out;
}
