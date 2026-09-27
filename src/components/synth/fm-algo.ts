/**
 * FM 算法矩阵的**图形几何**（纯函数，无 React、无 DOM）。
 *
 * 移植自原型 `VFX.html::fmAlgoGlyph` —— 那张图是用户自己排出来的：
 * 4 个算子自上而下（1 号最靠输出总线），方框 = 会发声的算子，
 * 箭头 = 调频方向，右侧引到底部总线的竖轨 = 直接进混音器。
 *
 * ⚠️ 为什么把几何从组件里抠出来：这段代码全是「算坐标」，而算错坐标的表现是
 * **图静静地画错**（箭头指反、方框压住连线、坐标 NaN 直接整块不渲染）——
 * 没有任何运行时报错。抠成纯函数之后 `fm-algo.test.ts` 能逐条断言
 * 「4 个方框都在视口内」「发声算子数 = 输出轨数」「没有 NaN」。
 *
 * ⛔ 坐标一律用**原型的原始数值**，别顺手「优化」间距：算子框、跨级竖轨的
 * 横向偏移量（`15 - skipN*7`）都是为了让连线不压在方框上，改一个数就乱。
 */

import { FM_ALGOS } from '../../engine/synth/patch';

/** 视口尺寸（原型的 viewBox） */
export const FM_GLYPH_W = 64;
export const FM_GLYPH_H = 74;
/** 算子框中心的横坐标 */
export const FM_GLYPH_CX = 32;
/** 算子框尺寸 */
const BOX_W = 22;
const BOX_H = 11;
const BOX_X = 21;
/** 算子 1 中心的纵坐标；往上每级 −14 */
const Y_OP1 = 58;
const Y_STEP = 14;
/** 输出总线（底部那条横线）的纵坐标 */
const BUS_Y = 67;
/** 箭头三角的宽度 */
const ARROW_W = 2.8;

/** 算子 i（1..4）中心的 y */
export function fmOpY(i: number): number {
  return Y_OP1 - (i - 1) * Y_STEP;
}
/** 算子 i 方框的上 / 下边 */
function boxTop(i: number): number {
  return fmOpY(i) - BOX_H / 2;
}
function boxBot(i: number): number {
  return fmOpY(i) + BOX_H / 2;
}

export interface FmBox {
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 是否直接发声（原型里表现为描边不透明 + 文字不满透明） */
  isOut: boolean;
}

export interface FmAlgoGlyph {
  /** 算子方框 */
  boxes: FmBox[];
  /** 调制连线（直线或折线）的 `d` */
  edges: string[];
  /** 箭头三角的 `d`（与 `edges` 一一对应） */
  arrows: string[];
  /** 输出轨的 `d`（从发声中算子的右边缘引到底部总线） */
  rails: string[];
  /** 输出轨末端的小圆点 */
  dots: Array<{ cx: number; cy: number }>;
}

/**
 * 一张算法的图形。
 *
 * `skipN` 是原型里那个「跨级竖轨的横向避让计数器」：每用一条绕行轨就往左挪 7px，
 * 否则同一张图里两条跨级连线会重叠成一条，看起来像少了一条调制边。
 */
/**
 * 把任意输入夹到合法的算法下标。
 *
 * ⛔ 必须显式判 `Number.isFinite`：`Math.round(NaN)` 是 `NaN`，
 * 而 `Math.max(0, NaN)` / `Math.min(7, NaN)` 也还是 `NaN` ——
 * 于是 `FM_ALGOS[NaN]` 是 `undefined`，读 `.out` 当场抛，
 * **整个算法矩阵（连同它所在的 React 子树）直接不渲染**。
 * 面板的值来自存档，脏值是真会出现的（见 `sanitizeSynthPatch` 的存在理由）。
 */
function algoIndex(idx: number): number {
  if (!Number.isFinite(idx)) return 0;
  return Math.min(FM_ALGOS.length - 1, Math.max(0, Math.round(idx)));
}

export function fmAlgoGlyph(algoIdx: number): FmAlgoGlyph {
  const algo = FM_ALGOS[algoIndex(algoIdx)];

  const boxes: FmBox[] = [];
  for (let i = 1; i <= 4; i++) {
    boxes.push({
      i,
      x: BOX_X,
      y: boxTop(i),
      w: BOX_W,
      h: BOX_H,
      isOut: algo.out.indexOf(i) >= 0,
    });
  }

  // 输出轨：从发声中算子的右边缘水平拉出，再竖直到总线；多个输出各占一条竖轨
  const rails: string[] = [];
  const dots: Array<{ cx: number; cy: number }> = [];
  algo.out
    .slice()
    .sort((a, b) => b - a)
    .forEach((k, idx) => {
      const rx = 50 + idx * 7;
      rails.push(`M43 ${fmOpY(k)} H${rx} V${BUS_Y}`);
      dots.push({ cx: rx, cy: BUS_Y });
    });

  // 调制边：相邻算子直连；跨级的绕到左侧竖轨，避免压住中间的算子框
  const edges: string[] = [];
  const arrows: string[] = [];
  let skipN = 0;
  for (const [a, b] of algo.edges) {
    if (b === a - 1) {
      edges.push(`M${FM_GLYPH_CX} ${boxBot(a)} V${boxTop(b) - ARROW_W - 0.8}`);
      arrows.push(
        `M${FM_GLYPH_CX - ARROW_W} ${boxTop(b) - ARROW_W - 0.8}` +
          ` H${FM_GLYPH_CX + ARROW_W} L${FM_GLYPH_CX} ${boxTop(b)} Z`,
      );
    } else {
      const lx = 15 - skipN++ * 7;
      edges.push(`M${BOX_X} ${fmOpY(a)} H${lx} V${fmOpY(b)} H${BOX_X - 3.6}`);
      arrows.push(
        `M${BOX_X - 3.6} ${fmOpY(b) - ARROW_W} V${fmOpY(b) + ARROW_W} L${BOX_X} ${fmOpY(b)} Z`,
      );
    }
  }

  return { boxes, edges, arrows, rails, dots };
}

/** 图下方的说明文案（原型的 `cap`） */
export function fmAlgoCaption(algoIdx: number): string {
  const cur = algoIndex(algoIdx);
  return `算法 ${cur + 1}/${FM_ALGOS.length} · ${FM_ALGOS[cur].name}`;
}

/** 全部 8 张图的几何（面板一次画完，切算法只是换高亮） */
export function fmAlgoGlyphAll(): FmAlgoGlyph[] {
  return FM_ALGOS.map((_a, i) => fmAlgoGlyph(i));
}
