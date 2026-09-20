import type { SampleRef, TakeEvent } from '../model/types';

/**
 * 逐事件声部解析（纯函数，零副作用）——take-player 与 exporter 共用的唯一真相。
 *
 * 预览与导出都经本函数把「素材基准半音 + 事件级放置覆盖」折算成最终
 * { semitones, timeFactor }，保证两条路径对同一事件产出完全一致的声部参数
 * （parity by construction）。
 *
 * 依赖规则：engine 层纯函数，不 import store/UI；仅取 model/types 的类型。
 */
export function resolveEventVoice(
  baseSemitones: number,
  ev: TakeEvent,
): { semitones: number; timeFactor: number } {
  return {
    semitones: baseSemitones + (ev.pitchDelta ?? 0),
    timeFactor: ev.timeFactor ?? 1,
  };
}

/** 舞台实时演奏使用的槽位级解析，与事件级规则保持相同数学语义。 */
export function resolveSlotVoice(
  baseSemitones: number,
  ref: Pick<SampleRef, 'pitchDelta' | 'timeFactor'>,
): { semitones: number; timeFactor: number } {
  return {
    semitones: baseSemitones + (ref.pitchDelta ?? 0),
    timeFactor: ref.timeFactor ?? 1,
  };
}
