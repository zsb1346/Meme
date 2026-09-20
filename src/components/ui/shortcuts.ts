/**
 * 全局快捷键注册中心 —— 统一 window keydown 分发（Wave A 地基）。
 *
 * 解决的现状：数字键（StudioPage）、空格试听、Escape 关弹层等监听散落各页，
 * 可能同时存活互相打架。所有全局键位改为在此登记：
 *  - 单一 window keydown 监听（懒安装，最后一个注销时卸载）；
 *  - priority 大者先派发；同优先级按注册逆序（LIFO）：后注册的先响应，
 *    天然实现「弹层栈顶层先关」；
 *  - 命中即短路，不再向后续同键位处理器传播；
 *  - guardInput（默认开）：焦点在输入类元素上时跳过，避免打字误触。
 *
 * 注意：preventDefault 不自动调用 —— 由各 handler 自行决定，
 * 保持与现有页面行为逐字节一致。
 *
 * ── 强制规矩 ──
 * 1. 全项目唯一允许 window.addEventListener('keydown') 的地方就是本文件。
 * 2. 任何页面/组件要键盘输入，只能 registerShortcut。
 * 3. e.repeat / guardInput / when / 通配捕获 全部在本文件统一处理。
 * 4. keyup 若要监听，必须用 registerKeyUp（后续加），禁止裸 addEventListener。
 */

export interface ShortcutSpec {
  /** 全局唯一 id；同 id 重复注册会覆盖旧的并刷新栈序 */
  id: string;
  /**
   * 键名列表，与 KeyboardEvent.key 对应；空格请写 'Space'
   * （内部归一化，' ' 与 'Space' 等价）
   */
  keys: string[];
  /** 额外门禁：返回 false 则跳过该快捷键 */
  when?: () => boolean;
  /** 焦点在输入框等可编辑元素时是否忽略（默认 true） */
  guardInput?: boolean;
  handler(event: KeyboardEvent, key: string): void;
  /** 数值大者优先派发（默认 0） */
  priority?: number;
  /**
   * 是否允许长按重复触发。默认 false（长按只响一次）。
   * 只有"长按连续生效"语义的快捷键才开：撤销、方向键移动。
   * 演奏键、空格播放、Escape 一律保持默认。
   */
  allowRepeat?: boolean;
  /**
   * 通配：匹配任何键。用于"绑定模式捕获任意键"这类独占场景。
   * 必须配合 priority（最高），命中即短路，其他快捷键不会触发。
   */
  captureAll?: boolean;
}

/** 键名归一化：字面空格统一叫 Space */
function normalizeKey(key: string): string {
  return key === ' ' ? 'Space' : key;
}

/** 判断事件目标是否处于可编辑控件中（打字保护用） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

interface Registration {
  spec: ShortcutSpec;
  /** 注册序号：同优先级时按此逆序派发（LIFO） */
  seq: number;
}

const registry = new Map<string, Registration>();
let seqCounter = 0;
let listenerInstalled = false;

function handleKeyDown(event: KeyboardEvent): void {
  const normalized = normalizeKey(event.key);

  // ── 通配捕获（captureAll）：最高优先级，命中即短路 ──
  for (const entry of registry.values()) {
    if (!entry.spec.captureAll) continue;
    if (entry.spec.when && !entry.spec.when()) continue;
    if ((entry.spec.guardInput ?? true) && isEditableTarget(event.target)) continue;
    entry.spec.handler(event, normalized);
    return;
  }

  // ── 长按重复（e.repeat）：只有显式 allowRepeat 的快捷键才继续处理 ──
  if (event.repeat) {
    for (const entry of registry.values()) {
      if (!entry.spec.allowRepeat) continue;
      if (!entry.spec.keys.some((k) => normalizeKey(k) === normalized)) continue;
      if (entry.spec.when && !entry.spec.when()) continue;
      if ((entry.spec.guardInput ?? true) && isEditableTarget(event.target)) continue;
      entry.spec.handler(event, normalized);
      return;
    }
    return; // 无 allowRepeat 候选，直接丢弃重复事件
  }

  // ── 常规匹配 ──
  const candidates: Registration[] = [];
  for (const entry of registry.values()) {
    if (entry.spec.keys.some((k) => normalizeKey(k) === normalized)) {
      candidates.push(entry);
    }
  }

  // priority 降序；同优先级注册逆序（LIFO）
  candidates.sort((a, b) =>
    (b.spec.priority ?? 0) !== (a.spec.priority ?? 0)
      ? (b.spec.priority ?? 0) - (a.spec.priority ?? 0)
      : b.seq - a.seq,
  );

  for (const { spec } of candidates) {
    if (spec.when && !spec.when()) continue;
    if ((spec.guardInput ?? true) && isEditableTarget(event.target)) continue;
    spec.handler(event, normalized);
    return; // 命中即短路
  }
}

function ensureListener(): void {
  if (listenerInstalled) return;
  window.addEventListener('keydown', handleKeyDown);
  listenerInstalled = true;
}

function maybeRemoveListener(): void {
  if (!listenerInstalled || registry.size > 0) return;
  window.removeEventListener('keydown', handleKeyDown);
  listenerInstalled = false;
}

/**
 * 注册一个全局快捷键，返回注销函数（组件卸载/effect cleanup 时调用）。
 */
export function registerShortcut(spec: ShortcutSpec): () => void {
  registry.set(spec.id, { spec, seq: ++seqCounter });
  ensureListener();
  return () => {
    registry.delete(spec.id);
    maybeRemoveListener();
  };
}

/** 清空全部注册（一般只在测试/HMR 边界使用） */
export function unregisterAllShortcuts(): void {
  registry.clear();
  maybeRemoveListener();
}
