/**
 * RollCanvas 纯绘制层 —— 键道（KEY-LANE）坐标系版。
 *
 * 零 React、零 ref：`draw` 只读 RenderState 快照，不产生任何副作用。
 * 与播放相关的滚动跟随属于控制器，应在绘制前调用 geometry.followPlayhead。
 * 颜色从 ThemeTokens 注入，保证 canvas 与 CSS 使用同一色值来源。
 *
 * ══ 相对旧实现的改动（全部为了「像专业软件」而非「像网页」）══
 *
 *  1. **删掉全部 `ctx.shadowBlur`**。旧实现给每个音符块加外发光 ——
 *     那是每帧每块一次高斯模糊，既是性能杀手，也是廉价感的主要来源。
 *     选中态改用「描边 + 右上角小三角」，零模糊开销。
 *  2. **键盘栏改真钢琴外观**：按 MIDI 音高判定黑白键，白键亮面 + 黑键
 *     压暗且行高压缩到 70%，主音 C 左缘强调条。**只标 C 音**，其余行留白 ——
 *     旧实现每行都写唱名，14 行文字是画面上最大的噪音源。
 *  3. **取消八度交替底纹**。它和行分隔线表达同一件事，属于重复信息。
 *  4. **力度改左侧 3px 竖条**（旧实现是底部横条，白占块高）。
 *  5. **时间刻度与音符共用 geometry.timeToX**，修掉原型 1.667 倍尺度错位。
 *  6. **矩形选择框**（橡皮筋）与**幽灵残影**（拖拽预览）内置在本层。
 *
 * 绘制层级（自底向上）：
 *   底 → 键道行带 + 钢琴键盘栏 → 小节/拍网格 → 标尺 →
 *   幽灵残影 → 事件块 → 橡皮筋选框 → 播放头 → 键盘栏右缘分隔线 → 缩放读数
 */
import type { TakeEvent } from '../../model/types';
import { midiNoteName } from '../../model/pitch-map';
import { withAlpha, type ThemeTokens } from '../../styles/getTokens';
import {
  GUTTER_W,
  RULER_H,
  blockHeight,
  blockSize,
  blockTop,
  blockTopOfEvent,
  blockWidth,
  isBlackPitch,
  pickTimeStep,
  pitchOfLane,
  subdivisionsFor,
  formatRulerTime,
  timeToX,
} from './geometry';
import type { RollLayout, ViewState } from './geometry';

/** 橡皮筋选框（屏幕坐标，canvas 空间） */
export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 幽灵残影：拖拽中的目标预览 */
export interface GhostPreview {
  /** 每个被拖动事件的目标位置 */
  items: Array<{ tSec: number; lane: number; duration?: number }>;
  /** 是否吸附到网格（未吸附时用虚线，吸附时用实线） */
  snapped: boolean;
}

/** 单帧渲染快照：字段与 draw 实际读取的来源一一对应 */
export interface RenderState {
  w: number;
  h: number;
  dpr: number;
  view: ViewState;
  layout: RollLayout;
  events: TakeEvent[];
  /** 选中事件下标集合（多选） */
  selected: ReadonlySet<number>;
  /** 外部高亮事件下标（填词联动）；null 不绘制 */
  highlighted: number | null;
  /**
   * 正在装配编辑的**键道行**；null 不绘制。
   *
   * 与 `highlighted`（高亮某个事件块）不同：这是整行底色 + 左缘标记，
   * 目的是让用户在装配面板里一眼看到「我正在改卷帘的哪一行」，
   * 不必在左右两侧之间来回对照。
   */
  editingLane: number | null;
  /** 正在播放的事件下标（闪烁） */
  playingIndex: number | null;
  /** 播放头位置（秒）；<0 不绘制 */
  playheadSec: number;
  keyLabels?: string[];
  /**
   * 各键道行的权威音高（Key.pitchMidi 的逐行投影）。
   * 缺省时回落旧下标映射（pitchOfLane）—— 只应发生在「调用方没接 store」
   * 的演示/测试场景。
   */
  lanePitches?: number[];
  /**
   * 半音键已收起（演奏键盘上不摆黑键）。
   *
   * 卷帘**照常显示全部音高行** —— 它是数据视图，藏起一整行等于藏起那一行上的
   * 音符（用户会以为音符丢了）。但把黑键行标成「关着」：
   * 行带压得更暗、钢琴栏的黑键改画成**空心轮廓**，
   * 一眼看出「这排键存在、只是现在按不了」。
   */
  blackLanesDisabled?: boolean;
  /**
   * 此刻**正被按住**的键道行（电脑键盘弹奏 / 点击左侧钢琴栏）。
   *
   * 与 `editingLane` 的区别：那个是「我在编辑这一行」，持久、安静；
   * 这个是「这一下我按着」，瞬时、响亮。两者同时存在时后者覆盖前者。
   */
  pressedLanes?: ReadonlySet<number>;
  colors: ThemeTokens;
  /** 橡皮筋选框；null 不绘制 */
  marquee: MarqueeRect | null;
  /** 拖拽幽灵残影；null 不绘制 */
  ghost: GhostPreview | null;
  /** 时间吸附网格（秒）；用于标尺次刻度密度 */
  gridSec: number;
}

/** 字体栈（与 CSS 令牌一致） */
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Consolas, monospace';
/** 标尺 / 读数 / 选框读数共用的 10px 等宽字体串（提出来避免每帧新建） */
const mono10 = `10px ${MONO}`;

/**
 * 绘制一帧键道卷帘。
 * 所有 X/Y 公式来自 geometry，与 hitTest 严格共享。
 */
export function draw(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { w, h, dpr } = state;
  if (w < 2 || h < 2) return;

  const v = state.view;
  const l = state.layout;
  const c = state.colors;
  const keyCount = l.keyCount;
  const ph = state.playheadSec ?? -1;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // ── 底：页面底 ──
  ctx.fillStyle = c.ink950;
  ctx.fillRect(0, 0, w, h);

  const step = pickTimeStep(v.pps);
  const subdiv = subdivisionsFor(step);

  /* ══════════════════ 每帧只算一次的派生量（性能）══════════════════

     ⛔ 下面这些颜色/字体**必须提到所有逐元素循环之外**。

     原因：`withAlpha()` 与模板字符串看起来便宜，但它们原本被写在
     「逐行」和「逐音符块」的循环体里 —— 一个 1800 个可见块的画面，
     每帧要跑上千次 `正则 exec + 模板字符串`，而且每次产出的都是**新字符串**。
     更贵的是下游：`ctx.fillStyle = 'rgba(...)'` 每次赋一个新字符串，
     浏览器都要重新解析一次 CSS 颜色（CDP 采样里 `(program)` 占 43%，
     很大一块就是这个）。

     提到循环外之后，同一帧内每个色值只解析一次。

     ⚠️ 全部是**常量**，不含任何随行/随块变化的部分；改这里不会改变画面。
     ══════════════════════════════════════════════════════════════ */
  const COL = {
    /** 黑键行底部的深色分隔线 */
    rowBlackSep: 'rgba(0,0,0,0.35)',
    /** 键帽顶部高光 / 底部键缝（整条栏共用的立体语言） */
    capTopHi: 'rgba(255,255,255,0.07)',
    capBottomSep: 'rgba(0,0,0,0.55)',
    /** 键盘栏右缘分界（不画它白键面与白键行带会糊成一片） */
    gutterSep: 'rgba(0,0,0,0.85)',
    /** 被按住的整行提亮（瞬时态） */
    pressedRow: withAlpha(c.flame300, 0.13),
    /** 白键被按住：整个键帽点亮 */
    pressedCapWhite: withAlpha(c.flame400, 0.5),
    /** 黑键被按住：只在黑键自己的宽度内点亮 */
    pressedCapBlack: withAlpha(c.flame400, 0.62),
    /** 半音键已收起：黑键画成凹槽 */
    disabledBlackSlot: 'rgba(0,0,0,0.45)',
    disabledBlackEdge: withAlpha(c.flame400, 0.42),
    /** 黑键：右缘高光（键的侧面）+ 底缘投影 */
    blackCapEdge: 'rgba(255,255,255,0.16)',
    blackCapShadow: 'rgba(0,0,0,0.7)',
    /** 装配编辑中的键道：整行淡强调 + 左右亮条 */
    editingRow: withAlpha(c.flame400, 0.14),
    editingBar: withAlpha(c.flame300, 0.9),
    /** 主音 C：左缘强调条 + 时间线区淡强调底 */
    cBar: withAlpha(c.flame400, 0.95),
    cRowTint: withAlpha(c.flame400, 0.09),
    /** 行高压得很小时 C 行的唯一线索 */
    cTinyBar: withAlpha(c.flame300, 0.8),
    /** 次刻度 / 主刻度 */
    subTick: 'rgba(255,255,255,0.04)',
    /** 标尺底部分隔线 */
    rulerSep: 'rgba(0,0,0,0.45)',
    /* ── 事件块 ── */
    /** 块底暗线（让块从底上「立起来」） */
    blockBottom: withAlpha(c.flame700, 0.85),
    /** 块顶 1px 高光（常 / 选中或播放中） */
    blockTopHi: withAlpha(c.flame200, 0.6),
    blockTopHiHot: withAlpha(c.flame200, 0.95),
    /** 力度槽 + 力度条（常 / 选中） */
    velSlot: withAlpha(c.ink950, 0.45),
    velBar: withAlpha(c.flame200, 0.9),
    velBarSel: withAlpha(c.flame200, 1),
    /** 外部联动高亮：虚描边 */
    highlightEdge: withAlpha(c.flame200, 0.95),
    /** pressCount 文字 */
    blockLabel: withAlpha(c.ink950, 0.9),
    /* ── 选框 / 播放头 ── */
    marqueeFill: withAlpha(c.flame400, 0.1),
    marqueeEdge: withAlpha(c.flame300, 0.9),
    playheadTail: withAlpha(c.flame400, 0.4),
    /** 幽灵残影 */
    ghostFill: withAlpha(c.flame400, 0.14),
    ghostEdgeOn: withAlpha(c.flame300, 0.85),
    ghostEdgeOff: withAlpha(c.flame300, 0.5),
  };

  /*
    字体串同样是模板字符串 —— 每行、每块各建一次纯属浪费。
    行高决定字号，而整帧行高恒定，所以在帧首算好两个即可。
  */
  const fontPlan = {
    nameC: `700 ${l.rowH >= 20 ? 10 : 9}px ${MONO}`,
    nameNormal: `${l.rowH >= 20 ? 10 : 9}px ${MONO}`,
    mono10,
    mono9Bold: `700 9px ${MONO}`,
  };

  /*
    赋值去重：canvas 的 `fillStyle` / `strokeStyle` / `font` 都是**解析型**属性，
    反复赋同一个值也会重新解析。逐块绘制时色值在几个常量间来回切换，
    这里挡掉「与当前值相同」的赋值。

    ⛔ 只用做「挡重复」，绝不改变最终生效的值 —— 每个 setter 都保证
        `ctx.X === 最后一次传入的值`，所以画面与逐次赋值完全一致。
  */
  let curFill: string | CanvasGradient | null = null;
  let curStroke: string | CanvasGradient | null = null;
  let curFont = '';
  const setFill = (f: string | CanvasGradient): void => {
    if (f !== curFill) {
      ctx.fillStyle = f;
      curFill = f;
    }
  };
  const setStroke = (s: string | CanvasGradient): void => {
    if (s !== curStroke) {
      ctx.strokeStyle = s;
      curStroke = s;
    }
  };
  const setFont = (f: string): void => {
    if (f !== curFont) {
      ctx.font = f;
      curFont = f;
    }
  };
  /** 外部的 `ctx.save()/restore()` 会重置样式，切回来时必须让缓存失效 */
  const invalidateStyleCache = (): void => {
    curFill = null;
    curStroke = null;
    curFont = '';
  };

  /* ═══════════════════════════ 键道行带 + 钢琴键盘栏 ═══════════════════════════ */
  const firstRow = Math.max(0, Math.floor(v.sy / l.rowH));
  const lastRow = Math.min(keyCount - 1, Math.ceil((v.sy + l.viewH) / l.rowH));

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, w, h - RULER_H);
  ctx.clip();
  ctx.textBaseline = 'middle';

  for (let r = firstRow; r <= lastRow; r++) {
    const y = RULER_H + r * l.rowH - v.sy;
    // 权威音高 = 该行键的 pitchMidi（缺省回落旧映射，见 RenderState.lanePitches）
    const pitch = state.lanePitches?.[r] ?? pitchOfLane(r);
    const black = isBlackPitch(pitch);
    const pc = ((pitch % 12) + 12) % 12;
    const isC = pc === 0;
    /** 此刻被按住（电脑键盘弹奏 / 点击左侧钢琴栏） */
    const pressed = state.pressedLanes?.has(r) === true;
    /** 黑键且半音键已收起 → 这一格存在但现在按不了 */
    const disabledBlack = black && state.blackLanesDisabled === true;

    /* ── 时间线区：两级对比底色（用户反馈：对比度太低看不出行）──
       白键行（唱名行）用「浮起面」色，黑键行用「页面底」色。
       两者明度差 ≈ 20 级，行带一眼可辨；
       而行内保持纯色（不做渐变），避免和音符块抢注意力。 */
    setFill(black ? c.ink950 : c.laneKey);
    ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
    // 黑键行底压一道更深的横线，强化「这是一条窄带」
    if (black && l.rowH >= 10) {
      setFill(COL.rowBlackSep);
      ctx.fillRect(GUTTER_W, y + l.rowH - 1, l.viewW, 1);
    }
    // 被按住的整行提亮（瞬时态；画在行带之上、音符块之下，不遮内容）
    if (pressed) {
      setFill(COL.pressedRow);
      ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
    }

    /* ═══════════════════════════ 钢琴键盘栏 ═══════════════════════════
       每一行都先铺**琴键面**，黑键行也不例外 —— 真钢琴上黑键背后的位置
       是相邻白键的延续，黑键只是压在键缝上的一截短键。

       ⛔ 曾把黑键行整格留成页面底色（= 在左栏挖了个洞），于是左栏成了
       「灰条 + 黑洞 + 一个悬浮蓝框」的斑马纹，完全不像一排琴键
       （用户实报「左边的钢琴设计的有点丑，很割裂」）。
       判据：**任何一行的左栏都必须有一条连续的面**，洞就是 bug。 */
    const capTop = y + 1;
    const capH = Math.max(1, l.rowH - 2);
    setFill(isC ? c.ink700 : c.ink800);
    ctx.fillRect(0, y, GUTTER_W, l.rowH);
    // 键帽顶部高光 + 底部键缝（整条栏共用的立体语言）
    setFill(COL.capTopHi);
    ctx.fillRect(0, y, GUTTER_W, 1);
    setFill(COL.capBottomSep);
    ctx.fillRect(0, y + l.rowH - 1, GUTTER_W, 1);

    // 白键被按住：整个键帽点亮
    if (pressed && !black) {
      setFill(COL.pressedCapWhite);
      ctx.fillRect(0, capTop, GUTTER_W, capH);
    }

    if (black) {
      // 短键：右侧留出琴键面，比例接近真钢琴的黑键宽度
      const bw = Math.round(GUTTER_W * 0.58);
      if (disabledBlack) {
        /* 半音键已收起：「位置在、现在按不了」。
           画成**凹槽**（压暗 + 强调色细描边）而不是空心底上的悬浮框 ——
           底色现在有琴键面了，凹槽读起来才是「关着的键」。 */
        setFill(COL.disabledBlackSlot);
        ctx.fillRect(0, capTop, bw, capH);
        setStroke(COL.disabledBlackEdge);
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, capTop + 0.5, bw - 1, Math.max(1, capH - 1));
      } else {
        setFill(c.ink950);
        ctx.fillRect(0, capTop, bw, capH);
        // 右缘高光 = 键的侧面：让它看起来是「压在琴键面上的方块」而不是缺口
        setFill(COL.blackCapEdge);
        ctx.fillRect(bw - 1, capTop, 1, capH);
        // 底缘投影
        setFill(COL.blackCapShadow);
        ctx.fillRect(0, capTop + capH - 1, bw, 1);
        // 黑键被按住：只在黑键自己的宽度内点亮，保住黑白键的形状差异
        if (pressed) {
          setFill(COL.pressedCapBlack);
          ctx.fillRect(0, capTop, bw, capH);
        }
      }
    }

    /* 键盘栏右缘分界。不画这条线时，白键面（ink800）与白键行带（laneKey）
       直接相接，两片灰糊成一片 —— 这是「割裂」的另一半来源。 */
    setFill(COL.gutterSep);
    ctx.fillRect(GUTTER_W - 1, y, 1, l.rowH);

    /* 装配编辑中的键道：整行铺一层淡强调色 + 左缘亮条。
       画在行带之后、主音标记之前，保证 C 行的强调条仍然可见。 */
    if (state.editingLane === r) {
      setFill(COL.editingRow);
      ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
      setFill(COL.editingBar);
      ctx.fillRect(GUTTER_W, y, 3, l.rowH);
      ctx.fillRect(0, y, 2, l.rowH);
    }

    // 主音 C：左缘强调条（黑键行不可能是 C）
    if (isC) {
      setFill(COL.cBar);
      ctx.fillRect(0, y, 2, l.rowH);
      // C 行在时间线区铺一层淡强调底色，作为「八度从这里开始」的横向锚点。
      // 5% 太弱（几乎看不出），9% 才在深底上读得出来。
      setFill(COL.cRowTint);
      ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
    }

    /* ── 键盘栏文字：音名（C4 / D#5…）──
       全站统一科学音高记谱（见 pitch-map）。行高足够时每行都标，
       否则只给 C 行留一条强调缝，避免小行高下糊成一团。 */
    if (l.rowH >= 12) {
      ctx.textAlign = 'right';
      const name = midiNoteName(pitch);
      setFont(isC ? fontPlan.nameC : fontPlan.nameNormal);
      setFill(isC ? c.flame300 : black ? c.textMuted : c.textLo);
      ctx.fillText(name, GUTTER_W - 5, y + l.rowH / 2 + 0.5);
    } else if (isC) {
      // 行高压得很小时，只留一条强调条作为唯一定位线索
      setFill(COL.cTinyBar);
      ctx.fillRect(GUTTER_W - 3, y, 2, l.rowH);
    }
  }
  ctx.restore();
  // `restore()` 把样式回滚到 `save()` 时的值 → 上面的赋值缓存必须作废
  invalidateStyleCache();

  /* ═══════════════════════════ 时间网格 ═══════════════════════════ */
  const tStart = Math.max(0, Math.floor((v.sx / v.pps) / step) * step);
  const tEnd = (v.sx + l.viewW) / v.pps;
  const firstTick = Math.round(tStart / step);
  const lastTick = Math.ceil(tEnd / step);

  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER_W, RULER_H, l.viewW, h - RULER_H);
  ctx.clip();

  // 次刻度（拍）
  if (subdiv > 1 && step * v.pps > 26) {
    setStroke(COL.subTick);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = firstTick; i <= lastTick; i++) {
      for (let k = 1; k < subdiv; k++) {
        const x = Math.round(timeToX((i + k / subdiv) * step, v)) + 0.5;
        if (x < GUTTER_W || x > w) continue;
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, h);
      }
    }
    ctx.stroke();
  }

  // 主刻度（小节线）
  setStroke(c.ink600);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = firstTick; i <= lastTick; i++) {
    const x = Math.round(timeToX(i * step, v)) + 0.5;
    if (x < GUTTER_W || x > w) continue;
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.restore();
  invalidateStyleCache();

  /* ═══════════════════════════ 标尺 ═══════════════════════════ */
  setFill(c.ink900);
  ctx.fillRect(0, 0, w, RULER_H);
  setFill(COL.rulerSep);
  ctx.fillRect(0, RULER_H - 1, w, 1);

  // 左上角区块：键盘栏与标尺的交叉格
  setFill(c.ink800);
  ctx.fillRect(0, 0, GUTTER_W, RULER_H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER_W, 0, l.viewW, RULER_H);
  ctx.clip();
  setFont(mono10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // 刻度短线 + 时间文字
  for (let i = firstTick; i <= lastTick; i++) {
    const tSec = i * step;
    const x = Math.round(timeToX(tSec, v)) + 0.5;
    if (x < GUTTER_W - 1 || x > w) continue;
    setFill(c.textFaint);
    ctx.fillRect(x, RULER_H - 5, 1, 4);
    if (x > GUTTER_W - 1) {
      setFill(c.textMuted);
      ctx.fillText(formatRulerTime(tSec, step), x + 4, RULER_H / 2 - 0.5);
    }
  }
  ctx.restore();
  invalidateStyleCache();

  /* ═══════════════════════════ 幽灵残影（拖拽预览）═══════════════════════════ */
  if (state.ghost) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, RULER_H, l.viewW, h - RULER_H);
    ctx.clip();
    for (const g of state.ghost.items) {
      const { bw, bh } = blockSize(l.rowH, v.pps, g.duration);
      const x = timeToX(g.tSec, v);
      const y = blockTop(g.lane, l, v);
      if (x + bw < GUTTER_W || x > w || y + bh < RULER_H || y > h) continue;
      // 虚线轮廓 + 极淡填充：一眼看出「将要落到这里」
      setFill(COL.ghostFill);
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 3);
      ctx.fill();
      setStroke(state.ghost.snapped ? COL.ghostEdgeOn : COL.ghostEdgeOff);
      ctx.lineWidth = 1;
      ctx.setLineDash(state.ghost.snapped ? [] : [3, 3]);
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, bw - 1, bh - 1, 3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    invalidateStyleCache();
  }

  /* ═══════════════════════════ 事件块 ═══════════════════════════ */
  const events = state.events;
  if (events.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, RULER_H, l.viewW, h - RULER_H);
    ctx.clip();

    /*
      块体渐变：亮实底，而不是旧版的暗色。
      旧版用 flame600 → flame700（#1F6FD0 → #154F98），那是强调色阶的**暗端**，
      铺在近黑底上几乎糊成一片 —— 这就是用户说的「对比度太低」。
      现在用 flame400 → flame500（#409CFF → #2E8AEC）：
        · 与白键行底 #2C2C2E 对比 ≈ 3.7:1
        · 与黑键行底 #0E0E10 对比 ≈ 5.5:1
      都足以一眼分辨，且仍在同一强调色族内，不引入新色相。
      渐变只创建一次（旧实现每块新建一个 createLinearGradient）。
    */
    const grad = ctx.createLinearGradient(0, 0, 0, Math.max(l.rowH, 2));
    grad.addColorStop(0, c.flame400);
    grad.addColorStop(1, c.flame500);

    /*
      ⛔ 循环体里**不再调用** blockSize / blockTop / laneOf / timeToX。

      为什么：`blockSize` 每个事件都返回一个新对象 `{bw, bh}`。一个 4000 事件的
      素材，每帧就是 4000 次对象分配 —— 全是 GC 垃圾；而其中绝大多数根本不在
      屏幕上（原来的写法要算完 x、y 才 `continue`，等于白算）。

      这里改用 geometry 里**按值返回的内核**（`blockWidth` / `blockHeight` /
      `blockTopOfEvent`，零分配），并把最便宜的横向判定提到最前面：
      横向落空就 `continue`，连纵向都不必算。
      ⭐ 公式仍只有 geometry 那一份（内核就是 `blockSize` / `blockTop` 的实现），
      所以「看到的」与「点得到的」不可能分叉。
    */
    const pps = v.pps;
    const sx = v.sx;
    const sy = v.sy;
    const rowH = l.rowH;
    const bh = blockHeight(rowH);
    const sel = state.selected;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const bw = blockWidth(pps, ev.duration);
      const x = GUTTER_W + ev.tSec * pps - sx;
      if (x + bw < GUTTER_W || x > w) continue;
      const y = blockTopOfEvent(ev.keyIndex, rowH, keyCount, sy);
      if (y + bh < RULER_H || y > h) continue;

      const isSel = sel.has(i);
      const isHi = state.highlighted === i;
      const isPlaying = state.playingIndex === i;

      // 块体：亮实底 + 顶部 1px 高光。
      // 播放中的块用 flame200 提亮一档 —— 这是「正在响」的即时反馈。
      setFill(isPlaying ? c.flame200 : grad);
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 3);
      ctx.fill();

      // 底边收一道暗线，让块从底上「立起来」（无 glow 的立体做法）
      setFill(COL.blockBottom);
      ctx.fillRect(x + 1, y + bh - 1, Math.max(0, bw - 2), 1);

      setFill(isSel || isPlaying ? COL.blockTopHiHot : COL.blockTopHi);
      ctx.fillRect(x + 1.5, y + 1, Math.max(0, bw - 3), 1);

      // 力度：**左侧 3px 竖条**（旧实现是底部横条，白占块高）
      const vel =
        typeof ev.velocity === 'number'
          ? Math.max(0, Math.min(1, ev.velocity))
          : null;
      if (vel !== null && bw >= 8 && bh >= 6) {
        const barH = Math.max(2, (bh - 3) * vel);
        // 力度条用最亮端 + 深色底槽：亮条压在暗槽上才读得出「多少」
        setFill(COL.velSlot);
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1.5, 2.5, Math.max(2, bh - 3), 1);
        ctx.fill();
        setFill(isSel ? COL.velBarSel : COL.velBar);
        ctx.beginPath();
        ctx.roundRect(x + 1, y + bh - 1.5 - barH, 2.5, barH, 1);
        ctx.fill();
      }

      // 选中：2px 亮描边 + 右上角小三角。**没有 glow**。
      if (isSel) {
        setStroke(c.flame200);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, bw - 2, bh - 2, 3);
        ctx.stroke();
        if (bw >= 12 && bh >= 10) {
          setFill(c.ink950);
          ctx.beginPath();
          ctx.moveTo(x + bw - 2, y + 2);
          ctx.lineTo(x + bw - 2, y + 8);
          ctx.lineTo(x + bw - 8, y + 2);
          ctx.closePath();
          ctx.fill();
        }
      } else if (isHi) {
        // 外部联动高亮：虚描边，与选中态区分开
        setStroke(COL.highlightEdge);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.roundRect(x + 0.75, y + 0.75, bw - 1.5, bh - 1.5, 3);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // pressCount：仅块够大时才画（旧实现 14px 就画，极小缩放下糊成一片）
      if (bw >= 20 && bh >= 12) {
        setFill(COL.blockLabel);
        setFont(fontPlan.mono9Bold);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ev.pressCount), x + bw / 2 + 1, y + bh / 2 + 0.5);
      }
    }
    ctx.restore();
    invalidateStyleCache();
  }

  /* ═══════════════════════════ 橡皮筋选框 ═══════════════════════════ */
  if (state.marquee) {
    const { x0, y0, x1, y1 } = state.marquee;
    const mx = Math.min(x0, x1);
    const my = Math.min(y0, y1);
    const mw = Math.abs(x1 - x0);
    const mh = Math.abs(y1 - y0);
    if (mw > 1 || mh > 1) {
      setFill(COL.marqueeFill);
      ctx.fillRect(mx, my, mw, mh);
      setStroke(COL.marqueeEdge);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
      ctx.setLineDash([]);
      // 尺寸读数：贴在选框右下角，省去用户自己数格子
      setFont(mono10);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = `${(mw / v.pps).toFixed(2)}s`;
      setFill(c.ink950);
      const tw = ctx.measureText(label).width + 8;
      ctx.beginPath();
      ctx.roundRect(mx + mw - tw, my + mh + 3, tw, 15, 3);
      ctx.fill();
      setFill(c.flame200);
      ctx.fillText(label, mx + mw - tw + 4, my + mh + 11);
    }
  }

  /* ═══════════════════════════ 播放头 ═══════════════════════════ */
  if (ph >= 0) {
    const x = timeToX(ph, v);
    if (x >= GUTTER_W && x <= w) {
      // 竖线：上端实、下端渐隐（用两段近似，避免每帧建渐变）
      setFill(c.flame400);
      ctx.fillRect(x - 0.75, 0, 1.5, h * 0.72);
      setFill(COL.playheadTail);
      ctx.fillRect(x - 0.75, h * 0.72, 1.5, h * 0.28);
      // 水滴形头部（不是三角）——顶部圆角、底部收尖
      setFill(c.flame300);
      ctx.beginPath();
      ctx.moveTo(x - 4.5, 1);
      ctx.lineTo(x + 4.5, 1);
      ctx.lineTo(x + 4.5, RULER_H - 8);
      ctx.quadraticCurveTo(x + 4.5, RULER_H - 1, x, RULER_H + 1);
      ctx.quadraticCurveTo(x - 4.5, RULER_H - 1, x - 4.5, RULER_H - 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ═══════════════════════════ 分隔与读数 ═══════════════════════════ */
  // 键盘栏右缘
  setFill(c.ink600);
  ctx.fillRect(GUTTER_W - 1, 0, 1, h);

  // 右下角缩放读数（弱化；它是「我在哪」的信息，不是装饰）
  setFont(mono10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  setFill(c.textFaint);
  ctx.fillText(`${Math.round(v.pps)} px/s`, w - 6, h - 5);
}
