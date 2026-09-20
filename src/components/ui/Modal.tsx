/**
 * Modal —— 响应式弹层（设计系统 v2 重做）。
 *
 * 视觉（戒律一：静 / 戒律二：层）：
 *   - **不再用 `backdrop-blur`**。遮罩改为纯色 `rgb(0 0 0 / .68)` ——
 *     毛玻璃在暗色专业软件里既耗性能又带「商业 web」气味。
 *   - 弹层本体 = `--ink-900` 面 + 1px 发丝线 + **顶部 1px 内高光** + 纯黑投影。
 *   - 圆角收敛到 `--r-lg`（13px）；移动端保留底部抽屉形态。
 *   - 头部无背景色差，只有一条分隔线；关闭按钮用 SVG 图标而非 ✕ 字符。
 *
 * 行为（与原实现一致，未改动）：
 *   - 移动端（<sm）底部抽屉，桌面端居中对话框；
 *   - 遮罩点击关闭（仅命中遮罩本身）；
 *   - Escape 走全局快捷键注册表，多层弹层按注册逆序（LIFO）派发；
 *   - 打开期间锁定 body 滚动；
 *   - size 四档桌面宽度；footer 可选底部操作区。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerShortcut } from './shortcuts';
import { IconClose } from './Icon';

const SIZE_MAX_W = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  xl: 'sm:max-w-3xl',
} as const;

export interface ModalProps {
  open: boolean;
  onClose(): void;
  /** 弹层标题（同时作为 aria-label） */
  title: string;
  children: ReactNode;
  /** 桌面端最大宽度档；移动端始终全宽抽屉。默认 md */
  size?: keyof typeof SIZE_MAX_W;
  /** 底部操作区（如确认/取消按钮组），渲染于内容之后 */
  footer?: ReactNode;
  /** 始终垂直居中（默认移动端底部抽屉、桌面端居中；编辑器等视觉中心场景开启） */
  centered?: boolean;
}

/** 模块内自增序号：保证多层弹层实例的 Esc 注册 id 互不相同 */
let modalSeq = 0;

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
  footer,
  centered = false,
}: ModalProps) {
  // onClose 走 ref：避免父组件每次渲染传新函数导致 Esc 监听反复注册/注销
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const escIdRef = useRef(`modal-esc-${++modalSeq}`);

  useEffect(() => {
    if (!open) return;
    const unregisterEsc = registerShortcut({
      id: escIdRef.current,
      keys: ['Escape'],
      guardInput: false,
      handler: () => onCloseRef.current(),
    });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      unregisterEsc();
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  // Portal 到 body：脱离祖先的 transform·filter·overflow 上下文，
  // 保证 fixed 永远相对视口。
  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center ${
        centered ? 'items-center' : 'items-end sm:items-center'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* 遮罩：纯色（无毛玻璃），点击关闭 */}
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <div
        className={`animate-panel-in relative z-10 flex max-h-[78dvh] w-full flex-col overflow-hidden rounded-t-lg border border-line bg-ink-900 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.85),inset_0_1px_0_rgb(var(--hl))] sm:max-h-[88dvh] ${
          centered ? 'sm:rounded-lg' : 'sm:rounded-lg'
        } ${SIZE_MAX_W[size]}`}
      >
        {/* 头部：标题 + 关闭（无背景色差，仅一条分隔线） */}
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <h3 className="min-w-0 flex-1 truncate text-body font-semibold tracking-[-0.01em] text-label-hi">
            {title}
          </h3>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-label-muted transition-colors hover:bg-ink-800 hover:text-label-hi"
          >
            <IconClose size={15} />
          </button>
        </header>

        {/* 内容区：自身滚动，头部与底部固定 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>

        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
