/**
 * RollCanvas 纯几何/布局层 —— 键道（KEY-LANE）坐标系版。
 *
 * 零 React、零 ref：所有状态经显式参数传入，便于单测与控制器复用。
 *
 * ══ 坐标系约定 ══
 *   x = 时间，单位秒，由**单一** `view.pps` 映射为像素；
 *   y = 键道，一行一键（行数 = keyCount），由 `view.rowH` 映射为像素。
 *   左侧钢琴键盘栏宽 GUTTER_W，顶部时间标尺高 RULER_H。
 *
 * 历史坑（务必保留这条注释）：早期原型用两套时间尺度 ——
 * 竖网格按 128px/s 画、音符块按 76.8px/s 定位，标尺与音符差 1.667 倍。
 * 本文件的 `timeToX` / `xToTime` 是**唯一**的时间↔像素换算入口，
 * draw 与 hitTest 都必须经过它们，绝不允许各画各的。
 *
 * 事件 Y 定位只认 `ev.keyIndex`（laneOf 收敛到 0..keyCount-1）。
 */
import type { TakeEvent } from '../../model/types';
import {
  isBlackMidi,
  keyPitchAt,
} from '../../model/pitch-map';

// ── 常量（canvas 无法用类名，故数值在此集中）──
/** 左侧钢琴键盘栏宽 */
export const GUTTER_W = 60;
/** 顶部时间标尺高 */
export const RULER_H = 22;
/**
 * 键道行高下限（纵向缩放；键多时可压到更小以容纳）。
 * 9px 仍能看清行分隔与力度条，且 32 键也只占 288px。
 */
export const MIN_ROW_H = 9;
/**
 * 键道行高上限。
 *
 * 这里必须给足余量：14 键在 643px 高的画布上「铺满」时行高约 44px，
 * 若上限只设 48，用户按一次 Alt+滚轮就撞顶，纵向放大形同失效。
 * 72px 意味着从铺满状态还能再放大约 1.6 倍，够用来精修单行。
 */
export const MAX_ROW_H = 72;
/** 初始适配行高下限（键多时优先铺满、少滚） */
export const FIT_ROW_MIN = 11;
/** 初始适配行高上限（铺满时不超过此值，避免少键时行高过大） */
export const FIT_ROW_MAX = 34;
export const MIN_PPS = 12;
export const MAX_PPS = 640;
export const DRAG_THRESHOLD_PX = 4;
/** 触摸命中外扩 */
export const BLOCK_PAD_HIT = 3;
/** 音符块右缘「改时长」热区宽度 */
export const RESIZE_HANDLE_W = 5;

/** MIDI 音高全域 */
const MIDI_PITCHES = 128;

/**
 * 键道 → MIDI 音高的**兜底**（正规路径永远走 `Key.pitchMidi`）。
 *
 * ⚠️ 兜底锚点必须与**键域的起点**一致（`keyPitchAt`，C3 = 48，且键集是
 * 连续半音序列，所以 lane 就是格号），不能再用旧的 C4 锚 ——
 * 旧锚会让「漏传 lanePitches」表现为「卷帘比键盘高一个八度」这种
 * **看起来像算法错了**的静默偏差。
 */
export function pitchOfLane(lane: number): number {
  return keyPitchAt(lane);
}

/** 是否黑键（钢琴键盘外观用）—— 委托 pitch-map 单一实现 */
export function isBlackPitch(pitch: number): boolean {
  return isBlackMidi(pitch);
}

/** 事件的 MIDI 音高：优先 ev.pitch，缺省由键道旧映射兜底 */
export function pitchOf(ev: TakeEvent): number {
  return ev.pitch !== undefined
    ? Math.max(0, Math.min(MIDI_PITCHES - 1, Math.round(ev.pitch)))
    : pitchOfLane(ev.keyIndex);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 事件的键道行（Y 轴唯一定位来源）：ev.keyIndex 收敛到 0..keyCount-1。
 */
export function laneOf(ev: TakeEvent, keyCount: number): number {
  return clamp(Math.round(ev.keyIndex), 0, Math.max(1, keyCount) - 1);
}

/** 初始行高：让 keyCount 行恰好铺满视口高（收敛到可读区间） */
export function fitRowH(viewH: number, keyCount: number): number {
  return clamp(viewH / Math.max(1, keyCount), FIT_ROW_MIN, FIT_ROW_MAX);
}

/** 视图状态：横向/纵向滚动偏移 + 每秒像素（时间缩放）+ 键道行高（纵向缩放） */
export interface ViewState {
  pps: number;
  sx: number;
  sy: number;
  rowH: number;
}

/** 单帧布局快照（draw 与命中测试共用同一公式） */
export interface RollLayout {
  w: number;
  h: number;
  /** 时间线区宽高（扣掉键盘栏与标尺） */
  viewW: number;
  viewH: number;
  rowH: number;
  keyCount: number;
  contentH: number;
  maxSx: number;
  maxSy: number;
}

/** 命中测试结果：命中的事件下标；-1 表示未命中。 */
export type HitResult = number;

/** 点事件（无 duration）默认块时长（秒）：缩放再小也有可见宽度 */
export const DEFAULT_BLOCK_SEC = 0.25;
/** 块最小像素宽：极小缩放下仍可看见、可命中 */
export const MIN_BLOCK_W = 8;

/* ═══════════════════════════════════════════════════════════════════════
   时间 ↔ 像素：唯一换算入口
   ═══════════════════════════════════════════════════════════════════════ */

/** 秒 → canvas x（含键盘栏偏移与横向滚动） */
export function timeToX(sec: number, view: ViewState): number {
  return GUTTER_W + sec * view.pps - view.sx;
}

/** canvas x → 秒（≥0）。与 timeToX 严格互逆。 */
export function timeAtX(x: number, view: ViewState): number {
  return Math.max(0, (x - GUTTER_W + view.sx) / view.pps);
}

/**
 * canvas y → 键道行（0..keyCount-1）；不在网格区（标尺以上 / 越界）返回 null。
 * 与绘制公式 `y = RULER_H + lane*rowH - sy` 严格互逆。
 */
export function yToLane(
  y: number,
  view: ViewState,
  l: RollLayout,
  keyCount: number,
): number | null {
  if (y < RULER_H) return null;
  const lane = Math.floor((y - RULER_H + view.sy) / l.rowH);
  return lane >= 0 && lane < Math.max(1, keyCount) ? lane : null;
}

/** 键道行 → canvas y（含标尺偏移与纵向滚动） */
export function laneToY(lane: number, view: ViewState): number {
  return RULER_H + lane * view.rowH - view.sy;
}

/**
 * 事件块尺寸（draw 与 hitTest 共用同一公式，保证视觉与命中一致）。
 * 宽度 = 时长 × 时间缩放：横向缩放会真实拉伸块；高度跟行高走。
 */
export function blockSize(
  rowH: number,
  pps: number,
  durationSec?: number,
): { bw: number; bh: number } {
  const dur =
    durationSec !== undefined && Number.isFinite(durationSec)
      ? Math.max(0, durationSec)
      : DEFAULT_BLOCK_SEC;
  return {
    bw: Math.max(MIN_BLOCK_W, dur * pps),
    // 高度占满行高减去 2px 缝；行高很小时退化为 4px 细条
    bh: Math.max(4, rowH - 2),
  };
}

/** 块的纵向起点（行内留 1px 上边距） */
export function blockTop(lane: number, l: RollLayout, view: ViewState): number {
  return RULER_H + lane * l.rowH - view.sy + 1;
}

/* ═══════════════════════════════════════════════════════════════════════
   布局
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 布局计算。入参为画布 CSS 尺寸、take 时长、键道数与视图状态。
 *
 * `contentSec` 取「时长 + 4s」与「视口秒数」较大者，保证空 take 也能平移；
 * `contentH = rowH * keyCount` 高于视口时纵向可滚动。
 */
export function computeLayout(
  w: number,
  h: number,
  durationSec: number,
  keyCount: number,
  view: ViewState,
): RollLayout {
  const viewW = Math.max(0, w - GUTTER_W);
  const viewH = Math.max(0, h - RULER_H);
  const kc = Math.max(1, Math.round(keyCount));
  const rowH = clamp(view.rowH, MIN_ROW_H, MAX_ROW_H);
  const contentH = rowH * kc;
  const contentSec = Math.max(durationSec + 4, viewW / view.pps);
  const maxSx = Math.max(0, contentSec * view.pps - viewW);
  const maxSy = Math.max(0, contentH - viewH);
  return { w, h, viewW, viewH, rowH, keyCount: kc, contentH, maxSx, maxSy };
}

/** 视图滚动/缩放边界收敛（返回新对象，不改入参） */
export function clampViewState(view: ViewState, l: RollLayout): ViewState {
  return {
    pps: clamp(view.pps, MIN_PPS, MAX_PPS),
    sx: clamp(view.sx, 0, l.maxSx),
    sy: clamp(view.sy, 0, l.maxSy),
    rowH: clamp(view.rowH, MIN_ROW_H, MAX_ROW_H),
  };
}

/**
 * 播放头自动跟随的纯数学（副作用由控制器承担）。
 * 仅外部预览播放中调用：播放头越过视口右侧 40px 内则跳到 65% 处，
 * 越过键盘栏左缘则贴左 48px；随后按布局边界收敛。
 */
export function followPlayhead(
  view: ViewState,
  playheadSec: number,
  l: RollLayout,
): ViewState {
  let sx = view.sx;
  const phX = timeToX(playheadSec, view);
  if (phX > l.w - 40) sx = playheadSec * view.pps - l.viewW * 0.65;
  else if (phX < GUTTER_W) sx = Math.max(0, playheadSec * view.pps - 48);
  return clampViewState({ ...view, sx }, l);
}

/**
 * 让某键道行进入可视区（纯函数）：行完全在视口外时平移 sy 露出整行，
 * 已可见则原样返回。选中/导航/换键后调用，保证键盘操作可见反馈。
 */
export function revealLane(
  view: ViewState,
  lane: number,
  l: RollLayout,
): ViewState {
  const top = RULER_H + lane * l.rowH - view.sy;
  const bottom = top + l.rowH;
  let sy = view.sy;
  if (top < RULER_H) sy -= RULER_H - top;
  else if (bottom > l.h) sy += bottom - l.h;
  if (sy === view.sy) return view;
  return clampViewState({ ...view, sy }, l);
}

/* ═══════════════════════════════════════════════════════════════════════
   时间刻度
   ═══════════════════════════════════════════════════════════════════════ */

/** 时间刻度候选档位（秒） */
const TIME_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;

/** 主刻度步长：取满足 step*pps ≥ 68px 的最小档 */
export function pickTimeStep(pps: number): number {
  for (const s of TIME_STEPS) if (s * pps >= 68) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/**
 * 次刻度细分：主刻度按 4 等分画细线（0.25s 这种步长下为 1 等分）。
 * 返回主刻度内的细分数量。
 */
export function subdivisionsFor(step: number): number {
  return step >= 1 ? 4 : step >= 0.25 ? 4 : 2;
}

/** 秒 → 标尺文字（0:03.2 / 12.5s 两种风格按跨度自动选） */
export function formatRulerTime(sec: number, step: number): string {
  if (step >= 1) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(0).padStart(2, '0')}`;
  }
  return `${sec.toFixed(step >= 0.5 ? 1 : 2)}s`;
}

/* ═══════════════════════════════════════════════════════════════════════
   编辑用纯函数
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 纯函数：任意编辑后按「每键时间顺序」重建 pressCount（1..n）。
 *
 * 不改变数组长度与元素顺序（选中下标不漂移），仅重写 pressCount 字段；
 * 无变化的事件返回原引用，便于上游做引用相等优化。
 * 按 keyIndex 分组 —— 换道编辑即改 keyIndex，pressCount 随之重排。
 */
export function rebuildPressCounts(events: TakeEvent[]): TakeEvent[] {
  const byKey = new Map<number, number[]>();
  events.forEach((ev, idx) => {
    const arr = byKey.get(ev.keyIndex);
    if (arr) arr.push(idx);
    else byKey.set(ev.keyIndex, [idx]);
  });
  const ranks = new Map<number, number>();
  for (const idxArr of byKey.values()) {
    const sorted = [...idxArr].sort(
      (a, b) => events[a].tSec - events[b].tSec || a - b,
    );
    sorted.forEach((idx, rank) => ranks.set(idx, rank + 1));
  }
  return events.map((ev, idx) => {
    const pc = ranks.get(idx);
    return pc !== undefined && pc !== ev.pressCount
      ? { ...ev, pressCount: pc }
      : ev;
  });
}

/** Take 时长 = 最后一个事件的「起点 + 时长」与起点的较大值 */
export function takeDuration(events: TakeEvent[]): number {
  let max = 0;
  for (const ev of events) {
    const end = ev.tSec + (ev.duration ?? 0);
    if (end > max) max = end;
    if (ev.tSec > max) max = ev.tSec;
  }
  return max;
}

/**
 * 命中测试（返回事件下标；触摸区外扩 BLOCK_PAD_HIT）。
 * 从后往前遍历：后绘制的事件块优先命中（与绘制层级一致）。
 */
export function hitTest(
  events: TakeEvent[],
  x: number,
  y: number,
  view: ViewState,
  l: RollLayout,
): HitResult {
  if (x < GUTTER_W || y < RULER_H) return -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const { bw, bh } = blockSize(l.rowH, view.pps, ev.duration);
    const ex = timeToX(ev.tSec, view);
    const ey = blockTop(laneOf(ev, l.keyCount), l, view);
    if (
      x >= ex - BLOCK_PAD_HIT &&
      x <= ex + bw + BLOCK_PAD_HIT &&
      y >= ey - BLOCK_PAD_HIT &&
      y <= ey + bh + BLOCK_PAD_HIT
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * 是否命中某块的右缘「改时长」热区。
 *
 * 注意命中范围：右缘只允许 **向内** 5px（不外扩）。
 * 若向外扩 BLOCK_PAD_HIT，那么「点击块右侧 3px 的空白」也会被判定为改时长，
 * 而用户的本意往往是「在块后面插入一个新音符」—— 那会变成一个 0.01s 的
 * 极短块，非常难撤销。故向右不放宽。
 */
export function hitResizeHandle(
  ev: TakeEvent,
  x: number,
  y: number,
  view: ViewState,
  l: RollLayout,
): boolean {
  const { bw, bh } = blockSize(l.rowH, view.pps, ev.duration);
  const ex = timeToX(ev.tSec, view);
  const ey = blockTop(laneOf(ev, l.keyCount), l, view);
  // 纵向允许 BLOCK_PAD_HIT 外扩（行很矮时也要能抓住）
  if (y < ey - BLOCK_PAD_HIT || y > ey + bh + BLOCK_PAD_HIT) return false;
  // 块很窄时整个块都算热区，避免完全无法改变时长
  const zone = Math.min(RESIZE_HANDLE_W, bw * 0.5);
  return x >= ex + bw - zone && x <= ex + bw;
}

/**
 * 矩形框选：返回与 [x0,y0]–[x1,y1] 相交的事件下标集合。
 * 只做包围盒相交判定（不做精确像素遮挡），符合「拉框选中」的直觉。
 */
export function eventsInRect(
  events: TakeEvent[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  view: ViewState,
  l: RollLayout,
): number[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const out: number[] = [];
  events.forEach((ev, i) => {
    const { bw, bh } = blockSize(l.rowH, view.pps, ev.duration);
    const ex = timeToX(ev.tSec, view);
    const ey = blockTop(laneOf(ev, l.keyCount), l, view);
    if (ex <= right && ex + bw >= left && ey <= bottom && ey + bh >= top) {
      out.push(i);
    }
  });
  return out;
}

/**
 * 时间吸附：把秒吸附到最近的网格。
 * 网格 = 主刻度步长的 1/subdivisions（即「拍」），步长随缩放自适应。
 * `grid` 由调用方传入（控制器按当前 pps 算出），保证与标尺刻度一致。
 */
export function snapSec(sec: number, grid: number): number {
  if (grid <= 0) return sec;
  return Math.max(0, Math.round(sec / grid) * grid);
}
