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
 * 4. keyup 一律用 registerKeyUp，禁止裸 addEventListener。
 *    （本文件也唯一允许 window.addEventListener('keyup')。）
 *
 * ── keydown 与 keyup 的**语义差异**（照抄 keydown 的规矩写 keyup 必出错）──
 * ① **不短路**：keydown 命中即停（一次按键只该触发一个动作），
 *    但 keyup 是「松开」这个事实的通知 —— 派发给**所有**匹配者。
 *    短路会让「按住 A 的同时按住 B，松开 A」把 B 的松开事件吃掉 → B 永远卡在按下态。
 * ② **默认不拦输入焦点**：guardInput 在 keydown 上是打字保护，在 keyup 上
 *    只会制造「焦点在输入框时松开 → 键位卡在按下态」。默认 false。
 * ③ **不设 when 门禁**：门禁只该拦「按下」。按住某键的过程中模式切了，
 *    `when` 变 false，松开事件被门禁吃掉 → 同样卡住。
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

/**
 * keyup 注册说明。字段比 `ShortcutSpec` 少：没有 `allowRepeat` / `captureAll` /
 * `priority` 之外的花样 —— 松开不需要「长按重复」，也不需要独占捕获。
 */
export interface KeyUpSpec {
  /** 全局唯一 id；同 id 重复注册会覆盖旧的 */
  id: string;
  /**
   * 关心的键名（`KeyboardEvent.key` 口径，空格写 'Space'）。
   *
   * **留空 = 接收所有松开**。演奏键位推荐留空：绑定表是用户随时可改的，
   * 按住某键的过程中绑定若被改掉，按 `keys` 过滤就会漏掉这次松开。
   * 松开的代价是不对称的 —— 多收一次只是白跑一趟（release 幂等），
   * 漏收一次则键位永远卡在按下态。所以宁可多收。
   */
  keys?: string[];
  /** 额外门禁。⛔ 慎用：拦掉松开 = 卡在按下态（见文件头 ③） */
  when?: () => boolean;
  /** 焦点在输入框等可编辑元素时是否忽略。**默认 false**（与 keydown 相反，见文件头 ②） */
  guardInput?: boolean;
  handler(event: KeyboardEvent, key: string): void;
}

/** 判断事件目标是否处于可编辑控件中（打字保护用） */
export function isEditableTarget(target: EventTarget | null): boolean {
  // node（vitest）里没有 HTMLElement，`null instanceof HTMLElement` 会直接抛
  // （右操作数不是对象）。此处退化为「不可编辑」，让本文件在无 DOM 环境下可用。
  if (typeof HTMLElement === 'undefined') return false;
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
  upRegistry.clear();
  maybeRemoveKeyUpListener();
}

// ═══════════════════════════════════════════════════════════════════════════
// keyup 通道
// ═══════════════════════════════════════════════════════════════════════════

interface UpRegistration {
  spec: KeyUpSpec;
  seq: number;
}

const upRegistry = new Map<string, UpRegistration>();
let upSeqCounter = 0;
let upListenerInstalled = false;

/**
 * keyup 派发 —— **不短路**（文件头 ①）。
 *
 * 单独导出是为了能在没有 DOM 的测试环境里直接驱动这条路径：
 * 本仓库的 vitest 跑在 node（无 jsdom），`window` 不存在，
 * 监听器的安装是空操作，但派发逻辑本身仍然可以被逐条断言。
 */
export function dispatchKeyUp(event: KeyboardEvent, key: string): void {
  const candidates: UpRegistration[] = [];
  for (const entry of upRegistry.values()) {
    const wanted = entry.spec.keys;
    if (wanted !== undefined && wanted.length > 0) {
      if (!wanted.some((k) => normalizeKey(k) === key)) continue;
    }
    candidates.push(entry);
  }

  // 顺序只影响可观测的副作用次序；因为不短路，次序不影响「谁收到了」
  candidates.sort((a, b) => b.seq - a.seq);

  for (const { spec } of candidates) {
    if (spec.when && !spec.when()) continue;
    if ((spec.guardInput ?? false) && isEditableTarget(event.target)) continue;
    spec.handler(event, key);
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  dispatchKeyUp(event, normalizeKey(event.key));
}

function ensureKeyUpListener(): void {
  if (upListenerInstalled) return;
  if (typeof window === 'undefined') return; // node 测试环境：只保证注册表可用
  window.addEventListener('keyup', handleKeyUp);
  upListenerInstalled = true;
}

function maybeRemoveKeyUpListener(): void {
  if (!upListenerInstalled || upRegistry.size > 0) return;
  window.removeEventListener('keyup', handleKeyUp);
  upListenerInstalled = false;
}

/**
 * 注册一个全局 keyup。返回注销函数（effect cleanup 时调用）。
 *
 * ⛔ 只用于**闭合「按住」状态**（释放视觉按下态 / 补写录音时长），
 *    不要用它做「松手才算确认」的动作键 —— 那是 keydown 的活。
 */
export function registerKeyUp(spec: KeyUpSpec): () => void {
  upRegistry.set(spec.id, { spec, seq: ++upSeqCounter });
  ensureKeyUpListener();
  return () => {
    upRegistry.delete(spec.id);
    maybeRemoveKeyUpListener();
  };
}
