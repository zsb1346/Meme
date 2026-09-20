/**
 * autotune.test —— 离线自动修音的真二进制端到端测试（vitest，纯 node 环境）。
 *
 * 用 fs 读 public/hajimi_audio.wasm 直接 WebAssembly.instantiate（Node 18+
 * 内置 WebAssembly；不走 loader 的 fetch —— node 下没有站点 origin 可解析
 * '/hajimi_audio.wasm'），手写最小胶水走 hajimi_at_run ABI：
 *   alloc → 写 planar f32 → atRun → atChannels/atFrames/atChannelPtr 读回 → free。
 * 合成 320→230Hz 滑音（glissando）锁到 MIDI 69，两端修正后音高都应 ≈440Hz
 * （±40 音分内），用项目自带 detectPitchYinCore 检测。
 *
 * 前置：public/hajimi_audio.wasm 必须是最新构建（npm run build:wasm）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectPitchYinCore, hzToMidi } from '../pitch';

/** hajimi_at_run 相关导出的最小类型面（与 wasm/src/autotune.rs 的 ABI 对齐）。 */
interface AtExports {
  memory: WebAssembly.Memory;
  hajimi_alloc(len: number): number;
  hajimi_dealloc(ptr: number, len: number): void;
  hajimi_at_run(
    inPtr: number,
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
  hajimi_at_channels(): number;
  hajimi_at_frames(): number;
  hajimi_at_channel_ptr(c: number): number;
  hajimi_at_free(): void;
}

async function instantiateWasm(): Promise<AtExports> {
  // 本文件在 src/engine/rush/，仓库根 = 上三级；public/hajimi_audio.wasm 相对解析。
  const url = new URL('../../../public/hajimi_audio.wasm', import.meta.url);
  const bytes = readFileSync(url);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as AtExports;
}

/** 相位积分滑音：from→to Hz 线性扫频，无相位跳变。 */
function glissando(n: number, sr: number, from: number, to: number): Float32Array {
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin(2 * Math.PI * phase);
    phase += (from + ((to - from) * i) / n) / sr;
  }
  return x;
}

interface RunOpts {
  targetMidi: number;
  scaleMask?: number;
  retuneMs?: number;
  transitionMs?: number;
  toleranceCents?: number;
  amount?: number;
  refHz?: number;
}

/** 完整 ABI 流程：alloc→写→atRun→读回→free。返回拷出的单声道输出。 */
function runAt(ex: AtExports, mono: Float32Array, sr: number, o: RunOpts): Float32Array {
  const frames = mono.length;
  const bytes = frames * 4; // ch=1
  const ptr = ex.hajimi_alloc(bytes) >>> 0;
  new Float32Array(ex.memory.buffer, ptr, frames).set(mono);
  let out: Float32Array;
  try {
    const rc = ex.hajimi_at_run(
      ptr,
      frames,
      1,
      sr,
      o.targetMidi,
      o.scaleMask ?? 0xfff,
      o.retuneMs ?? 15,
      o.transitionMs ?? 120,
      o.toleranceCents ?? 0,
      o.amount ?? 1,
      o.refHz ?? 440,
    );
    expect(rc).toBeGreaterThan(0);
    expect(ex.hajimi_at_channels()).toBe(1);
    expect(ex.hajimi_at_frames()).toBe(rc);
    const cp = ex.hajimi_at_channel_ptr(0) >>> 0;
    // 立即拷出独立缓冲（随后 atFree 会释放 wasm 侧存储）
    out = new Float32Array(new Float32Array(ex.memory.buffer, cp, rc));
  } finally {
    ex.hajimi_at_free();
    ex.hajimi_dealloc(ptr, bytes);
  }
  return out;
}

/**
 * 音分差（cents）。
 *
 * 这里曾经写作 `1200 * (hzToMidi(a) - hzToMidi(b))` —— 错的，而且错 12 倍：
 * `hzToMidi` 返回的是**半音**（69 + 12·log2），一个八度 = 12，而 1200 是「每八度
 * 的音分数」。于是 1200 × 半音差 = 12 × 真实音分。后果是下面那句
 * `toBeLessThan(40)` 实际上卡在 **3.33 音分**上：两者都远远超过「锁定 A4」应有的
 * 精度要求，却恰好落在实测误差（约 3.2~3.6 音分）的两侧 —— 于是同一个算法会在
 * 阈值左右的噪声里时红时绿，看起来像算法回归，其实是尺子错了。
 *
 * 修成 100（每半音的分数）后，40 才是真正的 40 音分。
 */
const centsOff = (hz: number, wantHz: number): number =>
  100 * (hzToMidi(hz) - hzToMidi(wantHz));

describe('hajimi_at_run（wasm 真二进制 · 离线自动修音）', () => {
  const SR = 48000;

  it('ABSOLUTE 锁定：320→230Hz 滑音两端都被修到 440Hz ±40 音分', async () => {
    const ex = await instantiateWasm();
    const n = SR * 2;
    const input = glissando(n, SR, 320, 230);
    // 先确认真未修准时 YIN 两端确实偏离（否则测试无意义）：
    // 滑音中段≈275Hz，对 440 至少差 800 音分。
    const rawMid = detectPitchYinCore(input.slice((n * 3) / 8, (n * 5) / 8), SR);
    expect(rawMid).not.toBeNull();
    expect(Math.abs(centsOff(rawMid!, 440))).toBeGreaterThan(40);

    const out = runAt(ex, input, SR, { targetMidi: 69 });
    expect(out.length).toBe(n);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);

    const head = detectPitchYinCore(out.slice(SR / 2, (SR * 3) / 4), SR);
    const tail = detectPitchYinCore(out.slice(n - SR / 4, n), SR);
    expect(head).not.toBeNull();
    expect(tail).not.toBeNull();
    expect(Math.abs(centsOff(head!, 440))).toBeLessThan(40);
    expect(Math.abs(centsOff(tail!, 440))).toBeLessThan(40);

    // 最后 0.1s 也必须被修到 —— 这条曾经不成立：旧的自动修音合成路径逐 mark
    // 顺序推进，源 mark 先于输出耗尽，于是**末段直接漏出来没变调**（实测最后
    // 100ms 的 YIN 读数就是源音高 230Hz）。上一条 tail 断言抓不到它，因为那段
    // 的坏帧置信度偏低、被 top-half 中位数筛掉了；这里单独盯结尾。
    const veryEnd = detectPitchYinCore(out.slice(n - SR / 10, n), SR);
    expect(veryEnd).not.toBeNull();
    expect(Math.abs(centsOff(veryEnd!, 440))).toBeLessThan(50);
  }, 30_000);

  it('amount=0：ABI 逐字节直通（不修不损）', async () => {
    const ex = await instantiateWasm();
    const input = glissando(SR, SR, 300, 260);
    const out = runAt(ex, input, SR, { targetMidi: 69, amount: 0 });
    expect(out).toEqual(input);
  }, 15_000);
});
