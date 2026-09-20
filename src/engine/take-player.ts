import type { Project, Take, TakeEvent, SampleId } from '../model/types';
import { resolveTakeEventRef } from '../model/take-stage';
import { getAudioContext, PREVIEW_LEAD_SEC } from './core';
import { playSample, type PlayingSample } from './sample-player';
import type { AudioDestination } from './key-machine';
import { resolveEventVoice } from './event-voice';

/**
 * Take 实时预览播放器 —— lookahead 调度器（计划 §4.1）。
 * 参考 Chris Wilson "A Tale of Two Clocks"：
 *   25ms tick 检查未来 ~100ms 视界内的事件，用 ctx 时钟精确调度，
 *   彻底摆脱 setInterval/setTimeout 的毫秒级抖动。
 *
 * 单一时钟模型（采样声与合成声共用）：
 *   start(fromSec) 时 origin = ctx.currentTime + PREVIEW_LEAD_SEC - fromSec，
 *   即 take 位置 0 发声的绝对 ctx 时刻；
 *   事件 ev 发声于绝对时刻 origin + ev.tSec；
 *   播放头（当前 take 位置）= ctx.currentTime - origin（getPositionSec）。
 *   播放头与音频同钟同提前量，永不偏差 LEAD。
 *
 * 声音唯一来源与导出器一致：事件自身 sampleId（resolveTakeEventRef）；
 * 空骨架事件 = 静音，不排程、不贡献结束时间。
 */

export interface TakePlayerOptions {
  project: Project;
  take: Take;
  /** 输出目的地；预览传主效果链 input（仅默认采样路径使用） */
  destination: AudioDestination;
  resolveBuffer(id: SampleId): AudioBuffer | null;
  resolveSemitones(id: SampleId, targetPitchMidi?: number): number;
  /**
   * 可注入声部：提供时每个事件改由 playEvent(ev, when) 发声
   * （合成试听传 triggerSynthNoteAt），绕过默认采样路径；
   * onEventScheduled 照常渐进回调，播放头数学不变。
   */
  playEvent?(ev: TakeEvent, whenCtxSec: number): void;
  callbacks?: {
    /** 事件被调度时回调（卷帘高亮/进度指示用），when 为绝对 ctx 时间 */
    onEventScheduled?(ev: TakeEvent, when: number): void;
    /** 自然播完时回调（手动 stop 不触发） */
    onEnded?(): void;
  };
  /** 调度视界秒数，默认 0.1 */
  lookaheadSec?: number;
  /** tick 间隔 ms，默认 25 */
  tickMs?: number;
}

export class TakePlayer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PlayingSample[] = [];
  private sorted: TakeEvent[] = [];
  private nextIdx = 0;
  /** take 位置 0 发声的绝对 ctx 时刻（时钟模型唯一原点） */
  private origin = 0;
  private playing = false;
  private generation = 0;

  constructor(private readonly o: TakePlayerOptions) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * 当前播放头 = 正在发声的 take 位置（秒）。
   * 两种声部共用的唯一权威读数；未播放时为 0。
   */
  getPositionSec(): number {
    if (!this.playing) return 0;
    return Math.max(0, getAudioContext().currentTime - this.origin);
  }

  /** 从 take 的 fromSec 处开始播放（默认 0）。已在播放则先停止。 */
  start(fromSec = 0): void {
    if (this.playing) this.stop();
    const generation = ++this.generation;
    const ctx = getAudioContext();
    this.sorted = [...this.o.take.events].sort((a, b) => a.tSec - b.tSec);
    this.nextIdx = 0;
    // seek 起播：跳过已过去的事件，否则 when 落在过去的音符会被立即补爆
    while (
      this.nextIdx < this.sorted.length &&
      (this.sorted[this.nextIdx]?.tSec ?? Infinity) < fromSec - 1e-4
    ) {
      this.nextIdx++;
    }
    this.origin = ctx.currentTime + PREVIEW_LEAD_SEC - fromSec;
    this.playing = true;

    const tickMs = this.o.tickMs ?? 25;
    this.timer = setInterval(() => {
      if (generation !== this.generation) return;
      this.tick();
    }, tickMs);
    this.tick(); // 立即调度第一批

    const audibleEndSec = this.o.take.events.reduce((maxEnd, ev) => {
      // 一声源：只认事件自身的 sampleId；骨架事件（ref=null）不出声，
      // 自然也不贡献结束时间。
      const ref = resolveTakeEventRef(this.o.project, ev);
      const buffer = ref ? this.o.resolveBuffer(ref.sampleId) : null;
      if (!ref || !buffer) return maxEnd;
      const voice = resolveEventVoice(
        this.o.resolveSemitones(ref.sampleId, this.o.project.settings.autoTuneEnabled ? ev.pitch : undefined),
        ev,
      );
      const naturalDuration = buffer.duration * voice.timeFactor;
      const eventDuration = ev.duration === undefined
        ? naturalDuration
        : Math.min(ev.duration, naturalDuration);
      return Math.max(maxEnd, ev.tSec + eventDuration);
    }, this.o.take.durationSec);
    const remainSec = Math.max(0, audibleEndSec - fromSec);
    const tailPadSec = 0.4;
    this.endTimer = setTimeout(
        () => {
          if (generation !== this.generation) return;
          this.stop();
          this.o.callbacks?.onEnded?.();
      },
      (remainSec + tailPadSec) * 1000,
    );
  }

  /** 停止并掐掉所有已调度采样（含正在响的，短淡出防咔哒）。 */
  stop(): void {
    this.generation++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    for (const h of this.pending) {
      h.stop(0.03);
    }
    this.pending = [];
    this.playing = false;
  }

  dispose(): void {
    this.stop();
  }

  private tick(): void {
    const ctx = getAudioContext();
    /**
     * 意图：每 tick 开头过滤已播完的句柄。
     * 旧版 pending 数组只增不减 —— 每播一个音加一个 PlayingSample，
     * 播 3 分钟积几百个。PlayingSample 没暴露 onended 回调，
     * 只能用 when + durationSec 推算结束时间，加 0.1s 余量防误删。
     */
    this.pending = this.pending.filter((h) => ctx.currentTime < h.when + h.durationSec + 0.1);
    /**
     * 意图：lookahead 从 0.1s 调到 1.5s。
     * 浏览器把后台标签的 setInterval 限到 ≥1 秒一次。
     * 旧逻辑"每 25ms 检查未来 100ms"，后台变成"每秒检查未来 100ms"，
     * 中间 900ms 的音全漏。调大 lookahead = "一次预排 1.5 秒"，
     * 后台即使 tick 间隔拉长到 1 秒也够用。
     */
    const horizon = ctx.currentTime + (this.o.lookaheadSec ?? 1.5);
    while (this.nextIdx < this.sorted.length) {
      const ev = this.sorted[this.nextIdx];
      if (!ev) break;
      if (this.origin + ev.tSec > horizon) break;
      this.scheduleEvent(ev);
      this.nextIdx++;
    }
  }

  private scheduleEvent(ev: TakeEvent): void {
    const when = this.origin + ev.tSec;

    // 注入声部（合成试听）：不经槽位/缓冲解析，直接按时钟发声
    if (this.o.playEvent) {
      this.o.playEvent(ev, when);
      this.o.callbacks?.onEventScheduled?.(ev, when);
      return;
    }

    const project = this.o.project;
    // 一声源：只认事件自身的 sampleId；骨架事件（ref=null）直接不排程（静音）。
    const ref = resolveTakeEventRef(project, ev);
    if (!ref) return;
    const buffer = this.o.resolveBuffer(ref.sampleId);
    if (!buffer) return;

    // 事件级放置覆盖（pitchDelta/timeFactor）与导出共用同一纯函数解析 → parity
    const v = resolveEventVoice(
      this.o.resolveSemitones(ref.sampleId, this.o.project.settings.autoTuneEnabled ? ev.pitch : undefined),
      ev,
    );
    const handle = playSample({
      buffer,
      destination: this.o.destination,
      when,
      semitones: v.semitones,
      timeFactor: v.timeFactor,
      gainLinear: ev.velocity ?? 1,
    });
    this.pending.push(handle);
    this.o.callbacks?.onEventScheduled?.(ev, when);
  }
}
