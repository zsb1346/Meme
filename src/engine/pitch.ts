import type { Sample } from '../model/types';
import { MAX_SEMITONE_SHIFT } from '../model/pitch-limits';

/**
 * 音高检测（自写 YIN，无重依赖）+ 半音换算 → playbackRate。
 * 全部为纯函数；检测失败一律返回 null，由调用方回退手动锚定。
 */

// ---------------------------------------------------------------------------
// 基础换算
// ---------------------------------------------------------------------------

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** from → to 的半音差（带符号小数） */
export function semitonesBetween(fromHz: number, toHz: number): number {
  return 12 * Math.log2(toHz / fromHz);
}

/** 变调核心公式（计划 §4.2）：playbackRate = 2^(semitones/12) */
export function playbackRateForSemitones(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

// ---------------------------------------------------------------------------
// YIN 音高检测
// ---------------------------------------------------------------------------

export interface YinOptions {
  /** CMND 阈值，越低越严格（默认 0.12） */
  threshold?: number;
  /** 分析窗长（采样数，默认 2048） */
  windowSize?: number;
  /** 最多分析多少帧（默认 24，取置信度前半的中位数抗噪） */
  maxFrames?: number;
  minHz?: number;
  maxHz?: number;
}

interface YinFrameResult {
  freq: number;
  conf: number;
}

/** 单帧 YIN：差分函数 → 累积均值归一 → 阈值搜索 → 抛物线插值。 */
function yinFrame(
  x: Float32Array,
  offset: number,
  win: number,
  minTau: number,
  maxTau: number,
  threshold: number,
  sampleRate: number,
): YinFrameResult | null {
  const diff = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let j = offset; j < offset + win; j++) {
      const delta = x[j] - x[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }
  let tauEst = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) return null;

  // 抛物线插值细化周期：顶点 x = i + (a-c) / (2*(a+c-2b))
  let betterTau = tauEst;
  if (tauEst > minTau && tauEst < maxTau) {
    const a = cmnd[tauEst - 1];
    const b = cmnd[tauEst];
    const c = cmnd[tauEst + 1];
    const denom = 2 * (a + c - 2 * b);
    if (denom !== 0) {
      betterTau = tauEst + (a - c) / denom;
    }
  }

  const freq = sampleRate / betterTau;
  if (!isFinite(freq) || freq <= 0) return null;
  return { freq, conf: 1 - cmnd[tauEst] };
}

function downmix(buffer: AudioBuffer, maxSec: number): Float32Array {
  const n = Math.min(buffer.length, Math.floor(buffer.sampleRate * maxSec));
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] || 0;
  }
  if (channels > 1) {
    for (let i = 0; i < n; i++) out[i] /= channels;
  }
  return out;
}

/**
 * 检测 AudioBuffer 的基频（Hz）。
 * 多帧扫描取「高置信度前半」的频率中位数，显著抗噪；
 * 无任何过阈帧（纯噪声/静音/打击乐）→ 返回 null，调用方回退手动锚定。
 */
export function detectPitchYin(
  buffer: AudioBuffer,
  opts: YinOptions = {},
): number | null {
  const data = downmix(buffer, 4);
  return detectPitchYinCore(data, buffer.sampleRate, opts);
}

/**
 * 纯核心函数：接收 Float32Array + sampleRate（Worker 与主线程共用）。
 * 与 detectPitchYin 行为完全一致，只是跳过 downmix 步骤。
 */
export function detectPitchYinCore(
  data: Float32Array,
  sampleRate: number,
  opts: YinOptions = {},
): number | null {
  const threshold = opts.threshold ?? 0.12;
  const win = opts.windowSize ?? 2048;
  if (data.length < win + 2) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / (opts.maxHz ?? 1200)));
  const maxTau = Math.min(win - 2, Math.ceil(sampleRate / (opts.minHz ?? 65)));
  if (maxTau <= minTau) return null;

  const maxFrames = opts.maxFrames ?? 24;
  const usable = data.length - win;
  const stride = Math.max(1, Math.floor(usable / maxFrames));

  const results: YinFrameResult[] = [];
  for (let off = 0; off + win <= data.length; off += stride) {
    const r = yinFrame(data, off, win, minTau, maxTau, threshold, sampleRate);
    if (r) results.push(r);
  }
  if (results.length === 0) return null;

  results.sort((a, b) => b.conf - a.conf);
  const topHalf = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
  const freqs = topHalf.map((r) => r.freq).sort((a, b) => a - b);
  return freqs[Math.floor(freqs.length / 2)];
}

// ---------------------------------------------------------------------------
// 变调决策（FL 式采样器语义：素材始终以原声/根音为基准）
// ---------------------------------------------------------------------------

/**
 * 最终半音偏移：FL 式采样器语义 —— 素材始终以原声（根音）为基准，
 * 唯一变调来源是手动微调 manualSemitoneOffset。
 * 检测到的根音 detectedPitchHz 仅作信息展示与未来相对映射的锚点，不参与变调计算。
 * 结果交给 playbackRateForSemitones() 得到 playbackRate。
 */
export function sampleSemitones(sample: Sample): number {
  return sample.manualSemitoneOffset;
}

/**
 * FL 采样器式目标音高：以检测根音为键盘映射锚点，再叠加素材手动微调。
 * 检测失败时不猜根音，退回原有素材级手动微调语义。
 */
export function sampleSemitonesAtPitch(
  sample: Sample,
  targetPitchMidi?: number,
): number {
  if (
    targetPitchMidi === undefined ||
    !Number.isFinite(targetPitchMidi) ||
    sample.detectedPitchHz === null ||
    !Number.isFinite(sample.detectedPitchHz) ||
    sample.detectedPitchHz <= 0
  ) {
    return sampleSemitones(sample);
  }
  const raw =
    targetPitchMidi -
    hzToMidi(sample.detectedPitchHz) +
    sample.manualSemitoneOffset;

  // 保护：变调量超 ±MAX_SEMITONE_SHIFT 视为 YIN 检测失败，退回手动模式。
  // 这个界与装配面板的手动增量**共用同一个常量**（`model/pitch-limits.ts`）——
  // 两边说的是同一件事：「超出两个八度就不是调教，是故障」。
  // 早先这里是个孤立的字面量 24，而面板那一侧根本没有界，于是同一条判断
  // 一边生效、一边完全不设防（2026-09-20 用户实报的「变调后无声」即由此而来）。
  if (!Number.isFinite(raw) || Math.abs(raw) > MAX_SEMITONE_SHIFT) {
    console.warn(
      '[pitch] 自动音高越界，退回手动模式',
      {
        name: sample.name,
        detectedHz: sample.detectedPitchHz,
        targetMidi: targetPitchMidi,
        raw,
      },
    );
    return sampleSemitones(sample);
  }
  return raw;
}

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;

/** Hz → 音名（如 "C4"）；非正数返回 null。四舍五入到最近半音。 */
export function midiNoteName(hz: number): string | null {
  if (!isFinite(hz) || hz <= 0) return null;
  const midi = Math.round(hzToMidi(hz));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}
