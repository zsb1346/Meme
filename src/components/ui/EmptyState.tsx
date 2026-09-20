/**
 * EmptyState —— 空态占位卡（Wave 1 ui 套件）。
 *
 * 虚线描边 + 居中排版；icon / description / action 三个可选槽位，
 * 对应 LibraryPage / StudioPage / SlotEditorModal 里现存的空态版式。
 */
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** 图形槽（svg / emoji 均可，弱化着色） */
  icon?: ReactNode;
  /** 主文案（一行短句） */
  title: string;
  /** 补充说明（引导用户下一步） */
  description?: string;
  /** 行动槽（通常是 Button） */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-raised/40 px-6 py-10 text-center ${
        className ?? ''
      }`}
    >
      {icon !== undefined && (
        <div aria-hidden="true" className="mb-3 text-slate-500">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {description !== undefined && (
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-slate-500">
          {description}
        </p>
      )}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
