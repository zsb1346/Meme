/**
 * 音频解码 Web Worker —— 素材导入的解码与音高检测全部在 hajimi-audio WASM 内完成。
 *
 * 换血说明（RUSH WASM 方案 · 解码层）：
 *  - 旧实现用 OfflineAudioContext.decodeAudioData 解码，会把一切重采样到上下文
 *    采样率（通常 48k），且各浏览器对 m4a/aac 支持不一、偶发解码失败。
 *  - 现改用纯 Rust 的 symphonia（编译进 wasm）：按文件原生采样率解码，格式覆盖
 *    WAV/MP3/FLAC/OGG/AAC/M4A/ALAC，行为跨浏览器一致。
 *  - 音高检测（YIN）同样在 wasm 内就地完成，主线程零负担。
 *  - 解码与检测都在本 worker 线程，主线程完全不接触字节与样本。
 *
 * 协议（request/response，自增 id 配对）——与旧版完全一致，故 sample-player 无需改：
 *   → { id, blob }
 *   ← { id, channels, sampleRate, numberOfChannels, length, detectedPitchHz }
 *   ← { id, error }
 *
 * 注意：本文件由 tsconfig.worker.json 独立类型检查（WebWorker lib），
 * 由 Vite `new Worker(new URL(...), { type: 'module' })` 打包。
 */
import { loadHajimiWasm, wasmDecode } from './rush/loader';

interface DecodeRequest {
  id: number;
  blob: Blob;
}

addEventListener('message', async (e: MessageEvent<DecodeRequest>) => {
  const { id, blob } = e.data;

  try {
    const w = await loadHajimiWasm();
    // 文件字节在 worker 内异步读取，主线程不接触原始文件
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { channels, sampleRate, pitchHz } = await wasmDecode(w, bytes);

    // 各 Float32Array 已持有独立 ArrayBuffer，直接转移所有权回主线程（零拷贝）
    const buffers = channels.map((c) => c.buffer as ArrayBuffer);
    postMessage(
      {
        id,
        channels: buffers,
        sampleRate,
        numberOfChannels: channels.length,
        length: channels[0]?.length ?? 0,
        detectedPitchHz: pitchHz > 0 ? pitchHz : null,
      },
      { transfer: buffers },
    );
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
});
