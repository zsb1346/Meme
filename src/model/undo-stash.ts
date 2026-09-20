/**
 * 撤销暂存区 —— 「即时删除 + 可撤销」交互的内存侧（Wave A 地基）。
 *
 * 设计要点：
 *  - stashForUndo(payload) → id；payload 携带闭包 undo()，由调用方组装还原逻辑；
 *  - 无定时器：过期采用惰性清除（访问时检查 expiresAtMs），避免后台计时开销；
 *  - Blob 等大对象由闭包自然持有，TTL 内可完整还原，过期后随条目一起释放。
 *
 * 典型接线（Wave C 落地）：
 *   const id = stashForUndo({ label: '删除素材', undo: () => restore(...) });
 *   toast({ text: '已删除「xx」', action: { label: '撤销', onClick: () => runUndo(id) } });
 */

export interface UndoPayload {
  /** 操作名（如「删除素材」）；预留用于调试与未来文案拼装 */
  label: string;
  /** 执行还原动作 */
  undo(): void;
}

/** 默认有效期：与带操作按钮的 toast 展示时长（6s）对齐 */
const DEFAULT_TTL_MS = 6000;

interface StashEntry extends UndoPayload {
  expiresAtMs: number;
}

const stash = new Map<number, StashEntry>();
let nextUndoId = 1;

/** 存入一条可撤销操作，返回句柄 id */
export function stashForUndo(
  payload: UndoPayload,
  ttlMs: number = DEFAULT_TTL_MS,
): number {
  const id = nextUndoId++;
  stash.set(id, { ...payload, expiresAtMs: Date.now() + ttlMs });
  return id;
}

/** 惰性过期检查：活着返回条目，过期则清除并返回 null */
function liveEntry(id: number): StashEntry | null {
  const entry = stash.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAtMs) {
    stash.delete(id);
    return null;
  }
  return entry;
}

/** 查看一条暂存（不消费）；不存在或已过期返回 null */
export function peekUndo(id: number): UndoPayload | null {
  const entry = liveEntry(id);
  return entry ? { label: entry.label, undo: entry.undo } : null;
}

/** 取出一条暂存（取出即移除）；不存在或已过期返回 null */
export function popUndo(id: number): UndoPayload | null {
  const entry = liveEntry(id);
  if (!entry) return null;
  stash.delete(id);
  return { label: entry.label, undo: entry.undo };
}

/** 执行撤销：找到且未过期则运行 undo() 并返回 true；否则 false */
export function runUndo(id: number): boolean {
  const payload = popUndo(id);
  if (!payload) return false;
  payload.undo();
  return true;
}
