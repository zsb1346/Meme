/**
 * fill-assign 特征化测试（characterization tests）：
 * 逐条钉死旧填词面板中 computeMatrix + assign 的既有语义，
 * 保证 model 层抽取后的纯函数与已验证的组件逻辑行为逐位一致。
 *
 * 被测行为（对应旧填词面板原注释「装配矩阵」规则）：
 * 1. 键未填满（矩阵含 null 槽）→ 不产生任何提交载荷；
 * 2. 补齐最后一个空槽 → 提交，序列按 len = max(现有长度, 最大 pressCount) 扩展（padding）；
 * 3. 现有更长的舞台编辑序列被保留（len 取现有长度，尾部槽位原样带出）；
 * 4. 计算结果与现有序列逐位相同 → 不提交（identical 检查）；
 * 5. pressCount 1 起计数连续性：pressCount p 恒映射到槽位 (p-1)%len。
 */

import { describe, expect, it } from 'vitest';

import { applyAssignment, computeMatrix } from './fill-assign';
import type { Key, Project, SampleId, TakeEvent } from './types';

// ---------------------------------------------------------------------------
// 测试夹具工厂
// ---------------------------------------------------------------------------

function makeKey(label: string, sampleIds: SampleId[]): Key {
  return {
    id: `key-${label}`,
    label,
    sequence: sampleIds.map((sampleId) => ({ sampleId })),
    cursor: 0,
  };
}

/** 第 pressCount 次按下 keyIndex 键（tSec 递增仅为保持事件顺序稳定）。 */
function makeEvent(keyIndex: number, pressCount: number): TakeEvent {
  return { keyIndex, pressCount, tSec: pressCount * 0.25 };
}

function makeProject(keys: Key[]): Project {
  return {
    schemaVersion: 1,
    id: 'p-test',
    name: 'characterization',
    samples: [],
    keys,
    takes: [],
    effects: {
      eq: {
        enabled: false,
        bands: [
          { enabled: true, type: 'highpass', frequencyHz: 20, gainDb: 0, q: 0.71 },
          { enabled: true, type: 'lowshelf', frequencyHz: 200, gainDb: 0, q: 0.71 },
          { enabled: true, type: 'peaking', frequencyHz: 1000, gainDb: 0, q: 1 },
          { enabled: true, type: 'highshelf', frequencyHz: 2000, gainDb: 0, q: 0.71 },
          { enabled: true, type: 'lowpass', frequencyHz: 20000, gainDb: 0, q: 0.71 },
        ],
      },
      compressor: {
        enabled: false,
        thresholdDb: -24,
        ratio: 4,
        attackSec: 0.003,
        releaseSec: 0.25,
      },
      chorus: {
        enabled: false,
        rateHz: 0.5,
        delayTimeMs: 40,
        depth: 0.25,
        spreadDegrees: 40,
        wet: 0.5,
      },
      reverb: {
        enabled: false,
        size: 1.2,
        decaySec: 2,
        preDelaySec: 0.01,
        damping: 0.4,
        diffusion: 0.7,
        early: 0.55,
        lowCutHz: 80,
        highCutHz: 12000,
        width: 1,
        wet: 0.3,
      },
      masterGainDb: 0,
    },
    settings: {
      pitchNormalizationEnabled: true,
      referencePitchHz: 261.6256,
      keyCount: 8,
      keyBindings: {},
      autoTuneEnabled: true,
      semitoneModeEnabled: false,
    },
    updatedAtMs: 0,
  };
}

// ---------------------------------------------------------------------------
// applyAssignment — 旧面板 assign 提交规则的纯函数化
// ---------------------------------------------------------------------------

describe('applyAssignment', () => {
  it('键只填了一半时不产生提交载荷（矩阵仍含空槽）', () => {
    // 空键 + 两次按下（pressCount 1、2）→ len=2；只填第 1 个事件
    const project = makeProject([makeKey('do', [])]);
    const events = [makeEvent(0, 1), makeEvent(0, 2)];

    const { nextDrafts, committedKeys } = applyAssignment(
      project,
      events,
      {},
      0,
      'a',
    );

    expect(nextDrafts).toEqual({ 0: 'a' });
    expect(committedKeys).toEqual([]);
  });

  it('补齐最后一个空槽时提交，序列扩展到 len = max(现有长度, 最大 pressCount)', () => {
    // 现有序列 ['old']（长度 1），最大 pressCount=2 → len=2（padding 一位）
    const project = makeProject([makeKey('do', ['old'])]);
    const events = [makeEvent(0, 1), makeEvent(0, 2)];
    const drafts: Record<number, SampleId> = { 0: 'old' };

    const { nextDrafts, committedKeys } = applyAssignment(
      project,
      events,
      drafts,
      1,
      'b',
    );

    expect(nextDrafts).toEqual({ 0: 'old', 1: 'b' });
    expect(committedKeys).toEqual([{ keyIndex: 0, sampleIds: ['old', 'b'] }]);
    // 入参 drafts 不被原地修改（纯函数）
    expect(drafts).toEqual({ 0: 'old' });
  });

  it('现有更长的舞台编辑序列被保留（len 取现有长度，尾部槽位原样带出）', () => {
    // 舞台已编辑 ['x','y','z']（长度 3），本次录制最大 pressCount=2 → len=3
    const project = makeProject([makeKey('do', ['x', 'y', 'z'])]);
    const events = [makeEvent(0, 1), makeEvent(0, 2)];

    const { committedKeys } = applyAssignment(
      project,
      events,
      { 0: 'a' },
      1,
      'b',
    );

    // 槽 0、1 被草稿覆盖，槽 2 的 'z' 是舞台编辑成果，必须保留
    expect(committedKeys).toEqual([{ keyIndex: 0, sampleIds: ['a', 'b', 'z'] }]);
  });

  it('装配结果与现有序列逐位相同时不提交（identical 检查）', () => {
    // 现有序列 ['a','b']，草稿填出来的也是 ['a','b'] → 无变化
    const project = makeProject([makeKey('do', ['a', 'b'])]);
    const events = [makeEvent(0, 1), makeEvent(0, 2)];

    const { nextDrafts, committedKeys } = applyAssignment(
      project,
      events,
      { 0: 'a' },
      1,
      'b',
    );

    expect(nextDrafts).toEqual({ 0: 'a', 1: 'b' });
    expect(committedKeys).toEqual([]);
  });

  it('素材不变但调音改变时仍提交槽位参数，供实时演奏复用', () => {
    const project = makeProject([makeKey('do', ['a'])]);
    const events = [makeEvent(0, 1)];

    const { committedKeys, committedRefs } = applyAssignment(
      project,
      events,
      {},
      0,
      'a',
      { pitchDelta: 5, timeFactor: 1.25 },
    );

    expect(committedKeys).toEqual([]);
    expect(committedRefs).toEqual([
      {
        keyIndex: 0,
        refs: [{ sampleId: 'a', pitchDelta: 5, timeFactor: 1.25 }],
      },
    ]);
  });

  it('调音复位时清除槽位上的旧覆盖', () => {
    const project = makeProject([makeKey('do', ['a'])]);
    project.keys[0].sequence[0] = {
      sampleId: 'a',
      pitchDelta: 7,
      timeFactor: 0.5,
    };
    const events = [makeEvent(0, 1)];

    const { committedRefs } = applyAssignment(
      project,
      events,
      {},
      0,
      'a',
      { pitchDelta: undefined, timeFactor: undefined },
    );

    expect(committedRefs).toEqual([
      { keyIndex: 0, refs: [{ sampleId: 'a' }] },
    ]);
  });

  it('多键场景只提交各自填满且变化的键，未填满的键静默', () => {
    // 键 0：两次按下，全填 → 提交；键 1：两次按下，只填一个 → 静默
    const project = makeProject([makeKey('do', []), makeKey('re', [])]);
    const events = [
      makeEvent(0, 1),
      makeEvent(0, 2),
      makeEvent(1, 1),
      makeEvent(1, 2),
    ];

    const { committedKeys } = applyAssignment(
      project,
      events,
      { 0: 'a', 1: 'b', 2: 'c' },
      3,
      'd',
    );

    expect(committedKeys).toEqual([
      { keyIndex: 0, sampleIds: ['a', 'b'] },
      { keyIndex: 1, sampleIds: ['c', 'd'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeMatrix — pressCount 1 起计数的槽位映射
// ---------------------------------------------------------------------------

describe('computeMatrix', () => {
  it('pressCount p 恒映射到槽位 (p-1)%len（1-based 连续性，p=1..5）', () => {
    // 空键 + pressCount 1..5 → len = max(0, 5) = 5，槽位 0..4 依次对应 p=1..5
    const keys = [makeKey('do', [])];
    const events = [1, 2, 3, 4, 5].map((p) => makeEvent(0, p));
    const drafts: Record<number, SampleId> = {
      0: 's1',
      1: 's2',
      2: 's3',
      3: 's4',
      4: 's5',
    };

    const mat = computeMatrix(keys, events, drafts);
    const arr = mat.get(0)!;

    expect(arr.length).toBe(5);
    for (let p = 1; p <= 5; p++) {
      expect(arr[(p - 1) % arr.length]).toBe(`s${p}`);
    }
  });

  it('len 大于最大 pressCount 时槽位仍按 (p-1)%len 落位（保留尾部编辑）', () => {
    // 现有长度 4，pressCount 1..3 → len=4，槽位 (p-1)%4 = 0,1,2
    const keys = [makeKey('do', ['x', 'y', 'z', 'w'])];
    const events = [1, 2, 3].map((p) => makeEvent(0, p));
    const drafts: Record<number, SampleId> = { 0: 'a', 1: 'b', 2: 'c' };

    const mat = computeMatrix(keys, events, drafts);
    const arr = mat.get(0)!;

    expect(arr.length).toBe(4);
    const expected = ['a', 'b', 'c'];
    for (let p = 1; p <= 3; p++) {
      expect(arr[(p - 1) % arr.length]).toBe(expected[p - 1]);
    }
    // 未被录制触及的尾部槽位保持现有序列内容
    expect(arr[3]).toBe('w');
  });

  it('未填草稿的事件不写槽位（drafts 缺省项跳过）', () => {
    const keys = [makeKey('do', [])];
    const events = [makeEvent(0, 1), makeEvent(0, 2)];

    const mat = computeMatrix(keys, events, { 1: 'b' });
    const arr = mat.get(0)!;

    expect(arr).toEqual(['', 'b']);
  });
});
