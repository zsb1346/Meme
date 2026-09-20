/**
 * buildCommitPatch 特征化测试：钉死「命令面板提交只动放置参数、不伤时序」红线。
 *
 * 被测行为：
 * 1. 补丁只落在下标 i 的事件上，其余事件对象引用逐位不变；
 * 2. 第 i 个事件的 pressCount / keyIndex / tSec 等其余字段原样保留（展开透传）；
 * 3. undefined 归一化原样透传（NotePalette 出口已把默认值归一为 undefined，
 *    补丁写入 undefined = 无覆盖，不得回填 0 / 1）。
 */

import { describe, expect, it } from 'vitest';

import { buildCommitPatch } from './studio-commit';
import type { TakeEvent } from '../model/types';

function makeEvent(over: Partial<TakeEvent> = {}): TakeEvent {
  return { keyIndex: 2, pressCount: 3, tSec: 1.25, pitch: 64, ...over };
}

describe('buildCommitPatch', () => {
  it('只修改下标 i 的事件，其余事件引用逐位不变', () => {
    const events = [makeEvent(), makeEvent({ pressCount: 1, tSec: 0.2 }), makeEvent({ keyIndex: 5 })];
    const next = buildCommitPatch(events, 1, 2, 0.8);

    expect(next).not.toBe(events);
    expect(next[0]).toBe(events[0]);
    expect(next[2]).toBe(events[2]);
    expect(next[1]).not.toBe(events[1]);
    expect(next[1].pitchDelta).toBe(2);
    expect(next[1].timeFactor).toBe(0.8);
    // 其余事件未被波及
    expect(next[0].pitchDelta).toBeUndefined();
    expect(next[2].timeFactor).toBeUndefined();
  });

  it('第 i 个事件的 pressCount / keyIndex / tSec 等其余字段逐位保留', () => {
    const original = makeEvent({ velocity: 0.7, duration: 0.3, pitchDelta: -1, timeFactor: 1.5 });
    const next = buildCommitPatch([original], 0, 4, 0.5);

    expect(next[0]).toMatchObject({
      keyIndex: 2,
      pressCount: 3,
      tSec: 1.25,
      pitch: 64,
      velocity: 0.7,
      duration: 0.3,
    });
    expect(next[0].pitchDelta).toBe(4);
    expect(next[0].timeFactor).toBe(0.5);
  });

  it('undefined 归一化原样透传：默认值写入 undefined 即无覆盖', () => {
    const original = makeEvent({ pitchDelta: 3, timeFactor: 2 });
    const next = buildCommitPatch([original], 0, undefined, undefined);

    expect(next[0].pitchDelta).toBeUndefined();
    expect(next[0].timeFactor).toBeUndefined();
    // 字段键存在但值为 undefined（= 无覆盖语义），不得回填 0 / 1
    expect(next[0].pitchDelta).not.toBe(0);
    expect(next[0].timeFactor).not.toBe(1);
  });

  it('不修改入参数组与原事件对象（纯函数）', () => {
    const original = makeEvent();
    const events = [original];
    buildCommitPatch(events, 0, 1, 1.2);

    expect(events.length).toBe(1);
    expect(events[0]).toBe(original);
    expect(original.pitchDelta).toBeUndefined();
    expect(original.timeFactor).toBeUndefined();
  });
});
