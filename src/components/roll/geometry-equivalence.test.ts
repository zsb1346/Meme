/**
 * 几何「热路径内核」的等价性守卫。
 *
 * ## 为什么需要它
 *
 * `hitTest` / `eventsInRect` / `hitResizeHandle` 是**每次指针移动**都要跑的
 * 热路径，而且要扫全部事件（未命中时是 O(n)）；`renderer.draw` 更是每帧扫一遍。
 * 原来的写法在循环里调 `blockSize()` —— 它返回新对象 `{bw, bh}`，
 * 于是 4000 事件的素材「每帧 / 每次 mousemove 分配 4000 个对象」，全是垃圾。
 *
 * 为了消掉这个分配，几何公式被拆成**按值返回的内核**
 * （`blockWidth` / `blockHeight` / `blockTopOfEvent`），热路径改调内核。
 * 风险随之而来：**内核和对象版是两个入口，一旦不等价，「看到的」与
 * 「点得到的」就会分叉** —— 而且分叉的方向恰好是最难查的那种
 * （命中框比画出来的块大一点 / 小一点，用户觉得「点不准」）。
 *
 * 所以这里把「对象版」当作**参照实现**逐点对拍：两者在整张参数网格上
 * 必须给出**完全相同**的结果（含所有畸形入参）。
 *
 * ⛔ 不要因为「反正都一样」就删掉这个文件 —— 它守的正是「一样」这件事。
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCK_PAD_HIT,
  GUTTER_W,
  RESIZE_HANDLE_W,
  RULER_H,
  blockHeight,
  blockSize,
  blockTop,
  blockTopOfEvent,
  blockWidth,
  computeLayout,
  eventsInRect,
  hitResizeHandle,
  hitTest,
  laneOf,
  timeToX,
} from './geometry';
import type { RollLayout, ViewState } from './geometry';
import type { TakeEvent } from '../../model/types';

const W = 900;
const H = 500;
const DUR_SEC = 40;
const KEY_COUNT = 21;

/** 覆盖正常值 + 全部退化值：缺省 / NaN / ±Infinity / 负数 / 越界键道 / 小数 */
const DURATIONS: Array<number | undefined> = [
  undefined,
  0,
  -1,
  0.05,
  0.25,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  12,
];
const KEY_INDICES = [-5, 0, 3.4, 3.5, 10, 20, 20.6, 21, 60];
const ROW_HEIGHTS = [4, 6, 9, 11, 12, 20, 25.9, 34, 72];
const PPS_LIST = [12, 40, 90, 240, 640];

function makeEvent(keyIndex: number, tSec: number, duration?: number): TakeEvent {
  return {
    keyIndex,
    pressCount: 1,
    tSec,
    duration,
  } as TakeEvent;
}

function view(partial: Partial<ViewState> = {}): ViewState {
  return { pps: 90, sx: 0, sy: 0, rowH: 20, ...partial };
}

function lay(v: ViewState): RollLayout {
  return computeLayout(W, H, DUR_SEC, KEY_COUNT, v);
}

/* ══════════════════════ 参照实现（= 改造前的对象版写法）══════════════════════ */

function refHitTest(
  events: TakeEvent[],
  x: number,
  y: number,
  v: ViewState,
  l: RollLayout,
): number {
  if (x < GUTTER_W || y < RULER_H) return -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const { bw, bh } = blockSize(l.rowH, v.pps, ev.duration);
    const ex = timeToX(ev.tSec, v);
    const ey = blockTop(laneOf(ev, l.keyCount), l, v);
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

function refEventsInRect(
  events: TakeEvent[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  v: ViewState,
  l: RollLayout,
): number[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const out: number[] = [];
  events.forEach((ev, i) => {
    const { bw, bh } = blockSize(l.rowH, v.pps, ev.duration);
    const ex = timeToX(ev.tSec, v);
    const ey = blockTop(laneOf(ev, l.keyCount), l, v);
    if (ex <= right && ex + bw >= left && ey <= bottom && ey + bh >= top) out.push(i);
  });
  return out;
}

function refHitResizeHandle(
  ev: TakeEvent,
  x: number,
  y: number,
  v: ViewState,
  l: RollLayout,
): boolean {
  const { bw, bh } = blockSize(l.rowH, v.pps, ev.duration);
  const ex = timeToX(ev.tSec, v);
  const ey = blockTop(laneOf(ev, l.keyCount), l, v);
  if (y < ey - BLOCK_PAD_HIT || y > ey + bh + BLOCK_PAD_HIT) return false;
  const zone = Math.min(RESIZE_HANDLE_W, bw * 0.5);
  return x >= ex + bw - zone && x <= ex + bw;
}

/* ══════════════════════════════ 断言 ══════════════════════════════ */

/**
 * 收集不一致项（而不是逐点 `expect`）。
 *
 * ⛔ 逐点 `expect` 在几十万次比较下会把用例跑成超时 —— 于是「测试很慢」
 * 会被误读成「代码有问题」，最后有人去调超时或删网格，守卫就废了。
 * 这里只累加字符串，最后一次性断言；顺带把前几条不一致的可读描述留下来。
 */
class Diffs {
  readonly items: string[] = [];
  n = 0;
  add(desc: string, a: unknown, b: unknown): void {
    this.n++;
    if (this.items.length < 5) this.items.push(`${desc}：内核 ${String(a)} ≠ 参照 ${String(b)}`);
  }
}

describe('几何内核与对象版等价', () => {
  it('blockWidth / blockHeight 与 blockSize 逐值相同', () => {
    const d = new Diffs();
    for (const rowH of ROW_HEIGHTS) {
      for (const pps of PPS_LIST) {
        for (const dur of DURATIONS) {
          const s = blockSize(rowH, pps, dur);
          const bw = blockWidth(pps, dur);
          const bh = blockHeight(rowH);
          if (bw !== s.bw) d.add(`blockWidth(rowH=${rowH},pps=${pps},dur=${dur})`, bw, s.bw);
          if (bh !== s.bh) d.add(`blockHeight(rowH=${rowH})`, bh, s.bh);
        }
      }
    }
    expect(d.items).toEqual([]);
  });

  it('blockTopOfEvent 与 blockTop(laneOf(ev)) 逐值相同', () => {
    const d = new Diffs();
    for (const rowH of ROW_HEIGHTS) {
      for (const sy of [-50, 0, 13, 400, 9999]) {
        for (const ki of KEY_INDICES) {
          const v = view({ rowH, sy });
          const l = lay(v);
          const ev = makeEvent(ki, 1.5, 0.25);
          /*
            ⚠️ 传 **`l.rowH`** 而不是上面的 `rowH`：`computeLayout` 会把行高
            夹到 `[MIN_ROW_H, MAX_ROW_H]`，而 `blockTop` 读的是 `l.rowH`。
            传原始值会在极小行高上差出 `lane * (l.rowH - rowH)` ——
            那是**测试写错**，不是内核不等价（本守卫第一次跑就抓到了这一点）。
          */
          const got = blockTopOfEvent(ki, l.rowH, l.keyCount, sy);
          const want = blockTop(laneOf(ev, l.keyCount), l, v);
          if (got !== want) {
            d.add(`blockTopOfEvent(ki=${ki},rowH=${rowH}→l.rowH=${l.rowH},sy=${sy})`, got, want);
          }
        }
      }
    }
    expect(d.items).toEqual([]);
  });

  it('hitTest 与参照实现在整张网格上同解（含未命中）', () => {
    const d = new Diffs();
    const events: TakeEvent[] = [];
    for (let i = 0; i < 24; i++) {
      events.push(makeEvent(i % 21, i * 0.37, DURATIONS[i % DURATIONS.length]));
    }
    let compared = 0;
    const probe = (x: number, y: number, v: ViewState, l: RollLayout): void => {
      const got = hitTest(events, x, y, v, l);
      const want = refHitTest(events, x, y, v, l);
      if (got !== want) d.add(`hitTest(x=${x},y=${y})`, got, want);
      compared++;
    };

    for (const rowH of ROW_HEIGHTS) {
      for (const pps of PPS_LIST) {
        for (const sx of [0, 640]) {
          for (const sy of [0, 40]) {
            const v = view({ rowH, pps, sx, sy });
            const l = lay(v);

            /* ① 粗网格铺一遍视口 —— 防止「只在某个局部成立」。 */
            for (let x = 0; x <= W; x += 61) {
              for (let y = 0; y <= H; y += 47) probe(x, y, v, l);
            }

            /*
              ② 边界采样。

              ⛔ 这里**刻意**不是均匀加密网格。两条谓语的不等价只可能出现在
              判据的**边界**上（±`BLOCK_PAD_HIT`、块的直角边、GUTTER/RULER 的
              提前返回），均匀网格绝大多数点落在「明显在里 / 明显在外」的
              安全区，花掉几十万次比较却几乎不碰边界。

              改成：对**每个事件**，在它自己四条边的外侧与内侧各取一点
              —— 边界覆盖率从「碰运气」变成「逐个钉住」。
              坐标用**参照实现**自己的算式算（参照是裁判，要围绕它的判据取样）。
            */
            for (const ev of events) {
              const { bw, bh } = blockSize(l.rowH, v.pps, ev.duration);
              const ex = timeToX(ev.tSec, v);
              const ey = blockTop(laneOf(ev, l.keyCount), l, v);
              for (const x of [ex - BLOCK_PAD_HIT, ex, ex + bw, ex + bw + BLOCK_PAD_HIT]) {
                for (const y of [ey - BLOCK_PAD_HIT, ey, ey + bh, ey + bh + BLOCK_PAD_HIT]) {
                  probe(x, y, v, l);
                }
              }
            }

            /* ③ 左栏 / 标尺这两个「提前返回」的直角边。 */
            for (const x of [0, GUTTER_W - 1, GUTTER_W, GUTTER_W + 1]) {
              for (const y of [0, RULER_H - 1, RULER_H, RULER_H + 1]) probe(x, y, v, l);
            }
          }
        }
      }
    }
    // 防止「网格退化成空循环」这种永远为真的假绿
    expect(compared).toBeGreaterThan(80000);
    expect(d.items).toEqual([]);
  });

  it('eventsInRect 与参照实现同解', () => {
    const d = new Diffs();
    const events: TakeEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(makeEvent((i * 5) % 21, i * 0.29, DURATIONS[(i + 2) % DURATIONS.length]));
    }
    let compared = 0;
    for (const rowH of ROW_HEIGHTS) {
      for (const pps of [12, 90, 640]) {
        for (const sx of [0, 300]) {
          const v = view({ rowH, pps, sx });
          const l = lay(v);
          for (const x0 of [0, 200, 700]) {
            for (const x1 of [120, 500, 900]) {
              for (const y0 of [RULER_H, 200]) {
                const got = eventsInRect(events, x0, y0, x1, y0 + 260, v, l);
                const want = refEventsInRect(events, x0, y0, x1, y0 + 260, v, l);
                if (JSON.stringify(got) !== JSON.stringify(want)) {
                  d.add(`eventsInRect(${x0},${y0}→${x1},${y0 + 260})`, got.join(','), want.join(','));
                }
                compared++;
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(d.items).toEqual([]);
  });

  it('hitResizeHandle 与参照实现同解', () => {
    const d = new Diffs();
    let compared = 0;
    for (const dur of DURATIONS) {
      const ev = makeEvent(7, 3.2, dur);
      for (const rowH of ROW_HEIGHTS) {
        for (const pps of [12, 90, 640]) {
          const v = view({ rowH, pps });
          const l = lay(v);
          for (let x = 0; x <= W; x += 11) {
            for (let y = 0; y <= H; y += 9) {
              const got = hitResizeHandle(ev, x, y, v, l);
              const want = refHitResizeHandle(ev, x, y, v, l);
              if (got !== want) d.add(`hitResizeHandle(dur=${dur},x=${x},y=${y})`, got, want);
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
    expect(d.items).toEqual([]);
  });
});
