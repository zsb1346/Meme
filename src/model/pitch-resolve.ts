/**
 * resolveSemitones 单一真相 —— 收编六处副本（Wave A 地基）。
 *
 * 原副本位置（行为完全一致，均为「找不到素材回退 0」）：
 *  - pages/StudioPage.tsx        L47-51
 *  - components/fill 旧填词面板（已下线） L40-44
 *  - hooks/useKeyMachineController.ts L71-75
 *  - pages/ExportDialog.tsx      L173-176（闭包 project 变体）
 *  - pages/StagePage.tsx         L152 & L192（内联两份）
 *
 * 决策函数与引擎契约一致：sampleSemitones(sample)（FL 式，仅 manualSemitoneOffset 参与变调）。
 * 变调语义见 engine/pitch.ts / README §7：归一开关 + 手动微调共同决定。
 */
import { sampleSemitonesAtPitch } from '../engine/pitch';
import { useStore } from './store';
import type { Project, SampleId } from './types';

/**
 * 纯函数变体：已有 project 快照时用这个。
 * 与 TakePlayer / exporter 的 resolveSemitones 回调签名对齐 ——
 * 播放/导出期间应使用同一份 project 快照，避免中途改配置撕裂一次播放。
 */
export function resolveSemitonesIn(
  project: Project,
  id: SampleId,
  targetPitchMidi?: number,
): number {
  const sample = project.samples.find((x) => x.id === id);
  return sample ? sampleSemitonesAtPitch(sample, targetPitchMidi) : 0;
}

/** 全局 store 变体：手头没有现成 project 快照时用这个 */
export function resolveSemitones(id: SampleId, targetPitchMidi?: number): number {
  return resolveSemitonesIn(useStore.getState().project, id, targetPitchMidi);
}
