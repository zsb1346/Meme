/**
 * 本地 WAV 编码 —— 32-bit IEEE float（fmt=3），最小 RIFF 头。
 *
 * 供素材箱波形编辑器（SampleEditorModal）切片入库使用。
 * 切片方案为 decode-extract：复用已解码 AudioBuffer，按采样级精确抽取区间
 * 后重编码为规范 WAV —— mp3/m4a 等压缩格式无法在任意采样点安全切帧，
 * decode-extract 才是采样精确且与引擎解码链路一致的方案。
 *
 * 编码格式必须是 32-bit float：源数据是 float32 AudioBuffer，float32 WAV
 * 编码即位级无损；若用 16-bit PCM 会丢失精度（尤其 24bit/FLAC 源素材），
 * 切片再入库等于白损失一档音质。浏览器 decodeAudioData 全支持 float WAV。
 *
 * 提供同步版与异步版：异步版在编码循环中周期性让出主线程（yield），
 * 让导入切片这类耗时编码在「后台」进行、不冻结 UI（配合按钮 loading 状态）。
 */

/** 计算采样区间并返回 { start, end, frames }，越界/空区间会抛错。 */
function sliceBounds(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
): { start: number; end: number; frames: number } {
  const sr = buffer.sampleRate;
  const start = Math.max(0, Math.min(buffer.length, Math.floor(startSec * sr)));
  const end = Math.max(start, Math.min(buffer.length, Math.ceil(endSec * sr)));
  const frames = end - start;
  if (frames <= 0) throw new Error('切片时长为 0');
  return { start, end, frames };
}

/** 构建 44 字节 RIFF/WAVE 头（32-bit float 格式，fmt=3）；dataSize = frames * blockAlign。 */
function buildWavHeader(
  v: DataView,
  sr: number,
  chCount: number,
  dataSize: number,
): void {
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, chCount, true);
  v.setUint32(24, sr, true);
  const blockAlign = chCount * 4;
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 32, true); // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
}

/**
 * 同步写入 [start, end) 帧到 DataView；float32 原样写入，无量化。
 * dstStartFrame 为目标数据区（44 字节头之后）的帧偏移，供异步分块续写：
 * off = 44 + dstStartFrame * chCount * 4，默认 0 即从数据区起始处写入。
 */
function encodeFramesSync(
  buffer: AudioBuffer,
  start: number,
  end: number,
  v: DataView,
  dstStartFrame = 0,
): void {
  const chCount = Math.max(1, buffer.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let c = 0; c < chCount; c++) channels.push(buffer.getChannelData(c));
  let off = 44 + dstStartFrame * chCount * 4;
  for (let i = start; i < end; i++) {
    for (let c = 0; c < chCount; c++) {
      const s = channels[c][i] || 0;
      v.setFloat32(off, s, true);
      off += 4;
    }
  }
}

/** 从 AudioBuffer 的 [startSec, endSec) 区间编码出一段 float32 WAV Blob（同步，位级无损）。 */
export function encodeRegionWav(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
): Blob {
  const { start, end, frames } = sliceBounds(buffer, startSec, endSec);
  const sr = buffer.sampleRate;
  const chCount = Math.max(1, buffer.numberOfChannels);
  const dataSize = frames * chCount * 4;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  buildWavHeader(v, sr, chCount, dataSize);
  encodeFramesSync(buffer, start, end, v);
  return new Blob([ab], { type: 'audio/wav' });
}

export interface EncodeRegionWavAsyncOptions {
  /** 每处理多少个采样帧让出一次主线程（默认 16384 ≈ 0.34s@48k）。 */
  yieldEvery?: number;
  /** 进度回调（0..1，按帧推进）；仅用于状态展示，勿用于精确调度。 */
  onProgress?(ratio: number): void;
}

/** 异步版：编码期间周期性让出事件循环，避免大选区编码卡顿 UI。 */
export async function encodeRegionWavAsync(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  opts: EncodeRegionWavAsyncOptions = {},
): Promise<Blob> {
  const { start, end, frames } = sliceBounds(buffer, startSec, endSec);
  const sr = buffer.sampleRate;
  const chCount = Math.max(1, buffer.numberOfChannels);
  const dataSize = frames * chCount * 4;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  buildWavHeader(v, sr, chCount, dataSize);

  const yieldEvery = Math.max(1, opts.yieldEvery ?? 16384);
  const onProgress = opts.onProgress;
  let done = start;
  while (done < end) {
    const chunkEnd = Math.min(end, done + yieldEvery);
    encodeFramesSync(buffer, done, chunkEnd, v, done - start);
    done = chunkEnd;
    onProgress?.(frames > 0 ? (done - start) / frames : 1);
    if (done < end) await new Promise((r) => setTimeout(r));
  }
  onProgress?.(1);
  return new Blob([ab], { type: 'audio/wav' });
}