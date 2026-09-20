/**
 * Worker 侧最小 Web Audio 类型声明。
 *
 * OfflineAudioContext / AudioBuffer 在 worker 全局作用域运行时可用，
 * 但 TypeScript 的 "WebWorker" lib 未收录它们；而把 DOM lib 加进 worker
 * tsconfig 会与 WebWorker lib 的 self/postMessage 等全局符号冲突。
 * 这里只声明 worker 代码实际用到的成员，由 tsconfig.worker.json include。
 *
 * 注意：本文件位于 src/ 之外，主 tsconfig（include: ["src"]）不会编译它，
 * 避免与 DOM lib 内置的 AudioBuffer 声明重复冲突。
 */

declare class AudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

declare class OfflineAudioContext {
  constructor(numberOfChannels: number, length: number, sampleRate: number);
  decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer>;
  close(): Promise<void>;
}
