import type { Key, Project, SampleId, SampleRef, TakeEvent } from './types';

/**
 * 填词装配的纯函数层（自旧填词面板抽取，行为逐位一致）。
 *
 * 本模块零 React、零 store 依赖：只吃数据、吐数据。
 * 调用方（命令面板 commit handler）负责把
 * committedKeys 逐条转成 store 的 setKeySequence 调用。
 */

type SlotMatrix = Map<number, SampleId[]>;

/**
 * 装配矩阵（纯函数）：现有序列打底 → 扩展到所需长度 → 按时间顺序应用草稿。
 * len 取「现有长度 ∨ 最大 pressCount」，既保留舞台编辑成果，
 * 又保证 (pressCount-1)%len 与录制语义逐位对应、不回绕覆盖。
 *
 * 空槽位用空字符串 '' 表示（SampleId 保留值约定）。
 */
export function computeMatrix(
  keys: Key[],
  events: TakeEvent[],
  drafts: Record<number, SampleId>,
): SlotMatrix {
  const maxPress = new Map<number, number>();
  for (const ev of events) {
    maxPress.set(ev.keyIndex, Math.max(maxPress.get(ev.keyIndex) ?? 0, ev.pressCount));
  }
  const mat: SlotMatrix = new Map();
  for (const [ki, mp] of maxPress) {
    const cur = (keys[ki]?.sequence ?? []).map((r) => r.sampleId);
    const len = Math.max(cur.length, mp);
    const arr: SampleId[] = cur.slice(0, len);
    while (arr.length < len) arr.push('');
    mat.set(ki, arr);
  }
  events.forEach((ev, i) => {
    const sid = drafts[i];
    if (!sid) return;
    const arr = mat.get(ev.keyIndex);
    if (!arr || arr.length === 0) return;
    const slot = (((ev.pressCount - 1) % arr.length) + arr.length) % arr.length;
    arr[slot] = sid;
  });
  return mat;
}

/** applyAssignment 的返回值：新草稿表 + 需要提交的键序列载荷。 */
export interface AssignmentResult {
  /** 合并本次选择后的草稿（不修改入参 drafts）。 */
  nextDrafts: Record<number, SampleId>;
  /** 结果与现有序列不同的键 → 调用方逐条执行 setKeySequence。 */
  committedKeys: Array<{ keyIndex: number; sampleIds: SampleId[] }>;
  /** 与 committedKeys 同键下标对齐，携带每个事件的装配参数。 */
  committedRefs: Array<{ keyIndex: number; refs: SampleRef[] }>;
}

/**
 * 纯函数版旧面板 assign：
 * 把 events[eventIndex] 这一格填上 sampleId，用合并后的草稿重建装配矩阵，
 * 对「结果有变化」的键产出 setKeySequence 载荷。
 * 不触碰任何 store —— 提交动作由调用方执行。
 */
export function applyAssignment(
  project: Project,
  events: TakeEvent[],
  drafts: Record<number, SampleId>,
  eventIndex: number,
  sampleId: SampleId,
  placement?: Pick<TakeEvent, 'pitch' | 'pitchDelta' | 'timeFactor'>,
): AssignmentResult {
  const nextDrafts: Record<number, SampleId> = {
    ...drafts,
    [eventIndex]: sampleId,
  };

  const committedKeys: Array<{ keyIndex: number; sampleIds: SampleId[] }> = [];
  const committedRefs: Array<{ keyIndex: number; refs: SampleRef[] }> = [];
  const mat = computeMatrix(project.keys, events, nextDrafts);
  mat.forEach((arr, ki) => {
    const ids = arr;
    // 未装满的键仍留在草稿态，不能把保留空串写进可演奏序列。
    if (ids.some((id) => !id)) return;

    const currentRefs = project.keys[ki]?.sequence ?? [];
    const cur = currentRefs.map((r) => r.sampleId);
    const identical =
      cur.length === ids.length && cur.every((v, j) => v === ids[j]);
    if (!identical) committedKeys.push({ keyIndex: ki, sampleIds: ids });

    const refs = ids.map((sampleId, slot) => {
      const eventIndexForSlot = events.findIndex((ev, i) =>
        ev.keyIndex === ki &&
        (((ev.pressCount - 1) % ids.length) + ids.length) % ids.length === slot &&
        (nextDrafts[i] ?? currentRefs[slot]?.sampleId) === sampleId,
      );
      const event = eventIndexForSlot >= 0 ? events[eventIndexForSlot] : undefined;
      const isEditedSlot = eventIndexForSlot === eventIndex;
      const overrides = isEditedSlot ? placement : event;
      const current = currentRefs[slot];
      return {
        sampleId,
        ...(overrides?.pitch !== undefined
          ? { targetPitchMidi: overrides.pitch }
          : !isEditedSlot && current?.targetPitchMidi !== undefined
            ? { targetPitchMidi: current.targetPitchMidi }
            : {}),
        ...(overrides?.pitchDelta !== undefined
          ? { pitchDelta: overrides.pitchDelta }
          : !isEditedSlot && current?.pitchDelta !== undefined
            ? { pitchDelta: current.pitchDelta }
            : {}),
        ...(overrides?.timeFactor !== undefined
          ? { timeFactor: overrides.timeFactor }
          : !isEditedSlot && current?.timeFactor !== undefined
            ? { timeFactor: current.timeFactor }
            : {}),
      };
    });
    const refsChanged =
      currentRefs.length !== refs.length ||
      refs.some((ref, slot) => {
        const current = currentRefs[slot];
        return current?.sampleId !== ref.sampleId ||
          current.targetPitchMidi !== ref.targetPitchMidi ||
          current.pitchDelta !== ref.pitchDelta ||
          current.timeFactor !== ref.timeFactor;
      });
    if (refsChanged) committedRefs.push({ keyIndex: ki, refs });
  });

  return { nextDrafts, committedKeys, committedRefs };
}
