/**
 * 缓存预热服务 —— 五处 prewarm 副本的单一真相（Wave A 地基）。
 *
 * 收编副本：
 *  - pages/StudioPage.tsx            prewarmKeyBuffers（keys 引用集）
 *  - 素材箱批量操作 prewarmAllSampleBuffers（装配面板只按需解码当前候选）
 *  - pages/ExportDialog.tsx          prewarmBuffers（keys 引用集，回传缺失）
 *  - hooks/useKeyMachineController.ts 内联预热
 *  - components/audio/SampleChip.tsx 单素材预热
 *
 * 行为对齐（engine/README §3 缓存预热约定）：
 *  - 已命中 getCachedBuffer 的直接跳过；
 *  - 无 Blob 或解码失败 → 计入缺失清单（调用方决定如何提示）；
 *  - 并发合并：同一 sampleId 的解码 Promise 全局共享，重复调用不重复解码。
 *
 * 本模块位于 model 层，允许依赖 store；但引擎依赖仅限 sample-player 的
 * 缓存 API，保持「engine 不反向依赖 model」的架构红线不变。
 */
import {
  cacheBuffer,
  decodeAudioBlobShared,
  getCachedBuffer,
} from '../engine/sample-player';
import { useStore } from './store';
import type { Project } from './types';

export interface PrewarmOptions {
  /** Blob 提供器；缺省读全局 store.blobs */
  getBlob?(id: string): Blob | undefined;
  /** 完成后回调缺失清单（可选；函数返回值是同一份数组） */
  onMissing?(missingIds: string[]): void;
}

/** 进行中的解码任务表：sampleId → Promise（成功进缓存，失败得 null） */
const inflight = new Map<string, Promise<AudioBuffer | null>>();

async function decodeIntoCache(id: string, blob: Blob): Promise<AudioBuffer | null> {
  try {
    // 共享 worker 解码入口：与导入/波形缩略同 id 去重，主线程零解码
    const { buffer } = await decodeAudioBlobShared(id, blob);
    cacheBuffer(id, buffer);
    return buffer;
  } catch (err) {
    console.warn('[buffer-cache] 预热解码失败', id, err);
    return null;
  }
}

function defaultGetBlob(id: string): Blob | undefined {
  return useStore.getState().blobs[id];
}

/**
 * 预热给定 sampleId 集合的解码缓存；返回缺失的 sampleId 清单
 * （无 Blob、解码失败、或共享中的任务最终失败都算缺失）。
 */
export async function prewarmBuffers(
  ids: Iterable<string>,
  opts: PrewarmOptions = {},
): Promise<string[]> {
  const getBlob = opts.getBlob ?? defaultGetBlob;
  const idList = [...new Set(ids)];
  const jobs: Array<Promise<AudioBuffer | null>> = [];

  for (const id of idList) {
    if (getCachedBuffer(id)) continue;
    const pending = inflight.get(id);
    if (pending) {
      jobs.push(pending);
      continue;
    }
    const blob = getBlob(id);
    if (!blob) continue; // 最终统一按「缓存未命中」记缺失
    const task = decodeIntoCache(id, blob).finally(() => {
      inflight.delete(id);
    });
    inflight.set(id, task);
    jobs.push(task);
  }

  await Promise.all(jobs);

  // 统一判定：凡此刻仍未命中缓存的请求 id 即为缺失
  const missing = idList.filter((id) => !getCachedBuffer(id));
  opts.onMissing?.(missing);
  return missing;
}

/**
 * 收集「可能被发声」的 sampleId（去重保序）：
 *  ① 各 Take 事件的自身 sampleId —— 一声源规则下预览/导出/舞台只认它；
 *     全局回退已删除，若这里不预热事件素材，装配音将永远解码不出来。
 *  ② 全局 keys[].sequence —— 保留给乐器包导入/舞台 KeyMachine 直演等
 *     仍引用键序列的路径（无害超集）。
 */
export function collectReferencedSampleIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const take of project.takes) {
    for (const ev of take.events) if (ev.sampleId) ids.add(ev.sampleId);
  }
  for (const k of project.keys) {
    for (const ref of k.sequence) if (ref.sampleId) ids.add(ref.sampleId);
  }
  return [...ids];
}

/**
 * 舞台/录制棚/导出语义：只预热会被发声引用到的素材。
 * （对应原 StudioPage.prewarmKeyBuffers / ExportDialog.prewarmBuffers）
 */
export function prewarmProjectBuffers(
  project: Project,
  opts: PrewarmOptions = {},
): Promise<string[]> {
  return prewarmBuffers(collectReferencedSampleIds(project), opts);
}

/** 素材箱批量语义：预热项目全部素材；逐音装配试听不要调用此函数。 */
export function prewarmAllSampleBuffers(
  opts: PrewarmOptions = {},
): Promise<string[]> {
  return prewarmBuffers(
    useStore.getState().project.samples.map((s) => s.id),
    opts,
  );
}
