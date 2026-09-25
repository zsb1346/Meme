/**
 * RollCanvas 控制器层（Wave 2 / Agent R 拆分；键道坐标系版）。
 *
 * 集中承载全部「有状态」的交互与渲染调度 —— rAF 循环、指针/滚轮/键盘处理、
 * ResizeObserver、编辑提交（commit）：
 *
 *  - 几何计算 → geometry.ts 纯函数；
 *  - 绘制     → renderer.ts 纯函数 draw(ctx, RenderState)；
 *  - 本文件   → 唯一的 rAF 循环所有者：仅 dirty / 拖拽中 / 平移中 / 播放中
 *    重绘，空闲零开销。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  交互契约（用户定稿，实现必须严格一致）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  【滚轮 —— 三档分工，各司其职】
 *    · **Ctrl/⌘ + 滚轮** → 横向缩放时间轴（pps）。**锚定指针下的时间点**，
 *      缩放前后指针指的那一秒不动。
 *    · **Alt + 滚轮**    → 纵向缩放键道行高（rowH）。**锚定指针下的键道行**，
 *      缩放前后指针指的那一行不动。
 *    · 普通滚轮          → 平移：有纵向溢出时滚纵向，否则滚横向。
 *      Shift + 滚轮      → 强制横向平移。
 *
 *  【指针】
 *    · **左键点击空白**     → 在该键道该时刻**插入一个音符**（吸附到网格）
 *    · **Shift + 左键拖拽** → **框选**（橡皮筋；框内音符实时高亮为选中态）
 *    · 左键拖拽已有块       → 移动（多选时整组一起动）；`Alt` 临时取消吸附
 *    · 左键拖块右缘 5px     → 改时长
 *    · `Shift` + 点击块     → 加选 / 减选
 *    · `Alt` + 点击块       → 删除该块
 *    · 中键拖拽             → 双轴平移
 *    · 双击块               → 请求打开装配面板（走 onRequestEditEvent）
 *
 *  【键盘】
 *    · ←/→ 切换选中（按时间序）；`Shift` + ←/→ 把选中块整体左右移一格
 *    · ↑/↓ 选中块换键道（`Shift` 为整组换道）
 *    · `Ctrl/⌘ + A` 全选；`Esc` 取消选中
 *    · `Delete`/`Backspace` 删除选中
 *    · `Ctrl/⌘ + C` / `Ctrl/⌘ + V` 复制 / 粘贴到播放头位置
 *    · `Ctrl/⌘ + Z` 撤销；`Ctrl/⌘ + Shift + Z` 重做
 *    · `Shift + A` 打开装配面板（保留旧行为）
 *
 *  颜色经 styles/getTokens 读取设计令牌（与 CSS 同源）。
 *  Props 契约：受控模式（take + onChange）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { Take, TakeEvent } from '../../model/types';
import { useStore } from '../../model/store';
import { midiNoteName } from '../../model/pitch-map';
import { getTokens } from '../../styles/getTokens';
import { getAudioContext, ensureAudioStarted } from '../../engine/core';
import { triggerSynthPitchAt } from '../../engine/synth-preview';
import {
  DRAG_THRESHOLD_PX,
  GUTTER_W,
  MAX_PPS,
  MAX_ROW_H,
  MIN_PPS,
  MIN_ROW_H,
  RULER_H,
  clamp,
  clampViewState,
  computeLayout,
  DEFAULT_BLOCK_SEC,
  eventsInRect,
  fitRowH,
  followPlayhead,
  hitResizeHandle,
  hitTest,
  isBlackPitch,
  laneOf,
  pickTimeStep,
  pitchOfLane,
  rebuildPressCounts,
  revealLane,
  subdivisionsFor,
  takeDuration,
  timeAtX,
  yToLane,
  snapSec,
} from './geometry';
import { draw } from './renderer';
import type { GhostPreview, MarqueeRect } from './renderer';

/** RollCanvas 受控契约 */
export interface RollCanvasProps {
  take: Take;
  keyCount?: number;
  keyLabels?: string[];
  /**
   * 各键道行的权威音高（Key.pitchMidi 的逐行投影，与 keyLabels 同序）。
   * 拖块换道 / 插入音符 / ↑↓ 换道时写入事件的 pitch 都取它；
   * 缺省回落旧下标映射（仅演示/测试场景）。
   */
  lanePitches?: number[];
  /**
   * 半音键已收起（演奏键盘上不摆黑键）。
   *
   * 卷帘**仍然显示全部音高行**（藏起一行 = 藏起那行上的音符），
   * 但把黑键标成「关着」：钢琴栏画空心轮廓。见 `renderer.ts`。
   */
  blackLanesDisabled?: boolean;
  onChange?(updatedTake: Take): void;
  playing?: boolean;
  playheadSec?: number;
  /** 外部高亮事件下标（填词区悬停联动）；null 不高亮 */
  highlightedEventIndex?: number | null;
  /** 正在装配编辑的事件下标（null 无）—— 会把该事件所在键道整行点亮 */
  editingEventIndex?: number | null;
  /** 标尺 scrub 回调（秒，≥0） */
  onScrub?(sec: number): void;
  /** 双击音符 / 选中按 Shift+A 时请求编辑 */
  onRequestEditEvent?(index: number): void;
  /** 选中集变化回调（供工具栏展示） */
  onSelectionChange?(info: SelectedInfo): void;
  className?: string;
}

/** 工具栏展示用的选中信息 */
export interface SelectedInfo {
  count: number;
  /** 单选时的详情；多选为 null */
  single: {
    index: number;
    lane: number;
    label: string;
    tSec: number;
    duration: number;
    velocity?: number;
    pressCount: number;
  } | null;
}

/* ── 指针状态机 ── */

interface MoveDragState {
  kind: 'move';
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** 拖动开始时各选中事件的原始位置（按 events 下标） */
  origins: Map<number, { tSec: number; keyIndex: number }>;
  /** 主拖拽事件的原始位置（用于算增量） */
  anchor: { tSec: number; keyIndex: number };
}

interface ResizeDragState {
  kind: 'resize';
  pointerId: number;
  startX: number;
  evIdx: number;
  origDuration: number;
  origTSec: number;
  moved: boolean;
}

interface MarqueeState {
  kind: 'marquee';
  pointerId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  moved: boolean;
  /** 拖拽开始时已选中的集合（加选模式用，目前框选为替换语义） */
  additive: boolean;
}

type DragState = MoveDragState | ResizeDragState | MarqueeState;

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  sx0: number;
  sy0: number;
}
interface ScrubState {
  pointerId: number;
}
interface PinchState {
  startDist: number;
  startPps: number;
  anchorTimeSec: number;
  anchorX: number;
}

/** 撤销栈深度上限 */
const HISTORY_LIMIT = 60;

/**
 * 键道卷帘控制器：输入受控 props，输出画布/容器 ref 与全部事件处理器。
 * 外壳组件只负责 JSX 结构。
 */
export function useRollController(props: RollCanvasProps) {
  const storeKeyCount = useStore((s) => s.project.settings.keyCount);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 渲染循环读取的最新快照（避免每帧闭包过期）
  const srcRef = useRef(props);
  useEffect(() => {
    srcRef.current = props;
  });

  /** 行的权威音高：lanePitches（Key.pitchMidi 投影）优先，缺省回落旧下标映射 */
  const lanePitchAt = (lane: number): number =>
    srcRef.current.lanePitches?.[lane] ?? pitchOfLane(lane);

  const take = props.take;
  const takeRef = useRef(take);
  useEffect(() => {
    takeRef.current = take;
  }, [take]);

  const keyCount = Math.max(1, props.keyCount ?? storeKeyCount);
  const keyCountRef = useRef(keyCount);
  /** 用户是否手动纵向缩放过（true 后不再随键数自动适配行高） */
  const rowHTouchedRef = useRef(false);

  // 视图状态放 ref（拖拽/缩放热路径不走 React 渲染）
  const viewRef = useRef({ pps: 90, sx: 0, sy: 0, rowH: 24 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const pendingSizeRef = useRef<{ w: number; h: number; dpr: number } | null>(null);
  const dirtyRef = useRef(true);
  /** 选中集（多选） */
  const selRef = useRef<Set<number>>(new Set());
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const scrubRef = useRef<ScrubState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  /** 标尺 scrub 写入的播放头覆盖值；非 null 时优先于外部 playheadSec */
  const playheadOvRef = useRef<number | null>(null);
  /** 拖拽中的本地事件缓冲：move 热路径只写这里（rAF 直读绘制），pointerup 才 commit */
  const dragBufRef = useRef<TakeEvent[] | null>(null);
  const marqueeRef = useRef<MarqueeRect | null>(null);
  const ghostRef = useRef<GhostPreview | null>(null);
  /** 剪贴板（内部，不接系统剪贴板 —— 卷帘音符是应用内私有数据） */
  const clipboardRef = useRef<TakeEvent[] | null>(null);
  /** 撤销/重做栈 */
  const undoRef = useRef<TakeEvent[][]>([]);
  const redoRef = useRef<TakeEvent[][]>([]);
  /** 拖动换道时「上一次已试听的音高」——只在音高真的变化时才发声，避免逐帧轰炸 */
  const lastPreviewPitchRef = useRef<number | null>(null);
  /** 拖动换道试听的上次发声时间戳（毫秒）——间隔 < 0.5s 不重复发声 */
  const lastPreviewTimeRef = useRef(0);

  /**
   * 编辑反馈发声（放置音符 / 拖动换道时）。
   *
   * 三条约束：
   *   1. 只在 AudioContext 已 running 时发声 —— 不因卷帘操作触发自动播放
   *      拦截提示（浏览器要求手势内 resume；指针事件算手势，但拖动过程中
   *      反复调用 resume 会打日志、也无意义）。
   *   2. 时长给短（0.18s），连点/连续换道不糊成一片。
   *   3. 力度下限 0.55（见 synth-preview），保证低力度音符也听得见。
   */
  const previewPitch = useCallback((midi: number, velocity = 0.8) => {
    try {
      const ctx = getAudioContext();
      if (ctx.state !== 'running') {
        // 首次交互：在用户手势内尝试解锁，本次不发声（下一次就正常了）
        ensureAudioStarted();
        return;
      }
      triggerSynthPitchAt(midi, ctx.currentTime, 0.18, velocity);
    } catch {
      /* 音频不可用（未解锁 / 被策略拦截）时静默降级，绝不影响编辑 */
    }
  }, []);

  const [selInfo, setSelInfo] = useState<SelectedInfo>({ count: 0, single: null });

  /** 当前帧布局 */
  const currentLayout = useCallback(() => {
    const { w, h } = sizeRef.current;
    return computeLayout(
      w,
      h,
      takeRef.current ? takeRef.current.durationSec : 0,
      keyCountRef.current,
      viewRef.current,
    );
  }, []);

  /** 视图滚动边界收敛（原地写回） */
  const clampScroll = useCallback(() => {
    const v = viewRef.current;
    const nv = clampViewState(v, currentLayout());
    v.sx = nv.sx;
    v.sy = nv.sy;
    v.rowH = nv.rowH;
  }, [currentLayout]);

  /* ── 键数变化：同步 ref；用户未手动纵缩时重新适配行高 ── */
  useEffect(() => {
    keyCountRef.current = keyCount;
    if (!rowHTouchedRef.current) {
      const { h } = sizeRef.current;
      if (h > 2) {
        viewRef.current.rowH = fitRowH(Math.max(0, h - RULER_H), keyCount);
      }
    }
    clampScroll();
    dirtyRef.current = true;
  }, [keyCount, clampScroll]);

  /** 选中集 → React 状态镜像（工具条展示）；内容不变时不触发渲染 */
  const syncSelInfo = useCallback(() => {
    const sel = selRef.current;
    const src = dragBufRef.current ?? takeRef.current?.events ?? [];
    setSelInfo((prev) => {
      if (sel.size === 0) return prev.count === 0 ? prev : { count: 0, single: null };
      if (sel.size === 1) {
        const idx = [...sel][0];
        const ev = src[idx];
        if (!ev) return prev.count === 0 ? prev : { count: 0, single: null };
        const lane = laneOf(ev, keyCountRef.current);
        if (
          prev.count === 1 &&
          prev.single &&
          prev.single.index === idx &&
          prev.single.lane === lane &&
          prev.single.tSec === ev.tSec &&
          prev.single.duration === (ev.duration ?? 0)
        ) {
          return prev;
        }
        const label =
          srcRef.current.keyLabels?.[lane] ?? midiNoteName(pitchOfLane(lane));
        return {
          count: 1,
          single: {
            index: idx,
            lane,
            label,
            tSec: ev.tSec,
            duration: ev.duration ?? 0,
            velocity: ev.velocity,
            pressCount: ev.pressCount,
          },
        };
      }
      return prev.count === sel.size ? prev : { count: sel.size, single: null };
    });
  }, []);

  /* ── 编辑提交 ── */

  /** 把「上一版 events」压入撤销栈（在真正提交前调用） */
  const pushUndo = useCallback((snapshot: TakeEvent[]) => {
    const stack = undoRef.current;
    stack.push(snapshot);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    redoRef.current.length = 0;
  }, []);

  /** 编辑提交：重建 pressCount → onChange（受控契约） */
  const commit = useCallback(
    (events: TakeEvent[], options?: { record?: boolean }) => {
      const t = takeRef.current;
      if (!t) return;
      const rebuilt = rebuildPressCounts(events);
      if (rebuilt === t.events) return;
      if (options?.record !== false) pushUndo(t.events);
      const next: Take = {
        ...t,
        events: rebuilt,
        durationSec: takeDuration(rebuilt),
      };
      srcRef.current.onChange?.(next);
      dirtyRef.current = true;
    },
    [pushUndo],
  );

  /** 拖拽结束/被打断时把本地缓冲一次性提交进受控状态 */
  const flushDragBuffer = useCallback(() => {
    const buf = dragBufRef.current;
    dragBufRef.current = null;
    if (buf) commit(buf);
    ghostRef.current = null;
  }, [commit]);

  /* ── 选中操作 ── */

  const setSelection = useCallback(
    (indices: number[]) => {
      selRef.current = new Set(indices);
      syncSelInfo();
      srcRef.current.onSelectionChange?.({ count: selRef.current.size, single: null });
      dirtyRef.current = true;
    },
    [syncSelInfo],
  );

  const selectSingle = useCallback(
    (idx: number) => {
      selRef.current = new Set([idx]);
      syncSelInfo();
      dirtyRef.current = true;
    },
    [syncSelInfo],
  );

  const toggleSelection = useCallback(
    (idx: number) => {
      const sel = selRef.current;
      if (sel.has(idx)) sel.delete(idx);
      else sel.add(idx);
      syncSelInfo();
      dirtyRef.current = true;
    },
    [syncSelInfo],
  );

  const clearSelection = useCallback(() => {
    if (selRef.current.size === 0) return;
    selRef.current = new Set();
    syncSelInfo();
    dirtyRef.current = true;
  }, [syncSelInfo]);

  const deleteSelected = useCallback(() => {
    const t = takeRef.current;
    const sel = selRef.current;
    if (!t || sel.size === 0) return;
    const events = t.events.filter((_, i) => !sel.has(i));
    selRef.current = new Set();
    syncSelInfo();
    commit(events);
  }, [commit, syncSelInfo]);

  /** 复制选中事件到内部剪贴板（相对最早的起点归零，便于粘贴到播放头） */
  const copySelected = useCallback(() => {
    const t = takeRef.current;
    const sel = selRef.current;
    if (!t || sel.size === 0) return;
    const picked = [...sel].sort((a, b) => a - b).map((i) => t.events[i]);
    const base = Math.min(...picked.map((e) => e.tSec));
    clipboardRef.current = picked.map((e) => ({ ...e, tSec: e.tSec - base }));
  }, []);

  /** 粘贴到播放头位置（无播放头则粘到视图左缘对应时刻） */
  const pasteClipboard = useCallback(() => {
    const t = takeRef.current;
    const clip = clipboardRef.current;
    if (!t || !clip || clip.length === 0) return;
    const v = viewRef.current;
    const at =
      playheadOvRef.current ??
      (srcRef.current.playheadSec !== undefined && srcRef.current.playheadSec >= 0
        ? srcRef.current.playheadSec
        : timeAtX(GUTTER_W + 8, v));
    const grid = gridSecOf(v.pps);
    const inserted = clip.map((e) => ({
      ...e,
      tSec: snapSec(at + e.tSec, grid),
      duration: e.duration,
    }));
    const events = [...t.events, ...inserted];
    commit(events);
    // 粘贴后选中新插入的块，方便接着微调
    const start = t.events.length;
    setSelection(inserted.map((_, i) => start + i));
  }, [commit, setSelection]);

  const undo = useCallback(() => {
    const t = takeRef.current;
    const stack = undoRef.current;
    if (!t || stack.length === 0) return;
    const prev = stack.pop()!;
    redoRef.current.push(t.events);
    selRef.current = new Set();
    syncSelInfo();
    // 撤销写入不再记录历史，否则会把撤销自己变成一步可撤销操作
    commit(prev, { record: false });
    dirtyRef.current = true;
  }, [commit, syncSelInfo]);

  const redo = useCallback(() => {
    const t = takeRef.current;
    const stack = redoRef.current;
    if (!t || stack.length === 0) return;
    const next = stack.pop()!;
    undoRef.current.push(t.events);
    selRef.current = new Set();
    syncSelInfo();
    commit(next, { record: false });
    dirtyRef.current = true;
  }, [commit, syncSelInfo]);

  /* ── take 更新后选中下标越界保护 ── */
  useEffect(() => {
    const sel = selRef.current;
    if (sel.size === 0) return;
    const valid = new Set(
      [...sel].filter((i) => i >= 0 && i < (take?.events.length ?? 0)),
    );
    if (valid.size !== sel.size) {
      selRef.current = valid;
      syncSelInfo();
      dirtyRef.current = true;
    }
  }, [take, syncSelInfo]);

  // 播放状态翻转时清除 scrub 覆盖值，播放头交还外部时钟
  const playingProp = props.playing ?? false;
  useEffect(() => {
    playheadOvRef.current = null;
    dirtyRef.current = true;
  }, [playingProp]);

  /* ── 单帧绘制 ── */
  const renderFrame = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h, dpr } = sizeRef.current;
    if (w < 2 || h < 2) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const p = srcRef.current;
    const v = viewRef.current;
    const t = takeRef.current;
    const l = currentLayout();

    const ph =
      playheadOvRef.current ?? (p.playheadSec !== undefined ? p.playheadSec : -1);
    if (p.playing && ph >= 0 && playheadOvRef.current === null) {
      const nv = followPlayhead(v, ph, l);
      v.sx = nv.sx;
    }

    // 正在播放的事件：播放头落在 [tSec, tSec+duration) 内的最早一个
    let playingIndex: number | null = null;
    if (ph >= 0) {
      const events = dragBufRef.current ?? (t ? t.events : []);
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const end = ev.tSec + Math.max(ev.duration ?? 0, gridSecOf(v.pps) * 0.5);
        if (ph >= ev.tSec && ph < end) {
          playingIndex = i;
          break;
        }
      }
    }

    draw(ctx, {
      w,
      h,
      dpr,
      view: v,
      layout: l,
      events: dragBufRef.current ?? (t ? t.events : []),
      selected: selRef.current,
      highlighted: srcRef.current.highlightedEventIndex ?? null,
      /*
        装配目标 → 键道行。取不到事件时传 null（不点亮任何行）。
        注意读的是 dragBuf（拖拽中的本地缓冲）优先，与绘制其他部分保持一致。
      */
      editingLane: (() => {
        const idx = srcRef.current.editingEventIndex;
        if (idx === null || idx === undefined) return null;
        const ev = (dragBufRef.current ?? (t ? t.events : []))[idx];
        return ev ? laneOf(ev, keyCount) : null;
      })(),
      playingIndex,
      playheadSec: ph,
      keyLabels: p.keyLabels,
      lanePitches: p.lanePitches,
      blackLanesDisabled: p.blackLanesDisabled,
      colors: getTokens(),
      marquee: marqueeRef.current,
      ghost: ghostRef.current,
      gridSec: gridSecOf(v.pps),
    });

    /**
     * 把当前视图快照挂到 canvas 上，供自动化验证读取。
     *
     * 为什么需要：卷帘的缩放/平移是「视觉状态」，靠截图或数像素无法可靠断言
     * （会被音符块、网格线干扰）。挂一个只读快照后，scripts/roll-verify.mjs
     * 可以直接读 pps / rowH / sx / sy 做精确校验。
     * 纯增量、无副作用；生产构建里同样存在但只占一个字段。
     */
    const dbg = cv as HTMLCanvasElement & {
      __rollView?: {
        pps: number;
        rowH: number;
        sx: number;
        sy: number;
        maxSy: number;
        viewH: number;
        keyCount: number;
      };
    };
    dbg.__rollView = {
      pps: v.pps,
      rowH: v.rowH,
      sx: v.sx,
      sy: v.sy,
      maxSy: l.maxSy,
      viewH: l.viewH,
      keyCount: l.keyCount,
    };
  }, [currentLayout]);

  const drawRef = useRef(renderFrame);
  useEffect(() => {
    drawRef.current = renderFrame;
    dirtyRef.current = true;
  });

  /* ── rAF 循环：仅 dirty / 拖拽中 / 平移中 / 播放中重绘 ── */
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      // 先应用挂起的尺寸变更（同一 tick 内完成 resize + draw，无空窗闪烁）
      const cv = canvasRef.current;
      const pending = pendingSizeRef.current;
      if (cv && pending) {
        const { w, h, dpr } = pending;
        cv.width = Math.max(1, Math.round(w * dpr));
        cv.height = Math.max(1, Math.round(h * dpr));
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
        sizeRef.current = pending;
        pendingSizeRef.current = null;
        if (!initViewRef.current) {
          initViewRef.current = true;
          const v = viewRef.current;
          v.rowH = fitRowH(Math.max(0, h - RULER_H), keyCountRef.current);
          v.sy = 0;
        }
        clampScroll();
        dirtyRef.current = true;
      }
      const p = srcRef.current;
      if (dirtyRef.current || dragRef.current || panRef.current || p.playing) {
        drawRef.current();
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ── 尺寸自适应（ResizeObserver + devicePixelRatio）── */
  const initViewRef = useRef(false);
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      pendingSizeRef.current = { w: rect.width, h: rect.height, dpr };
      dirtyRef.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [clampScroll]);

  /* ── 中键按下：拦截浏览器原生 autoscroll ── */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    cv.addEventListener('mousedown', onMouseDown);
    return () => cv.removeEventListener('mousedown', onMouseDown);
  }, []);

  /* ═══════════════════════════ 指针交互 ═══════════════════════════ */

  const localPos = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const rect = cv.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTestAt = useCallback(
    (x: number, y: number): number => {
      const t = takeRef.current;
      if (!t) return -1;
      return hitTest(t.events, x, y, viewRef.current, currentLayout());
    },
    [currentLayout],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      /**
       * 指针捕获必须容错。
       *
       * `setPointerCapture` 在「该 pointerId 已不再活跃」时会抛
       * `NotFoundError`（例如指针在别处已释放、或事件由脚本合成）。
       * 它一旦抛出，**本回调后续所有逻辑都会中断** —— 表现为「点了没反应」，
       * 而且错误被 React 的调用栈吞掉、很难定位。
       *
       * 捕获本身只是「指针移出元素后仍收得到 move」的优化，
       * 失败不应影响任何功能，故包一层 try/catch。
       */
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败：不影响拖拽逻辑，只是指针移出画布后会丢 move */
      }
      const pos = localPos(e);
      pointersRef.current.set(e.pointerId, pos);
      const v = viewRef.current;
      const l = currentLayout();
      // 每次新手势重置「换道试听」去重标记，否则第二次拖到同一行不会发声
      lastPreviewPitchRef.current = null;
      lastPreviewTimeRef.current = 0;

      /* 第二指落下 → 双指捏合缩放时间轴（取消其它手势） */
      if (pointersRef.current.size === 2) {
        flushDragBuffer();
        dragRef.current = null;
        panRef.current = null;
        scrubRef.current = null;
        marqueeRef.current = null;
        const pts = [...pointersRef.current.values()];
        const mid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchRef.current = {
          startDist: Math.max(dist, 1),
          startPps: v.pps,
          anchorTimeSec: timeAtX(mid.x, v),
          anchorX: mid.x,
        };
        dirtyRef.current = true;
        return;
      }

      /* 中键 = 双轴平移（优先于一切） */
      if (e.button === 1) {
        panRef.current = {
          pointerId: e.pointerId,
          startX: pos.x,
          startY: pos.y,
          sx0: v.sx,
          sy0: v.sy,
        };
        dirtyRef.current = true;
        return;
      }
      /*
        ══ 右键 = 删除该音符（用户定稿的新操作）══

        在命中测试之前处理，因为右键不需要知道「命中了哪个块」之外的信息。
        未命中任何块时什么都不做（不弹菜单、不清选区）。

        配合 canvas 上的 onContextMenu → preventDefault，
        否则浏览器会弹出原生右键菜单盖住画布。
      */
      if (e.button === 2) {
        const hitIdx = hitTestAt(pos.x, pos.y);
        const tk = takeRef.current;
        if (hitIdx >= 0 && tk) {
          const events = tk.events.filter((_, i) => i !== hitIdx);
          // 选中集里被删元素之后的索引整体前移，避免选中漂移
          selRef.current = new Set(
            [...selRef.current]
              .filter((i) => i !== hitIdx)
              .map((i) => (i > hitIdx ? i - 1 : i)),
          );
          syncSelInfo();
          commit(events);
          dirtyRef.current = true;
        }
        return;
      }
      if (e.button !== 0) return;

      /* 标尺区域：scrub（点击/拖动定位播放头） */
      if (pos.y < RULER_H) {
        clearSelection();
        scrubRef.current = { pointerId: e.pointerId };
        const sec = Math.max(0, timeAtX(pos.x, v));
        if (srcRef.current.playing) {
          srcRef.current.onScrub?.(sec);
        } else {
          playheadOvRef.current = sec;
          srcRef.current.onScrub?.(sec);
        }
        dirtyRef.current = true;
        return;
      }

      const idx = hitTestAt(pos.x, pos.y);
      const t = takeRef.current;

      /* ── 命中已有块 ── */
      if (idx >= 0 && t) {
        const ev = t.events[idx];

        // Alt + 点击 = 直接删除该块
        if (e.altKey) {
          const events = t.events.filter((_, i) => i !== idx);
          const nextSel = new Set(
            [...selRef.current].filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)),
          );
          selRef.current = nextSel;
          syncSelInfo();
          commit(events);
          dirtyRef.current = true;
          return;
        }

        // Shift + 点击 = 加选/减选（不改位置，不起拖拽）
        if (e.shiftKey) {
          toggleSelection(idx);
          return;
        }

        // 右缘热区 = 改时长
        if (hitResizeHandle(ev, pos.x, pos.y, v, l)) {
          selectSingle(idx);
          dragRef.current = {
            kind: 'resize',
            pointerId: e.pointerId,
            startX: pos.x,
            evIdx: idx,
            origDuration: ev.duration ?? DEFAULT_BLOCK_SEC,
            origTSec: ev.tSec,
            moved: false,
          };
          dirtyRef.current = true;
          return;
        }

        // 命中未选中的块 → 单选它；命中已选中的块 → 保留整组（准备整组拖拽）
        if (!selRef.current.has(idx)) selectSingle(idx);

        const origins = new Map<number, { tSec: number; keyIndex: number }>();
        for (const i of selRef.current) {
          const it = t.events[i];
          if (it) origins.set(i, { tSec: it.tSec, keyIndex: it.keyIndex });
        }
        dragRef.current = {
          kind: 'move',
          pointerId: e.pointerId,
          startX: pos.x,
          startY: pos.y,
          moved: false,
          origins,
          anchor: { tSec: ev.tSec, keyIndex: ev.keyIndex },
        };
        dirtyRef.current = true;
        return;
      }

      /* ── 空白处 ── */
      // Shift + 拖拽 = 框选
      if (e.shiftKey) {
        dragRef.current = {
          kind: 'marquee',
          pointerId: e.pointerId,
          x0: pos.x,
          y0: pos.y,
          x1: pos.x,
          y1: pos.y,
          moved: false,
          additive: false,
        };
        marqueeRef.current = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
        dirtyRef.current = true;
        return;
      }

      // 普通左键点击空白 = 插入音符（点击即添加，拖动则转为平移）
      dragRef.current = null;
      clearSelection();
      panRef.current = {
        pointerId: e.pointerId,
        startX: pos.x,
        startY: pos.y,
        sx0: v.sx,
        sy0: v.sy,
      };
      dirtyRef.current = true;
    },
    [
      clearSelection,
      commit,
      currentLayout,
      flushDragBuffer,
      hitTestAt,
      selectSingle,
      syncSelInfo,
      toggleSelection,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const pos = localPos(e);
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, pos);
      const v = viewRef.current;
      const l = currentLayout();

      /* 双指捏合：距离比 → pps，锚定中点时刻 */
      const pinch = pinchRef.current;
      if (pinch && pointersRef.current.size === 2) {
        const pts = [...pointersRef.current.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        v.pps = clamp(pinch.startPps * (dist / pinch.startDist), MIN_PPS, MAX_PPS);
        v.sx = Math.max(0, pinch.anchorTimeSec * v.pps - (midX - GUTTER_W));
        clampScroll();
        dirtyRef.current = true;
        return;
      }

      /* 标尺 scrub */
      const scrub = scrubRef.current;
      if (scrub && e.pointerId === scrub.pointerId) {
        const sec = Math.max(0, timeAtX(pos.x, v));
        if (!srcRef.current.playing) playheadOvRef.current = sec;
        srcRef.current.onScrub?.(sec);
        dirtyRef.current = true;
        return;
      }

      const drag = dragRef.current;
      if (drag && e.pointerId === drag.pointerId) {
        const t = takeRef.current;
        if (!t) return;

        /* ── 框选 ── */
        if (drag.kind === 'marquee') {
          const dx = pos.x - drag.x0;
          const dy = pos.y - drag.y0;
          if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) drag.moved = true;
          drag.x1 = pos.x;
          drag.y1 = pos.y;
          if (drag.moved) {
            marqueeRef.current = {
              x0: drag.x0,
              y0: drag.y0,
              x1: pos.x,
              y1: pos.y,
            };
            // 框选实时高亮：框内音符立即呈现选中态，不必等松手
            const inside = eventsInRect(
              t.events,
              drag.x0,
              drag.y0,
              pos.x,
              pos.y,
              v,
              l,
            );
            if (
              inside.length !== selRef.current.size ||
              inside.some((i) => !selRef.current.has(i))
            ) {
              selRef.current = new Set(inside);
              syncSelInfo();
            }
            dirtyRef.current = true;
          }
          return;
        }

        const dx = pos.x - drag.startX;

        /* ── 改时长 ── */
        if (drag.kind === 'resize') {
          if (!drag.moved && Math.abs(dx) > DRAG_THRESHOLD_PX) drag.moved = true;
          if (!drag.moved) return;
          const snapped = !e.altKey;
          const grid = gridSecOf(v.pps);
          const rawDur = Math.max(0.01, drag.origDuration + dx / v.pps);
          const newDur = snapped ? Math.max(grid, snapSec(rawDur, grid)) : rawDur;
          if (!dragBufRef.current) dragBufRef.current = t.events.slice();
          dragBufRef.current = dragBufRef.current.map((ev, i) =>
            i === drag.evIdx ? { ...ev, duration: newDur } : ev,
          );
          dirtyRef.current = true;
          syncSelInfo();
          return;
        }

        /* ── 移动（整组）── */
        const dy = pos.y - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) drag.moved = true;
        if (!drag.moved) return;
        const snapped = !e.altKey;
        const grid = gridSecOf(v.pps);
        // 以「第一个选中的事件」为锚，算统一的整数格 + 行增量，保证组内相对位置不变
        const anchorIdx = [...drag.origins.keys()][0];
        const anchor = drag.origins.get(anchorIdx);
        if (!anchor) return;
        const rawT = Math.max(0, anchor.tSec + dx / v.pps);
        const newAnchorT = snapped ? snapSec(rawT, grid) : rawT;
        const dtSec = newAnchorT - anchor.tSec;
        const dLane = Math.round(dy / l.rowH);

        if (!dragBufRef.current) dragBufRef.current = t.events.slice();
        const buf = dragBufRef.current.slice();
        for (const [i, o] of drag.origins) {
          if (!buf[i]) continue;
          const newLane = clamp(o.keyIndex + dLane, 0, keyCountRef.current - 1);
          buf[i] = {
            ...buf[i],
            tSec: Math.max(0, o.tSec + dtSec),
            keyIndex: newLane,
            pitch: lanePitchAt(newLane),
          };
        }
        dragBufRef.current = buf;
        // 幽灵残影：单一锚点块的目标位置（整组同时动，残影只画锚点避免糊成一片）
        ghostRef.current = {
          items: [
            {
              tSec: Math.max(0, anchor.tSec + dtSec),
              lane: clamp(anchor.keyIndex + dLane, 0, keyCountRef.current - 1),
              duration: t.events[anchorIdx]?.duration,
            },
          ],
          snapped,
        };
        // 拖动换道发一声 —— 但**只在音高真的变了时**发。
        // 若每帧都发，一次拖动会触发上百次 attackRelease，既糊又卡。
        // 额外保护：间隔 < 0.5s 不重复发声，避免快速拖拽时声音过密。
        const dragLane = clamp(anchor.keyIndex + dLane, 0, keyCountRef.current - 1);
        const dragMidi = pitchOfLane(dragLane);
        const now = performance.now();
        if (lastPreviewPitchRef.current !== dragMidi && now - lastPreviewTimeRef.current >= 500) {
          lastPreviewPitchRef.current = dragMidi;
          lastPreviewTimeRef.current = now;
          previewPitch(dragMidi, t.events[anchorIdx]?.velocity ?? 0.8);
        }
        dirtyRef.current = true;
        syncSelInfo();
        return;
      }

      /* ── 平移 ── */
      const pan = panRef.current;
      if (pan && e.pointerId === pan.pointerId) {
        v.sx = pan.sx0 - (pos.x - pan.startX);
        v.sy = pan.sy0 - (pos.y - pan.startY);
        clampScroll();
        dirtyRef.current = true;
      }
    },
    [clampScroll, currentLayout, syncSelInfo],
  );

  const endPointer = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      pointersRef.current.delete(e.pointerId);
      if (pinchRef.current && pointersRef.current.size < 2) pinchRef.current = null;

      const drag = dragRef.current;
      if (drag && e.pointerId === drag.pointerId) {
        if (drag.kind === 'marquee') {
          marqueeRef.current = null;
          dragRef.current = null;
          dirtyRef.current = true;
          return;
        }
        if (drag.kind === 'move' && !drag.moved) {
          // 点了一下没拖动 → 视为「选中」（框选外的单点选择）
          dragRef.current = null;
          ghostRef.current = null;
          dirtyRef.current = true;
          return;
        }
        dragRef.current = null;
        flushDragBuffer();
      } else if (!drag && panRef.current && e.pointerId === panRef.current.pointerId) {
        // 空白处点击（未拖动）→ 插入音符。
        // 判定条件：平移位移为 0，说明只是单纯点了一下。
        const pan = panRef.current;
        const pos = localPos(e);
        const dist = Math.hypot(pos.x - pan.startX, pos.y - pan.startY);
        if (dist <= DRAG_THRESHOLD_PX) {
          const t = takeRef.current;
          const v = viewRef.current;
          const l = currentLayout();
          const lane = yToLane(pos.y, v, l, keyCountRef.current);
          if (t && lane !== null && pos.x >= GUTTER_W) {
            const sec = timeAtX(pos.x, v);
            const grid = gridSecOf(v.pps);
            const tSec = snapSec(sec, grid);
            const velocity = 0.85;
            const midi = pitchOfLane(lane);
            const next = [
              ...t.events,
              {
                keyIndex: lane,
                pressCount: 1, // 由 rebuildPressCounts 重排
                tSec,
                pitch: midi,
                duration: grid,
                velocity,
              } satisfies TakeEvent,
            ];
            commit(next);
            // 新建的块直接选中，方便立刻拖或改时长
            setSelection([t.events.length]);
            // 放置音符发一声：给出「这个音是这个音高」的即时听觉确认
            previewPitch(midi, velocity);
          }
        }
      }
      if (panRef.current && e.pointerId === panRef.current.pointerId) {
        panRef.current = null;
      }
      if (scrubRef.current && e.pointerId === scrubRef.current.pointerId) {
        scrubRef.current = null;
      }
      dirtyRef.current = true;
    },
    [commit, currentLayout, flushDragBuffer, setSelection],
  );

  const onDoubleClick = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const pos = localPos(e);
      const idx = hitTestAt(pos.x, pos.y);
      if (idx >= 0) srcRef.current.onRequestEditEvent?.(idx);
    },
    [hitTestAt],
  );

  /* ═══════════════════════════ 滚轮：三档分工 ═══════════════════════════ */

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // 触控板横向分量优先当平移用（不参与缩放）
      const dy = e.deltaY;

      /* ── Ctrl/⌘ + 滚轮 → 横向缩放时间轴，锚定指针下的时间点 ── */
      if (e.ctrlKey || e.metaKey) {
        if (dy !== 0) {
          const anchorT = timeAtX(mx, v);
          const factor = Math.exp(-dy * 0.0022);
          v.pps = clamp(v.pps * factor, MIN_PPS, MAX_PPS);
          // 缩放后把 anchorT 重新对齐到指针 x（这就是「锚定」的实现）
          v.sx = Math.max(0, anchorT * v.pps - (mx - GUTTER_W));
        }
        if (e.deltaX !== 0) v.sx += e.deltaX;
        clampScroll();
        dirtyRef.current = true;
        return;
      }

      /* ── Alt + 滚轮 → 纵向缩放键道行高，锚定指针下的键道行 ── */
      if (e.altKey) {
        if (dy !== 0) {
          // 指针下的「小数行号」——缩放前后保持它不动
          const anchorLane = (my - RULER_H + v.sy) / v.rowH;
          const factor = Math.exp(-dy * 0.0022);
          rowHTouchedRef.current = true;
          v.rowH = clamp(v.rowH * factor, MIN_ROW_H, MAX_ROW_H);
          v.sy = Math.max(0, anchorLane * v.rowH - (my - RULER_H));
        }
        if (e.deltaX !== 0) v.sx += e.deltaX;
        clampScroll();
        dirtyRef.current = true;
        return;
      }

      /* ── 普通滚轮 → 平移 ── */
      const l = currentLayout();
      if (e.shiftKey) {
        // Shift 强制横向
        v.sx += dy + e.deltaX;
      } else {
        if (e.deltaX !== 0) v.sx += e.deltaX;
        if (dy !== 0) {
          // 有纵向溢出就滚纵向，否则滚横向（笔记本触控板只有一个轴时的兜底）
          if (l.maxSy > 0) v.sy += dy;
          else v.sx += dy;
        }
      }
      clampScroll();
      dirtyRef.current = true;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [clampScroll, currentLayout]);

  /* ═══════════════════════════ 工具栏缩放按钮 ═══════════════════════════ */

  /** 横向缩放（以视口中心为锚） */
  const zoomBy = useCallback(
    (factor: number) => {
      const v = viewRef.current;
      const l = currentLayout();
      const anchorT = (v.sx + l.viewW / 2) / v.pps;
      v.pps = clamp(v.pps * factor, MIN_PPS, MAX_PPS);
      v.sx = Math.max(0, anchorT * v.pps - l.viewW / 2);
      clampScroll();
      dirtyRef.current = true;
    },
    [clampScroll, currentLayout],
  );

  /** 纵向缩放（以视口纵向中心为锚） */
  const zoomRowBy = useCallback(
    (factor: number) => {
      const v = viewRef.current;
      const l = currentLayout();
      const centerY = l.viewH / 2;
      const anchorLane = l.viewH > 0 && v.rowH > 0 ? (centerY + v.sy) / v.rowH : 0;
      rowHTouchedRef.current = true;
      v.rowH = clamp(v.rowH * factor, MIN_ROW_H, MAX_ROW_H);
      v.sy = Math.max(0, anchorLane * v.rowH - centerY);
      clampScroll();
      dirtyRef.current = true;
    },
    [clampScroll, currentLayout],
  );

  /** 「铺满」：行高回到「键道铺满视口」，回到纵向总览 */
  const fitRows = useCallback(() => {
    const { h } = sizeRef.current;
    rowHTouchedRef.current = false;
    if (h > 2) {
      viewRef.current.rowH = fitRowH(Math.max(0, h - RULER_H), keyCountRef.current);
    }
    viewRef.current.sy = 0;
    clampScroll();
    dirtyRef.current = true;
  }, [clampScroll]);

  /** 横向铺满：让整段 take 恰好占满视口宽 */
  const fitTime = useCallback(() => {
    const t = takeRef.current;
    const l = currentLayout();
    if (!t || l.viewW <= 0) return;
    const dur = Math.max(t.durationSec, 1);
    viewRef.current.pps = clamp((l.viewW - 16) / dur, MIN_PPS, MAX_PPS);
    viewRef.current.sx = 0;
    clampScroll();
    dirtyRef.current = true;
  }, [clampScroll, currentLayout]);

  /* ═══════════════════════════ 键盘导航 ═══════════════════════════ */

  /** 选中集按时间序排列 */
  const orderedSelection = useCallback((): number[] => {
    const t = takeRef.current;
    if (!t) return [];
    return [...selRef.current]
      .filter((i) => t.events[i])
      .sort((a, b) => t.events[a].tSec - t.events[b].tSec || a - b);
  }, []);

  const navigateSelection = useCallback(
    (dir: 1 | -1) => {
      const t = takeRef.current;
      if (!t || t.events.length === 0) return;
      const order = t.events
        .map((_, i) => i)
        .sort((a, b) => t.events[a].tSec - t.events[b].tSec || a - b);
      const cur = orderedSelection();
      let nextIdx: number;
      if (cur.length === 0) {
        nextIdx = dir > 0 ? order[0] : order[order.length - 1];
      } else {
        const last = cur[cur.length - 1];
        const pos = order.indexOf(last);
        const np = clamp(pos + dir, 0, order.length - 1);
        nextIdx = order[np];
      }
      selectSingle(nextIdx);
      const ev = t.events[nextIdx];
      if (ev) {
        const nv = revealLane(
          viewRef.current,
          laneOf(ev, keyCountRef.current),
          currentLayout(),
        );
        viewRef.current.sy = nv.sy;
      }
      dirtyRef.current = true;
    },
    [currentLayout, orderedSelection, selectSingle],
  );

  /** 把选中事件整体换道 ±dir（收敛 0..keyCount-1）并 commit */
  const nudgeLane = useCallback(
    (dir: 1 | -1) => {
      const t = takeRef.current;
      const sel = orderedSelection();
      if (!t || sel.length === 0) return;
      const events = t.events.slice();
      let blocked = false;
      for (const i of sel) {
        const nk = events[i].keyIndex + dir;
        if (nk < 0 || nk > keyCountRef.current - 1) {
          blocked = true;
          break;
        }
      }
      if (blocked) return;
      for (const i of sel) {
        const nk = events[i].keyIndex + dir;
        events[i] = { ...events[i], keyIndex: nk, pitch: pitchOfLane(nk) };
      }
      commit(events);
      const first = sel[0];
      const nv = revealLane(
        viewRef.current,
        laneOf(events[first], keyCountRef.current),
        currentLayout(),
      );
      viewRef.current.sy = nv.sy;
      dirtyRef.current = true;
    },
    [commit, currentLayout, orderedSelection],
  );

  /** 把选中事件整体左右移一格（吸附网格） */
  const nudgeTime = useCallback(
    (dir: 1 | -1) => {
      const t = takeRef.current;
      const sel = orderedSelection();
      if (!t || sel.length === 0) return;
      const grid = gridSecOf(viewRef.current.pps);
      // 以组内最早的事件为基准，防整组被推到负时间
      const minT = Math.min(...sel.map((i) => t.events[i].tSec));
      if (dir < 0 && minT < grid * 0.5) return;
      const events = t.events.slice();
      for (const i of sel) {
        events[i] = { ...events[i], tSec: Math.max(0, events[i].tSec + dir * grid) };
      }
      commit(events);
      dirtyRef.current = true;
    },
    [commit, orderedSelection],
  );

  const selectAll = useCallback(() => {
    const t = takeRef.current;
    if (!t) return;
    setSelection(t.events.map((_, i) => i));
  }, [setSelection]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelected();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) nudgeTime(dir);
        else navigateSelection(dir);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // 视觉上 lane 0 在顶部：↑ = 向顶部换道（keyIndex-1）
        nudgeLane(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        if (selRef.current.size > 0 && !e.repeat) {
          e.preventDefault();
          srcRef.current.onRequestEditEvent?.([...selRef.current][0]);
        }
        return;
      }
      if (e.key === 'Escape') {
        clearSelection();
      }
    },
    [
      clearSelection,
      copySelected,
      deleteSelected,
      navigateSelection,
      nudgeLane,
      nudgeTime,
      pasteClipboard,
      redo,
      selectAll,
      undo,
    ],
  );

  return {
    canvasRef,
    wrapRef,
    take,
    keyCount,
    selectedInfo: selInfo,
    /** 是否已有选中（工具栏按钮禁用态用） */
    hasSelection: selInfo.count > 0,
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
    copySelected,
    pasteClipboard,
    undo,
    redo,
    selectAll,
    clearSelection,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   工具
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 当前缩放下的吸附网格（秒）。
 *
 * 网格 = 主刻度步长 ÷ 细分数，与标尺刻度严格同源 ——
 * 所以「吸附到的位置」永远正好落在用户看得见的那条细线上。
 */
export function gridSecOf(pps: number): number {
  const step = pickTimeStep(pps);
  return step / subdivisionsFor(step);
}

/** 键道是否黑键（供 UI 着色，如工具栏展示当前行音名） */
export { isBlackPitch };
