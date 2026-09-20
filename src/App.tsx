import { useEffect } from 'react';
import { useStore } from './model/store';
import { installAudioUnlock } from './engine/core';
import { getMasterChain } from './engine/effects';
import { ensureRushLoaded } from './engine/rush/transform';
import { flushSave, loadAll, scheduleSave } from './model/persistence';
import LibraryPage from './pages/LibraryPage';
import StagePage from './pages/StagePage';
import StudioPage from './pages/StudioPage';
import MixPage from './pages/MixPage';
import { Toaster } from './components/ui/Toaster';
import {
  IconBrand,
  IconLibrary,
  IconMix,
  IconStage,
  IconStudio,
} from './components/ui/Icon';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import type { PageId } from './model/types';

// ---------------------------------------------------------------------------
// 导航表 —— 图标 + 名称 + 数字键直跳
// ---------------------------------------------------------------------------

const NAV_ITEMS: ReadonlyArray<{
  id: PageId;
  label: string;
  hint: string;
  Icon: typeof IconLibrary;
}> = [
  { id: 'material', label: '素材箱', hint: '1', Icon: IconLibrary },
  { id: 'stage', label: '演奏台', hint: '2', Icon: IconStage },
  { id: 'studio', label: '制作台', hint: '3', Icon: IconStudio },
  { id: 'mix', label: '混音台', hint: '4', Icon: IconMix },
];

// ---------------------------------------------------------------------------
// 页面路由表。「素材」页即素材箱（LibraryPage）：
// 原独立「切割机」子页已下线，切片能力并入素材箱——双击任意波形
// 弹出 SampleEditorModal（空格试听 / Shift+拖拽选区 / 导入选区）。
// ---------------------------------------------------------------------------

const PAGES: Record<PageId, () => JSX.Element> = {
  material: LibraryPage,
  stage: StagePage,
  studio: StudioPage,
  mix: MixPage,
};

const KEY_TO_PAGE: Record<string, PageId> = {
  '1': 'material',
  '2': 'stage',
  '3': 'studio',
  '4': 'mix',
};

/**
 * App —— 应用骨架。
 *
 * 布局（戒律一：静 / 戒律二：层）：
 *
 *   ┌────┬────────────────────────────────────────┐
 *   │ 图 │  单行顶栏 44px（页面标题与工具合并）      │
 *   │ 标 ├────────────────────────────────────────┤
 *   │ 侧 │  内容区（100% 宽，不居中、不留白）        │
 *   │ 栏 │  重页面（卷帘 / 混音）占满剩余高度        │
 *   │56px│                                        │
 *   └────┴────────────────────────────────────────┘
 *
 * 侧栏行为：常态 56px 纯图标；指针移入展开到 200px 显示文字与快捷键。
 * 主内容区锚定在 56px 轨道右侧 —— 展开时覆盖在内容之上，**不推挤内容**，
 * 避免悬停导航时整页重排（这是「灵动」与「抖动」的分界线）。
 *
 * 已删除（旧方案遗留的装饰性像素）：
 *   - 侧栏右缘霓虹渐变发丝线
 *   - 品牌名的霓虹发光圆点与 shadow-[0_0_10px...]
 *   - 移动端底部导航的发光指示条
 *   - body::before 的彩色环境光晕（见 index.css）
 */
export default function App() {
  const activePage = useStore((s) => s.activePage);
  const setActivePage = useStore((s) => s.setActivePage);
  const hydrate = useStore((s) => s.hydrate);
  const sampleCount = useStore((s) => s.project.samples.length);
  const keyCount = useStore((s) => s.project.settings.keyCount);

  useEffect(() => {
    installAudioUnlock();

    let unsubSave: (() => void) | undefined;
    let unsubFx: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      // 预加载主线程 WASM（播放变换用）与读取本地存档并行，二者就绪后再 hydrate，
      // 保证 UI 可演奏时相位声码器已就位。
      const [saved] = await Promise.all([
        loadAll().catch((err) => {
          console.error('[app] 读取本地存档失败，使用全新工程', err);
          return null;
        }),
        ensureRushLoaded().catch((err) => {
          console.error('[app] hajimi WASM 预加载失败，播放将退化为原生变调', err);
        }),
      ]);
      if (cancelled) return;
      hydrate(saved?.project ?? null, saved?.blobs ?? {});

      const state = useStore.getState();
      // 初始化实时主效果链（首次必须传 settings）
      getMasterChain(state.project.effects);

      let prevEffects = state.project.effects;
      unsubSave = useStore.subscribe((s) => {
        scheduleSave({ project: s.project, blobs: s.blobs });
      });
      unsubFx = useStore.subscribe((s) => {
        if (s.project.effects !== prevEffects) {
          prevEffects = s.project.effects;
          getMasterChain(s.project.effects); // 幂等 apply
        }
      });
    })();

    const onHide = () => {
      void flushSave();
    };
    window.addEventListener('pagehide', onHide);

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onHide);
      unsubSave?.();
      unsubFx?.();
    };
  }, [hydrate]);

  // 数字键 1-4 直跳页面（非输入焦点时）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return;
      const page = KEY_TO_PAGE[e.key];
      if (page) {
        e.preventDefault();
        setActivePage(page);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setActivePage]);

  const ActivePage = PAGES[activePage];

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-ink-950">
      {/* ═══════════ 图标侧栏 ═══════════
          固定占位 56px；展开层绝对定位覆盖其上，故内容区永不重排。 */}
      <aside
        className="group relative z-30 hidden w-14 shrink-0 md:block"
        aria-label="主导航"
      >
        <div
          className="absolute inset-y-0 left-0 flex w-14 flex-col overflow-hidden border-r border-line bg-ink-900
                     transition-[width] duration-200 ease-out group-hover:w-[200px] group-hover:shadow-[0_0_0_1px_rgb(var(--line)),12px_0_32px_-8px_rgb(0_0_0/0.7)]"
        >
          {/* 品牌 */}
          <button
            type="button"
            onClick={() => setActivePage('material')}
            title="哈吉米 Meme Instrument"
            className="flex h-[52px] shrink-0 items-center gap-2.5 pl-[17px] pr-4 text-left transition-colors hover:bg-ink-800"
          >
            <IconBrand size={21} className="shrink-0 text-flame-400" />
            <span className="whitespace-nowrap text-body font-semibold tracking-[-0.01em] text-label-hi opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              哈吉米
            </span>
          </button>

          <div className="mx-3 mb-1 h-px bg-line" />

          {/* 页面导航 */}
          <nav className="flex flex-col gap-px px-1.5">
            {NAV_ITEMS.map(({ id, label, hint, Icon }) => {
              const active = activePage === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActivePage(id)}
                  aria-current={active ? 'page' : undefined}
                  title={label}
                  className={`relative flex h-9 items-center gap-2.5 rounded-sm pl-[15px] pr-3 text-left transition-colors ${
                    active
                      ? 'bg-flame-600/15 font-semibold text-flame-300'
                      : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
                  }`}
                >
                  {/* 选中指示：2px 强调竖条，无发光 */}
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute -left-1.5 h-[18px] w-0.5 rounded-r-sm bg-flame-400"
                    />
                  )}
                  <Icon size={19} className="shrink-0" />
                  <span className="whitespace-nowrap text-body opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    {label}
                  </span>
                  <span
                    className={`ml-auto shrink-0 font-mono text-micro opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
                      active ? 'text-flame-600' : 'text-label-faint'
                    }`}
                  >
                    {hint}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* 底部状态：不参与导航 */}
          <div className="mt-auto flex h-11 shrink-0 items-center gap-2 border-t border-line pl-[17px] pr-3">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
            />
            <span className="whitespace-nowrap font-mono text-micro text-label-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              {keyCount} 键 · {sampleCount} 素材
            </span>
          </div>
        </div>
      </aside>

      {/* ═══════════ 主内容区 ═══════════
          移动端底部留出导航高度；页面切换淡入。 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0">
        {/*
          页面外包一层 ErrorBoundary：任何一页渲染抛异常时只中断该页，
          显示可见的错误卡，而不是让整个 <main> 变空（表现为「切换过去画面变黑」
          且无法切走，只能刷新）。
          resetKey={activePage} 保证「切走再切回来」自动清除错误态。
        */}
        <ErrorBoundary
          label={NAV_ITEMS.find((n) => n.id === activePage)?.label ?? '页面'}
          resetKey={activePage}
        >
          <div key={activePage} className="animate-page-in flex min-h-0 flex-1 flex-col">
            <ActivePage />
          </div>
        </ErrorBoundary>
      </main>

      {/* ═══════════ 移动端底部导航 ═══════════
          纯图标 + 文字，无发光指示条；选中靠颜色与字重区分。 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-ink-900 md:hidden"
        aria-label="底部导航"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const active = activePage === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActivePage(id)}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-micro font-medium transition-colors ${
                active ? 'text-flame-300' : 'text-label-muted active:text-label-lo'
              }`}
            >
              <Icon size={20} />
              {label}
            </button>
          );
        })}
      </nav>

      {/* 全局 toast（全站唯一挂载点） */}
      <Toaster />
    </div>
  );
}
