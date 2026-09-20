/**
 * rush/autotune —— 主线程「离线自动修音」（调 hajimi-audio WASM hajimi_at_run）。
 *
 * 与 rush/transform 同一架构约定（静态参数 + 离线预渲染）：
 *  - 播放前把源 AudioBuffer 整段跑一遍 QPitch 控制环 + 变 ratio PSOLA，
 *    渲染出修好音的新 AudioBuffer，之后照常以 rate=1 精确调度播放；
 *  - 结果按 (源 buffer, 参数组) 用 WeakMap+Map LRU 缓存：同一素材反复改参
 *    来回切不重算，源 buffer 回收时缓存自动失效；
 *  - WASM 实例走 loader 的进程内单例（与 transform 共享同一份，无重复加载）。
 *
 * 修音语义（详见 wasm/src/autotune.rs 头注释）：
 *  - targetMidi > 0 → ABSOLUTE 模式：全曲锁到该 MIDI 音（哈吉米用法）；
 *  - targetMidi <= 0 → SCALE 模式：逐帧吸附 scaleMask 音阶内最近音；
 *  - amount <= 0 → 直通返回源（不拷贝）。
 */
import { loadHajimiWasm, type HajimiWasm } from './loader';

let wasm: HajimiWasm | null = null;
let loading: Promise<HajimiWasm> | null = null;

/** 预加载 WASM（与 rush/transform 共享单例；App 启动时 await 一次；幂等）。 */
export async function ensureAutotuneLoaded(): Promise<void> {
  if (wasm) return;
  if (!loading) loading = loadHajimiWasm();
  wasm = await loading;
}

/** WASM 是否已就绪（调用方据此决定修音还是原样播放）。 */
export function isAutotuneReady(): boolean {
  return wasm !== null;
}

export interface AutotuneParams {
  /** >0：ABSOLUTE 锁音（MIDI 音号，如 69=A4）；<=0：SCALE 模式。 */
  targetMidi: number;
  /** 12-bit 音级掩码（bit0=C … bit11=B），SCALE 模式用；ABSOLUTE 模式忽略。 */
  scaleMask: number;
  /** retune speed（ms）：修正量平滑速度，越小越机器人（≤10ms 瞬切）。 */
  retuneMs: number;
  /** 目标音符过渡（ms）：换目标音的滑移时长（≤20ms 硬切）。 */
  transitionMs: number;
  /** 容差死区（音分）：范围内不修，保留原唱细节。 */
  toleranceCents: number;
  /** 修音强度 0..1；<=0 直通。 */
  amount: number;
  /** A4 参考频率（Hz）；<=0 → 440。 */
  refHz: number;
}

// 源 buffer → (参数 key → 修音后 buffer)。WeakMap 让源 buffer 卸载后缓存自动回收。
const cache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();
/**
 * 意图：每个源 buffer 最多缓存 8 条修音结果（与 transform.ts 同额度）。
 * 修音结果同样是全长音频，参数滑杆连拖会瞬间堆出几十条，必须限流。
 * Map 插入序即时间序，超出时删最早的条目；命中后移到末尾（LRU）。
 */
const MAX_CACHE_PER_BUFFER = 8;

function keyOf(p: AutotuneParams): string {
  return [
    'at',
    p.targetMidi.toFixed(2),
    p.scaleMask >>> 0,
    p.retuneMs.toFixed(1),
    p.transitionMs.toFixed(1),
    p.toleranceCents.toFixed(1),
    p.amount.toFixed(3),
    p.refHz.toFixed(2),
  ].join('|');
}

/**
 * 同步整段修音。要求 ensureAutotuneLoaded() 已完成，否则抛错。
 * 返回新 AudioBuffer（采样率/时长同源）；amount<=0 直接返回源（不拷贝）。
 */
export function autotuneBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  params: AutotuneParams,
): AudioBuffer {
  if (!(params.amount > 0)) return buffer;
  const w = wasm;
  if (!w) throw new Error('[rush] WASM 未加载即调用 autotuneBuffer');

  let m = cache.get(buffer);
  if (!m) {
    m = new Map();
    cache.set(buffer, m);
  }
  const key = keyOf(params);
  const hit = m.get(key);
  if (hit) {
    // Map 同时作为 LRU 队列：命中后移到末尾，避免常用结果被误淘汰。
    m.delete(key);
    m.set(key, hit);
    return hit;
  }

  const ch = buffer.numberOfChannels;
  const frames = buffer.length;
  const sr = buffer.sampleRate;
  const bytes = ch * frames * 4;
  const ptr = w.alloc(bytes);
  let out: AudioBuffer;
  let hasAtOutput = false;
  try {
    const view = new Float32Array(w.memory.buffer, ptr, ch * frames);
    for (let c = 0; c < ch; c++) view.set(buffer.getChannelData(c), c * frames);

    const outF = w.atRun(
      ptr,
      frames,
      ch,
      sr,
      params.targetMidi,
      params.scaleMask >>> 0,
      params.retuneMs,
      params.transitionMs,
      params.toleranceCents,
      params.amount,
      params.refHz,
    );
    if (outF <= 0) throw new Error(`[rush] 修音失败 code=${outF}`);
    hasAtOutput = true;

    const outCh = w.atChannels();
    out = ctx.createBuffer(outCh, outF, sr);
    for (let c = 0; c < outCh; c++) {
      const cp = w.atChannelPtr(c);
      out.copyToChannel(new Float32Array(w.memory.buffer, cp, outF), c);
    }
  } finally {
    w.dealloc(ptr, bytes);
    if (hasAtOutput) w.atFree();
  }

  m.set(key, out);
  // 缓存上限：超出时删最早的条目（Map 插入序即时间序）
  if (m.size > MAX_CACHE_PER_BUFFER) {
    const firstKey = m.keys().next().value;
    if (firstKey !== undefined) m.delete(firstKey);
  }
  return out;
}
