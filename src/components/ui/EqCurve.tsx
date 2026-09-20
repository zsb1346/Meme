/**
 * EqCurve —— Canvas 三段 EQ 频响曲线（VST 风格效果弹层套件）。
 *
 * 低架（low shelf）/ 峰值（peaking mid）/ 高架（high shelf）三节的
 * 幅度响应按 RBJ cookbook 双二阶公式逐点求和绘制；横轴对数频率
 * 20Hz–20kHz，纵轴 ±24 dB。三个节点可拖拽：纵向改增益，
 * 低/高节点横向改分频点（中频节点水平位置由两分频点的几何均值决定，
 * 不可单独拖动）。全部变更经 onChange 上抛，本组件不直接写 store。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getTokens, withAlpha } from '../../styles/getTokens';

export interface EqCurveChange {
  lowDb?: number;
  midDb?: number;
  highDb?: number;
  lowFrequencyHz?: number;
  highFrequencyHz?: number;
}

export interface EqCurveProps {
  lowDb: number;
  midDb: number;
  highDb: number;
  /** 低/中分频点 Hz */
  lowFreq: number;
  /** 中/高分频点 Hz */
  highFreq: number;
  onChange(patch: EqCurveChange): void;
  /** 画布高度 px（默认 144） */
  height?: number;
}

// ---------------------------------------------------------------------------
// 频响数学（RBJ cookbook，Fs 仅用于可视化，不影响音频）
// ---------------------------------------------------------------------------

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const DB_MIN = -24;
const DB_MAX = 24;
const SAMPLE_RATE = 48000;
const MID_Q = 1;

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** 双二阶传递函数在频率 f 处的幅度（dB） */
function magDbAt(c: BiquadCoeffs, f: number): number {
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const cosW = Math.cos(w);
  const cos2W = Math.cos(2 * w);
  const sinW = Math.sin(w);
  const sin2W = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cosW + c.b2 * cos2W;
  const numIm = c.b1 * sinW + c.b2 * sin2W;
  const denRe = c.a0 + c.a1 * cosW + c.a2 * cos2W;
  const denIm = c.a1 * sinW + c.a2 * sin2W;
  const mag =
    Math.sqrt(numRe * numRe + numIm * numIm) /
    Math.sqrt(denRe * denRe + denIm * denIm);
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

function lowShelfCoeffs(f0: number, gainDb: number): BiquadCoeffs {
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cosW0 = Math.cos(w0);
  const sq = Math.SQRT2 * Math.sin(w0); // S=1 → alpha·2√A 化简
  return {
    b0: a * (a + 1 - (a - 1) * cosW0 + sq),
    b1: 2 * a * (a - 1 - (a + 1) * cosW0),
    b2: a * (a + 1 - (a - 1) * cosW0 - sq),
    a0: a + 1 + (a - 1) * cosW0 + sq,
    a1: -2 * (a - 1 + (a + 1) * cosW0),
    a2: a + 1 + (a - 1) * cosW0 - sq,
  };
}

function highShelfCoeffs(f0: number, gainDb: number): BiquadCoeffs {
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cosW0 = Math.cos(w0);
  const sq = Math.SQRT2 * Math.sin(w0);
  return {
    b0: a * (a + 1 + (a - 1) * cosW0 + sq),
    b1: -2 * a * (a - 1 + (a + 1) * cosW0),
    b2: a * (a + 1 + (a - 1) * cosW0 - sq),
    a0: a + 1 - (a - 1) * cosW0 + sq,
    a1: 2 * (a - 1 - (a + 1) * cosW0),
    a2: a + 1 - (a - 1) * cosW0 - sq,
  };
}

function peakingCoeffs(f0: number, gainDb: number, q: number): BiquadCoeffs {
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: 1 + alpha * a,
    b1: -2 * cosW0,
    b2: 1 - alpha * a,
    a0: 1 + alpha / a,
    a1: -2 * cosW0,
    a2: 1 - alpha / a,
  };
}

/** 三节幅度响应之和（dB） */
function totalResponseDb(
  f: number,
  lowDb: number,
  midDb: number,
  highDb: number,
  lowFreq: number,
  highFreq: number,
): number {
  const midF = Math.sqrt(lowFreq * highFreq);
  return (
    magDbAt(lowShelfCoeffs(lowFreq, lowDb), f) +
    magDbAt(peakingCoeffs(midF, midDb, MID_Q), f) +
    magDbAt(highShelfCoeffs(highFreq, highDb), f)
  );
}

// ---------------------------------------------------------------------------
// 几何布局
// ---------------------------------------------------------------------------

interface CurveLayout {
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  xOf(f: number): number;
  fOf(x: number): number;
  yOf(db: number): number;
  dbOf(y: number): number;
}

function buildLayout(w: number, h: number): CurveLayout {
  const padL = 30;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const plotW = Math.max(w - padL - padR, 1);
  const plotH = Math.max(h - padT - padB, 1);
  const logMin = Math.log10(FREQ_MIN);
  const logSpan = Math.log10(FREQ_MAX) - logMin;
  return {
    padL,
    padR,
    padT,
    padB,
    xOf: (f) => padL + ((Math.log10(Math.max(f, FREQ_MIN)) - logMin) / logSpan) * plotW,
    fOf: (x) =>
      10 ** (logMin + ((Math.min(Math.max(x, padL), padL + plotW) - padL) / plotW) * logSpan),
    yOf: (db) =>
      padT +
      ((DB_MAX - Math.min(Math.max(db, DB_MIN), DB_MAX)) / (DB_MAX - DB_MIN)) * plotH,
    dbOf: (y) =>
      DB_MAX -
      ((Math.min(Math.max(y, padT), padT + plotH) - padT) / plotH) * (DB_MAX - DB_MIN),
  };
}

/** 按 step 量化并夹取 */
function snap(v: number, step: number, min: number, max: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Math.min(max, Math.max(min, Number((Math.round(v / step) * step).toFixed(decimals))));
}

/** 与 Knob.trimNum 同规则 */
function trimNum(n: number): string {
  return String(Number(n.toFixed(2)));
}

// 网格与交互常量
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;
const GRID_FREQ_LABELS: Record<number, string> = {
  50: '50',
  100: '100',
  200: '200',
  500: '500',
  1000: '1k',
  2000: '2k',
  5000: '5k',
  10000: '10k',
};
const GRID_DB = [12, 6, 0, -6, -12] as const;
const HIT_RADIUS_PX = 16;
const LOW_F_MIN = 50;
const LOW_F_MAX = 1000;
const HIGH_F_MIN = 500;
const HIGH_F_MAX = 16000;

type BandKey = 'low' | 'mid' | 'high';

export function EqCurve({
  lowDb,
  midDb,
  highDb,
  lowFreq,
  highFreq,
  onChange,
  height = 144,
}: EqCurveProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; band: BandKey } | null>(null);

  // 容器宽度自适应
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => buildLayout(width, height), [width, height]);
  const midFreq = Math.sqrt(lowFreq * highFreq);

  const nodes = useMemo(
    () => [
      { band: 'low' as const, f: lowFreq, db: lowDb },
      { band: 'mid' as const, f: midFreq, db: midDb },
      { band: 'high' as const, f: highFreq, db: highDb },
    ],
    [lowFreq, midFreq, lowDb, highFreq, highDb],
  );

  // —— 绘制 ——
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const monoFont = '9px ui-monospace, SFMono-Regular, Menlo, monospace';

    // 横向网格线 + dB 标签
    ctx.font = monoFont;
    ctx.textBaseline = 'middle';
    for (const db of GRID_DB) {
      const y = layout.yOf(db);
      ctx.strokeStyle = db === 0 ? 'rgba(110,129,119,0.9)' : 'rgba(44,54,47,0.55)';
      ctx.beginPath();
      ctx.moveTo(layout.padL, y);
      ctx.lineTo(width - layout.padR, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(157,176,165,0.9)';
      ctx.textAlign = 'right';
      ctx.fillText(db > 0 ? `+${db}` : String(db), layout.padL - 4, y);
    }

    // 纵向网格线 + 频率标签
    ctx.textBaseline = 'top';
    for (const f of GRID_FREQS) {
      const x = layout.xOf(f);
      ctx.strokeStyle = 'rgba(44,54,47,0.35)';
      ctx.beginPath();
      ctx.moveTo(x, layout.padT);
      ctx.lineTo(x, height - layout.padB);
      ctx.stroke();
      ctx.fillStyle = 'rgba(157,176,165,0.9)';
      ctx.textAlign = 'center';
      ctx.fillText(GRID_FREQ_LABELS[f], x, height - layout.padB + 3);
    }

    // 频响曲线（flame-500 电光青 + 辉光）
    const t = getTokens();
    const plotRight = width - layout.padR;
    const N = 180;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = layout.padL + (i / N) * (plotRight - layout.padL);
      const db = totalResponseDb(layout.fOf(x), lowDb, midDb, highDb, lowFreq, highFreq);
      const y = layout.yOf(db);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = t.flame500;
    ctx.lineWidth = 2;
    ctx.shadowColor = withAlpha(t.flame500, 0.55);
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 曲线到 0dB 线的渐变填充
    ctx.lineTo(plotRight, layout.yOf(0));
    ctx.lineTo(layout.padL, layout.yOf(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, layout.padT, 0, height - layout.padB);
    grad.addColorStop(0, withAlpha(t.flame500, 0.16));
    grad.addColorStop(1, withAlpha(t.flame500, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();

    // 波段节点
    nodes.forEach((n, i) => {
      const x = layout.xOf(n.f);
      const y = layout.yOf(n.db);
      const active = i === activeIdx;
      if (active) {
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(t.flame400, 0.18);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = t.ink900;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? t.flame300 : t.flame500;
      ctx.stroke();
    });

    // 激活节点的读数气泡
    if (activeIdx !== null) {
      const n = nodes[activeIdx];
      const x = layout.xOf(n.f);
      const y = layout.yOf(n.db);
      const freqText = n.f >= 1000 ? `${trimNum(n.f / 1000)}k` : trimNum(n.f);
      const text = `${freqText}Hz ${n.db > 0 ? '+' : ''}${trimNum(n.db)}dB`;
      ctx.font = monoFont;
      ctx.textBaseline = 'bottom';
      const nearRight = x > width - 80;
      ctx.textAlign = nearRight ? 'right' : 'left';
      ctx.fillStyle = withAlpha(t.flame300, 0.95);
      ctx.fillText(text, x + (nearRight ? -9 : 9), y - 9);
    }
  }, [layout, nodes, activeIdx, width, height, lowDb, midDb, highDb, lowFreq, highFreq]);

  // —— 交互 ——
  const hitTest = (x: number, y: number): number | null => {
    let best: number | null = null;
    let bestD = HIT_RADIUS_PX * HIT_RADIUS_PX;
    nodes.forEach((n, i) => {
      const dx = layout.xOf(n.f) - x;
      const dy = layout.yOf(n.db) - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const idx = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (idx === null) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragRef.current = { pointerId: ev.pointerId, band: nodes[idx].band };
    setActiveIdx(idx);
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const drag = dragRef.current;
    if (!drag || ev.pointerId !== drag.pointerId) {
      // 未拖拽 → 悬停高亮
      const idx = hitTest(x, y);
      if (idx !== activeIdx) setActiveIdx(idx);
      return;
    }
    const db = snap(layout.dbOf(y), 0.5, DB_MIN, DB_MAX);
    if (drag.band === 'mid') {
      onChange({ midDb: db });
      return;
    }
    if (drag.band === 'low') {
      const f = snap(layout.fOf(x), 5, LOW_F_MIN, Math.min(LOW_F_MAX, highFreq / 2));
      onChange({ lowDb: db, lowFrequencyHz: f });
    } else {
      const f = snap(layout.fOf(x), 50, Math.max(HIGH_F_MIN, lowFreq * 2), HIGH_F_MAX);
      onChange({ highDb: db, highFrequencyHz: f });
    }
  };

  const endDrag = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === ev.pointerId) dragRef.current = null;
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-lg border border-ink-700 bg-ink-950/60"
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor: activeIdx !== null ? 'grab' : 'crosshair' }}
        aria-label="三段均衡器频响曲线"
        role="img"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (!dragRef.current) setActiveIdx(null);
        }}
      />
    </div>
  );
}
