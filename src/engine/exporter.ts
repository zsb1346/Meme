import * as Tone from 'tone';
import type { Project, SampleId, Take } from '../model/types';
import { resolveTakeEventRef } from '../model/take-stage';
import { buildEffectChain, type EffectChain } from './effects';
import { playSample } from './sample-player';
import { sampleSemitonesAtPitch } from './pitch';
import { resolveEventVoice } from './event-voice';
import { tailSecFor, LEAD_IN_SEC } from './export-constants';

/**
 * 导出渲染（计划 §4.4）：
 * OfflineAudioContext 重放 Take 事件流（含各键 playbackRate 与同一条总线效果链）
 * → wav（自写 PCM16 编码）/ mp3（lamejs 动态 import 懒加载）。
 * 保证「导出 = 预览」：声音解析与 TakePlayer 同一入口 resolveTakeEventRef
 * ——事件自身 sampleId 是唯一声源，骨架事件在两条路径里同样静音。
 */

// ---------------------------------------------------------------------------
// 导出锁 —— 导出期间屏蔽实时演奏/预览，防止 Tone 上下文被抢
// ---------------------------------------------------------------------------

/**
 * 意图：导出期间 Tone.setContext(offline) 是进程级替换。
 * 用户按键盘/点击演奏台时，那个音会接到离线的链上 ——
 * 实时没声、或 Tone 内部状态错乱（节点挂到已销毁的 OfflineAudioContext）。
 * 加全局锁，key-machine / take-player 在触发前检查，导出期间直接跳过。
 */
let exporting = false;

/** 当前是否正在导出（key-machine / take-player 据此跳过发声） */
export function isExporting(): boolean {
  return exporting;
}

export type ExportFormat = 'wav' | 'mp3';

export interface RenderTakeOptions {
  /** 混响等尾音余量秒数，默认 2.5 */
  tailSec?: number;
  /** 渲染采样率，默认 44100 */
  sampleRate?: number;
  /** 起始留白秒数，默认 0.05（防首样本截断） */
  leadInSec?: number;
  /** mp3 码率 kbps，默认 192 */
  mp3Kbps?: number;
}

export interface TakeRenderInput {
  project: Project;
  take: Take;
  /** sampleId → 解码缓冲（UI 层用 sample-player 的缓存组装） */
  resolveBuffer(id: SampleId): AudioBuffer | null;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
}

/**
 * 离线渲染 Take → AudioBuffer。
 * 过程中临时把 Tone 全局上下文切到离线上下文以复用 buildEffectChain，
 * 结束后无论成败都恢复原上下文（finally）。
 */
export async function renderTake(
  input: TakeRenderInput,
  opts: RenderTakeOptions = {},
): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 44100;
  const tailSec = opts.tailSec ?? tailSecFor(input.project.effects);
  const leadInSec = opts.leadInSec ?? LEAD_IN_SEC;
  const audibleEndSec = input.take.events.reduce((maxEnd, ev) => {
    // 一声源：只认事件自身的 sampleId；骨架事件不出声，也不贡献结束时间。
    // 全骨架 Take → audibleEnd 落到 durationSec，渲染仍是合法的空音频。
    const ref = resolveTakeEventRef(input.project, ev);
    const buffer = ref ? input.resolveBuffer(ref.sampleId) : null;
    if (!ref || !buffer) return maxEnd;
    const sample = input.project.samples.find((s) => s.id === ref.sampleId);
    const targetPitch = input.project.settings.autoTuneEnabled ? ev.pitch : undefined;
    const voice = resolveEventVoice(
      sample ? sampleSemitonesAtPitch(sample, targetPitch) : 0,
      ev,
    );
    const naturalDuration = buffer.duration * voice.timeFactor;
    const eventDuration = ev.duration === undefined
      ? naturalDuration
      : Math.min(ev.duration, naturalDuration);
    return Math.max(maxEnd, ev.tSec + eventDuration);
  }, input.take.durationSec);
  const durationSec = Math.max(audibleEndSec + leadInSec + tailSec, 1);

  const offline = new OfflineAudioContext(
    2,
    Math.ceil(durationSec * sampleRate),
    sampleRate,
  );
  const previousContext = Tone.getContext();
  Tone.setContext(new Tone.Context(offline));
  exporting = true;

  let chain: EffectChain | null = null;
  try {
    chain = buildEffectChain(input.project.effects);
    await chain.ready; // Reverb IR 必须在 startRendering 前生成完毕

    const sorted = [...input.take.events].sort((a, b) => a.tSec - b.tSec);
    for (const ev of sorted) {
      // 一声源：与 TakePlayer.scheduleEvent 同一解析入口，骨架事件直接跳过。
      const ref = resolveTakeEventRef(input.project, ev);
      if (!ref) continue;
      const buffer = input.resolveBuffer(ref.sampleId);
      if (!buffer) continue;

      const sample = input.project.samples.find((s) => s.id === ref.sampleId);
      // 与 TakePlayer.scheduleEvent 共用同一纯函数 → 预览/导出 parity
      const targetPitch = input.project.settings.autoTuneEnabled ? ev.pitch : undefined;
      const v = resolveEventVoice(
        sample ? sampleSemitonesAtPitch(sample, targetPitch) : 0,
        ev,
      );

      playSample({
        buffer,
        destination: chain.input,
        sourceContext: offline,
        when: leadInSec + ev.tSec,
        semitones: v.semitones,
        timeFactor: v.timeFactor,
        gainLinear: ev.velocity ?? 1,
      });
    }

    return await offline.startRendering();
  } finally {
    // 无论成败都释放离线链并恢复原上下文
    exporting = false;
    chain?.dispose();
    Tone.setContext(previousContext);
  }
}

// ---------------------------------------------------------------------------
// WAV 编码（自写 PCM16 RIFF）
// ---------------------------------------------------------------------------

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** AudioBuffer → 16bit PCM wav Blob。 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const data = channels[c];
      const raw = data ? (data[i] || 0) : 0;
      const s = Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// MP3 编码（lamejs 动态 import —— 仅点导出时才下载该 chunk）
// ---------------------------------------------------------------------------

function floatToInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i] || 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * lamejs 1.2.1 的已知 bug：Encoder.js / Lame.js / PsyModel.js 引用了未 require
 * 的裸标识符 `MPEGMode` / `Lame` / `BitStream`（script 标签时代它们恰为全局变量）。
 * 打包环境下必须在编码前把这三个模块挂到 globalThis，否则抛 ReferenceError。
 * （已在 Node 端实测：注入后 encodeBuffer/flush 正常出帧。）
 */
async function patchLamejsGlobals(): Promise<void> {
  const [mpegMode, lame, bitStream] = await Promise.all([
    import('lamejs/src/js/MPEGMode.js'),
    import('lamejs/src/js/Lame.js'),
    import('lamejs/src/js/BitStream.js'),
  ]);
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.MPEGMode === undefined) g.MPEGMode = mpegMode.default;
  if (g.Lame === undefined) g.Lame = lame.default;
  if (g.BitStream === undefined) g.BitStream = bitStream.default;
}

/** AudioBuffer → mp3 Blob（lamejs 懒加载）。 */
export async function encodeMp3(buffer: AudioBuffer, kbps = 192): Promise<Blob> {
  await patchLamejsGlobals();
  const lame = await import('lamejs');
  const numChannels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const encoder = new lame.Mp3Encoder(numChannels, buffer.sampleRate, kbps);

  const left = floatToInt16(buffer.getChannelData(0));
  const right =
    numChannels > 1 ? floatToInt16(buffer.getChannelData(1)) : undefined;

  const blockSize = 1152;
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const r = right ? right.subarray(i, i + blockSize) : undefined;
    const encoded =
      numChannels > 1 && r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  return new Blob(chunks, { type: 'audio/mpeg' });
}

// ---------------------------------------------------------------------------
// 一站式导出
// ---------------------------------------------------------------------------

function sanitizeName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'take';
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 渲染 + 编码一步到位。文件名：`工程名-take名-时间戳.ext`。 */
export async function exportTake(
  input: TakeRenderInput,
  format: ExportFormat,
  opts: RenderTakeOptions = {},
): Promise<ExportResult> {
  const buffer = await renderTake(input, opts);
  if (format === 'wav') {
    return {
      blob: encodeWav(buffer),
      filename: `${sanitizeName(input.project.name)}-${sanitizeName(input.take.name)}-${timestamp()}.wav`,
      mimeType: 'audio/wav',
    };
  }
  const blob = await encodeMp3(buffer, opts.mp3Kbps ?? 192);
  return {
    blob,
    filename: `${sanitizeName(input.project.name)}-${sanitizeName(input.take.name)}-${timestamp()}.mp3`,
    mimeType: 'audio/mpeg',
  };
}
