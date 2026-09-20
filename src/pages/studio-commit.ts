import type { TakeEvent } from '../model/types';
import type { SampleId } from '../model/types';

/**
 * 命令面板提交的事件补丁（纯函数，自 StudioPage handlePaletteCommit 抽取供单测钉死）。
 *
 * 红线：只改第 i 个事件的 pitchDelta / timeFactor 两个放置参数；
 * 其余字段（pressCount / keyIndex / tSec / pitch / duration / velocity）
 * 经展开逐位保留，其余事件对象引用原样带出（绝不重建，时序连续性不可被动）。
 *
 * undefined 归一化原样透传：NotePalette 已在出口把「0 半音 / ×1.00」归一为
 * undefined，本函数不做任何再加工 —— 写入 undefined 即「无覆盖」。
 */
export function buildCommitPatch(
  events: TakeEvent[],
  i: number,
  pitchDelta: number | undefined,
  timeFactor: number | undefined,
  sampleId?: SampleId,
  pitch?: number,
): TakeEvent[] {
  return events.map((e, j) =>
    j === i
      ? {
          ...e,
          pitchDelta,
          timeFactor,
          ...(sampleId ? { sampleId } : {}),
          ...(pitch !== undefined ? { pitch } : {}),
        }
      : e,
  );
}
