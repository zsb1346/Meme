import * as Tone from 'tone';
import { keyIndexToMidi } from './recorder';
import { midiToHz } from './pitch';

/**
 * 合成试听声部（synth voice）——不再是独立调度器。
 *
 * 时钟与 lookahead 调度完全交给 TakePlayer（单一 origin 模型）：
 * 本模块只负责「在给定绝对 ctx 时刻响一声」，由 TakePlayer 的
 * playEvent 注入逐音符调用 —— 高亮随调度渐进推进，杜绝一次性
 * 批量排程导致的「瞬间跳到最后一个音符」。
 *
 * 音色镜像 recorder 的 FeedbackPiano：PolySynth 三角波 + 快衰减包络。
 * 独立干路 Gain 直连 Destination —— 绝不进主效果链、绝不进导出渲染。
 * 单例常驻（模块懒建、跨多次播放复用，不 dispose）；
 * 停止时 releaseAllSynth() 让当前音符立即止鸣。
 */

/** 单音符时值（秒），与录制反馈音一致 */
const NOTE_SEC = 0.5;

let synth: Tone.PolySynth | null = null;
let bus: Tone.Gain | null = null;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

function triggerSynthNoteNow(keyIndex: number): void {
  ensureVoice().triggerAttackRelease(
    midiToHz(keyIndexToMidi(keyIndex)),
    NOTE_SEC,
    undefined,
  );
}

function ensureVoice(): Tone.PolySynth {
  if (!synth) {
    bus = new Tone.Gain(0.9).toDestination();
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.003, decay: 0.45, sustain: 0.06, release: 1.0 },
      volume: -9,
    });
    // 常驻声部：放宽复音上限，密集 take 不抢声部
    synth.maxPolyphony = 64;
    synth.connect(bus);
  }
  return synth;
}

/**
 * 在绝对 AudioContext 时刻 whenCtxSec 响一声（keyIndex → 大调音阶音高）。
 * whenCtxSec 必须来自 TakePlayer 的时钟模型（origin + ev.tSec）。
 */
export function triggerSynthNoteAt(keyIndex: number, whenCtxSec: number): void {
  const delayMs = Math.max(0, (whenCtxSec - Tone.getContext().now()) * 1000);
  if (delayMs < 4) {
    triggerSynthNoteNow(keyIndex);
    return;
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    triggerSynthNoteNow(keyIndex);
  }, delayMs);
  pendingTimers.add(timer);
}

/**
 * 按**绝对 MIDI 音高**响一声 —— 钢琴卷帘编辑反馈专用。
 *
 * 为什么不能复用 `triggerSynthNoteAt`：那个按「键道下标」推音高
 * （`keyIndexToMidi`），而卷帘里一个音符同时有 keyIndex 与它自己的
 * `pitch`，拖动换道时二者需要独立表达。直接用 MIDI 音高最直白。
 *
 * 音量：常驻声部 volume 定在 -9dB 是为「批量回放不炸」，
 * 单点一个音符时偏轻。故这里把力度抬到 0.55 起（拖动时会频繁触发，
 * 太响会烦），上限仍为 1。
 *
 * @param midi        MIDI 音号（60 = C4）
 * @param whenCtxSec  绝对 AudioContext 时刻
 * @param durationSec 发声时长（秒）；短一点，编辑时连点不糊
 * @param velocity    0..1 归一力度，直接透传给 PolySynth
 *                    （`triggerAttackRelease` 的 velocity 就是 0..1，不是 dB）
 */
export function triggerSynthPitchAt(
  midi: number,
  whenCtxSec: number,
  durationSec = 0.2,
  velocity = 0.8,
): void {
  ensureVoice().triggerAttackRelease(
    midiToHz(Math.max(0, Math.min(127, Math.round(midi)))),
    durationSec,
    whenCtxSec,
    Math.min(1, Math.max(0.55, velocity)),
  );
}

/** 止鸣当前音符（播放 stop 时调用）；单例保留供下次播放复用。 */
export function releaseAllSynth(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  synth?.releaseAll();
}
