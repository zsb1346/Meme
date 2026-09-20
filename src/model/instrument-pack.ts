/**
 * 乐器包导入导出（高层封装，供 useStageShare 调用）。
 * 底层走 transfer.ts 的 .hjm zip I/O；本模块负责：
 *  - buildPack：导出时统计缺失 Blob 数量
 *  - readPack：导入时解析 zip → LoadedPack
 *  - materialize：把 LoadedPack 转成 replaceStage 能消费的扁平结构
 */
import type { Key, Sample, SampleId } from './types';
import {
  exportHjm,
  importHjm,
  downloadBlob,
  type HjmManifest,
  type HjmPackage,
} from './transfer';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LoadedPack {
  manifest: HjmManifest;
  project: HjmPackage['project'];
  blobs: Record<SampleId, Blob>;
}

export interface BuildResult {
  blob: Blob;
  /** 缺失 Blob 的素材数量 */
  missing: number;
}

export interface MaterializedStage {
  samples: Sample[];
  keys: Key[];
  blobs: Record<SampleId, Blob>;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** 打包当前工程为乐器包 zip Blob，并返回缺失素材计数。 */
export async function buildPack(
  project: HjmPackage['project'],
  blobs: HjmPackage['blobs'],
): Promise<BuildResult> {
  // 先统计缺失数量（exportHjm 内部也会跳过，这里额外计数供 UI 提示）
  const missing = project.samples.filter((s) => !blobs[s.id]).length;
  const blob = await exportHjm(project, blobs);
  return { blob, missing };
}

/** 解析 .zip → LoadedPack。 */
export async function readPack(file: File): Promise<LoadedPack> {
  const pkg: HjmPackage = await importHjm(file);
  return {
    manifest: {
      app: 'meme-studio',
      schemaVersion: pkg.project.schemaVersion,
      exportedAt: new Date().toISOString(),
      projectName: pkg.project.name,
      audioFiles: {},
    },
    project: pkg.project,
    blobs: pkg.blobs,
  };
}

/** 把 LoadedPack 转成 replaceStage 能直接消费的扁平结构。 */
export function materialize(pack: LoadedPack): MaterializedStage {
  return {
    samples: pack.project.samples,
    keys: pack.project.keys,
    blobs: pack.blobs,
  };
}

/** 触发浏览器下载。 */
export { downloadBlob };
