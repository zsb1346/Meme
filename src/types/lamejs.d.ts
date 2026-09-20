/**
 * lamejs 1.2.1 缺少官方类型，且其 CJS 源码存在已知 bug：
 * Encoder.js / Lame.js / PsyModel.js 引用了未 require 的裸标识符
 * `MPEGMode` / `Lame` / `BitStream`（浏览器 script 标签下恰好是全局变量，
 * 模块化打包后变成 ReferenceError）。
 *
 * 处理方式（engine/exporter.ts）：动态 import 三个子路径模块，
 * 在编码前把它们挂到 globalThis 上 —— 已在 Node 端验证可正常出帧。
 */
declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    /** 编码一段 PCM16 数据；立体声时传左右声道。返回 MP3 帧（可能为空）。 */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    /** 结束编码，冲刷剩余帧。 */
    flush(): Int8Array;
  }
}

declare module 'lamejs/src/js/MPEGMode.js' {
  const MPEGMode: unknown;
  export default MPEGMode;
}

declare module 'lamejs/src/js/Lame.js' {
  const Lame: unknown;
  export default Lame;
}

declare module 'lamejs/src/js/BitStream.js' {
  const BitStream: unknown;
  export default BitStream;
}
