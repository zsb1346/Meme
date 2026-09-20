/**
 * PageBar —— 单行顶栏（44px）。
 *
 * 设计要点（戒律一：静 / 用户诉求：讨厌莫名其妙占空间的东西）：
 *   把旧实现的「页面大标题区」与「页面工具条」合并成一行。
 *   旧结构 = 大标题 h1(30px 行高) + 描述段 + 独立工具栏行，
 *   垂直方向白吃掉 90~130px；新结构固定 44px，且顺带承载上下文读数。
 *
 * 结构：  [标题] [上下文读数] ———— [工具槽] [状态槽]
 *
 * 用法：
 *   <PageBar title="演奏台" meta="每排七键 = 一个八度">
 *     <Seg>…</Seg>
 *     <IconButton …/>
 *   </PageBar>
 */
import type { ReactNode } from 'react';

export interface PageBarProps {
  /** 页面名（唯一必填） */
  title: string;
  /** 标题右侧的弱化说明或上下文读数（如当前 take 名） */
  meta?: ReactNode;
  /** 右侧工具区（按钮 / 分段 / 图标按钮组） */
  children?: ReactNode;
  /** 最右侧的状态区（LED + 文案），与工具区之间自动加分隔线 */
  status?: ReactNode;
  className?: string;
}

export function PageBar({ title, meta, children, status, className }: PageBarProps) {
  return (
    <header className={`topbar shrink-0 ${className ?? ''}`}>
      <h1 className="shrink-0 text-lead font-semibold tracking-[-0.01em] text-label-hi">
        {title}
      </h1>
      {meta !== undefined && (
        <span className="hidden min-w-0 truncate text-small text-label-muted sm:inline">
          {meta}
        </span>
      )}

      <span className="min-w-2 flex-1" />

      {children !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</div>
      )}

      {status !== undefined && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
          <div className="flex shrink-0 items-center gap-1.5">{status}</div>
        </>
      )}
    </header>
  );
}

/* ═══════════════════════════════════════════════════════════════
   顶栏内的小件 —— 全站共用，避免各页各写一套
   ═══════════════════════════════════════════════════════════════ */

/** LED 指示灯：6px 圆。运行中呼吸，待机常暗。 */
export function Led({
  tone = 'ok',
  on = true,
  breathe = false,
}: {
  tone?: 'ok' | 'accent' | 'danger';
  on?: boolean;
  breathe?: boolean;
}) {
  const toneClass = !on
    ? 'bg-slate-600'
    : tone === 'accent'
      ? 'bg-flame-400'
      : tone === 'danger'
        ? 'bg-danger'
        : 'bg-success';
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${toneClass} ${
        on && breathe ? 'animate-breathe' : ''
      }`}
      style={on ? { boxShadow: '0 0 6px -1px currentColor' } : undefined}
    />
  );
}

/** 分段控件：Apple segmented control（凹槽 + 浮起选中块） */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange(v: T): void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-px rounded-sm bg-ink-950 p-0.5 shadow-[inset_0_0_0_1px_rgb(var(--line))]"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`min-w-0 rounded-[4px] px-2 font-medium transition-colors ${
              size === 'sm' ? 'h-[20px] text-[11px]' : 'h-[24px] text-small'
            } ${
              on
                ? 'bg-ink-800 text-label-hi font-semibold'
                : 'text-label-muted hover:text-label-lo'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
