import type { Take, TakeEvent } from '../model/types';
import { getAudioContext } from './core';
import { keyPitchAt } from '../model/pitch-map';
import { playSynthNote, setSynthChannelMuted } from './synth';
import { uid } from '../utils/uid';

/**
 * 录制（计划 §4.3）：
 * - 事件时间戳一律取 audioContext.currentTime（相对录制起点），禁用 Date.now()
 * - 按键同时触发「真实音准的跟弹参考音」（按 Key.pitchMidi 定音高）
 * - 两段式按住时长：notifyKeyPress 记录事件（duration 留空），notifyKeyRelease
 *   在松开时用音频时钟补写 duration（秒）；播放/导出暂不消费该字段
 * - 参考音的音色由**合成声部**提供（`engine/synth`，音色设计面板可调），
 *   走独立干路、绝不进主效果链、绝不进导出渲染
 */

/**
 * 键位 → MIDI 音高的**兜底**。
 *
 * ⚠️ 新代码一律传 `Key.pitchMidi`（`notifyKeyPress` / `playFeedback` 的第二参）。
 * 本函数只在「调用方拿不到键对象」时兜底 —— 键集恒为「从键域起点 C3 起的
 * 连续半音序列」，所以兜底就是 `keyPitchAt`（**逐半音**，与键位矩阵上的
 * 真实音高逐点一致）。
 *
 * 旧实现兜底到「C4 起的自然音序列」（lane 1 → D4），在半音键集上会差
 * 整整一个音 —— 那种偏差听着只是「有点不对」，极难定位。
 */
export function keyIndexToMidi(keyIndex: number): number {
  return keyPitchAt(keyIndex);
}

/**
 * 跟弹参考音的发声时长（秒）。与旧实现一致：够听清音准，不至于拖到下一个音。
 */
export const FEEDBACK_DURATION_SEC = 0.5;

export class TakeRecorder {
  private events: TakeEvent[] = [];
  private pressCounts: number[] = [];
  private startTime = 0;
  private running = false;

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
   * @param pitchMidi 该键的固定音高（Key.pitchMidi）；缺省回落旧下标映射
   * @returns 记录到的事件；未在录制中返回 null
   */
  notifyKeyPress(keyIndex: number, velocity = 1, pitchMidi?: number): TakeEvent | null {
    if (!this.running || keyIndex < 0) return null;
    const tSec = Math.max(0, getAudioContext().currentTime - this.startTime);
    const prev = this.pressCounts[keyIndex] ?? 0;
    const pressCount = prev + 1;
    this.pressCounts[keyIndex] = pressCount;
    // 音高 = 键的固定身份（pitchMidi），与键的位置/增删无关
    const pitch = pitchMidi ?? keyIndexToMidi(keyIndex);
    // duration 刻意不设置：保持 undefined 直到 notifyKeyRelease 闭合
    const ev: TakeEvent = { keyIndex, pressCount, tSec, velocity, pitch };
    this.events.push(ev);
    return ev;
  }

  /**
   * 播放跟弹参考音（录制时的「这是我该按的音」）。
   * 只有需要"跟弹"语义的调用方显式调用 —— 目前是"录制中且采样已发声"。
   * 独立于 notifyKeyPress，避免 recorder 内部发声与调用方的发声叠加。
   *
   * ⚠️ 音色来自**合成声部**（音色设计面板那套），且走 `'feedback'` 通道：
   * 通道静音只掐这一路，不会连坐试听声。
   * @param pitchMidi 该键的固定音高（Key.pitchMidi）；缺省回落旧下标映射
   */
  playFeedback(keyIndex: number, pitchMidi?: number): void {
    playSynthNote(pitchMidi ?? keyIndexToMidi(keyIndex), {
      durationSec: FEEDBACK_DURATION_SEC,
      // 参考音要压过素材本身才叫「参考」——旧实现也是满力度
      velocity: 1,
      channel: 'feedback',
    });
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

  /** 静音/恢复跟弹参考音（如用户不想听参考声）。走通道静音，不影响试听声。 */
  setFeedbackMuted(muted: boolean): void {
    setSynthChannelMuted('feedback', muted);
  }

  /**
   * 放弃录制并释放本实例持有的东西。
   *
   * ⚠️ **不 dispose 合成引擎**：引擎是模块级单例，由 `engine/synth` 持有，
   * 这里只是它的一个使用者。旧实现自带一份 PolySynth 才需要在这里销毁。
   */
  dispose(): void {
    this.cancel();
  }
}
