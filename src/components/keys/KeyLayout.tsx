/**
 * 键布局：**单一几何，由音高决定**（2026-09-25 定稿）。
 *
 * ══ 为什么不再按「半音开关」切两套几何 ══
 *
 * 旧实现是两套：开关关 → 7 列阶梯网格（按下标顺序填格）；开关开 → 钢琴几何。
 * 于是「开着半音加过键、再关掉」会当场说谎：C#3 变成一个**白键格子**，
 * 按数组顺序占掉 D3 的位置，整行「一行 = 一个八度」崩掉 ——
 * 用户原话「半音会被当做音符块挤占其他的地方」。
 *
 * 根因是把**「一个键长什么样」跟「半音键开不开」混成了一个开关**。现在拆开：
 *   · 几何永远由 `Key.pitchMidi` 决定 —— 是黑键就永远站在黑键的位置；
 *   · 「半音键开关」只决定**摆不摆**黑键（`hideBlackKeys`），
 *     白键的列位、行数、跨度一点不变。
 *
 * 这样「开 → 关」与「关 → 开」都无损：没有任何键会移动、改名或改音高。
 *
 * ══ 几何 ══
 * 每个八度一行：白键 7 列等宽铺底（**恒定 7 列**，空列留洞，保证跨八度纵向对齐），
 * 黑键（C# D# F# G# A#）压在上层、落在白键缝隙处（高 58%、宽 ≈ 白键 62%）——
 * 与真钢琴一致。键按 `floor(pitch/12)` 分组归位。
 *
 * 行内弧线只在**该行没有黑键**时保留（纯自然音的观感与旧版一致）；
 * 一旦这行有黑键就转平 —— 黑键是绝对定位的，跟着弧线走会与白键错位。
 * 收起黑键（`hideBlackKeys`）后每行都没有黑键，于是弧线回来了，
 * 观感与「自然音键盘」逐像素一致。
 *
 * 本组件只负责「摆位」，键本体由 renderKey(index) 注入。
 */

import { type ReactNode } from 'react';
import { isBlackMidi } from '../../model/pitch-map';

export interface KeyLayoutProps {
  keyCount: number;
  renderKey: (index: number) => ReactNode;
  /**
   * 各键音高（Key.pitchMidi 投影，与下标同序）—— 布局的**唯一**依据。
   * 缺省时退化为「按下标填 7 列」的兜底网格（仅演示/测试场景，正常调用方必传）。
   */
  keyPitches?: number[];
  /**
   * 收起黑键（半音键开关关闭时）。
   *
   * 注意它**只影响「摆不摆」**，不影响几何 —— 白键依旧按 `WHITE_COL`
   * 落在它自己的列上（含空列占位），所以「收起黑键」得到的是一台
   * 每行恰好 7 个白键的键盘，而不是「把黑键的位置让给后面的白键」。
   *
   * 这正是旧实现翻车的地方：旧版按开关切了两套几何，关掉后走
   * 「按下标顺序填格」的网格，C#3 变成白键格子、顶掉 D3 的位置。
   */
  hideBlackKeys?: boolean;
  /**
   * 让每一排**吃满容器高度**（演奏台手机端「缩小塞进一屏」用）。
   *
   * `false`（默认）= 每排固定 96px：桌面演奏台与制作台照旧，一行不动。
   * `true` = 每排 `flex-1`，实际高度由**调用方给容器的高度**决定 ——
   * 所以调用方必须同时给出高度区间，判据就是下面导出的两个常量：
   *   `minHeight = 排数 × KEY_ROW_MIN_H + 间隙`（给不到就让外层滚动）
   *   `maxHeight = 排数 × KEY_ROW_MAX_H + 间隙`（给多了就留白，别把键拉成方块）
   * ⛔ 只给 `fill` 不给高度 = 每排高度 0（`flex-1` 无参照），整片键盘消失。
   */
  fill?: boolean;
}

const COLS = 7; // 一个八度 = 7 个白键
const GAP_PX = 8; // 与 gap-2 一致

/**
 * 一排的高度区间。
 *
 * `MAX` = 桌面上的现状（96px）；`MIN` = **触控安全线 64px** ——
 * 手机端「缩小塞进一屏」只能缩到这个下限，再矮就会误触相邻键
 * （见 `原型/手机端设计.md`：琴键最小高度 64）。
 */
export const KEY_ROW_MAX_H = 96;
export const KEY_ROW_MIN_H = 64;
/** 排间间隙（= GAP_PX，导出给调用方算容器高度用） */
export const KEY_ROW_GAP = GAP_PX;

/** 黑键音级 → 它落在「第几条白键缝」（C#→1, D#→2, F#→4, G#→5, A#→6） */
const BLACK_BOUNDARY: Record<number, number> = {
  1: 1,
  3: 2,
  6: 4,
  8: 5,
  10: 6,
};

/**
 * 白键音级 → 它在八度内的**列位**（C→0 D→1 E→2 F→3 G→4 A→5 B→6）。
 *
 * ⚠️ 必须按音级定位，不能按数组顺序依次填格：
 * 半音模式下「C# 之后追加的 D」所在的尾组里，白键数组可能只有一个 D，
 * 按顺序填会把它摆到第 1 列（C 的位置）—— 画面直接骗人。
 */
const WHITE_COL: Record<number, number> = {
  0: 0, // C
  2: 1, // D
  4: 2, // E
  5: 3, // F
  7: 4, // G
  9: 5, // A
  11: 6, // B
};

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

/** 一个八度（一排）的分组结果 */
export interface OctaveGroup {
  /** 列位（0..6）→ 键下标；空列留洞，保证跨八度纵向对齐 */
  whiteByCol: Map<number, number>;
  blacks: Array<{ i: number; boundary: number }>;
}

/**
 * 按八度分组 —— **全项目唯一**的分组实现。
 *
 * ⛔ 排数在两处都要用：这里决定画几排，调用方还要拿它算容器高度
 * （`minHeight / maxHeight`）。**各算一遍必然迟早不一致** ——
 * 表现是「按 4 排算的高度配 3 排的画面」，末排被拉长或底下留一条空带。
 * 所以只有这一个函数，`octaveRowCount` 也只是数它。
 */
export function octaveGroups(
  keyPitches: readonly number[],
  keyCount: number,
  hideBlackKeys: boolean,
): Array<[number, OctaveGroup]> {
  const groups = new Map<number, OctaveGroup>();
  for (let i = 0; i < keyCount; i++) {
    const pitch = keyPitches[i];
    if (typeof pitch !== 'number') continue;
    const group = Math.floor(pitch / 12);
    const chroma = ((Math.round(pitch) % 12) + 12) % 12;
    const g: OctaveGroup = groups.get(group) ?? { whiteByCol: new Map(), blacks: [] };
    if (isBlackMidi(pitch)) {
      /* 半音键收起：黑键**不摆**。它的键对象还在 store 里（装配、音符都在），
         只是此刻没有可点的位置 —— 重新打开开关即刻原样回来。 */
      if (!hideBlackKeys) g.blacks.push({ i, boundary: BLACK_BOUNDARY[chroma] ?? 1 });
    } else {
      g.whiteByCol.set(WHITE_COL[chroma] ?? 0, i);
    }
    groups.set(group, g);
  }
  /*
    收起黑键后，末尾可能剩下一整个「只有黑键」的八度组（音域正好收在黑键上）。
    那一行会渲染成 7 个空格子 —— 高 96px 的空白带，看着像布局坏了。整组跳过。
  */
  return [...groups.entries()]
    .filter(([, g]) => !hideBlackKeys || g.whiteByCol.size > 0)
    .sort((a, b) => a[0] - b[0]);
}

/** 这台键盘会画几排（= 几个八度组） */
export function octaveRowCount(
  keyPitches: readonly number[],
  keyCount: number,
  hideBlackKeys: boolean,
): number {
  return octaveGroups(keyPitches, keyCount, hideBlackKeys).length;
}

/** 一排的高度区间 → 整块键区的高度区间（`fill` 模式的调用方直接用） */
export function keyAreaHeightRange(rows: number): { minH: number; maxH: number } {
  const gaps = Math.max(0, rows - 1) * KEY_ROW_GAP;
  return {
    minH: rows * KEY_ROW_MIN_H + gaps,
    maxH: rows * KEY_ROW_MAX_H + gaps,
  };
}

export default function KeyLayout({
  keyCount,
  renderKey,
  keyPitches,
  hideBlackKeys = false,
  fill = false,
}: KeyLayoutProps) {
  if (!keyPitches) return <FallbackGrid keyCount={keyCount} renderKey={renderKey} />;
  return (
    <PianoLayout
      keyCount={keyCount}
      renderKey={renderKey}
      keyPitches={keyPitches}
      hideBlackKeys={hideBlackKeys}
      fill={fill}
    />
  );
}

/**
 * 兜底网格（调用方没给音高时）：按下标填 7 列。
 * 正常路径不会走到 —— 所有真实调用方都传 keyPitches。
 */
function FallbackGrid({ keyCount, renderKey }: KeyLayoutProps) {
  return (
    <div className="touch-play-area w-full">
      <div
        className="mx-auto grid w-full max-w-[1180px]"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gap: `${GAP_PX}px`,
        }}
      >
        {Array.from({ length: keyCount }, (_, i) => (
          <div key={i} className="h-[96px] min-w-0">
            {renderKey(i)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 键布局（钢琴几何）：每个八度一行；白键铺底、黑键压在缝隙上。
 *
 * 分组依据是**音高**（floor(pitch/12)）而不是下标 —— 混合工程
 * （自然音前缀 + 半音追加）里，每个键都能归到自己八度的正确位置。
 */
function PianoLayout({
  keyCount,
  renderKey,
  keyPitches = [],
  hideBlackKeys = false,
  fill = false,
}: KeyLayoutProps) {
  const ordered = octaveGroups(keyPitches, keyCount, hideBlackKeys);

  return (
    <div className={fill ? 'touch-play-area flex h-full min-h-0 w-full flex-col' : 'touch-play-area w-full'}>
      <div
        className={
          'mx-auto flex w-full min-w-0 max-w-[1180px] flex-col' +
          (fill ? ' h-full min-h-0 flex-1' : '')
        }
        style={{ gap: `${GAP_PX}px` }}
      >
        {ordered.map(([group, g]) => {
          /* 有黑键的行转平：黑键绝对定位在白键缝上，弧线会让两者错位 */
          const flat = g.blacks.length > 0;
          return (
            <div
              key={group}
              className={fill ? 'relative min-h-0 flex-1' : 'relative h-[96px]'}
            >
              {/*
                白键铺底：**恒定 7 列**，空列渲染成占位块。
                「尾组只有 1 个白键就只给 1 列」曾是 bug —— 那个键会被拉满整行宽度，
                且与上方的 C 错位（用户一眼就看出不对）。
              */}
              <div
                className="grid h-full"
                style={{
                  gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                  gap: `${GAP_PX}px`,
                }}
              >
                {Array.from({ length: COLS }, (_, col) => {
                  const i = g.whiteByCol.get(col);
                  const y = flat ? 0 : arcOffsetY(col, COLS, 5);
                  const rot = flat ? 0 : arcRotationDeg(col, COLS, 1.6);
                  return (
                    <div
                      key={col}
                      className="h-full min-w-0"
                      style={
                        flat || y === 0 && rot === 0
                          ? undefined
                          : { transform: `translateY(${y.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)` }
                      }
                    >
                      {i === undefined ? null : renderKey(i)}
                    </div>
                  );
                })}
              </div>
              {/*
                黑键压上层：center 对齐白键缝隙。
                缝隙 b（1..6）的精确位置 = b*(w+g) − g/2，其中 w = (100% − 6g)/7、g = 8px
                → calc(b·100/7 % + (b·8/7 − 4)px)，再 translateX(−50%) 居中。
                宽度 = 白键的 62% ≈ calc(0.62·(100% − 48px)/7)。
              */}
              {g.blacks.map(({ i, boundary }) => (
                <div
                  key={i}
                  className="absolute top-0 z-10 h-[58%]"
                  style={{
                    left: `calc(${(boundary * 100) / 7}% + ${(boundary * GAP_PX) / 7 - GAP_PX / 2}px)`,
                    width: `calc(${(0.62 * 100) / 7}% - ${(0.62 * 6 * GAP_PX) / 7}px)`,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {renderKey(i)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
