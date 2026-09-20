import { openDB, type IDBPDatabase } from 'idb';
import type { Project, SampleId } from './types';

/**
 * IndexedDB 自动保存/恢复（计划 §2 持久化）。
 * - meta 库：工程元数据 JSON（不含 Blob）
 * - audio 库：素材原始文件 Blob（键 = sampleId），载入时再 decodeAudioData
 *   （规避「直接存 AudioBuffer 失败」风险，见计划 §7）
 */

const DB_NAME = 'meme-studio';
const DB_VERSION = 1;
const META_STORE = 'meta';
const AUDIO_STORE = 'audio';
const META_KEY = 'project';

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * 已确认落盘的 Blob id 集合：saveNow 用它做增量 diff（只写新增、只删缺失），
 * 避免每次状态变更都全量清空并重写所有 Blob —— 批量导入/大文件素材入库时，
 * 反复序列化大体积 Blob 正是主线程卡顿的根源。
 */
let savedBlobIds = new Set<SampleId>();

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(META_STORE)) {
          d.createObjectStore(META_STORE);
        }
        if (!d.objectStoreNames.contains(AUDIO_STORE)) {
          d.createObjectStore(AUDIO_STORE);
        }
      },
    });
  }
  return dbPromise;
}

export interface PersistedPayload {
  project: Project;
  blobs: Record<SampleId, Blob>;
}

// ---------------------------------------------------------------------------
// 写入（串行队列 + 500ms 防抖）
// ---------------------------------------------------------------------------

/** 立即写盘（两个 store 同一事务，保证元数据与音频一致；Blob 仅做增量同步） */
export async function saveNow(payload: PersistedPayload): Promise<void> {
  const d = await db();
  const tx = d.transaction([META_STORE, AUDIO_STORE], 'readwrite');
  void tx.objectStore(META_STORE).put(payload.project, META_KEY);

  // 增量 diff：新出现的 blob 才 put，消失的 blob 才 delete，未变的跳过。
  // 批量导入时 N 个素材只写 N 次，而不是每回全量重写既有全部素材。
  const audio = tx.objectStore(AUDIO_STORE);
  const nextIds = new Set<SampleId>();
  for (const [id, blob] of Object.entries(payload.blobs)) {
    nextIds.add(id);
    if (!savedBlobIds.has(id)) void audio.put(blob, id);
  }
  for (const id of savedBlobIds) {
    if (!nextIds.has(id)) void audio.delete(id);
  }
  await tx.done;
  savedBlobIds = nextIds;
}

let queue: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  queue = queue
    .then(op)
    .catch((err) => console.error('[persistence] 自动保存失败', err));
  return queue;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let latest: PersistedPayload | null = null;

/** 防抖自动保存：每次状态变化调用；500ms 内合并为一次写盘。 */
export function scheduleSave(
  payload: PersistedPayload,
  delayMs = 500,
): void {
  latest = payload;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushSave();
  }, delayMs);
}

/** 立刻冲刷待保存内容（pagehide / 导出前调用）。 */
export async function flushSave(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!latest) return;
  const payload = latest;
  latest = null;
  await enqueue(() => saveNow(payload));
}

// ---------------------------------------------------------------------------
// 读取 / 清空
// ---------------------------------------------------------------------------

/** 启动时恢复；无存档返回 null。Blob 与 sampleId 一并带回。 */
export async function loadAll(): Promise<PersistedPayload | null> {
  const d = await db();
  const project: Project | undefined = await d.get(META_STORE, META_KEY);
  if (!project) return null;
  const keys = await d.getAllKeys(AUDIO_STORE);
  const values = await d.getAll(AUDIO_STORE);
  const blobs: Record<SampleId, Blob> = {};
  keys.forEach((k, i) => {
    const v = values[i];
    if (typeof k === 'string' && v instanceof Blob) blobs[k] = v;
  });
  // 播种已落盘集合：后续 saveNow 只对新增/删除做增量同步
  savedBlobIds = new Set(keys.filter((k): k is SampleId => typeof k === 'string'));
  return { project, blobs };
}

/** 清空全部本地数据（设置页/调试用）。 */
export async function clearAll(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear(META_STORE), d.clear(AUDIO_STORE)]);
  savedBlobIds = new Set();
}
