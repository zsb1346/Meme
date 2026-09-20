/**
 * EqCanvas —— 可交互的多段均衡频响曲线。
 *
 * ══ 交互契约（移植自 原型/效果器/新EQ.html 的交互模型）══
 *
 *   · **拖拽节点**：横向改频率（对数轴），纵向改增益
 *   · **Alt + 拖拽**：精调（灵敏度降到 0.2 倍）
 *   · **滚轮**：调该段 Q 值（乘性 ×1.11 / ×0.9 —— 符合感知，而非常规线性）
 *   · **双击节点**：增益归零
 *   · **右键节点**：循环切换滤波类型
 *   · **右键节点**：循环切换类型（峰值→低架→高架→低通→高通→陷波→全通）
 *
 * 这些操作都不是我发明的 —— 是专业 EQ 的通用肌肉记忆，
 * 直接沿用能让有经验的人零学习成本上手。
 *
 * ══ 为什么用 Canvas 而不是 SVG ══
 * 曲线有 240 个采样点、且拖拽时每帧重算（`getFrequencyResponse` × 段数）；
 * 每帧重建 240 个 SVG path 的 DOM 开销远高于一次 canvas 描边。
 * 网格则预渲染到离屏 canvas，每帧只 drawImage 一次（原型同款优化）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EqBand, EqBandType } from '../../model/types';
import {
  EQ_CURVE_POINTS,
  EQ_TYPE_LABEL,
  EQ_TYPE_ORDER,
  computeEqResponse,
  eqFreqToNorm,
  eqGainToNorm,
  eqNormToFreq,
  eqNormToGain,
  eqBandColor,
  eqTypeHasGain,
  getEqNodes,
  getActiveEqBands,
} from '../../engine/effect-units/eq';
import { getTokens } from '../../styles/getTokens';


export interface EqCanvasProps {
  bands: EqBand[];
  /** 当前选中的段（高亮、并用于滚轮调 Q 的兜底目标） */
  selected: number;
  onSelect(index: number): void;
  /** 拖拽/滚轮产生的段级改动 */
  onBandChange(index: number, patch: Partial<EqBand>): void;
  height?: number;
}

/** 节点命中半径（px） */
const HIT_RADIUS = 18;
const Q_MIN = 0.05;
const Q_MAX = 40;
const TYPE_ORDER = EQ_TYPE_ORDER;

export default function EqCanvas({
  bands,
  selected,
  onSelect,
  onBandChange,
  height = 240,
}: EqCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    index: number;
    startX: number;
    startY: number;
    startFreq: number;
    startGain: number;
  } | null>(null);
  /** 悬停读数（右上角 HUD） */
  const [hud, setHud] = useState<{ freq: number; gain: number } | null>(null);
  const [hovered, setHovered] = useState<number>(-1);

  /** 绘制所需的最新 props（rAF 循环读 ref，避免每帧重建闭包） */
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const dirtyRef = useRef(true);

  const freqToX = useCallback((f: number, w: number) => eqFreqToNorm(f) * w, []);
  const gainToY = useCallback((db: number, h: number) => eqGainToNorm(db) * h, []);
  const xToFreq = useCallback((x: number, w: number) => eqNormToFreq(x / w), []);
  const yToGain = useCallback((y: number, h: number) => eqNormToGain(y / h), []);

  /* ── 网格预渲染到离屏 canvas（每帧只 drawImage 一次）── */
  const buildGrid = useCallback((w: number, h: number, dpr: number) => {
    const c = gridRef.current ?? document.createElement('canvas');
    gridRef.current = c;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const t = getTokens();

    // 纵向频率线
    const majorF = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const f of majorF) {
      const x = Math.round(eqFreqToNorm(f) * w) + 0.5;
      g.strokeStyle = f === 1000 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.045)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.fillStyle = t.textFaint;
      g.font = '9px "SF Mono", ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h - 4);
    }

    // 横向 dB 线
    for (let db = -24; db <= 24; db += 6) {
      const y = Math.round(eqGainToNorm(db) * h) + 0.5;
      g.strokeStyle = db === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.045)';
      g.lineWidth = db === 0 ? 1.2 : 1;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillStyle = t.textFaint;
      g.font = '9px "SF Mono", ui-monospace, monospace';
      g.textAlign = 'left';
      g.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y - 3);
    }
  }, []);

  /* ── 尺寸自适应 ── */
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      cv.width = Math.max(1, Math.round(rect.width * dpr));
      cv.height = Math.max(1, Math.round(rect.height * dpr));
      cv.style.width = `${rect.width}px`;
      cv.style.height = `${rect.height}px`;
      buildGrid(rect.width, rect.height, dpr);
      dirtyRef.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [buildGrid]);

  /* ── 单帧绘制 ── */
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h, dpr } = sizeRef.current;
    if (w < 2 || h < 2) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const t = getTokens();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = t.ink950;
    ctx.fillRect(0, 0, w, h);

    if (gridRef.current) ctx.drawImage(gridRef.current, 0, 0, w, h);

    const bs = bandsRef.current;

    /*
      曲线数据来源：优先用**真实段节点**的 getFrequencyResponse。
      若节点还没就绪（主链未初始化），退化为用段配置在本地推导 ——
      退化的曲线不会显示（宁可空着也不画一条错的），
      因为「可视化骗人」比「暂时没可视化」糟得多。
    */
    const nodes = getEqNodes();
    const liveBands = getActiveEqBands();
    const useLive = nodes.length > 0 && liveBands.length === bs.length;
    const curve = useLive
      ? computeEqResponse(nodes, liveBands, EQ_CURVE_POINTS)
      : null;

    if (curve) {
      // 曲线下面积（以 0dB 线为界，上下分别填充）
      ctx.beginPath();
      ctx.moveTo(0, gainToY(0, h));
      for (let i = 0; i < EQ_CURVE_POINTS; i++) {
        ctx.lineTo((i / (EQ_CURVE_POINTS - 1)) * w, gainToY(curve[i], h));
      }
      ctx.lineTo(w, gainToY(0, h));
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(64,156,255,0.20)');
      grad.addColorStop(0.5, 'rgba(64,156,255,0.03)');
      grad.addColorStop(1, 'rgba(64,156,255,0.20)');
      ctx.fillStyle = grad;
      ctx.fill();

      // 主曲线（无 glow —— 每帧高斯模糊太贵，且是廉价感来源）
      ctx.beginPath();
      for (let i = 0; i < EQ_CURVE_POINTS; i++) {
        const x = (i / (EQ_CURVE_POINTS - 1)) * w;
        const y = gainToY(curve[i], h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = t.flame400;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // ── 段节点 ──
    bs.forEach((b, i) => {
      if (!b.enabled) return;
      // 字段名是 `frequencyHz`（见 model/types.ts 的 EqBand）。
      // 写成 `b.frequency` 不会报运行时错 —— 它读到 undefined，
      // 于是所有节点被画在最左侧、且命中测试永远失败（拖不动）。
      const x = freqToX(b.frequencyHz, w);
      const y = gainToY(eqTypeHasGain(b.type) ? b.gainDb : 0, h);
      const sel = i === selectedRef.current;
      const hov = i === hoveredRef.current;
      const r = sel ? 8 : hov ? 7 : 6;
      const color = eqBandColor(i);

      // 选中/悬停：外圈环（不用 shadowBlur）
      if (sel || hov) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = `${color}33`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = sel ? 2 : 1.4;
      ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.stroke();
      // 中心高光
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();

      // 段序号：色觉障碍用户的兜底标识
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = '700 9px "SF Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    });
  }, [freqToX, gainToY]);

  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
    dirtyRef.current = true;
  });

  /* ── rAF：只在标脏时重绘（空闲零开销）── */
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (dirtyRef.current) {
        drawRef.current();
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // props 变化 → 标脏
  useEffect(() => {
    dirtyRef.current = true;
  }, [bands, selected, hovered]);

  /* ── 命中测试 ── */
  const hitTest = useCallback(
    (px: number, py: number): number => {
      const { w, h } = sizeRef.current;
      let best = -1;
      let bestD = HIT_RADIUS * HIT_RADIUS;
      bandsRef.current.forEach((b, i) => {
        if (!b.enabled) return;
        // 同样必须用 `frequencyHz`；用错会让命中测试恒不命中 → 节点拖不动
        const dx = freqToX(b.frequencyHz, w) - px;
        const dy = gainToY(eqTypeHasGain(b.type) ? b.gainDb : 0, h) - py;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    },
    [freqToX, gainToY],
  );

  const localPos = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /* ── 指针交互 ── */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const pos = localPos(e);

      // 右键：循环切换类型
      if (e.button === 2) {
        e.preventDefault();
        const idx = hitTest(pos.x, pos.y);
        if (idx < 0) return;
        const cur = bandsRef.current[idx].type;
        const next = TYPE_ORDER[(TYPE_ORDER.indexOf(cur) + 1) % TYPE_ORDER.length];
        onSelect(idx);
        onBandChange(idx, { type: next as EqBandType });
        return;
      }
      if (e.button !== 0) return;

      const idx = hitTest(pos.x, pos.y);
      if (idx < 0) return;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不影响逻辑 */
      }
      const b = bandsRef.current[idx];
      onSelect(idx);
      dragRef.current = {
        pointerId: e.pointerId,
        index: idx,
        startX: pos.x,
        startY: pos.y,
        startFreq: b.frequencyHz,
        startGain: b.gainDb,
      };
      dirtyRef.current = true;
    },
    [hitTest, onBandChange, onSelect],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pos = localPos(e);
      const { w, h } = sizeRef.current;

      // HUD 始终显示指针处的频率/增益
      setHud({ freq: xToFreq(pos.x, w), gain: yToGain(pos.y, h) });

      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) {
        const idx = hitTest(pos.x, pos.y);
        if (idx !== hoveredRef.current) setHovered(idx);
        return;
      }

      const fine = e.altKey ? 0.2 : 1;
      const b = bandsRef.current[drag.index];

      // 频率：对数轴横向映射（与画布同一套归一化，保证「手到哪、点到哪」）
      const dNormX = ((pos.x - drag.startX) / w) * fine;
      const nextFreq = eqNormToFreq(eqFreqToNorm(drag.startFreq) + dNormX);

      const patch: Partial<EqBand> = { frequencyHz: Math.round(nextFreq) };

      // 增益：仅对响应 gain 的类型生效（否则拧了没反应）
      if (eqTypeHasGain(b.type)) {
        const dNormY = ((pos.y - drag.startY) / h) * fine;
        const nextGain = eqNormToGain(eqGainToNorm(drag.startGain) + dNormY);
        patch.gainDb = Math.round(nextGain * 10) / 10;
      }

      onBandChange(drag.index, patch);
      dirtyRef.current = true;
    },
    [hitTest, onBandChange, xToFreq, yToGain],
  );

  const endPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      try {
        cv?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      dirtyRef.current = true;
    }
  }, []);

  /** 双击：增益归零 */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const pos = localPos(e);
      const idx = hitTest(pos.x, pos.y);
      if (idx < 0) return;
      onBandChange(idx, { gainDb: 0 });
      dirtyRef.current = true;
    },
    [hitTest, onBandChange],
  );

  /** 滚轮：调 Q（乘性，符合感知） */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      const r = cv.getBoundingClientRect();
      let idx = hitTest(e.clientX - r.left, e.clientY - r.top);
      if (idx < 0) idx = selectedRef.current;
      if (idx < 0 || idx >= bandsRef.current.length) return;
      e.preventDefault();
      const b = bandsRef.current[idx];
      const next = Math.min(Q_MAX, Math.max(Q_MIN, b.q * (e.deltaY > 0 ? 0.9 : 1.11)));
      onBandChange(idx, { q: Math.round(next * 100) / 100 });
      dirtyRef.current = true;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [hitTest, onBandChange]);

  const sel = bands[selected];

  return (
    <div
      ref={wrapRef}
      className="relative min-w-0 flex-1 overflow-hidden rounded-sm bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]"
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none select-none"
        style={{ cursor: hovered >= 0 ? 'grab' : 'crosshair' }}
        aria-label="均衡器频响曲线（可拖拽节点调整）"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => {
          setHovered(-1);
          setHud(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* 右上角读数：指针处的频率/增益 */}
      {hud && (
        <div className="pointer-events-none absolute right-2 top-2 flex gap-3 rounded-sm bg-ink-900/85 px-2 py-1 font-mono text-micro tabular-nums text-label-muted">
          <span>
            频率 <b className="font-semibold text-flame-300">{formatFreq(hud.freq)}</b>
          </span>
          <span>
            增益{' '}
            <b className="font-semibold text-flame-300">
              {hud.gain >= 0 ? '+' : ''}
              {hud.gain.toFixed(1)}dB
            </b>
          </span>
        </div>
      )}

      {/* 右下角：当前选中段的类型提示 + 操作提示 */}
      <div className="pointer-events-none absolute bottom-5 right-2 flex flex-col items-end gap-0.5 text-right">
        {sel && (
          <span className="rounded-sm bg-ink-900/85 px-2 py-0.5 font-mono text-micro text-label-lo">
            段 {selected + 1} · {EQ_TYPE_LABEL[sel.type]}
          </span>
        )}
        <span className="font-mono text-micro text-label-faint">
          拖拽 频率/增益 · 滚轮 Q · 右键 换类型 · 双击 归零 · Alt 精调
        </span>
      </div>
    </div>
  );
}

/** 频率标签（Hz / kHz 自动切换） */
function formatFreq(f: number): string {
  if (f >= 10000) return `${(f / 1000).toFixed(1)}k`;
  if (f >= 1000) return `${(f / 1000).toFixed(2)}k`;
  return `${Math.round(f)}Hz`;
}
