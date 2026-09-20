import * as Tone from 'tone';
import type { Key, SampleId } from '../model/types';
import { getAudioContext } from './core';
import { playSample } from './sample-player';
import { isExporting } from './exporter';
import { resolveSlotVoice } from './event-voice';

/**
 * KeyMachine 键状态机（计划 §1 核心语义）：
 *   每次触发 Key：播放 sequence[cursor]，然后 cursor = (cursor+1) % sequence.length。
 *   键与键之间完全隔离 —— 每键独立游标，互不影响。
 */

export type AudioDestination = AudioNode | Tone.ToneAudioNode;

export interface KeyMachineConfig {
  keys: Key[];
  /** sampleId → 解码缓冲；未命中返回 null（哑触发：游标照常推进） */
  resolveBuffer(sampleId: SampleId): AudioBuffer | null;
  /** sampleId → 应施加的半音偏移（用 pitch.computeSampleSemitones 计算） */
  resolveSemitones(sampleId: SampleId, targetPitchMidi?: number): number;
  /** 输出目的地；实时演奏传主效果链 input */
  destination: AudioDestination;
}

export interface KeyTriggerResult {
  keyIndex: number;
  /** 是否真的出了声（序列为空或缓冲缺失 = false） */
  triggered: boolean;
  slotIndex: number | null;
  sampleId: SampleId | null;
  cursorBefore: number;
  cursorAfter: number;
  when: number;
}

/**
 * 确定性重放规则：第 pressCount 次按下对应槽位 = (pressCount-1) % len。
 * 与「游标从 0 开始、每次触发 +1」的历史一致。导出器/预览器必须用它，
 * 保证录制→填词→重放→导出全链路槽位一致。
 */
export function slotIndexForPress(
  pressCount: number,
  sequenceLength: number,
): number | null {
  if (sequenceLength <= 0 || pressCount < 1) return null;
  return (pressCount - 1) % sequenceLength;
}

export class KeyMachine {
  private cursors: number[] = [];

  constructor(private cfg: KeyMachineConfig) {
    this.syncKeys(cfg.keys);
  }

  /**
   * 键配置变化（增删键/改序列）后调用：按下标保留既有游标并夹取到新序列范围。
   * 注意按「下标」对齐 —— 若 UI 会重排键数组，请先自行迁移 cursor 再 syncKeys。
   */
  syncKeys(keys: Key[]): void {
    this.cfg.keys = keys;
    this.cursors = keys.map((k, i) => {
      const len = k.sequence.length;
      if (len === 0) return 0;
      const prev = this.cursors[i] ?? k.cursor ?? 0;
      return ((prev % len) + len) % len;
    });
  }

  getCursor(keyIndex: number): number {
    return this.cursors[keyIndex] ?? 0;
  }

  resetCursor(keyIndex: number): void {
    if (keyIndex >= 0 && keyIndex < this.cursors.length) {
      this.cursors[keyIndex] = 0;
    }
  }

  resetAllCursors(): void {
    this.cursors = this.cursors.map(() => 0);
  }

  /**
   * 触发一键：播放 sequence[cursor] → 游标循环推进。
   * @param opts.when 绝对调度时间（ctx 时钟）；缺省立即
   * @param opts.velocity 力度 0..1；缺省 1
   */
  trigger(
    keyIndex: number,
    opts: { when?: number; velocity?: number } = {},
  ): KeyTriggerResult {
    const ctx = getAudioContext();
    const when = Math.max(opts.when ?? ctx.currentTime, ctx.currentTime);
    const key = this.cfg.keys[keyIndex];
    const idle: KeyTriggerResult = {
      keyIndex,
      triggered: false,
      slotIndex: null,
      sampleId: null,
      cursorBefore: this.getCursor(keyIndex),
      cursorAfter: this.getCursor(keyIndex),
      when,
    };
    if (!key || key.sequence.length === 0) return idle;

    /**
     * 意图：导出期间屏蔽实时演奏。
     * exporter.ts 会 Tone.setContext(offline) 切到离线上下文，
     * 此时 playSample 创建的节点全挂在 OfflineAudioContext 上，
     * 实时输出听不到，且可能污染离线渲染状态。
     * isExporting() 是导出器暴露的全局锁，导出期间返回 true。
     */
    if (isExporting()) return idle;

    const cursorBefore = this.cursors[keyIndex] ?? 0;
    const slotIndex = cursorBefore % key.sequence.length;
    const ref = key.sequence[slotIndex];
    console.log('[trigger]', {
      keyIndex,
      cursorBefore,
      slotIndex,
      ref,
    });
    if (!ref) return { ...idle, slotIndex };

    // 游标无条件推进（即使缓冲缺失也推进，保持序列位置语义稳定）
    const cursorAfter = (cursorBefore + 1) % key.sequence.length;
    this.cursors[keyIndex] = cursorAfter;

    const buffer = this.cfg.resolveBuffer(ref.sampleId);
    if (!buffer) {
      return {
        keyIndex,
        triggered: false,
        slotIndex,
        sampleId: ref.sampleId,
        cursorBefore,
        cursorAfter,
        when,
      };
    }

    const voice = resolveSlotVoice(
      this.cfg.resolveSemitones(ref.sampleId, ref.targetPitchMidi),
      ref,
    );
    playSample({
      buffer,
      destination: this.cfg.destination,
      when,
      semitones: voice.semitones,
      timeFactor: voice.timeFactor,
      gainLinear: opts.velocity ?? 1,
    });
    return {
      keyIndex,
      triggered: true,
      slotIndex,
      sampleId: ref.sampleId,
      cursorBefore,
      cursorAfter,
      when,
    };
  }
}
