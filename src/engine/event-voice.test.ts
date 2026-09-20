import { describe, expect, it } from 'vitest';
import type { Sample, SampleId, TakeEvent } from '../model/types';
import { resolveEventVoice, resolveSlotVoice } from './event-voice';
import { sampleSemitones } from './pitch';

/**
 * resolveEventVoice 单元测试 + 预览/导出 parity 测试。
 * 全部为纯算术，不触碰任何音频对象。
 */

function ev(overrides: Partial<TakeEvent> = {}): TakeEvent {
  return { keyIndex: 0, pressCount: 1, tSec: 0, ...overrides };
}

describe('resolveEventVoice', () => {
  it('无覆盖字段 → 原样返回 base、timeFactor=1', () => {
    expect(resolveEventVoice(2, ev())).toEqual({ semitones: 2, timeFactor: 1 });
  });

  it('仅 pitchDelta → 半音叠加在 base 上，时长不变', () => {
    expect(resolveEventVoice(2, ev({ pitchDelta: 3 }))).toEqual({
      semitones: 5,
      timeFactor: 1,
    });
  });

  it('仅 timeFactor → 半音不变，时长因子覆盖', () => {
    expect(resolveEventVoice(2, ev({ timeFactor: 0.5 }))).toEqual({
      semitones: 2,
      timeFactor: 0.5,
    });
  });

  it('pitchDelta + timeFactor 同时生效', () => {
    expect(resolveEventVoice(-1, ev({ pitchDelta: 4, timeFactor: 1.25 }))).toEqual({
      semitones: 3,
      timeFactor: 1.25,
    });
  });

  it('负 pitchDelta 下移', () => {
    expect(resolveEventVoice(2, ev({ pitchDelta: -7 }))).toEqual({
      semitones: -5,
      timeFactor: 1,
    });
  });

  it('显式 0 / 1 与缺省等价（0=不加移调，1=不变速）', () => {
    expect(resolveEventVoice(2, ev({ pitchDelta: 0, timeFactor: 1 }))).toEqual(
      resolveEventVoice(2, ev()),
    );
  });

  it('base=0（素材缺失回退）时覆盖字段依然生效', () => {
    expect(resolveEventVoice(0, ev({ pitchDelta: -3, timeFactor: 2 }))).toEqual({
      semitones: -3,
      timeFactor: 2,
    });
  });
});

describe('resolveSlotVoice', () => {
  it('实时演奏读取槽位的独立变调和时长因子', () => {
    expect(resolveSlotVoice(-2, { pitchDelta: 7, timeFactor: 1.5 })).toEqual({
      semitones: 5,
      timeFactor: 1.5,
    });
  });

  it('旧存档槽位无覆盖时保持素材默认声音', () => {
    expect(resolveSlotVoice(3, {})).toEqual({ semitones: 3, timeFactor: 1 });
  });
});

describe('预览/导出 parity：同一 TakeEvent[] 经两条解析路径得到逐事件一致的声部参数', () => {
  // 固定夹具：3 个素材、2 个键（键 0 双槽循环，键 1 单槽）
  const samples: Record<SampleId, Sample> = {
    a: { id: 'a', name: 'A', durationSec: 0.5, detectedPitchHz: 440, manualSemitoneOffset: 2, createdAtMs: 0 },
    b: { id: 'b', name: 'B', durationSec: 0.5, detectedPitchHz: null, manualSemitoneOffset: -1, createdAtMs: 0 },
    c: { id: 'c', name: 'C', durationSec: 0.5, detectedPitchHz: 220, manualSemitoneOffset: 0, createdAtMs: 0 },
  };
  const keys: { sequence: SampleId[] }[] = [{ sequence: ['a', 'b'] }, { sequence: ['c'] }];

  // 确定性重放槽位规则（与 slotIndexForPress 相同：(pressCount-1) % len）
  const sampleIdFor = (e: TakeEvent): SampleId | null => {
    const seq = keys[e.keyIndex]?.sequence;
    if (!seq || seq.length === 0) return null;
    return seq[(e.pressCount - 1) % seq.length] ?? null;
  };

  const events: TakeEvent[] = [
    ev({ keyIndex: 0, pressCount: 1, tSec: 0 }),                          // 无覆盖 → a
    ev({ keyIndex: 0, pressCount: 2, tSec: 0.2, pitchDelta: 5 }),          // 仅 π → b
    ev({ keyIndex: 0, pressCount: 3, tSec: 0.4, timeFactor: 0.75 }),       // 仅 τ → a（循环）
    ev({ keyIndex: 1, pressCount: 1, tSec: 0.6, pitchDelta: -4, timeFactor: 1.5 }), // 双覆盖 → c
    ev({ keyIndex: 1, pressCount: 2, tSec: 0.8, pitchDelta: 0 }),          // 显式 0 → c
  ];

  it('take-player 风格解析与 exporter 风格解析逐事件相等', () => {
    for (const e of events) {
      const id = sampleIdFor(e);

      // take-player.scheduleEvent: base = this.o.resolveSemitones(ref.sampleId)
      const playerBase = id ? sampleSemitones(samples[id]) : 0;
      const playerVoice = resolveEventVoice(playerBase, e);

      // exporter.renderTake: base = sample ? sampleSemitones(sample) : 0
      const sample = id ? samples[id] : undefined;
      const exporterVoice = resolveEventVoice(sample ? sampleSemitones(sample) : 0, e);

      expect(playerVoice).toEqual(exporterVoice);
    }
  });

  it('parity 结果符合手工期望（防止两边同时错）', () => {
    const expected = [
      { semitones: 2, timeFactor: 1 },      // a(2) 无覆盖
      { semitones: 4, timeFactor: 1 },      // b(-1) + 5
      { semitones: 2, timeFactor: 0.75 },   // a(2) 仅 τ
      { semitones: -4, timeFactor: 1.5 },   // c(0) - 4, τ=1.5
      { semitones: 0, timeFactor: 1 },      // c(0) + 0
    ];
    events.forEach((e, i) => {
      const id = sampleIdFor(e);
      const sample = id ? samples[id] : undefined;
      const voice = resolveEventVoice(sample ? sampleSemitones(sample) : 0, e);
      expect(voice).toEqual(expected[i]);
    });
  });
});
