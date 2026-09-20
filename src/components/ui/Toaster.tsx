/**
 * 全局 toast 渲染层（Wave A 扩展）。
 *
 * 固定于底部居中：移动端抬到底部导航之上（bottom-24），桌面端 bottom-8。
 * 容器保持 pointer-events-none（纯文案条目点击穿透、不挡操作）；
 * 带操作按钮的条目单独恢复 pointer-events-auto，保证按钮可点。
 * role="status" 供读屏播报；上滑入场动画以组件内 <style> 内联注入。
 *
 * kind 决定描边色：default=accent / success=emerald / error=red。
 *
 * 在 App.tsx 根节点挂载一次即可；页面本地 toast 后续 Wave 统一迁移。
 */
import { useToastStore } from './toast';
import type { ToastKind } from './toast';

/** subtle slide-up 入场（与页面本地 toast 的 stage-toast-in 同节奏） */
const TOAST_KEYFRAMES = `
@keyframes hajimi-toast-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.hajimi-toast-in { animation: hajimi-toast-in 0.22s ease-out both; }
`;

const KIND_BORDER_CLASS: Record<ToastKind, string> = {
  default: 'border-accent/40',
  success: 'border-emerald-400/50',
  error: 'border-red-400/50',
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <>
      <style>{TOAST_KEYFRAMES}</style>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-8"
      >
        {toasts.map((t) => {
          const action = t.action;
          return (
            <div
              key={t.id}
              className={`hajimi-toast-in flex max-w-full items-center gap-2.5 rounded-full border bg-surface-raised/95 px-4 py-2 text-xs text-slate-200 shadow-[0_8px_30px_rgba(0,0,0,0.5)] backdrop-blur ${
                KIND_BORDER_CLASS[t.kind ?? 'default']
              }${action ? ' pointer-events-auto' : ''}`}
            >
              <span className="min-w-0 truncate whitespace-nowrap">
                {t.text}
              </span>
              {action && (
                <button
                  type="button"
                  onClick={() => {
                    action.onClick();
                    dismiss(t.id);
                  }}
                  className="shrink-0 rounded-full border border-accent/50 px-2.5 py-0.5 text-[11px] font-semibold text-accent transition hover:bg-accent/10"
                >
                  {action.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
