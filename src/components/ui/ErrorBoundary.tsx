/**
 * ErrorBoundary —— 页面级错误边界。
 *
 * ══ 为什么必须有这个 ══
 *
 * React 的默认行为是：组件在渲染期抛异常 → **卸载整棵子树**。
 * 本项目此前没有任何错误边界，于是任何一页的渲染异常都会让整个
 * `<main>` 变空 —— 用户看到的就是「切换过去画面变黑」，
 * 而且**无法切走**（导航栏虽然还在，但内容永远空白），
 * 只能刷新页面。这类故障极难自查：黑屏本身不提供任何线索。
 *
 * 真实案例：ReverbUnit 的接线异常抛在 `getMasterChain()` 里
 * （App 启动时同步执行），表现却是「制作台打不开」——
 * 排查时误以为是 UI 问题，实际根因在音频引擎的节点连接。
 *
 * 加了边界之后的收益：
 *   1. 崩溃变成**可见的错误卡**，直接显示错误信息与堆栈，
 *      不必开 DevTools 就能知道哪里炸了；
 *   2. 导航仍然可用 —— 切到别的页面即可继续工作；
 *   3. 「重试」按钮可以就地重挂，省掉一次整页刷新。
 *
 * 注意：错误边界只能捕获**渲染期 / 生命周期 / 构造函数**里的异常，
 * 捕获不了事件处理器与异步回调里的（那两类要靠各自的 try/catch，
 * 本项目在音频路径上已经这么做了）。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** 出错时显示的上下文名（如页面名），用于提示与 key 重置 */
  label: string;
  children: ReactNode;
  /**
   * 重置标识：变化时自动清除错误态并重挂子树。
   * 典型用法是传当前 pageId —— 切走再切回来即可自动恢复。
   */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 同时打到控制台，便于开发时看完整堆栈
    console.error(`[ErrorBoundary] 「${this.props.label}」渲染失败`, error, info);
  }

  componentDidUpdate(prev: Props): void {
    // resetKey 变化 → 自动清除错误态（切换页面即恢复）
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, info: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const stack = (info?.componentStack ?? '').trim();

    return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
        <div className="w-full max-w-2xl rounded-md border border-danger/40 bg-ink-900 shadow-[inset_0_1px_0_rgb(var(--hl))]">
          <header className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
            <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-danger">
              「{this.props.label}」渲染失败
            </h2>
            <button
              type="button"
              onClick={this.handleRetry}
              className="h-6 shrink-0 rounded-sm bg-ink-800 px-2 text-small text-label-lo transition-colors hover:bg-ink-700 hover:text-label-hi"
            >
              重试
            </button>
          </header>

          <div className="flex flex-col gap-2 p-3">
            <p className="text-small leading-relaxed text-label-lo">
              这一页抛了异常，渲染已中断。导航仍可用 —— 可以切到别的页面继续，
              或点「重试」就地重挂。
            </p>

            <pre className="max-h-32 overflow-auto rounded-sm bg-ink-950 p-2 font-mono text-micro leading-relaxed text-danger/90">
              {error.name}: {error.message}
            </pre>

            {stack !== '' && (
              <details className="group">
                <summary className="cursor-pointer text-micro text-label-faint transition-colors hover:text-label-muted">
                  组件堆栈
                </summary>
                <pre className="mt-1 max-h-56 overflow-auto rounded-sm bg-ink-950 p-2 font-mono text-micro leading-relaxed text-label-muted">
                  {stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }
}
