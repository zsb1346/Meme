/**
 * `revealBlockX` —— 左右键切换音符时的**横向**聚焦。
 *
 * 为什么单测这一层：滚动是否发生、滚到哪儿，全是纯数学（`timeToX` /
 * `blockSize` / `clampViewState`），跟 canvas、React、事件接线无关。
 * 接线层由 `scripts/roll-verify.mjs` 的「左右键横向聚焦」小节兜底，
 * 这里只钉住**判据本身**：
 *   - 完整可见 → **必须原样返回**（同一个对象，调用方靠 `!==` 判断动没动）；
 *   - 越界才滚，滚到「块 + 边距」刚好进视口；
 *   - 落地位置只受边距影响，**触发条件不含边距**（否则音符还在屏幕上视图就自己动）；
 *   - 块比可视区还宽 → 左缘对齐（能看到音头）；
 *   - 到边界就收敛，绝不越界。
 */
import { describe, expect, it } from 'vitest';
import {
  GUTTER_W,
  REVEAL_MARGIN_PX,
  computeLayout,
  revealBlockX,
  timeToX,
} from './geometry';
import type { RollLayout, ViewState } from './geometry';

const W = 600;
const H = 400;
const DUR_SEC = 30;
const KEY_COUNT = 12;

function lay(view: ViewState): RollLayout {
  return computeLayout(W, H, DUR_SEC, KEY_COUNT, view);
}

function view(partial: Partial<ViewState> = {}): ViewState {
  return { pps: 100, sx: 0, sy: 0, rowH: 20, ...partial };
}

/** 块完全落在可视区（不含边距） */
function fullyVisible(x: number, bw: number): boolean {
  return x >= GUTTER_W && x + bw <= W;
}

describe('revealBlockX', () => {
  it('块完整可见 → 原样返回（同一个对象，说明「没动」）', () => {
    const v = view();
    const l = lay(v);
    const next = revealBlockX(v, 0.5, 0.25, l);
    expect(next).toBe(v);
    expect(next.sx).toBe(0);
  });

  it('块在视口右侧之外 → 向右滚，落地时右缘留边距', () => {
    const v = view();
    const l = lay(v);
    const bw = 0.25 * v.pps; // 25px
    const next = revealBlockX(v, 10, 0.25, l);
    expect(next.sx).toBeGreaterThan(v.sx);
    const x = timeToX(10, next);
    expect(x + bw).toBeCloseTo(W - REVEAL_MARGIN_PX, 6);
    expect(fullyVisible(x, bw)).toBe(true);
  });

  it('块在视口左侧之外 → 向左滚，落地时左缘留边距', () => {
    const v = view({ sx: 1000 });
    const l = lay(v);
    const bw = 0.25 * v.pps;
    const next = revealBlockX(v, 5, 0.25, l);
    expect(next.sx).toBeLessThan(v.sx);
    const x = timeToX(5, next);
    expect(x).toBeCloseTo(GUTTER_W + REVEAL_MARGIN_PX, 6);
    expect(fullyVisible(x, bw)).toBe(true);
  });

  it('⛔ 触发条件不含边距：块紧贴右缘但完整可见时**不许动**', () => {
    // 造一个「右缘正好贴在 l.w 上」的视图：tSec * pps - sx + GUTTER_W + bw === W
    const bw = 0.25 * 100;
    const tSec = 4;
    const sx = GUTTER_W + tSec * 100 + bw - W;
    const v = view({ sx });
    const l = lay(v);
    const x = timeToX(tSec, v);
    expect(x + bw).toBeCloseTo(W, 6); // 前置：确实贴边
    expect(revealBlockX(v, tSec, 0.25, l)).toBe(v);
  });

  it('块比可视区还宽 → 左缘对齐（看得见音头）', () => {
    const v = view({ sx: 500 });
    const l = lay(v);
    const bw = 20 * v.pps; // 2000px，远比可视区宽
    const next = revealBlockX(v, 6, 20, l);
    expect(timeToX(6, next)).toBeCloseTo(GUTTER_W + REVEAL_MARGIN_PX, 6);
    expect(bw).toBeGreaterThan(l.viewW);
  });

  it('点事件（无 duration）按默认块宽参与判定', () => {
    const v = view();
    const l = lay(v);
    // 0.25s 默认块 ≈ 25px；tSec=9.5 时块整体在视口外
    const next = revealBlockX(v, 9.5, undefined, l);
    expect(next.sx).toBeGreaterThan(v.sx);
    expect(fullyVisible(timeToX(9.5, next), 25)).toBe(true);
  });

  it('时间线尾部：sx 收敛到 maxSx 为止，绝不越界', () => {
    const v = view();
    const l = lay(v);
    // 事件时间已超出「时长 + 4s」的内容区，横向没有更多可滚
    const next = revealBlockX(v, 400, 0.25, l);
    expect(next.sx).toBe(l.maxSx);
    expect(next.sx).toBeLessThanOrEqual(l.maxSx);
  });

  it('sy 不受影响（横向聚焦不许顺手改纵向）', () => {
    // rowH 取大到纵向可滚（12 行 × 40px = 480px > 可视高 378px），
    // 否则 clampViewState 会把 sy 顺手夹成 0，测的就成了「构造的视图本身非法」
    const v = view({ sy: 40, rowH: 40 });
    const l = lay(v);
    expect(l.maxSy).toBeGreaterThan(0); // 前置：确实还有纵向余量
    const next = revealBlockX(v, 10, 0.25, l);
    expect(next.sx).not.toBe(v.sx); // 前置：横向确实滚了
    expect(next.sy).toBe(v.sy);
  });
});
