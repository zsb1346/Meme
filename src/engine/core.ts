import * as Tone from 'tone';

/**
 * 引擎单例：AudioContext 管理、iOS/Chrome 自动播放策略解锁、主输出挂载入口。
 * 本模块是 engine 层的地基 —— 任何发声前必须先 getAudioContext()。
 * 纯 TS，禁止 import React。
 */

let ctx: AudioContext | null = null;
let unlockInstalled = false;

/**
 * 取全局唯一 AudioContext（懒创建）。
 * 创建后立即把它设为 Tone.js 的全局上下文，保证原生节点与 Tone 节点同钟同硬件。
 */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    Tone.setContext(new Tone.Context(ctx));
  }
  return ctx;
}

/** 预览起播提前量（秒）：给调度与解锁留余量。时钟数学的唯一真相。 */
export const PREVIEW_LEAD_SEC = 0.08;

/** 取上下文并尝试 resume（已解锁时为 no-op）。返回值可直接用于解码/调度。 */
export function ensureAudioStarted(): AudioContext {
  const c = getAudioContext();
  void c.resume().catch((err) =>
    console.warn('[core] AudioContext resume 失败（等待用户手势）', err),
  );
  return c;
}

/**
 * 取上下文并 **await** resume，返回最终是否 running。
 * 播放入口必须先过这道门：suspended 状态下 currentTime 冻结，
 * lookahead 调度器的视界永不推进 → 既不发声也不动播放头。
 */
export async function ensureAudioContextRunning(): Promise<boolean> {
  const c = getAudioContext();
  if (c.state === 'running') return true;
  try {
    await c.resume();
  } catch (err) {
    console.warn('[core] AudioContext resume 失败（等待用户手势）', err);
  }
  // 重新读取状态：resume 是异步的，c.state 可能已变为 running，
  // 但 TS 会把上面的早退收窄成「非 running」，故用新取值规避跨 await 的过时收窄。
  return getAudioContext().state === 'running';
}

/**
 * 安装一次性手势解锁监听（pointerdown / touchend / keydown）。
 * App 挂载时调用一次即可；重复调用安全。
 */
export function installAudioUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const unlock = () => {
    const c = getAudioContext();
    if (c.state !== 'running') {
      c.resume().catch((err) =>
        console.warn('[core] 手势解锁 resume 失败', err),
      );
    }
  };
  const opts: AddEventListenerOptions = { passive: true };
  window.addEventListener('pointerdown', unlock, opts);
  window.addEventListener('touchend', unlock, opts);
  window.addEventListener('keydown', unlock, opts);
}

/** 当前上下文是否处于 running 状态（调试/遮罩判断用）。 */
export function isAudioRunning(): boolean {
  return ctx?.state === 'running';
}

/** 测试/HMR 用：丢弃单例引用（不 dispose Tone 链，进程级资源由页面卸载回收）。 */
export function resetAudioContextForTest(): void {
  ctx = null;
}
