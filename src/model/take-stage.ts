import { keyIndexToMidi } from '../engine/recorder';
import { keyPitch } from './pitch-map';
import { uid } from '../utils/uid';
import type { Key, Project, SampleId, SampleRef, Take, TakeEvent } from './types';

/**
 * 事件自身的 sampleId 是声音的**唯一来源**（「一声源」规则）：
 * 装有素材 → 携带事件音高/放置参数的 SampleRef；没装 → null = 静音。
 *
 * 空骨架事件（录制产物）本来就不该出声，最多由 UI 叠加电子参考音
 * （voiceMode='synth' / playFeedback），引擎绝不代找声音。
 * 旧行为「event.sampleId 缺省 → 回退全局 Key.sequence」已删除：
 * 那条路会把别的编辑、甚至别的 Take 装过的旧音色泄漏进当前 Take
 * （演奏台/导出仍响旧音的根因）。
 */
export function resolveTakeEventRef(
  _project: Project,
  event: TakeEvent,
): SampleRef | null {
  if (!event.sampleId) return null;
  return {
    sampleId: event.sampleId,
    targetPitchMidi: event.pitch,
    pitchDelta: event.pitchDelta,
    timeFactor: event.timeFactor,
  };
}

/** 选中 Take → 演奏台键状态。每键槽位数由该 Take 的最大 pressCount 决定。 */
export function buildTakeKeys(project: Project, take: Take | null): Key[] {
  // 无 Take ≠ 全局 keys：演奏台任何时刻都只呈现「本 Take 的槽位」，
  // 空列表 = 空矩阵。声音唯一来源是事件自身 sampleId，空骨架事件解析为
  // null、不落槽；全局 Key.sequence 已退役为纯展示镜像，仅供乐器包导入
  // 时显式种入（seedTakeFromKeys）。直接返回会把别的编辑泄漏到当前 Take
  // 视图（刷新后残留 bug 的根因）。
  if (!take) return project.keys.map((key) => ({ ...key, sequence: [], cursor: 0 }));
  const refsByKey = new Map<number, SampleRef[]>();
  for (const event of take.events) {
    const ref = resolveTakeEventRef(project, event);
    if (!ref) continue;
    const refs = refsByKey.get(event.keyIndex) ?? [];
    const slot = Math.max(0, event.pressCount - 1);
    while (refs.length <= slot) refs.push({ sampleId: '' });
    refs[slot] = ref;
    refsByKey.set(event.keyIndex, refs);
  }
  return project.keys.map((key, keyIndex) => ({
    ...key,
    sequence: refsByKey.get(keyIndex) ?? [],
    cursor: 0,
  }));
}

// ---------------------------------------------------------------------------
// 编辑模式的逐 Take 槽位变更（Take.events 是唯一真相，绝不写全局 keys）
//
// 所有函数纯函数化：返回新数组，未受影响的原事件对象保持引用不变——
// 与 studio-commit.ts buildCommitPatch 同一套「按需重建、其余共享」纪律。
// ---------------------------------------------------------------------------

/** 尾部追加一槽：pressCount = 该键现有事件数 + 1，tSec 排在全部事件之后。 */
export function appendTakeSlot(
  events: TakeEvent[],
  keyIndex: number,
  sampleId: SampleId,
  pitch?: number,
): TakeEvent[] {
  const pressCount = events.filter((e) => e.keyIndex === keyIndex).length + 1;
  const tSec = events.length > 0 ? events.reduce((m, e) => Math.max(m, e.tSec), 0) + 0.001 : 0;
  const event: TakeEvent = {
    keyIndex,
    pressCount,
    tSec,
    pitch: pitch ?? keyIndexToMidi(keyIndex),
    sampleId,
  };
  return [...events, event];
}

/**
 * 替换第 slotIndex 槽（0-based）。命中已有事件时只换 sampleId，
 * tSec/pitch/duration/pitchDelta/timeFactor 原样保留；遇稀疏空洞或旧档
 * padding 则合成新事件插入，并把该键 pressCount 更大的事件整体后移一位。
 */
export function replaceTakeSlot(
  events: TakeEvent[],
  keyIndex: number,
  slotIndex: number,
  sampleId: SampleId,
  pitch?: number,
): TakeEvent[] {
  const press = slotIndex + 1;
  const target = events.find((e) => e.keyIndex === keyIndex && e.pressCount === press);
  if (target) {
    return events.map((e) => (e === target ? { ...target, sampleId } : e));
  }
  // 空洞回退：时间戳贴前一行，没有前一行就借用后一行，整键皆空则从 0 起。
  const siblings = events.filter((e) => e.keyIndex === keyIndex);
  const prev = siblings.find((e) => e.pressCount === press - 1);
  const next = siblings.find((e) => e.pressCount === press + 1);
  const tSec = prev ? prev.tSec + 0.001 : next ? next.tSec : 0;
  const synthetic: TakeEvent = {
    keyIndex,
    pressCount: press,
    tSec,
    pitch: pitch ?? keyIndexToMidi(keyIndex),
    sampleId,
  };
  const insertAt = events.findIndex((e) => e.keyIndex === keyIndex && e.pressCount > press);
  const nextList = events.map((e) =>
    e.keyIndex === keyIndex && e.pressCount > press
      ? { ...e, pressCount: e.pressCount + 1 }
      : e,
  );
  nextList.splice(insertAt === -1 ? nextList.length : insertAt, 0, synthetic);
  return nextList;
}

/** 删除第 slotIndex 槽并把该键剩余事件重新致密化为 1..m（tSec 永不改动）。 */
export function removeTakeSlot(
  events: TakeEvent[],
  keyIndex: number,
  slotIndex: number,
): TakeEvent[] {
  const press = slotIndex + 1;
  const remaining = events.filter(
    (e) => !(e.keyIndex === keyIndex && e.pressCount === press),
  );
  // pressCount 是重放的唯一真相：删中间槽后必须按原序重编号 1..m，
  // 只重建编号真的变了的事件，其余保持引用。
  const remap = new Map<TakeEvent, number>();
  remaining
    .filter((e) => e.keyIndex === keyIndex)
    .sort((a, b) => a.pressCount - b.pressCount)
    .forEach((e, i) => {
      if (e.pressCount !== i + 1) remap.set(e, i + 1);
    });
  return remaining.map((e) => {
    const renumbered = remap.get(e);
    return renumbered !== undefined ? { ...e, pressCount: renumbered } : e;
  });
}

/**
 * 旧存档迁移：全局 Key.sequence 里已装配的声音 → 种成第一个 Take 的事件。
 * 空槽跳过、pressCount 逐键致密、tSec 按 0.25s 步进排布；
 * 素材引用上的 targetPitchMidi/pitchDelta/timeFactor 镜像进事件，
 * 保证迁移前后 buildTakeKeys 呈现完全一致（数据零丢失）。
 *
 * 这是读取全局序列的**唯一合法入口**：一次性显式「装配」——种完之后
 * 声音只活在事件上（一声源规则）。现在仅供乐器包导入流程调用。
 */
export function seedTakeFromKeys(project: Project, name = '演奏 1'): Take {
  const events: TakeEvent[] = [];
  let globalCounter = 0;
  project.keys.forEach((key, keyIndex) => {
    let pressCount = 0;
    for (const ref of key.sequence) {
      if (!ref.sampleId) continue;
      const event: TakeEvent = {
        keyIndex,
        pressCount: ++pressCount,
        tSec: globalCounter++ * 0.25,
        sampleId: ref.sampleId,
        pitch: ref.targetPitchMidi ?? keyPitch(key, keyIndex),
      };
      if (ref.pitchDelta) event.pitchDelta = ref.pitchDelta;
      if (ref.timeFactor && ref.timeFactor !== 1) event.timeFactor = ref.timeFactor;
      events.push(event);
    }
  });
  return {
    id: uid(),
    name,
    events,
    durationSec: events.reduce((m, e) => Math.max(m, e.tSec), 0),
    createdAtMs: Date.now(),
  };
}
