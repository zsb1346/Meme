/**
 * 键布局（八度制）：固定 7 列网格，每行恰好一个八度（do re mi fa sol la si），
 * 行数 = ceil(keyCount / 7)，自上而下堆叠；键按行优先填充
 * （index 0..6 = 第 1 行 = 第 1 个八度，以此类推）。
 * - 单元格触控目标 ≥56px，列宽 56–88px 弹性，整体居中；
 *   仅当视口真的放不下（7×56 + 间距）时才允许横向滚动兜底。
 * - 每行保留极轻微的抛物线上扬 + 切线倾斜做气质（幅度克制），
 *   绝不把 >12 键塞进一排、也绝不超过 7 键/行。
 *
 * 本组件只负责「摆位」，键本体由 renderKey(index) 注入（Stage/Studio 渲染 MemeKey）。
 */

import { type ReactNode } from 'react';

export interface KeyLayoutProps {
  keyCount: number;
  renderKey: (index: number) => ReactNode;
}

const COLS = 7; // 一个八度 = 7 个唱名键
const GAP_PX = 8; // 与 gap-2 一致

/** 行内抛物线偏移：中心 0、两端上扬 arcH px（y 轴向下为正 → 取负） */
function arcOffsetY(pos: number, rowLen: number, arcH: number): number {
  if (rowLen <= 1) return 0;
  const half = (rowLen - 1) / 2;
  const norm = (pos - half) / half; // -1 .. 1
  return -arcH * norm * norm;
}

/** 行内切线角：让键随弧面轻微倾斜（度），幅度很小只做气质 */
function arcRotationDeg(pos: number, rowLen: number, maxDeg: number): number {
  if (rowLen <= 1) return 0;
  const half = (rowLen - 1) / 2;
  const t = (pos - half) / half; // -1 .. 1
  return -t * maxDeg;
}

/**
 * 键布局（八度制）：固定 7 列网格，每行恰好一个八度（do re mi fa sol la si）。
 *
 * 空间策略：**铺满可用宽度，但限制单键宽高比**。
 * 旧实现用 `max-width:900px` + `mx-auto`，大屏上键区两侧留出大片空白而键本身偏小；
 * 但如果只改成「无限铺满」，14 键在宽屏上会被拉成 150×76 的扁条，不像琴键。
 * 故取 `max-w-[1180px]`：既吃满常见笔记本宽度，又让单键落在 ≈160×96 的舒适比例。
 *
 * 保留的两个签名手法：行内轻微抛物线上扬 + 切线倾斜（幅度克制，只做气质）。
 */
export default function KeyLayout({ keyCount, renderKey }: KeyLayoutProps) {
  return (
    <div className="touch-play-area w-full">
      <div
        className="mx-auto grid w-full max-w-[1180px]"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gap: `${GAP_PX}px`,
        }}
      >
        {Array.from({ length: keyCount }, (_, i) => {
          const rowLen = Math.min(COLS, keyCount - Math.floor(i / COLS) * COLS);
          const pos = i % COLS;
          const y = arcOffsetY(pos, rowLen, 5);
          const rot = arcRotationDeg(pos, rowLen, 1.6);
          return (
            <div
              key={i}
              className="h-[96px] min-w-0"
              style={{
                transform: `translateY(${y.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`,
              }}
            >
              {renderKey(i)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
