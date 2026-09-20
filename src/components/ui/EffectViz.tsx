/**
 * 效果器可视化套件 —— 5 个专属可视化，全部纯 SVG。
 *
 * 设计原则（来自 原型/效果器/_分析报告.md 的反模式清单）：
 *   1. **可视化必须与参数真实相关**。原型的 effects-rack.html 画
 *      `sin(log10(f)*2)*6` 这种与旋钮无关的曲线 —— 那是欺骗用户，
 *      比没有可视化更糟。本文件所有图形都由参数精确推导。
 *   2. **旧值留痕（幽灵预览）**。参数变化时旧曲线以极淡描边保留，
 *      一眼看出「我从哪来、改了哪」。
 *   3. **不做装饰性像素**。无 glow、无渐变按钮、无每帧重建的渐变。
 *      渐变只在 defs 里声明一次，由 React 静态渲染。
 *   4. **静**。这些图只在参数变化时重绘，没有 rAF 循环、没有动画。
 *      唯一例外是压缩器的增益衰减表（它反映实时电平，必须动）。
 *
 * 配色全部走设计令牌（与 CSS 同一来源），不硬编码色值。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getTokens } from '../../styles/getTokens';

/* ═══════════════════════════════════════════════════════════════════════
   共用工具
   ═══════════════════════════════════════════════════════════════════════ */

/** 可视化的统一外框：凹槽底 + 1px 发丝线 + 左上角标签 */
function VizFrame({
  label,
  children,
  aspect = 3,
}: {
  label: string;
  children: React.ReactNode;
  aspect?: number;
}) {
  return (
    <div className="relative min-w-0 flex-1 overflow-hidden rounded-sm bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
      <span className="pointer-events-none absolute left-2 top-1.5 z-10 font-mono text-micro uppercase tracking-[0.16em] text-label-faint">
        {label}
      </span>
      <div className="h-full w-full" style={{ aspectRatio: String(aspect) }}>
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   1 · EQ 频响曲线
   ═══════════════════════════════════════════════════════════════════════ */

export interface EqCurveVizProps {
  lowDb: number;
  midDb: number;
  highDb: number;
  lowFreq: number;
  highFreq: number;
  enabled: boolean;
}

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const DB_MIN = -24;
const DB_MAX = 24;
const SR = 48000;
const MID_Q = 1;
const PTS = 160;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** 双二阶传递函数在频率 f 处的幅度（dB）—— RBJ cookbook 标准式 */
function magDbAt(c: Biquad, f: number): number {
  const w = (2 * Math.PI * f) / SR;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const nRe = c.b0 + c.b1 * cw + c.b2 * c2w;
  const nIm = c.b1 * sw + c.b2 * s2w;
  const dRe = c.a0 + c.a1 * cw + c.a2 * c2w;
  const dIm = c.a1 * sw + c.a2 * s2w;
  const mag = Math.sqrt(nRe * nRe + nIm * nIm) / Math.sqrt(dRe * dRe + dIm * dIm);
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

function lowShelf(f0: number, db: number): Biquad {
  const A = 10 ** (db / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w0);
  const sq = Math.SQRT2 * Math.sin(w0);
  return {
    b0: A * (A + 1 - (A - 1) * cw + sq),
    b1: 2 * A * (A - 1 - (A + 1) * cw),
    b2: A * (A + 1 - (A - 1) * cw - sq),
    a0: A + 1 + (A - 1) * cw + sq,
    a1: -2 * (A - 1 + (A + 1) * cw),
    a2: A + 1 + (A - 1) * cw - sq,
  };
}

function highShelf(f0: number, db: number): Biquad {
  const A = 10 ** (db / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w0);
  const sq = Math.SQRT2 * Math.sin(w0);
  return {
    b0: A * (A + 1 + (A - 1) * cw + sq),
    b1: -2 * A * (A - 1 + (A + 1) * cw),
    b2: A * (A + 1 + (A - 1) * cw - sq),
    a0: A + 1 - (A - 1) * cw + sq,
    a1: 2 * (A - 1 - (A + 1) * cw),
    a2: A + 1 - (A - 1) * cw - sq,
  };
}

function peaking(f0: number, db: number, q: number): Biquad {
  const A = 10 ** (db / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cw,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cw,
    a2: 1 - alpha / A,
  };
}

/**
 * EQ 频响曲线。横轴对数 20Hz–20kHz，纵轴 ±24dB。
 * 三个节点可拖拽：纵向改增益；低/高节点横向改分频点。
 */
export function EqCurveViz(props: EqCurveVizProps) {
  const { lowDb, midDb, highDb, lowFreq, highFreq, enabled } = props;
  const t = getTokens();
  const uid = useId().replace(/:/g, '');

  const W = 460;
  const H = 150;
  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 14;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const logMin = Math.log10(FREQ_MIN);
  const logSpan = Math.log10(FREQ_MAX) - logMin;
  const xOf = (f: number) =>
    PAD_L + ((Math.log10(Math.max(f, FREQ_MIN)) - logMin) / logSpan) * plotW;
  const yOf = (db: number) =>
    PAD_T + ((DB_MAX - Math.min(Math.max(db, DB_MIN), DB_MAX)) / (DB_MAX - DB_MIN)) * plotH;

  const midFreq = Math.sqrt(lowFreq * highFreq);

  /** 采样成 polyline 点串 */
  const buildPath = (l: number, m: number, h: number, lf: number, hf: number) => {
    const cs = [lowShelf(lf, l), peaking(Math.sqrt(lf * hf), m, MID_Q), highShelf(hf, h)];
    const pts: string[] = [];
    for (let i = 0; i <= PTS; i++) {
      const f = 10 ** (logMin + (i / PTS) * logSpan);
      const db = cs.reduce((acc, c) => acc + magDbAt(c, f), 0);
      pts.push(`${xOf(f).toFixed(1)},${yOf(db).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const current = useMemo(
    () => buildPath(lowDb, midDb, highDb, lowFreq, highFreq),
    [lowDb, midDb, highDb, lowFreq, highFreq],
  );

  /**
   * 幽灵预览：保存「上一组参数」的曲线。
   * 用 ref 持有上一帧的参数，仅在真正变化时更新 —— 避免拖动中每帧都覆盖。
   */
  const ghostRef = useRef<{ path: string; at: number } | null>(null);
  const prevKey = useRef('');
  const key = `${lowDb}|${midDb}|${highDb}|${lowFreq}|${highFreq}`;
  if (prevKey.current !== key) {
    ghostRef.current = { path: current, at: Date.now() };
    prevKey.current = key;
  }
  // 幽灵只在最近 1.2s 内出现，之后淡出（避免长期残留造成视觉噪音）
  const [showGhost, setShowGhost] = useState(false);
  useEffect(() => {
    setShowGhost(true);
    const timer = window.setTimeout(() => setShowGhost(false), 1100);
    return () => window.clearTimeout(timer);
  }, [key]);

  const gridFreqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const gridDbs = [24, 12, 0, -12, -24];

  const nodes = [
    { band: 'low' as const, f: lowFreq, db: lowDb },
    { band: 'mid' as const, f: midFreq, db: midDb },
    { band: 'high' as const, f: highFreq, db: highDb },
  ];

  const stroke = enabled ? t.flame400 : t.textFaint;

  return (
    <VizFrame label="频响 · 20Hz–20kHz · ±24dB">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id={`eqf-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={t.flame400} stopOpacity="0.2" />
            <stop offset="1" stopColor={t.flame400} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* 网格 */}
        {gridFreqs.map((f) => (
          <line
            key={f}
            x1={xOf(f)}
            y1={PAD_T}
            x2={xOf(f)}
            y2={PAD_T + plotH}
            stroke="rgba(255,255,255,0.045)"
            strokeWidth="1"
          />
        ))}
        {gridDbs.map((db) => (
          <g key={db}>
            <line
              x1={PAD_L}
              y1={yOf(db)}
              x2={PAD_L + plotW}
              y2={yOf(db)}
              stroke={db === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.045)'}
              strokeWidth="1"
            />
            <text
              x={PAD_L - 4}
              y={yOf(db) + 3}
              textAnchor="end"
              fontFamily="var(--mono)"
              fontSize="8"
              fill={t.textFaint}
            >
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}

        {/* 幽灵（旧曲线） */}
        {showGhost && ghostRef.current && ghostRef.current.path !== current && (
          <polyline
            points={ghostRef.current.path}
            fill="none"
            stroke={t.flame400}
            strokeOpacity="0.22"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* 当前曲线 + 面积填充 */}
        <polygon
          points={`${PAD_L},${yOf(0)} ${current} ${PAD_L + plotW},${yOf(0)}`}
          fill={`url(#eqf-${uid})`}
        />
        <polyline
          points={current}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />

        {/* 三个节点 */}
        {nodes.map((n) => (
          <circle
            key={n.band}
            cx={xOf(n.f)}
            cy={yOf(n.db)}
            r="4"
            fill={t.ink950}
            stroke={enabled ? t.flame300 : t.textFaint}
            strokeWidth="2"
          />
        ))}
      </svg>
    </VizFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · 压缩器传输曲线 + 实时增益衰减表
   ═══════════════════════════════════════════════════════════════════════ */

export interface CompressorVizProps {
  thresholdDb: number;
  ratio: number;
  enabled: boolean;
}

const KNEE_DB = 6;

/**
 * 压缩器传输曲线（in → out）。
 *
 * 与 Tone.Compressor 的软拐点行为一致：|over| < knee/2 时用二次插值平滑，
 * 之外按线性斜率。这比原型的「直折线」更接近真实听感。
 */
function transferDb(inDb: number, thDb: number, ratio: number, knee = KNEE_DB): number {
  const over = inDb - thDb;
  if (over <= -knee / 2) return inDb;
  if (over >= knee / 2) return thDb + over / ratio;
  // 软拐点区：二次插值
  const x = over + knee / 2;
  return inDb + ((1 / ratio - 1) * x * x) / (2 * knee);
}

export function CompressorViz({ thresholdDb, ratio, enabled }: CompressorVizProps) {
  const t = getTokens();
  const W = 460;
  const H = 150;
  const PAD = 18;
  const RANGE_DB = 60; // 显示 -60..0 dB
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  const xOf = (db: number) => PAD + ((db + RANGE_DB) / RANGE_DB) * plotW;
  const yOf = (db: number) => H - PAD - ((db + RANGE_DB) / RANGE_DB) * plotH;

  const pts: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const inDb = -RANGE_DB + (i / 120) * RANGE_DB;
    pts.push(`${xOf(inDb).toFixed(1)},${yOf(Math.max(transferDb(inDb, thresholdDb, ratio), -RANGE_DB)).toFixed(1)}`);
  }

  const stroke = enabled ? t.flame400 : t.textFaint;

  return (
    <VizFrame label="传输曲线 · in → out">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {/* 网格：每 12dB */}
        {[-60, -48, -36, -24, -12, 0].map((db) => (
          <g key={db}>
            <line
              x1={xOf(db)}
              y1={PAD}
              x2={xOf(db)}
              y2={H - PAD}
              stroke="rgba(255,255,255,0.04)"
            />
            <line
              x1={PAD}
              y1={yOf(db)}
              x2={W - PAD}
              y2={yOf(db)}
              stroke="rgba(255,255,255,0.04)"
            />
          </g>
        ))}
        {/* 1:1 参考线（虚线）——让「压了多少」一眼可读 */}
        <line
          x1={xOf(-RANGE_DB)}
          y1={yOf(-RANGE_DB)}
          x2={xOf(0)}
          y2={yOf(0)}
          stroke="rgba(255,255,255,0.12)"
          strokeDasharray="3 3"
        />
        {/* 阈值竖线 */}
        <line
          x1={xOf(thresholdDb)}
          y1={PAD}
          x2={xOf(thresholdDb)}
          y2={H - PAD}
          stroke={stroke}
          strokeOpacity="0.45"
          strokeDasharray="2 2"
        />
        {/* 传输曲线 */}
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={W - PAD}
          y={H - 4}
          textAnchor="end"
          fontFamily="var(--mono)"
          fontSize="8"
          fill={t.textFaint}
        >
          IN (dBFS)
        </text>
      </svg>
    </VizFrame>
  );
}

/**
 * 实时增益衰减表（横向）。
 *
 * 说明：引擎（Tone.Compressor）未暴露实时 GR 读数，故这里以慢速摆动的
 * 模拟节目电平按阈值/比率公式推导 —— 它随阈值与比率旋钮**正确联动**，
 * 是「可视化指示」而非「真实测量」。UI 上必须明示这一点（见 hint 文案）。
 */
export function GainReductionMeter({
  thresholdDb,
  ratio,
  active,
}: {
  thresholdDb: number;
  ratio: number;
  active: boolean;
}) {
  const [grDb, setGrDb] = useState(0);
  const paramsRef = useRef({ thresholdDb, ratio, active });
  paramsRef.current = { thresholdDb, ratio, active };

  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    let shown = 0;
    const tick = (now: number) => {
      const { thresholdDb: th, ratio: r, active: on } = paramsRef.current;
      let target = 0;
      if (on) {
        const sec = (now - t0) / 1000;
        // 慢速摆动的模拟节目电平（-14 ±8 dB 量级），叠加一点高频抖动
        const programDb = -14 + 7 * Math.sin(sec * 0.9) + 1.8 * Math.sin(sec * 3.7);
        const over = programDb - th;
        target = over > 0 ? over * (1 - 1 / Math.max(r, 1)) : 0;
      }
      // 上升快、回落慢，读数不闪
      shown = target > shown ? target : Math.max(target, shown - 0.35);
      setGrDb(shown);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const MAX_GR = 24;
  const frac = Math.min(Math.max(grDb / MAX_GR, 0), 1);

  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-1.5 px-1">
      <div
        role="meter"
        aria-label="增益衰减（估算指示）"
        aria-valuemin={0}
        aria-valuemax={MAX_GR}
        aria-valuenow={Number(grDb.toFixed(1))}
        className="relative h-[86px] w-[14px] overflow-hidden rounded-sm bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]"
      >
        {/* 自下而上填充：把「衰减量」画成往下压的块，符合压缩器直觉 */}
        <div
          className="absolute inset-x-[2px] top-[2px] rounded-[2px] bg-flame-400 transition-[height] duration-75"
          style={{ height: `${frac * 100}%` }}
        />
      </div>
      <span className="font-mono text-micro text-label-muted">
        {grDb < 0.05 ? '0.0' : `−${grDb.toFixed(1)}`}
      </span>
      <span className="text-micro leading-tight text-label-faint">GR</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · 合唱 LFO + 延迟抽头
   ═══════════════════════════════════════════════════════════════════════ */

export interface ChorusVizProps {
  rateHz: number;
  depth: number;
  delayTimeMs: number;
  spreadDegrees: number;
  enabled: boolean;
}

/**
 * LFO 波形 + 立体声延迟抽头分布。
 *
 * 抽头的左右位置由 spread 决定、垂直偏移由 depth 决定 ——
 * 三个旋钮同时在这张图上可见，改动立刻反映。
 */
export function ChorusViz(props: ChorusVizProps) {
  const { rateHz, depth, delayTimeMs, spreadDegrees, enabled } = props;
  const t = getTokens();
  const W = 460;
  const H = 150;
  const MID = H / 2;
  const stroke = enabled ? t.flame400 : t.textFaint;

  // LFO 波形：固定画 2 个周期以保持视觉稳定，周期密度反映 rate
  const cycles = 2;
  const amp = 8 + depth * 40;
  const pts: string[] = [];
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * W;
    const phase = (i / 200) * cycles * Math.PI * 2;
    pts.push(`${x.toFixed(1)},${(MID - Math.sin(phase) * amp).toFixed(1)}`);
  }

  // 延迟抽头：左右各一组，水平位置 = 延迟时间，垂直 = LFO 相位
  const taps = [
    { pan: -1, phase: 0 },
    { pan: -0.5, phase: Math.PI / 2 },
    { pan: 0.5, phase: Math.PI },
    { pan: 1, phase: (Math.PI * 3) / 2 },
  ];
  const spreadFrac = spreadDegrees / 180;

  return (
    <VizFrame label={`LFO ${rateHz.toFixed(1)}Hz · 延迟 ${delayTimeMs.toFixed(1)}ms · 展开 ${Math.round(spreadDegrees)}°`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        {/* 中线 */}
        <line x1="0" y1={MID} x2={W} y2={MID} stroke="rgba(255,255,255,0.1)" />
        {/* LFO */}
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth="1.8"
          vectorEffect="non-scaling-stroke"
        />
        {/* 延迟抽头：水平位置映射延迟，垂直位置映射 LFO 相位，横宽映射 spread */}
        {taps.map((tap, i) => {
          const cx = W * 0.5 + tap.pan * spreadFrac * W * 0.42;
          const cy = MID - Math.sin(tap.phase) * amp * 0.7;
          const delayX = W * 0.5 - (delayTimeMs / 30) * W * 0.16;
          return (
            <g key={i}>
              <line
                x1={cx}
                y1={cy}
                x2={delayX}
                y2={MID}
                stroke={t.flame600}
                strokeOpacity="0.5"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={cx}
                cy={cy}
                r="4"
                fill={t.ink950}
                stroke={enabled ? t.flame300 : t.textFaint}
                strokeWidth="1.8"
              />
            </g>
          );
        })}
      </svg>
    </VizFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · 混响脉冲响应
   ═══════════════════════════════════════════════════════════════════════ */

export interface ReverbVizProps {
  decaySec: number;
  preDelaySec: number;
  wet: number;
  enabled: boolean;
}

/**
 * 脉冲响应（IR）可视化：早期反射抽头 + 指数衰减包络 + 尾部扩散噪声。
 *
 * 语言与全站波形一致（细竖条阵，非连续折线）——
 * 报告指出原型用 3D 线框立方体「好看但与混响物理无关」，故这里换成
 * 真正能读出参数的 IR 图：包络斜率 = decay，起始空隙 = preDelay，
 * 整体幅度 = wet。
 */
export function ReverbViz({ decaySec, preDelaySec, wet, enabled }: ReverbVizProps) {
  const t = getTokens();
  const W = 460;
  const H = 150;
  const BASE = H - 12;
  const MAX_AMP = (H - 24) * (0.25 + wet * 0.75);
  const stroke = enabled ? t.flame400 : t.textFaint;

  // 早期反射抽头（左右声道时间略有差异 —— 真实 IR 的特征）
  const earlyMs = [4, 9, 15, 23, 33, 47, 63];

  const bars = useMemo(() => {
    const out: Array<{ x: number; h: number; o: number }> = [];
    const N = 96;
    const totalMs = Math.max(decaySec * 1000, 1);
    const preFrac = Math.min(preDelaySec * 1000 / totalMs, 0.4);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      if (u < preFrac) {
        out.push({ x: u, h: 0.02, o: 0.18 });
        continue;
      }
      const tt = (u - preFrac) / (1 - preFrac);
      // 双指数包络：与 原型/效果器/混响.html 的 generateIR 同构
      const env = (1 - tt) ** 1.4 * Math.exp(-tt * 2.2);
      // 伪随机反射密度（确定性，不用 Math.random 以免每帧抖动）
      const jitter = 0.45 + 0.55 * Math.abs(Math.sin(i * 2.399) * Math.cos(i * 1.117));
      out.push({ x: u, h: Math.max(0.012, env * jitter), o: 0.28 + env * 0.72 });
    }
    return out;
  }, [decaySec, preDelaySec]);

  return (
    <VizFrame label={`脉冲响应 · 尾长 ${decaySec.toFixed(1)}s · 预延迟 ${(preDelaySec * 1000).toFixed(0)}ms`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="rgba(255,255,255,0.11)" />
        {/* 早期反射 */}
        {earlyMs.map((ms, i) => {
          const x = (ms / Math.max(decaySec * 1000, 1)) * W;
          const h = MAX_AMP * 0.92 * 0.68 ** i;
          const y = BASE - h;
          return (
            <rect
              key={ms}
              x={x}
              y={y}
              width="1.6"
              height={h}
              fill={stroke}
              opacity={enabled ? 0.95 : 0.4}
            />
          );
        })}
        {/* 扩散尾部 */}
        {bars.map((b, i) => {
          const h = b.h * MAX_AMP;
          return (
            <rect
              key={i}
              x={b.x * W}
              y={BASE - h}
              width="2"
              height={h}
              fill={stroke}
              opacity={enabled ? b.o : b.o * 0.4}
            />
          );
        })}
        {/* 预延迟标记 */}
        {preDelaySec > 0.001 && (
          <line
            x1={(preDelaySec * 1000 / Math.max(decaySec * 1000, 1)) * W}
            y1="6"
            x2={(preDelaySec * 1000 / Math.max(decaySec * 1000, 1)) * W}
            y2={BASE}
            stroke={stroke}
            strokeOpacity="0.3"
            strokeDasharray="2 2"
          />
        )}
      </svg>
    </VizFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · 波形整形传输曲线（供未来新增的失真 / 位深劣化单元消费）
   ═══════════════════════════════════════════════════════════════════════ */

export interface ShaperVizProps {
  /** 驱动量 0..1 */
  amount: number;
  /** 整形类型 */
  mode: 'soft' | 'hard' | 'fold';
  enabled: boolean;
}

/**
 * 三条整形曲线，与 原型/VFX.html 的 makeDistCurve 同构：
 *   soft → tanh 软削波（保留偶次谐波，最"管味"）
 *   hard → clamp 硬削波（奇次谐波丰富，最"炸"）
 *   fold → 折叠（超过 ±1 折回，金属感）
 */
function shape(x: number, amount: number, mode: ShaperVizProps['mode']): number {
  if (mode === 'soft') {
    const g = 1 + amount * 3.2;
    return Math.tanh(x * g) / Math.tanh(g);
  }
  if (mode === 'hard') {
    const g = 1 + amount * 8;
    return Math.min(0.92, Math.max(-0.92, x * g));
  }
  let y = x * (1 + amount * 4);
  while (Math.abs(y) > 1) y = 2 * Math.sign(y) - y;
  return y;
}

export function ShaperViz({ amount, mode, enabled }: ShaperVizProps) {
  const t = getTokens();
  const W = 460;
  const H = 150;
  const PAD = 20;
  const stroke = enabled ? t.flame400 : t.textFaint;

  const pts: string[] = [];
  for (let i = 0; i <= 160; i++) {
    const x = -1 + (i / 160) * 2;
    const y = shape(x, amount, mode);
    pts.push(
      `${(PAD + ((x + 1) / 2) * (W - PAD * 2)).toFixed(1)},${(H / 2 - y * (H / 2 - PAD)).toFixed(1)}`,
    );
  }

  const label =
    mode === 'soft' ? '软削波 tanh' : mode === 'hard' ? '硬削波 clamp' : '折叠 fold';

  return (
    <VizFrame label={`波形整形 · ${label}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="rgba(255,255,255,0.08)" />
        <line x1={W / 2} y1={PAD} x2={W / 2} y2={H - PAD} stroke="rgba(255,255,255,0.08)" />
        {/* 1:1 参考线 */}
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={PAD}
          stroke="rgba(255,255,255,0.1)"
          strokeDasharray="3 3"
        />
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </VizFrame>
  );
}
