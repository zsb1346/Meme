import type { ReactNode, Ref } from 'react';
import { useRollController } from './useRollController';
import type { RollCanvasProps } from './useRollController';
import {
  IconCopy,
  IconFit,
  IconMarquee,
  IconPaste,
  IconRedo,
  IconTrash,
  IconUndo,
  IconZoomIn,
  IconZoomOut,
} from '../ui/Icon';

/**
 * RollCanvas —— 键道卷帘（钢琴卷帘式事件编辑器）。
 *
 * Canvas 渲染（性能优先）：x = 时间（单一 pxPerSec 可缩放），
 * y = 演奏台键道（一行一键，唱名制分组，超出视口纵滚）。
 *
 * ══ 交互速查（完整契约见 useRollController 顶部注释）══
 *
 *   左键点击空白        插入音符（吸附网格）
 *   Shift + 左键拖拽     框选
 *   拖拽音符块           移动（多选时整组一起动）；Alt 临时取消吸附
 *   拖块右缘             改时长
 *   Shift + 点击块       加选 / 减选
 *   Alt + 点击块         删除该块
 *   双击块               打开装配面板
 *   中键拖拽             平移
 *   Ctrl/⌘ + 滚轮        横向缩放（锚定指针下的时间点）
 *   Alt + 滚轮           纵向缩放（锚定指针下的键道行）
 *   普通滚轮 / Shift+滚轮 平移
 *   空格                 播放/暂停（由父级注册）
 *   Ctrl+A / C / V / Z   全选 / 复制 / 粘贴到播放头 / 撤销
 *   Shift+Z              重做
 *   ←→                   切换选中；Shift+←→ 整组左右移一格
 *   ↑↓                   选中块换键道
 *   Delete               删除选中
 *   Esc                  取消选中
 *
 * ══ 分层 ══
 *   geometry.ts  纯几何/布局/命中/时间换算/编辑纯函数；
 *   renderer.ts  纯绘制 draw(ctx, RenderState)；
 *   useRollController.ts  rAF 调度、指针/滚轮/键盘、编辑提交、undo 栈；
 *   本文件       外壳：工具栏 + 画布 + 选中信息条，无业务逻辑。
 */

// 公共 API 再导出：既有导入路径保持不变
export type { RollCanvasProps, SelectedInfo } from './useRollController';
export { rebuildPressCounts } from './geometry';

/** 外壳扩展：可选传输槽（父级把播放/声部/读数整组塞进工具栏左侧） */
export interface RollCanvasShellProps extends RollCanvasProps {
  transport?: ReactNode;
  /**
   * 正在被装配面板编辑的事件下标（null 无）。
   *
   * 用途：打开装配面板时，卷帘把**该音符所在的那一整条键道**淡淡点亮，
   * 让用户不必在「左边滚动列表的 do/re/mi」和「右边面板的音名」之间来回找 ——
   * 一眼就能看到自己正在编辑卷帘的哪一行。
   */
  editingEventIndex?: number | null;
  /** 外层键盘焦点宿主的 ref */
  outerRef?: Ref<HTMLDivElement>;
}

export default function RollCanvas(props: RollCanvasShellProps) {
  const {
    canvasRef,
    wrapRef,
    take,
    selectedInfo,
    hasSelection,
    onPointerDown,
    onPointerMove,
    endPointer,
    onDoubleClick,
    onKeyDown,
    zoomBy,
    zoomRowBy,
    fitRows,
    fitTime,
    deleteSelected,
    undo,
    redo,
  } = useRollController(props);

  const isEmpty = !take || take.events.length === 0;

  return (
    <div
      ref={props.outerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md border border-line bg-ink-900 outline-none transition-shadow focus-visible:border-flame-500/70 ${
        props.className ?? ''
      }`}
    >
      {/* ── 工具栏：左 = 传输槽，右 = 缩放 / 编辑 / 撤销 ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        {props.transport && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {props.transport}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* 缩放组 */}
          <ToolBtn label="横向缩小（Ctrl+滚轮）" onClick={() => zoomBy(1 / 1.35)}>
            <IconZoomOut size={14} />
          </ToolBtn>
          <ToolBtn label="横向放大（Ctrl+滚轮）" onClick={() => zoomBy(1.35)}>
            <IconZoomIn size={14} />
          </ToolBtn>
          <ToolBtn label="横向铺满整段" onClick={fitTime} wide>
            铺满
          </ToolBtn>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

          <ToolBtn label="纵向缩小（Alt+滚轮）" onClick={() => zoomRowBy(1 / 1.3)} wide>
            行−
          </ToolBtn>
          <ToolBtn label="纵向放大（Alt+滚轮）" onClick={() => zoomRowBy(1.3)} wide>
            行＋
          </ToolBtn>
          <ToolBtn label="纵向铺满视口" onClick={fitRows}>
            <IconFit size={14} />
          </ToolBtn>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

          {/* 撤销 / 重做 */}
          <ToolBtn label="撤销（Ctrl+Z）" onClick={undo}>
            <IconUndo size={14} />
          </ToolBtn>
          <ToolBtn label="重做（Ctrl+Shift+Z）" onClick={redo}>
            <IconRedo size={14} />
          </ToolBtn>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

          <ToolBtn label="删除选中（Delete）" onClick={deleteSelected} disabled={!hasSelection}>
            <IconTrash size={14} />
          </ToolBtn>
        </div>
      </div>

      {/* ── 画布区 ── */}
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          /*
            这里必须有 CSS 背景色，否则「选中/删除时黑闪一瞬」。

            原因：`draw()` 的第一步是 `clearRect()`，之后要依次画钢琴键盘栏、
            行带、网格、标尺、事件块…… 在这些绘制跑完之前，画布那一区是
            **透明的**，于是露出下面的深色页面底。桌面浏览器通常在同一帧内
            就补上了，但在较慢的机器或较重的重绘（选中/删除会触发整帧重画）时，
            会真实地闪出一帧黑 —— 就是用户看到的现象。

            给 canvas 本身铺上与页面底同色的背景后，清除瞬间露出的也是同色，
            视觉上完全连续。纯 CSS，零 JS 开销。
          */
          className="absolute inset-0 touch-none select-none bg-ink-950"
          style={{ cursor: 'crosshair' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={onDoubleClick}
          onAuxClick={(e) => e.preventDefault()}
          // 右键用于删除音符，必须拦掉浏览器原生菜单
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* 空态：教用户怎么开始（不再是「先去录制」的推诿，而是给出三种入口） */}
        {isEmpty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
            <IconMarquee size={28} className="text-label-faint" />
            <p className="text-body font-medium text-label-lo">卷帘还是空的</p>
            <div className="flex flex-col gap-1 text-small leading-relaxed text-label-muted">
              <span>
                <b className="font-medium text-label-lo">左键点空白</b> 直接画一个音符
              </span>
              <span>
                <b className="font-medium text-label-lo">Shift + 拖拽</b> 框选一段
              </span>
              <span>或到「录制」敲几个键、导入一段 MIDI</span>
            </div>
          </div>
        )}
      </div>

      {/* ── 选中信息条：有选中才占位（戒律一：静） ── */}
      {selectedInfo.count > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line bg-ink-900 px-2.5 py-1">
          <span className="text-tiny text-label-muted">
            已选 <b className="font-mono text-flame-300">{selectedInfo.count}</b>
          </span>
          {selectedInfo.single && (
            <span className="font-mono text-tiny tabular-nums text-label-lo">
              键 {selectedInfo.single.label}
              <span className="mx-1.5 text-label-faint">·</span>
              第 {selectedInfo.single.pressCount} 按
              <span className="mx-1.5 text-label-faint">·</span>t ={' '}
              {selectedInfo.single.tSec.toFixed(2)}s
              <span className="mx-1.5 text-label-faint">·</span>
              时长 {selectedInfo.single.duration.toFixed(2)}s
              {selectedInfo.single.velocity !== undefined && (
                <>
                  <span className="mx-1.5 text-label-faint">·</span>
                  力度 {selectedInfo.single.velocity.toFixed(2)}
                </>
              )}
            </span>
          )}
          <span className="min-w-2 flex-1" />
          {/* 操作提示贴在信息条右端，不占额外行 */}
          <span className="hidden items-center gap-2 font-mono text-micro text-label-faint lg:flex">
            <span className="flex items-center gap-1">
              <IconCopy size={11} />
              Ctrl+C
            </span>
            <span className="flex items-center gap-1">
              <IconPaste size={11} />
              Ctrl+V
            </span>
            <span>Shift+←→ 移位</span>
            <span>↑↓ 换键道</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** 工具栏图标按钮：26px，圆角 4px（不是胶囊） */
function ToolBtn({
  label,
  onClick,
  disabled,
  wide,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-[26px] place-items-center rounded-sm text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent ${
        wide ? 'px-2 text-small' : 'w-[26px]'
      }`}
    >
      {children}
    </button>
  );
}
