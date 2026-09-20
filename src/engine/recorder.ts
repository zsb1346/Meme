import * as Tone from 'tone';
import type { Take, TakeEvent } from '../model/types';
import { getAudioContext } from './core';
import { midiToHz } from './pitch';
import { uid } from '../utils/uid';

/**
 * 录制（计划 §4.3）：
 * - 事件时间戳一律取 audioContext.currentTime（相对录制起点），禁用 Date.now()
 * - 按键同时触发「真实音准钢琴反馈音」（do re mi…，按大调音阶映射键位）
 * - 两段式按住时长：notifyKeyPress 记录事件（duration 留空），notifyKeyRelease
 *   在松开时用音频时钟补写 duration（秒）；播放/导出暂不消费该字段
 * - 反馈音走独立 gain 直连输出，绝不进主效果链、绝不进导出渲染
 */

/** 大调全音阶半音级（do re mi fa sol la si） */
const MAJOR_STEPS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];

/** 键位 → MIDI 音高：从 C4(60) 开始按大调音阶铺开，跨八度循环。 */
export function keyIndexToMidi(keyIndex: number, baseMidi = 60): number {
  const octave = Math.floor(keyIndex / MAJOR_STEPS.length);
  return baseMidi + octave * 12 + (MAJOR_STEPS[keyIndex % MAJOR_STEPS.length] ?? 0);
}

/**
 * 钢琴反馈音源：PolySynth 三角波 + 快衰减包络（轻量合成，避免 CDN 采样依赖）。
 * 独立 bus 直连 Tone Destination —— 与效果链物理隔离。
 */
class FeedbackPiano {
  private synth: Tone.PolySynth | null = null;
  private bus: Tone.Gain | null = null;

  private ensure(): void {
    if (this.synth && this.bus) return;
    this.bus = new Tone.Gain(0.9).toDestination();
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.003, decay: 0.45, sustain: 0.06, release: 1.0 },
      volume: -9,
    });
    this.synth.connect(this.bus);
  }

  play(keyIndex: number): void {
    this.ensure();
    const synth = this.synth;
    if (!synth) return;
    const freq = midiToHz(keyIndexToMidi(keyIndex));
    synth.triggerAttackRelease(freq, 0.5, Tone.now());
  }

  setMuted(muted: boolean): void {
    this.bus?.gain.rampTo(muted ? 0 : 0.9, 0.03);
  }

  dispose(): void {
    this.synth?.dispose();
    this.bus?.dispose();
    this.synth = null;
    this.bus = null;
  }
}

export class TakeRecorder {
  private events: TakeEvent[] = [];
  private pressCounts: number[] = [];
  private startTime = 0;
  private running = false;
  private readonly feedback = new FeedbackPiano();

  /** 开始一段新录制（重复调用安全：进行中则忽略）。 */
  start(): void {
    if (this.running) return;
    this.events = [];
    this.pressCounts = [];
    this.startTime = getAudioContext().currentTime;
    this.running = true;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * UI pointerdown 时调用：**只记录事件**，不发声。
   * 发声（钢琴反馈 / 电子音）由调用方按播放上下文决定 ——
   * 见 StudioPage.playKey。理由：同一个物理按键在不同上下文要出不同的声，
   * 让 recorder 内部猜是错的，会与调用方的兜底音叠加导致重复发声。
   *
   * pressCount 为该键第几次按下（1-based），与 KeyMachine 游标历史一致。
   * 两段式时长捕获：按下时先记录事件（duration 留空 = 「未闭合」），
   * 待 UI pointerup 调用配对的 notifyKeyRelease 时补写 duration。
   * @returns 记录到的事件；未在录制中返回 null
   */
  notifyKeyPress(keyIndex: number, velocity = 1): TakeEvent | null {
    if (!this.running || keyIndex < 0) return null;
    const tSec = Math.max(0, getAudioContext().currentTime - this.startTime);
    const prev = this.pressCounts[keyIndex] ?? 0;
    const pressCount = prev + 1;
    this.pressCounts[keyIndex] = pressCount;
    // 音高自动从 keyIndex 生成：do=C4=60，按大调音阶跨八度铺开
    const pitch = keyIndexToMidi(keyIndex);
    // duration 刻意不设置：保持 undefined 直到 notifyKeyRelease 闭合
    const ev: TakeEvent = { keyIndex, pressCount, tSec, velocity, pitch };
    this.events.push(ev);
    return ev;
  }

  /**
   * 播放钢琴反馈音（跟弹参考音）。
   * 只有需要"跟弹"语义的调用方显式调用 —— 目前是"录制中且采样已发声"。
   * 独立于 notifyKeyPress，避免 recorder 内部发声与调用方的发声叠加。
   */
  playFeedback(keyIndex: number): void {
    this.feedback.play(keyIndex);
  }

  /**
   * UI pointerup / keyup 时调用：闭合该键最后一个「未闭合」事件，
   * 用音频时钟（getAudioContext().currentTime，绝不 Date.now）补写按住时长。
   * 轻点 → duration 很小；长按 → duration 较大。钳制到 [0.03, 8] 秒。
   */
  notifyKeyRelease(keyIndex: number): void {
    if (!this.running || keyIndex < 0) return;
    // 从后往前找该键最后一个 duration 未定义（open）的事件
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.keyIndex === keyIndex && ev.duration === undefined) {
        const held = getAudioContext().currentTime - this.startTime - ev.tSec;
        ev.duration = Math.min(8, Math.max(0.03, held));
        return;
      }
    }
    // 无未闭合事件：忽略（重复 release / 未按下过）
  }

  /** 结束并产出 Take（事件流快照）。 */
  stop(name: string): Take {
    this.running = false;
    /**
     * 意图：时长 = 最后一个音的**结束时间**（tSec + duration）。
     * 旧版用 max(tSec)（只算开始时间），如果最后一个音长按 2 秒，
     * 那 2 秒的尾巴没算进去 → 导出/卷帘播放末尾会被截断。
     */
    const durationSec = this.events.reduce(
      (m, e) => Math.max(m, e.tSec + (e.duration ?? 0)),
      0,
    );
    return {
      id: uid(),
      name,
      events: [...this.events],
      durationSec,
      createdAtMs: Date.now(),
    };
  }

  /** 放弃当前录制。 */
  cancel(): void {
    this.running = false;
    this.events = [];
    this.pressCounts = [];
  }

  /** 静音/恢复反馈音（如用户不想听钢琴声）。 */
  setFeedbackMuted(muted: boolean): void {
    this.feedback.setMuted(muted);
  }

  dispose(): void {
    this.cancel();
    this.feedback.dispose();
  }
}
