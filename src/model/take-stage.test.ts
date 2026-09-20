import { describe, expect, it } from 'vitest';
import {
  appendTakeSlot,
  buildTakeKeys,
  removeTakeSlot,
  replaceTakeSlot,
  resolveTakeEventRef,
  seedTakeFromKeys,
} from './take-stage';
import { keyIndexToMidi } from '../engine/recorder';
import type { Project, Take, TakeEvent } from './types';

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'p',
    samples: [],
    keys: [
      { id: 'k0', label: 'do', sequence: [{ sampleId: 'global' }], cursor: 0 },
      { id: 'k1', label: 're', sequence: [], cursor: 0 },
    ],
    takes: [],
    effects: {} as Project['effects'],
    settings: {} as Project['settings'],
    updatedAtMs: 0,
  };
}

function take(id: string, events: Take['events']): Take {
  return { id, name: id, events, durationSec: 1, createdAtMs: 0 };
}

describe('buildTakeKeys', () => {
  it('切换 Take 时按各自事件生成独立的槽位数量和素材', () => {
    const p = project();
    const a = take('a', [
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'a1', pitch: 60 },
    ]);
    const b = take('b', [
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'b1', pitch: 62 },
      { keyIndex: 0, pressCount: 2, tSec: 0.5, sampleId: 'b2', pitch: 64 },
    ]);

    expect(buildTakeKeys(p, a)[0].sequence).toEqual([
      { sampleId: 'a1', targetPitchMidi: 60 },
    ]);
    expect(buildTakeKeys(p, b)[0].sequence).toEqual([
      { sampleId: 'b1', targetPitchMidi: 62 },
      { sampleId: 'b2', targetPitchMidi: 64 },
    ]);
  });

  it('跨 Take 互不污染：空 Take 呈现空矩阵，全局 keys 不泄漏（用户 bug 场景）', () => {
    const p = project(); // k0 全局序列里有 'global' 声音
    const a = take('a', [
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'a1', pitch: 60 },
    ]);
    const b = take('b', []);
    expect(buildTakeKeys(p, a)[0].sequence).toHaveLength(1);
    // 切到 B：每个键都必须是空的，绝不能看见 A 的槽位或全局残留
    for (const key of buildTakeKeys(p, b)) expect(key.sequence).toEqual([]);
  });

  it('无 Take（legacy 回退）→ 不再暴露全局序列，而是全空槽位 + 游标归零', () => {
    const p = project();
    const keys = buildTakeKeys(p, null);
    expect(keys).toHaveLength(p.keys.length);
    for (const key of keys) {
      expect(key.sequence).toEqual([]);
      expect(key.cursor).toBe(0);
    }
    // 键本体（id/label 等）保持不变，只清空序列
    expect(keys[0].label).toBe('do');
  });

  it('旧档事件缺 sampleId 不再回退全局 Key.sequence：骨架 = 静音（一声源规则）', () => {
    const p = project(); // k0 全局序列里装着 'global' 旧音
    const t = take('legacy', [
      { keyIndex: 0, pressCount: 1, tSec: 0 }, // 无 sampleId = 空骨架
    ]);
    // 全局旧音绝不泄漏进当前 Take 视图
    for (const key of buildTakeKeys(p, t)) expect(key.sequence).toEqual([]);
  });
});

describe('resolveTakeEventRef', () => {
  it('空骨架（无 sampleId）→ null：不发声，不回退全局键序列', () => {
    const p = project(); // k0 全局序列装着 'global'
    const ev: TakeEvent = { keyIndex: 0, pressCount: 1, tSec: 0 };
    expect(resolveTakeEventRef(p, ev)).toBeNull();
  });

  it('sampleId 为空串（保留值）→ null', () => {
    const p = project();
    const ev: TakeEvent = { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: '' };
    expect(resolveTakeEventRef(p, ev)).toBeNull();
  });

  it('非空 sampleId → 事件自身的 ref，携带音高/放置字段', () => {
    const p = project();
    const ev: TakeEvent = {
      keyIndex: 0,
      pressCount: 2,
      tSec: 0.5,
      sampleId: 'mine',
      pitch: 67,
      pitchDelta: -2,
      timeFactor: 1.5,
    };
    expect(resolveTakeEventRef(p, ev)).toEqual({
      sampleId: 'mine',
      targetPitchMidi: 67,
      pitchDelta: -2,
      timeFactor: 1.5,
    });
  });
});

describe('buildTakeKeys（用户投诉场景钉桩）', () => {
  it('全局已装音 + 当前 Take 全是无 sampleId 骨架 → 所有键序列全空', () => {
    const p = project();
    p.keys[0].sequence = [{ sampleId: 'global' }];
    const t = take('recorded', [
      { keyIndex: 0, pressCount: 1, tSec: 0 },
      { keyIndex: 0, pressCount: 2, tSec: 0.25 },
      { keyIndex: 1, pressCount: 1, tSec: 0.5 },
    ]);
    const keys = buildTakeKeys(p, t);
    for (const key of keys) expect(key.sequence).toEqual([]);
  });
});

describe('appendTakeSlot', () => {
  it('空 Take 追加：pressCount=1、tSec=0、pitch 默认 keyIndexToMidi、sampleId 落位', () => {
    const next = appendTakeSlot([], 1, 's1');
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({
      keyIndex: 1,
      pressCount: 1,
      tSec: 0,
      pitch: keyIndexToMidi(1),
      sampleId: 's1',
    });
  });

  it('pressCount 逐键致密为 n+1；tSec = 全体最大 + 0.001；原事件引用不变', () => {
    const events: TakeEvent[] = [
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'a', pitch: 60 },
      { keyIndex: 1, pressCount: 1, tSec: 0.5, sampleId: 'b', pitch: 62 },
    ];
    const next = appendTakeSlot(events, 0, 'c', 70);
    // 键 0 已有 1 个事件 → 新事件 pressCount=2（哪怕最大 tSec 在别的键上）
    expect(next[2]).toEqual({
      keyIndex: 0,
      pressCount: 2,
      tSec: 0.501,
      pitch: 70,
      sampleId: 'c',
    });
    // 纯函数：新数组 + 原事件对象同一引用
    expect(next).not.toBe(events);
    expect(next[0]).toBe(events[0]);
    expect(next[1]).toBe(events[1]);
  });

  it('不传 pitch 时用 keyIndexToMidi 兜底，round-trip 后矩阵出现新芯片', () => {
    const p = project();
    const events = appendTakeSlot([], 1, 'new');
    const seq = buildTakeKeys(p, take('t', events))[1].sequence;
    expect(seq).toEqual([{ sampleId: 'new', targetPitchMidi: keyIndexToMidi(1) }]);
  });
});

describe('replaceTakeSlot（命中已有事件）', () => {
  it('只改 sampleId：tSec/pitch/pitchDelta/timeFactor/duration 全保留，其余事件引用不变', () => {
    const keep: TakeEvent = {
      keyIndex: 0,
      pressCount: 1,
      tSec: 1.25,
      pitch: 64,
      duration: 0.3,
      pitchDelta: -2,
      timeFactor: 1.5,
      velocity: 0.8,
      sampleId: 'old',
    };
    const other: TakeEvent = { keyIndex: 1, pressCount: 1, tSec: 2, sampleId: 'x' };
    const next = replaceTakeSlot([keep, other], 0, 0, 'new');
    expect(next[0]).not.toBe(keep);
    expect(next[0]).toEqual({ ...keep, sampleId: 'new' });
    expect(next[1]).toBe(other);
  });
});

describe('replaceTakeSlot（稀疏空洞 / 旧档 padding）', () => {
  it('插入合成事件并把该键更高 pressCount 后移一位；其他键纹丝不动', () => {
    const k1a: TakeEvent = { keyIndex: 1, pressCount: 1, tSec: 9, sampleId: 'z' };
    const p3: TakeEvent = { keyIndex: 0, pressCount: 3, tSec: 3, sampleId: 'p3' };
    const p1: TakeEvent = { keyIndex: 0, pressCount: 1, tSec: 1, sampleId: 'p1' };
    // 键 0 有空洞（缺 pressCount=2）：replace slot 1 → 合成 press2，press3→press4
    const next = replaceTakeSlot([p1, p3, k1a], 0, 1, 'hole', 72);
    const byKey0 = next.filter((e) => e.keyIndex === 0);
    expect(byKey0).toHaveLength(3);
    const inserted = byKey0.find((e) => e.sampleId === 'hole')!;
    expect(inserted).toEqual({
      keyIndex: 0,
      pressCount: 2,
      // 前一行 press1 存在 → tSec = prev + 0.001
      tSec: 1.001,
      pitch: 72,
      sampleId: 'hole',
    });
    const shifted = byKey0.find((e) => e.sampleId === 'p3')!;
    expect(shifted.pressCount).toBe(4);
    expect(shifted.tSec).toBe(3); // tSec 永不改动
    expect(shifted).not.toBe(p3); // 被移位的事件是新对象
    expect(byKey0.find((e) => e.sampleId === 'p1')).toBe(p1); // 未受影响，引用不变
    expect(next).toContain(k1a); // 其他键的事件保持原引用
  });
});

describe('removeTakeSlot', () => {
  it('删除后事件消失、该键重致密 1..m、tSec 不变；其他键引用不变', () => {
    const a1: TakeEvent = { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'a1' };
    const a2: TakeEvent = { keyIndex: 0, pressCount: 2, tSec: 0.5, sampleId: 'a2' };
    const a3: TakeEvent = { keyIndex: 0, pressCount: 3, tSec: 1, sampleId: 'a3' };
    const b1: TakeEvent = { keyIndex: 1, pressCount: 1, tSec: 1.5, sampleId: 'b1' };
    const next = removeTakeSlot([a1, a2, a3, b1], 0, 0); // 删中间概念：slot0
    expect(next).toHaveLength(3);
    expect(next.find((e) => e.sampleId === 'a1')).toBeUndefined();
    const k0 = next.filter((e) => e.keyIndex === 0);
    // a2 → press1（编号变了→新对象），a3 → press2；tSec 保持
    expect(k0.map((e) => [e.sampleId, e.pressCount, e.tSec])).toEqual([
      ['a2', 1, 0.5],
      ['a3', 2, 1],
    ]);
    expect(k0.find((e) => e.sampleId === 'a3')).not.toBe(a3);
    // 其他键：原对象引用
    expect(next.find((e) => e.sampleId === 'b1')).toBe(b1);
  });

  it('round-trip：删除后 buildTakeKeys 少一个槽位', () => {
    const p = project();
    const events: TakeEvent[] = [
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 's1', pitch: 60 },
      { keyIndex: 0, pressCount: 2, tSec: 0.25, sampleId: 's2', pitch: 60 },
    ];
    expect(buildTakeKeys(p, take('t', events))[0].sequence).toHaveLength(2);
    const after = removeTakeSlot(events, 0, 1);
    expect(buildTakeKeys(p, take('t', after))[0].sequence).toHaveLength(1);
  });

  it('无目标槽位 = no-op（内容不变）', () => {
    const a1: TakeEvent = { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'a1' };
    const next = removeTakeSlot([a1], 1, 5);
    expect(next).toEqual([a1]);
    expect(next[0]).toBe(a1);
  });
});

describe('seedTakeFromKeys', () => {
  it('旧全局序列 → 致密事件：跳过空槽、tSec 步进 0.25、ref 字段镜像进事件', () => {
    const p = project();
    p.keys[0].sequence = [
      { sampleId: 'g1' }, // pitch 兜底 = keyIndexToMidi(0)
      { sampleId: '' }, // 空槽跳过
      { sampleId: 'g2', targetPitchMidi: 70, pitchDelta: 2, timeFactor: 1.5 },
    ];
    p.keys[1].sequence = [
      { sampleId: 'h1', targetPitchMidi: 64, timeFactor: 1 }, // τ=1 不携带
    ];
    const t = seedTakeFromKeys(p);
    expect(t.name).toBe('演奏 1');
    expect(t.id).toBeTruthy();
    expect(t.events).toStrictEqual([
      { keyIndex: 0, pressCount: 1, tSec: 0, sampleId: 'g1', pitch: keyIndexToMidi(0) },
      {
        keyIndex: 0,
        pressCount: 2,
        tSec: 0.25,
        sampleId: 'g2',
        pitch: 70,
        pitchDelta: 2,
        timeFactor: 1.5,
      },
      { keyIndex: 1, pressCount: 1, tSec: 0.5, sampleId: 'h1', pitch: 64 },
    ]);
    expect(t.durationSec).toBe(0.5); // max tSec
    expect(t.createdAtMs).toBeGreaterThan(0);
  });

  it('种出的 Take 经 buildTakeKeys 呈现与旧全局序列同样的声音布局（迁移零丢失）', () => {
    const p = project();
    p.keys[0].sequence = [{ sampleId: 'g1' }, { sampleId: '' }, { sampleId: 'g2' }];
    const t = seedTakeFromKeys(p);
    const keys = buildTakeKeys(p, t);
    expect(keys[0].sequence.map((r) => r.sampleId)).toEqual(['g1', 'g2']);
    expect(keys[1].sequence).toEqual([]);
  });

  it('全空工程：种子 Take 无任何事件', () => {
    const p = project();
    p.keys[0].sequence = [{ sampleId: '' }];
    const t = seedTakeFromKeys(p);
    expect(t.events).toEqual([]);
    expect(t.durationSec).toBe(0);
  });
});
