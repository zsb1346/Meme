/**
 * hajimi-audio WASM 加载器 —— 在 Web Worker（解码）与后续 AudioWorklet（播放）
 * 中共享的 bare-wasm 胶水。无 wasm-bindgen：直接 WebAssembly.instantiate +
 * extern "C" 导出符号 + 线性内存视图。
 *
 * 与 Rust 侧（wasm/src/lib.rs）的 ABI 一一对应。
 */

export interface HajimiWasm {
  memory: WebAssembly.Memory;
  /** 分配 len 字节，返回线性内存偏移（ptr）。 */
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  /** 解码 ptr 处 len 字节；返回声道数（>0），<=0 失败。结果暂存于 wasm。 */
  decode(ptr: number, len: number): number;
  decodeChannels(): number;
  decodeFrames(): number;
  decodeSampleRate(): number;
  /** 第 c 声道 f32 首地址（长度 = decodeFrames()）。 */
  decodeChannelPtr(c: number): number;
  /** 在暂存解码结果上跑 YIN；返回 Hz，0 = 未检出。 */
  detectPitch(): number;
  /**
   * 在**任意**单声道 f32 缓冲上跑 YIN；返回 Hz，0 = 未检出。
   *
   * 与 `detectPitch` 是同一份 Rust 实现（`yin::detect_pitch_opts`），只是这个
   * 入口参数可调、且不依赖暂存解码结果 —— 音高面板要的就是这两个能力。
   *
   * 历史坑：面板曾自己维护一份 JS 版 YIN，两份各自演化，兜底只加在 Rust 侧，
   * 41 个真素材上 wasm 未检出 2/41、JS 版未检出 15/41。现在面板走这里，
   * JS 版只作 wasm 不可用时的应急退路，**不要再往 JS 版里补算法**。
   *
   * @param ptr    wasm 线性内存偏移（`alloc` 得到，已写入 f32 数据）
   * @param frames 样本数
   * @param threshold / minHz / maxHz：<=0 时用 Rust 默认值（0.12 / 65 / 1200）
   */
  yinF32(
    ptr: number,
    frames: number,
    sampleRate: number,
    threshold: number,
    minHz: number,
    maxHz: number,
  ): number;
  /**
   * 该 wasm 是否带 `hajimi_yin_f32` 导出。
   *
   * 为什么单独开一个能力查询、而不是让 `yinF32` 用返回值表达「我不支持」：
   * `0` 是 YIN 的合法「未检出」，用它兼表「没有这个函数」会让调用方
   * **把「素材无音高」误判成「wasm 太老」而去跑 JS 应急退路**，
   * 结果就是双实现对同一素材给出不同答案。
   */
  hasYinF32(): boolean;
  /** 释放暂存解码结果。 */
  decodeFree(): void;
  // ---- 播放 DSP：离线整段时间/音高变换（vocoder / PSOLA / SOLA）----
  /**
   * 变换 ptr 处 planar f32（ch 段 × frames）；返回输出帧数（<=0 失败）。
   * @param mode 0=声码器, 1=PSOLA, 2=SOLA/FL Stretch 风格, 3=PSOLA+谐波/噪声分离
   *             （3 只在 pitch < 0.89 时与 1 有区别，见 `psola::apply_planar_harmonic`）
   */
  txRun(ptr: number, frames: number, ch: number, pitch: number, time: number, mode: number, sampleRate: number): number;
  txChannels(): number;
  txFrames(): number;
  txChannelPtr(c: number): number;
  /**
   * 上一次 `txRun` 里被判为 voiced 的帧数
   * （只有 mode=1 / mode=3 会填，其余为 0）。
   *
   * 用来识别 PSOLA 的**静默空转**：非周期素材（短切片 / 带音效 / 噪声型）逐帧 YIN
   * 一帧都过不了阈值 → 整段走固定颗粒路径 → 那等于「按时间映射重采样」，**音高完全
   * 不移动**，但它照样返回合法音频、不抛异常。调用方的降级链是靠异常推进的，
   * 于是误判成功。实测真素材 41 个里 13 个命中。
   *
   * 现在由 `transform.ts::isPsolaSilentNoop` 消费（配合 [`txMarks`]，marks===0
   * 才是精确判据）并主动抛 `PsolaSilentNoopError`，降级链因此能推进到 SOLA。
   * 真素材上的验收见 `scripts/_probe-degradation-chain.mjs`。
   */
  txVoicedFrames(): number;
  /** 上一次 mode=1 渲染得到的 pitch mark 数（`-1` = 该 wasm 未导出此计数）。 */
  txMarks(): number;
  txFree(): void;
  // ---- 离线自动修音：QPitch 控制环 + 变 ratio PSOLA（全曲预渲染）----
  /** 修音 ptr 处 planar f32（ch 段 × frames）；返回输出帧数（<=0 失败）。时长 1:1。 */
  atRun(
    ptr: number,
    frames: number,
    ch: number,
    sampleRate: number,
    targetMidi: number,
    scaleMask: number,
    retuneMs: number,
    transitionMs: number,
    toleranceCents: number,
    amount: number,
    refHz: number,
  ): number;
  atChannels(): number;
  atFrames(): number;
  atChannelPtr(c: number): number;
  atFree(): void;
}

export interface WasmDecoded {
  channels: Float32Array[];
  sampleRate: number;
  /** 基频 Hz；0 = 未检出。 */
  pitchHz: number;
}

/** wasm 静态资源路径（public/ 根，静态托管与 worker fetch 均可解析）。 */
export const HAJIMI_WASM_URL = '/hajimi_audio.wasm';

let promise: Promise<HajimiWasm> | null = null;

/** 加载并实例化 wasm（进程内单例；worker 与主线程各自持有一份实例）。 */
export function loadHajimiWasm(url: string = HAJIMI_WASM_URL): Promise<HajimiWasm> {
  if (!promise) promise = instantiate(url);
  return promise;
}

async function instantiate(url: string): Promise<HajimiWasm> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`hajimi wasm fetch failed: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as Record<string, unknown>;
  const memory = ex.memory as WebAssembly.Memory;
  const fn = (name: string) => ex[name] as (...args: number[]) => number;
  return {
    memory,
    alloc: (len) => fn('hajimi_alloc')(len) >>> 0,
    dealloc: (ptr, len) => {
      fn('hajimi_dealloc')(ptr, len);
    },
    decode: (ptr, len) => fn('hajimi_decode')(ptr, len) | 0,
    decodeChannels: () => fn('hajimi_decode_channels')() | 0,
    decodeFrames: () => fn('hajimi_decode_frames')() | 0,
    decodeSampleRate: () => fn('hajimi_decode_sample_rate')() | 0,
    decodeChannelPtr: (c) => fn('hajimi_decode_channel_ptr')(c) >>> 0,
    detectPitch: () => (ex.hajimi_detect_pitch as () => number)(),
    yinF32: (ptr, frames, sampleRate, threshold, minHz, maxHz) => {
      const f = ex.hajimi_yin_f32 as
        | ((
            a: number,
            b: number,
            c: number,
            d: number,
            e: number,
            g: number,
          ) => number)
        | undefined;
      // 老产物没这个导出 → 返回 0；调用方先用 hasYinF32() 判断，不会把它当结果。
      if (typeof f !== 'function') return 0;
      return f(ptr, frames, sampleRate, threshold, minHz, maxHz) || 0;
    },
    hasYinF32: () => typeof ex.hajimi_yin_f32 === 'function',
    decodeFree: () => {
      fn('hajimi_decode_free')();
    },
    txRun: (ptr, frames, ch, pitch, time, mode, sampleRate) =>
      (ex.hajimi_tx_run as (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number)(
        ptr,
        frames,
        ch,
        pitch,
        time,
        mode,
        sampleRate,
      ) | 0,
    txChannels: () => fn('hajimi_tx_channels')() | 0,
    txFrames: () => fn('hajimi_tx_frames')() | 0,
    txChannelPtr: (c) => fn('hajimi_tx_channel_ptr')(c) >>> 0,
    txVoicedFrames: () => {
      const f = fn('hajimi_tx_voiced_frames');
      return typeof f === 'function' ? f() | 0 : -1;
    },
    txMarks: () => {
      const f = fn('hajimi_tx_marks');
      return typeof f === 'function' ? f() | 0 : -1;
    },
    txFree: () => {
      fn('hajimi_tx_free')();
    },
    atRun: (
      ptr,
      frames,
      ch,
      sampleRate,
      targetMidi,
      scaleMask,
      retuneMs,
      transitionMs,
      toleranceCents,
      amount,
      refHz,
    ) =>
      (
        ex.hajimi_at_run as (
          a: number,
          b: number,
          c: number,
          d: number,
          e: number,
          f: number,
          g: number,
          h: number,
          i: number,
          j: number,
          k: number,
        ) => number
      )(
        ptr,
        frames,
        ch,
        sampleRate,
        targetMidi,
        scaleMask,
        retuneMs,
        transitionMs,
        toleranceCents,
        amount,
        refHz,
      ) | 0,
    atChannels: () => fn('hajimi_at_channels')() | 0,
    atFrames: () => fn('hajimi_at_frames')() | 0,
    atChannelPtr: (c) => fn('hajimi_at_channel_ptr')(c) >>> 0,
    atFree: () => {
      fn('hajimi_at_free')();
    },
  };
}

/**
 * 解码一段字节为 planar f32 + 原生采样率 + 基频。
 * 返回的 Float32Array 各自持有独立 ArrayBuffer（已从 wasm 内存拷出），
 * 可直接 transfer 回主线程。
 */
export async function wasmDecode(w: HajimiWasm, bytes: Uint8Array): Promise<WasmDecoded> {
  const ptr = w.alloc(bytes.length);
  // 写入输入字节（memory.buffer 在 alloc 后可能已增长，此处重新取视图）
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  const nch = w.decode(ptr, bytes.length);
  w.dealloc(ptr, bytes.length);
  if (nch <= 0) throw new Error('hajimi wasm decode failed (unsupported or corrupt audio)');

  const frames = w.decodeFrames();
  const sampleRate = w.decodeSampleRate();
  const pitchHz = w.detectPitch();
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c++) {
    const cp = w.decodeChannelPtr(c);
    // 从 wasm 内存拷出独立缓冲（随后 decodeFree 会释放 wasm 侧存储）
    channels.push(new Float32Array(new Float32Array(w.memory.buffer, cp, frames)));
  }
  w.decodeFree();
  return { channels, sampleRate, pitchHz };
}
