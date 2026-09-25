/**
 * Take 播放控制器工厂 + React 订阅 hook（Wave A 地基）。
 *
 * 收编三处手写编排（StudioPage.startPlayback / 旧填词面板.startPreview（已下线） /
 * ExportDialog.startPreview）的公共骨架：
 *  - ensureAudioStarted + resume；
 *  - TakePlayer 构造（project/take/destination 每次启动现取，README §10.3）；
 *  - 声部可切换（getVoice：采样 = TakePlayer 默认路径 / 合成 = playEvent 注入
 *    triggerSynthNoteAt），两种声部共用 TakePlayer 的单一 lookahead 时钟；
 *  - 播放头直接读 TakePlayer.getPositionSec()（与音频同钟，唯一权威读数）；
 *  - onEventScheduled → 事件下标回调（卷帘高亮联动）；
 *  - 手动停止 / 自然播完统一复位快照并回调 onEnded。
 *
 * 快照经 subscribe/getSnapshot 暴露，配合 useTakePlaybackState()
 * （内部 useSyncExternalStore）在组件里订阅 —— 进度更新只重渲染
 * 订阅它的小组件，不再牵动整页树。
 */
import { useSyncExternalStore } from 'react';
import { ensureAudioStarted } from '../engine/core';
import { getCachedBuffer } from '../engine/sample-player';
import { TakePlayer } from '../engine/take-player';
import { triggerSynthNoteAt, releaseAllSynth } from '../engine/synth-preview';
import type { AudioDestination } from '../engine/key-machine';
import { resolveSemitonesIn } from '../model/pitch-resolve';
import type { Project, Take } from '../model/types';

/** 与 TakePlayer 内部尾垫一致（tailPadSec = 0.4），进度条满格时刻对齐 */
const TAIL_PAD_SEC = 0.4;

export interface TakePlaybackSnapshot {
  isPlaying: boolean;
  /** 已播放秒数（ctx 时钟推算；手动停止后归零） */
  playheadSec: number;
  /** 最近被调度发声的事件在 take.events 中的下标；无则 -1 */
  activeEventIndex: number;
}

export interface TakePlaybackOptions {
  /** 每次启动现取播放目标（保证用到最新 project/take） */
  getTarget(): { project: Project; take: Take | null };
  /** 输出目的地；每次启动现取（勿缓存 getMasterChain 结果，README §10.3） */
  getDestination(): AudioDestination;
  /**
   * 每次启动现读声部：'sample' = 填词采样（TakePlayer 默认路径）
   * / 'synth' = 合成骨架（playEvent 注入 triggerSynthNoteAt）。
   * 省略时恒为 'sample'（既有调用方零影响）。
   */
  getVoice?(): 'sample' | 'synth';
  /** 事件被调度时回调（传 take.events 下标） */
  onEventScheduled?(index: number): void;
  /** 自然播完回调（手动 stop 不触发） */
  onEnded?(): void;
}

export interface TakePlaybackController {
  /** 开始播放；已在播则先停旧的再起新的（与既有页面行为一致） */
  start(fromSec?: number): void;
  /** 手动停止并复位快照（不触发 onEnded） */
  stop(): void;
  /** 播放中则停，否则从头播 */
  toggle(): void;
  /** useSyncExternalStore 订阅接口 */
  subscribe(listener: () => void): () => void;
  getSnapshot(): TakePlaybackSnapshot;
  /** 彻底废弃：停止播放并拒绝后续 start（组件卸载时调用） */
  dispose(): void;
}

const IDLE_SNAPSHOT: TakePlaybackSnapshot = {
  isPlaying: false,
  playheadSec: 0,
  activeEventIndex: -1,
};

export function createTakePlayback(
  options: TakePlaybackOptions,
): TakePlaybackController {
  let disposed = false;
  let player: TakePlayer | null = null;
  let rafId = 0;
  let fromSec = 0;
  let totalSec = 0;
  const listeners = new Set<() => void>();
  let snapshot: TakePlaybackSnapshot = IDLE_SNAPSHOT;

  function emit(next: TakePlaybackSnapshot): void {
    const changed =
      next.isPlaying !== snapshot.isPlaying ||
      next.activeEventIndex !== snapshot.activeEventIndex ||
      Math.abs(next.playheadSec - snapshot.playheadSec) >= 0.001;
    if (!changed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function setIdle(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    emit(IDLE_SNAPSHOT);
  }

  function tickFrame(): void {
    if (!player || !snapshot.isPlaying) return;
    // 唯一权威播放头：TakePlayer 内部时钟（origin 数学），两种声部同读数
    emit({
      isPlaying: true,
      playheadSec: Math.min(totalSec, player.getPositionSec()),
      activeEventIndex: snapshot.activeEventIndex,
    });
    rafId = requestAnimationFrame(tickFrame);
  }

  const controller: TakePlaybackController = {
    start(startSec = 0) {
      if (disposed) return;

      // 先释放旧实例
      if (player) {
        player.dispose();
        player = null;
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }

      const { project, take } = options.getTarget();
      if (!take || take.events.length === 0) return;

      const ctx = ensureAudioStarted();
      void ctx.resume();

      const voice: 'sample' | 'synth' = options.getVoice
        ? options.getVoice()
        : 'sample';

      // TakePlayer 回调拿到的是排序副本里的同一事件对象引用，可用 Map 反查下标
      const indexByEvent = new Map(take.events.map((ev, i) => [ev, i]));
      const instance = new TakePlayer({
        project,
        take,
        destination: options.getDestination(),
        resolveBuffer: (id) => getCachedBuffer(id),
        resolveSemitones: (id, targetPitchMidi) =>
          resolveSemitonesIn(project, id, targetPitchMidi),
        // 合成声部：注入 playEvent 走同一 lookahead 时钟，高亮逐音符渐进。
        // 音高用事件自身的 pitch（卷帘拖动/装配改写过的也如实反映），
        // 缺省才回落 keyIndex 的旧下标映射。
        playEvent:
          voice === 'synth'
            ? (ev, when) => triggerSynthNoteAt(ev.keyIndex, when, ev.pitch)
            : undefined,
        callbacks: {
          onEventScheduled: (ev) => {
            const idx = indexByEvent.get(ev) ?? -1;
            emit({
              isPlaying: true,
              playheadSec: snapshot.playheadSec,
              activeEventIndex: idx,
            });
            options.onEventScheduled?.(idx);
          },
          onEnded: () => {
            player = null;
            setIdle();
            options.onEnded?.();
          },
        },
      });

      fromSec = startSec;
      totalSec = take.durationSec + TAIL_PAD_SEC;
      player = instance;
      emit({
        isPlaying: true,
        playheadSec: fromSec,
        activeEventIndex: -1,
      });
      instance.start(fromSec);
      rafId = requestAnimationFrame(tickFrame);
    },

    stop() {
      if (player) {
        player.dispose();
        player = null;
      }
      // 合成音符止鸣（采样模式无单例声部，调用无害）
      releaseAllSynth();
      setIdle();
    },

    toggle() {
      if (snapshot.isPlaying) controller.stop();
      else controller.start(0);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return snapshot;
    },

    dispose() {
      disposed = true;
      controller.stop();
      listeners.clear();
    },
  };

  return controller;
}

/**
 * 在组件里订阅控制器快照（useSyncExternalStore 薄封装）。
 * 只把需要显示进度/状态的子组件接上来，避免整页跟随 rAF 重渲染。
 */
export function useTakePlaybackState(
  controller: TakePlaybackController,
): TakePlaybackSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
