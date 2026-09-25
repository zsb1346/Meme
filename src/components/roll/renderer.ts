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
  blockSize,
  blockTop,
  isBlackPitch,
  laneOf,
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

    /* ── 时间线区：两级对比底色（用户反馈：对比度太低看不出行）──
       白键行（唱名行）用「浮起面」色，黑键行用「页面底」色。
       两者明度差 ≈ 20 级，行带一眼可辨；
       而行内保持纯色（不做渐变），避免和音符块抢注意力。 */
    ctx.fillStyle = black ? c.ink950 : c.laneKey;
    ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
    // 黑键行底压一道更深的横线，强化「这是一条窄带」
    if (black && l.rowH >= 10) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(GUTTER_W, y + l.rowH - 1, l.viewW, 1);
    }

    // ── 钢琴键盘栏 ──
    // 黑键：压暗 + 内缩（右缘留出白键可见 1/3），模拟真钢琴的短黑键
    if (black) {
      const bw = GUTTER_W * 0.6;
      if (state.blackLanesDisabled) {
        /* 半音键已收起：黑键画成**空心轮廓** —— 「位置在、现在是关着的」。
           行带底色不再加深（音符块还要在这行上清楚可读）。 */
        ctx.strokeStyle = withAlpha(c.flame400, 0.45);
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y + 0.5, bw - 1, Math.max(1, l.rowH - 1));
      } else {
        ctx.fillStyle = c.ink950;
        ctx.fillRect(0, y, bw, l.rowH);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, y, bw, 1);
        ctx.fillRect(bw - 1, y, 1, l.rowH);
      }
    } else {
      ctx.fillStyle = c.ink800;
      ctx.fillRect(0, y, GUTTER_W, l.rowH);
      // 白键顶部 1px 内高光（与面板同一套立体语言）
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, y, GUTTER_W, 1);
      // 白键之间的缝隙
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, y + l.rowH - 1, GUTTER_W, 1);
    }

    /* 装配编辑中的键道：整行铺一层淡强调色 + 左缘亮条。
       画在行带之后、主音标记之前，保证 C 行的强调条仍然可见。 */
    if (state.editingLane === r) {
      ctx.fillStyle = withAlpha(c.flame400, 0.14);
      ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
      ctx.fillStyle = withAlpha(c.flame300, 0.9);
      ctx.fillRect(GUTTER_W, y, 3, l.rowH);
      ctx.fillRect(0, y, 2, l.rowH);
    }

    // 主音 C：左缘强调条（黑键行不可能是 C）
    if (isC) {
      ctx.fillStyle = withAlpha(c.flame400, 0.95);
      ctx.fillRect(0, y, 2, l.rowH);
      // C 行在时间线区铺一层淡强调底色，作为「八度从这里开始」的横向锚点。
      // 5% 太弱（几乎看不出），9% 才在深底上读得出来。
      ctx.fillStyle = withAlpha(c.flame400, 0.09);
      ctx.fillRect(GUTTER_W, y, l.viewW, l.rowH);
    }

    /* ── 键盘栏文字：音名（C4 / D#5…）──
       全站统一科学音高记谱（见 pitch-map）。行高足够时每行都标，
       否则只给 C 行留一条强调缝，避免小行高下糊成一团。 */
    if (l.rowH >= 12) {
      ctx.textAlign = 'right';
      const name = midiNoteName(pitch);
      ctx.font = isC
        ? `700 ${l.rowH >= 20 ? 10 : 9}px ${MONO}`
        : `${l.rowH >= 20 ? 10 : 9}px ${MONO}`;
      ctx.fillStyle = isC ? c.flame300 : black ? c.textMuted : c.textLo;
      ctx.fillText(name, GUTTER_W - 5, y + l.rowH / 2 + 0.5);
    } else if (isC) {
      // 行高压得很小时，只留一条强调条作为唯一定位线索
      ctx.fillStyle = withAlpha(c.flame300, 0.8);
      ctx.fillRect(GUTTER_W - 3, y, 2, l.rowH);
    }
  }
  ctx.restore();

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
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
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
  ctx.strokeStyle = c.ink600;
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

  /* ═══════════════════════════ 标尺 ═══════════════════════════ */
  ctx.fillStyle = c.ink900;
  ctx.fillRect(0, 0, w, RULER_H);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, RULER_H - 1, w, 1);

  // 左上角区块：键盘栏与标尺的交叉格
  ctx.fillStyle = c.ink800;
  ctx.fillRect(0, 0, GUTTER_W, RULER_H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER_W, 0, l.viewW, RULER_H);
  ctx.clip();
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // 刻度短线 + 时间文字
  for (let i = firstTick; i <= lastTick; i++) {
    const tSec = i * step;
    const x = Math.round(timeToX(tSec, v)) + 0.5;
    if (x < GUTTER_W - 1 || x > w) continue;
    ctx.fillStyle = c.textFaint;
    ctx.fillRect(x, RULER_H - 5, 1, 4);
    if (x > GUTTER_W - 1) {
      ctx.fillStyle = c.textMuted;
      ctx.fillText(formatRulerTime(tSec, step), x + 4, RULER_H / 2 - 0.5);
    }
  }
  ctx.restore();

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
      ctx.fillStyle = withAlpha(c.flame400, 0.14);
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 3);
      ctx.fill();
      ctx.strokeStyle = withAlpha(c.flame300, state.ghost.snapped ? 0.85 : 0.5);
      ctx.lineWidth = 1;
      ctx.setLineDash(state.ghost.snapped ? [] : [3, 3]);
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, bw - 1, bh - 1, 3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
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

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const { bw, bh } = blockSize(l.rowH, v.pps, ev.duration);
      const x = timeToX(ev.tSec, v);
      const y = blockTop(laneOf(ev, keyCount), l, v);
      if (x + bw < GUTTER_W || x > w || y + bh < RULER_H || y > h) continue;

      const isSel = state.selected.has(i);
      const isHi = state.highlighted === i;
      const isPlaying = state.playingIndex === i;

      // 块体：亮实底 + 顶部 1px 高光。
      // 播放中的块用 flame200 提亮一档 —— 这是「正在响」的即时反馈。
      ctx.fillStyle = isPlaying ? c.flame200 : grad;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 3);
      ctx.fill();

      // 底边收一道暗线，让块从底上「立起来」（无 glow 的立体做法）
      ctx.fillStyle = withAlpha(c.flame700, 0.85);
      ctx.fillRect(x + 1, y + bh - 1, Math.max(0, bw - 2), 1);

      ctx.fillStyle = withAlpha(c.flame200, isSel || isPlaying ? 0.95 : 0.6);
      ctx.fillRect(x + 1.5, y + 1, Math.max(0, bw - 3), 1);

      // 力度：**左侧 3px 竖条**（旧实现是底部横条，白占块高）
      const vel =
        typeof ev.velocity === 'number'
          ? Math.max(0, Math.min(1, ev.velocity))
          : null;
      if (vel !== null && bw >= 8 && bh >= 6) {
        const barH = Math.max(2, (bh - 3) * vel);
        // 力度条用最亮端 + 深色底槽：亮条压在暗槽上才读得出「多少」
        ctx.fillStyle = withAlpha(c.ink950, 0.45);
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1.5, 2.5, Math.max(2, bh - 3), 1);
        ctx.fill();
        ctx.fillStyle = withAlpha(c.flame200, isSel ? 1 : 0.9);
        ctx.beginPath();
        ctx.roundRect(x + 1, y + bh - 1.5 - barH, 2.5, barH, 1);
        ctx.fill();
      }

      // 选中：2px 亮描边 + 右上角小三角。**没有 glow**。
      if (isSel) {
        ctx.strokeStyle = c.flame200;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, bw - 2, bh - 2, 3);
        ctx.stroke();
        if (bw >= 12 && bh >= 10) {
          ctx.fillStyle = c.ink950;
          ctx.beginPath();
          ctx.moveTo(x + bw - 2, y + 2);
          ctx.lineTo(x + bw - 2, y + 8);
          ctx.lineTo(x + bw - 8, y + 2);
          ctx.closePath();
          ctx.fill();
        }
      } else if (isHi) {
        // 外部联动高亮：虚描边，与选中态区分开
        ctx.strokeStyle = withAlpha(c.flame200, 0.95);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.roundRect(x + 0.75, y + 0.75, bw - 1.5, bh - 1.5, 3);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // pressCount：仅块够大时才画（旧实现 14px 就画，极小缩放下糊成一片）
      if (bw >= 20 && bh >= 12) {
        ctx.fillStyle = withAlpha(c.ink950, 0.9);
        ctx.font = `700 9px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ev.pressCount), x + bw / 2 + 1, y + bh / 2 + 0.5);
      }
    }
    ctx.restore();
  }

  /* ═══════════════════════════ 橡皮筋选框 ═══════════════════════════ */
  if (state.marquee) {
    const { x0, y0, x1, y1 } = state.marquee;
    const mx = Math.min(x0, x1);
    const my = Math.min(y0, y1);
    const mw = Math.abs(x1 - x0);
    const mh = Math.abs(y1 - y0);
    if (mw > 1 || mh > 1) {
      ctx.fillStyle = withAlpha(c.flame400, 0.1);
      ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = withAlpha(c.flame300, 0.9);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
      ctx.setLineDash([]);
      // 尺寸读数：贴在选框右下角，省去用户自己数格子
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = `${(mw / v.pps).toFixed(2)}s`;
      ctx.fillStyle = c.ink950;
      const tw = ctx.measureText(label).width + 8;
      ctx.beginPath();
      ctx.roundRect(mx + mw - tw, my + mh + 3, tw, 15, 3);
      ctx.fill();
      ctx.fillStyle = c.flame200;
      ctx.fillText(label, mx + mw - tw + 4, my + mh + 11);
    }
  }

  /* ═══════════════════════════ 播放头 ═══════════════════════════ */
  if (ph >= 0) {
    const x = timeToX(ph, v);
    if (x >= GUTTER_W && x <= w) {
      // 竖线：上端实、下端渐隐（用两段近似，避免每帧建渐变）
      ctx.fillStyle = c.flame400;
      ctx.fillRect(x - 0.75, 0, 1.5, h * 0.72);
      ctx.fillStyle = withAlpha(c.flame400, 0.4);
      ctx.fillRect(x - 0.75, h * 0.72, 1.5, h * 0.28);
      // 水滴形头部（不是三角）——顶部圆角、底部收尖
      ctx.fillStyle = c.flame300;
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
  ctx.fillStyle = c.ink600;
  ctx.fillRect(GUTTER_W - 1, 0, 1, h);

  // 右下角缩放读数（弱化；它是「我在哪」的信息，不是装饰）
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = c.textFaint;
  ctx.fillText(`${Math.round(v.pps)} px/s`, w - 6, h - 5);
}
