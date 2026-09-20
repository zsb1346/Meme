/**
 * 全局 toast 迷你仓库（Wave A 扩展 —— 向后兼容）。
 *
 * 基础能力不变：
 *  - 自动消失：2400ms；
 *  - 最多同时叠 3 条，超出时最旧的先出（最新者始终贴底）；
 *  - 500ms 内重复推送完全相同的文案会被去重忽略（防连点刷屏）。
 * 新增能力（旧调用方零改动）：
 *  - kind: 'default' | 'success' | 'error' —— 由 <Toaster/> 决定描边色；
 *  - action: 操作按钮（如「撤销」）；带按钮的条目默认展示 6000ms，
 *    给足反应时间（与 model/undo-stash 默认 TTL 对齐）；
 *  - durationMs 可显式覆盖展示时长。
 *
 * 调用方式：
 *   toast('已送入素材箱');
 *   toast({ text: '已删除「xx」', action: { label: '撤销', onClick: () => runUndo(id) } });
 *
 * 页面现存的本地 toast（StagePage / StudioPage）由后续 Wave
 * 统一切换到 <Toaster />。
 */
import { create } from 'zustand';

export type ToastKind = 'default' | 'success' | 'error';

/** 操作按钮：点击后由 <Toaster/> 自动关闭该条 toast */
export interface ToastAction {
  label: string;
  onClick(): void;
}

/** 单条 toast 的最小展示单元 */
export interface ToastItem {
  /** 单调递增 id，兼作 React key 与定时器句柄 */
  id: number;
  text: string;
  kind?: ToastKind;
  action?: ToastAction;
}

/** 富文本入参：直接传字符串等价于 { text } */
export type ToastInput =
  | string
  | {
      text: string;
      kind?: ToastKind;
      durationMs?: number;
      action?: ToastAction;
    };

interface ToastStoreState {
  toasts: ToastItem[];
  push(input: ToastInput): void;
  dismiss(id: number): void;
}

/** 自动消失时长（ms），与页面本地 toast 现行为一致 */
const AUTO_DISMISS_MS = 2400;
/** 带操作按钮时的默认时长（ms）：与 undo-stash 默认 TTL 对齐 */
const ACTION_AUTO_DISMISS_MS = 6000;
/** 相同文案去重窗口（ms） */
const DEDUPE_WINDOW_MS = 500;
/** 最大同屏条数，超出淘汰最旧 */
const MAX_STACKED = 3;

let nextId = 1;
let lastText = '';
let lastPushedAtMs = 0;
const dismissTimers = new Map<number, number>();

function clearDismissTimer(id: number): void {
  const timer = dismissTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    dismissTimers.delete(id);
  }
}

export const useToastStore = create<ToastStoreState>()((set, get) => ({
  toasts: [],

  push: (input) => {
    const item: Omit<ToastItem, 'id'> =
      typeof input === 'string' ? { text: input } : input;

    // 去重：窗口期内相同文案直接忽略
    const now = Date.now();
    if (item.text === lastText && now - lastPushedAtMs < DEDUPE_WINDOW_MS) {
      return;
    }
    lastText = item.text;
    lastPushedAtMs = now;

    const id = nextId++;
    set((s) => {
      const stacked: ToastItem[] = [
        ...s.toasts,
        { id, text: item.text, kind: item.kind, action: item.action },
      ];
      if (stacked.length <= MAX_STACKED) return { toasts: stacked };
      // newest-wins：淘汰数组头部（最旧、堆叠最上层）的溢出条目
      const evicted = stacked.slice(0, stacked.length - MAX_STACKED);
      for (const stale of evicted) clearDismissTimer(stale.id);
      return { toasts: stacked.slice(stacked.length - MAX_STACKED) };
    });

    const durationMs =
      typeof input === 'string'
        ? AUTO_DISMISS_MS
        : (input.durationMs ??
          (input.action ? ACTION_AUTO_DISMISS_MS : AUTO_DISMISS_MS));
    dismissTimers.set(
      id,
      window.setTimeout(() => get().dismiss(id), durationMs),
    );
  },

  dismiss: (id) => {
    clearDismissTimer(id);
    set((s) =>
      s.toasts.some((t) => t.id === id)
        ? { toasts: s.toasts.filter((t) => t.id !== id) }
        : s,
    );
  },
}));

/**
 * 弹一条全局 toast。无需 hook，任意模块可调用。
 * 带操作按钮时默认展示 6s；纯文案维持 2400ms。
 */
export function toast(input: ToastInput): void {
  useToastStore.getState().push(input);
}
