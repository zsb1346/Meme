/**
 * Panel —— 带可选标题头的描边卡片（Wave 1 ui 套件）。
 *
 * 通用「机架模块卡」容器：圆角 + 语义边框/面底；
 * title / hint 任一存在时渲染分隔式头部（对应 MixPage 模块卡头）。
 */
import type { ReactNode } from 'react';

export interface PanelProps {
  /** 卡片标题（可省略 → 纯内容卡） */
  title?: string;
  /** 标题下方的弱化说明行 */
  hint?: string;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, hint, className, children }: PanelProps) {
  return (
    <section
      className={`rounded-2xl border border-white/[0.06] bg-ink-900/40 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.03),0_10px_30px_-15px_rgba(0,0,0,0.7)] backdrop-blur-xl ${className ?? ''}`}
    >
      {(title !== undefined || hint !== undefined) && (
        <header className="border-b border-white/[0.06] px-4 py-2.5">
          {title !== undefined && (
            <h2 className="truncate text-sm font-semibold text-slate-100">
              {title}
            </h2>
          )}
          {hint !== undefined && (
            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
              {hint}
            </p>
          )}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
