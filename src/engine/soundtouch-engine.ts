/**
 * SoundTouchJS 引擎 —— 把流式的 SoundTouch 泵成「整段进、整段出」的函数。
 *
 * 这是 `@soundtouchjs/core`（SoundTouch C++ 的 JS 移植，由 Cutter 维护）在我们
 * 同步渲染管线里的适配层。分工：
 *   · `external-shift.ts`  —— 引擎注册表 / 偏好 / 懒加载
 *   · 本文件               —— **只有** SoundTouch 的驱动逻辑
 *
 * ── 两个引擎（都是另一个项目独有、@audio/* 里没有的东西）──
 *   · `soundTouchWsola` —— SoundTouch 出厂链路：WSOLA 找最佳拼接点 +
 *     RateTransposer 用 **Lanczos** 插值重采样。
 *   · `soundTouchPvoc`  —— 把 WSOLA 伸缩级换成**相位声码器**
 *     （`@soundtouchjs/stretch-phase-vocoder`）：频域相位累积，是完全不同的算法族，
 *     artifact 性质也不同（颗粒感 ← → 频域拖尾）。
 *
 * ── 三条必须按原样遵守的约定（不写下来下次一定忘）──
 *
 * 1. **SampleBuffer 是立体声交错的**：每帧两个 float（L,R）。
 *    单声道素材必须复制成 L=R，取回时只取 L；>2 通道时按「每通道独立复制」处理
 *    （硬塞 3 通道只会让库按错误帧长解析，出来是垃圾）。
 *
 * 2. **`pitch` 只要设一个数**。它内部派生 `_rate = pitch`、`_tempo = 1/pitch`
 *    并据此**交换 Transposer 与 Stretch 的串联顺序**（pitch > 1 时是 Stretch→Transposer）。
 *    所以不要再自己拼「两段式」，交给她；输出时长会自动等于输入。
 *    ⚠️ 但本项目里 `timeFactor τ`（变速）**不用** SoundTouch 的 tempo ——
 *    那一层由共享的 `@audio/stretch-psola` 在变调之后统一处理（见 `playSample`），
 *    与其它引擎走同一条路，避免「换个引擎变速行为就变了」。
 *
 * 3. **必须尾部补静音**（`PAD_SEC`）。SoundTouch 是给实时流设计的：输入喂完后
 *    Stretch 级里还压着不到一个分析窗的材料，而 `process()` 在输入不足时**不会**
 *    吐出来，也没有 `flush()` 可调 —— 结果是**尾巴被静默截掉**。
 *    实测：0.720s 的源出 0.630s，少 12.5%，听感上只是「结尾短了一截」，很难当场察觉。
 *    做法：尾部补 300ms 静音把它顶出来，再把输出按**输入帧数**裁回。
 */

import { SoundTouch } from '@soundtouchjs/core';
import { createPhaseVocoderFactory } from '@soundtouchjs/stretch-phase-vocoder';

/** 每次从 outputBuffer 搬多少帧 */
const PUMP_CHUNK = 8192;
/** 连续多少次「processing 但没吐出东西」才算泵干 */
const DRY_RUNS = 64;
/**
 * 尾部补静音的时长（秒）。大于 sequenceMs 上限 125ms + seekWindow 上限 25ms + overlap。
 * 改小会让尾巴被截；`trimTo` 里留了告警，真短了会在控制台喊。
 */
const PAD_SEC = 0.3;

/** 跨块可复用的搬运缓冲（避免每次处理都分配 8k×2 的数组） */
let pumpScratch: Float32Array | null = null;

function pump(st: SoundTouch): Float32Array {
  if (!pumpScratch || pumpScratch.length < PUMP_CHUNK * 2) {
    pumpScratch = new Float32Array(PUMP_CHUNK * 2);
  }
  const scratch = pumpScratch;
  const chunks: Float32Array[] = [];
  let dry = 0;

  while (dry < DRY_RUNS) {
    st.process();
    const n = st.outputBuffer.frameCount;
    if (n <= 0) {
      dry++;
      continue;
    }
    dry = 0;
    let off = 0;
    while (off < n) {
      const take = Math.min(n - off, PUMP_CHUNK);
      st.outputBuffer.extract(scratch, off, take);
      // extract 写进 scratch 的**开头**，所以要拷出来而不是直接引用
      chunks.push(scratch.slice(0, take * 2));
      off += take;
    }
    st.outputBuffer.receive(n);
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export interface SoundTouchOptions {
  /** 目标音高比（1.5 = +7 半音） */
  ratio?: number;
  sampleRate?: number;
  /** true = 用相位声码器替换 WSOLA 伸缩级 */
  phaseVocoder?: boolean;
  /** true = 拉长 WSOLA 分析窗（大降调档，见 `soundTouchWsolaLong`） */
  longWindow?: boolean;
}

/**
 * 「长窗」档的 WSOLA 参数 —— 就是探针里实测过的那一组，别凭感觉改。
 * `_probe-st.mjs` 里量的是 `{ sequenceMs: 120, seekWindowMs: 25 }`。
 */
const LONG_WINDOW_WSOLA = { sequenceMs: 120, seekWindowMs: 25 } as const;

/**
 * 整段变调（时长不变）。`channels` 逐通道进、逐通道出，与 `@audio/shift-*` 同签名。
 */
export function soundTouchShift(
  channels: Float32Array<ArrayBufferLike>[],
  o: SoundTouchOptions = {},
): Float32Array<ArrayBufferLike>[] {
  const nch = channels.length;
  if (nch === 0) return [];
  const sr = o.sampleRate && o.sampleRate > 0 ? o.sampleRate : 44100;
  const ratio = o.ratio && o.ratio > 0 ? o.ratio : 1;
  const frames = channels[0].length;
  const pad = Math.ceil(sr * PAD_SEC);
  const fed = frames + pad;

  // 交错成 SoundTouch 要的立体声帧。只有正好 2 通道才当真正的立体声用
  // （相位声码器的中/侧相位参考依赖这一对是同一时刻的 L/R）。
  const asStereo = nch === 2;
  const pairs: Array<{ inter: Float32Array; mode: 'stereo' | 'mono' }> = [];
  if (asStereo) {
    const inter = new Float32Array(fed * 2);
    for (let i = 0; i < frames; i++) {
      inter[2 * i] = channels[0][i];
      inter[2 * i + 1] = channels[1][i];
    }
    pairs.push({ inter, mode: 'stereo' });
  } else {
    for (let c = 0; c < nch; c++) {
      const inter = new Float32Array(fed * 2);
      const src = channels[c];
      for (let i = 0; i < frames; i++) {
        inter[2 * i] = src[i];
        inter[2 * i + 1] = src[i];
      }
      pairs.push({ inter, mode: 'mono' });
    }
  }

  const results = pairs.map(({ inter, mode }) => {
    const st = new SoundTouch({
      sampleRate: sr,
      ...(o.phaseVocoder ? { stretchFactory: createPhaseVocoderFactory() } : {}),
    });
    st.pitch = ratio;
    if (o.longWindow) st.setStretchParameters({ ...LONG_WINDOW_WSOLA });
    st.inputBuffer.putSamples(inter, 0, fed);
    const outInter = pump(st);
    if (mode === 'stereo') return outInter;
    const mono = new Float32Array(outInter.length / 2);
    for (let i = 0; i < mono.length; i++) mono[i] = outInter[2 * i];
    return mono;
  });

  /** 裁回输入帧数：pitch-only 的输出时长应当与输入相同 */
  const trim = (a: Float32Array): Float32Array => {
    if (a.length === frames) return a;
    if (a.length > frames) return a.subarray(0, frames);
    // 短了说明补静音还不够。宁可原样返回并在控制台留痕，也不静默补零把问题藏起来。
    console.warn(
      `[soundtouch-engine] 输出比输入短：${a.length} / ${frames} 帧（ratio=${ratio.toFixed(4)}）` +
        `—— 需要加大 PAD_SEC`,
    );
    return a;
  };

  if (asStereo) {
    const inter = results[0];
    const n = Math.min(inter.length / 2, frames);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = inter[2 * i];
      R[i] = inter[2 * i + 1];
    }
    return [trim(L), trim(R)];
  }
  return results.map(trim);
}

/** SoundTouch 出厂链路：WSOLA 拼接 + Lanczos 插值重采样 */
export function soundTouchWsola(
  channels: Float32Array<ArrayBufferLike>[],
  o: SoundTouchOptions = {},
): Float32Array<ArrayBufferLike>[] {
  return soundTouchShift(channels, o);
}

/**
 * 大降调档：把 WSOLA 的分析窗拉长（`LONG_WINDOW_WSOLA`）。
 *
 * 依据（`_probe-st.mjs`，−12 半音 高北）：默认档 HNR 9.95，长窗档 **12.04**；
 * 而 −8.2 半音 龙.001 两档基本持平（12.73 / 12.69），**不做亏本买卖**。
 * 大位移时拼接点更难找，给搜索更长的上下文是有回报的。
 */
export function soundTouchWsolaLong(
  channels: Float32Array<ArrayBufferLike>[],
  o: SoundTouchOptions = {},
): Float32Array<ArrayBufferLike>[] {
  return soundTouchShift(channels, { ...o, longWindow: true });
}

/** SoundTouch 管线 + 相位声码器伸缩级（算法族不同，artifact 性质也不同） */
export function soundTouchPvoc(
  channels: Float32Array<ArrayBufferLike>[],
  o: SoundTouchOptions = {},
): Float32Array<ArrayBufferLike>[] {
  return soundTouchShift(channels, { ...o, phaseVocoder: true });
}
