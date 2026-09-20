/**
 * Knob —— SVG 旋钮（效果器套件）。
 *
 * ══ 视觉（用户指定：参考 原型/效果器 的彩色弧旋钮）══
 *
 * 结构（自外向内）：
 *   1. 弧形轨道：**粗弧**（5px）从 -135° 到 +135°，浅色底槽 + 彩色活动弧
 *   2. 端点圆点：活动弧末端一个实心圆点，是「当前值」的锚
 *   3. 旋钮本体：深色圆盘，比弧小一圈，只作底衬（不抢弧的注意力）
 *   4. 下方两行：数值（等宽、加粗、亮）+ 参数名（小、弱）
 *
 * 与旧实现的区别：
 *   - 旧版把「价值指针」画成一根粗线压在弧上，和弧互相干扰；
 *     新版**只保留端点圆点**，弧本身就是指针。
 *   - 旧版读数画在旋钮**中心**（小圆盘里挤两行小字，10px/7px 几乎读不出）；
 *     新版移到**下方**，能放大字号，也更符合「弧是主角」的构图。
 *   - 弧色可注入（`accent`），供 EQ 多频段按频率着色。
 *   - 弧宽 5px（旧 7px）：粗弧配小旋钮会糊成一团。
 *
 * 交互（在旧版基础上补全）：
 *   - 纵向拖动改值，150px = 全量程
 *   - 键盘：方向键 / PageUp·PageDown 大步进 / Home / End
 *   - **双击复位**到 `def`（旧版没有）
 *   - **滚轮微调**（乘性，符合「越靠近目标越精细」的感知；Shift 更细）
 *
 * 纯受控组件：拖动只经 onChange 上抛，不持有自身数值状态。
 */
import { useId, useRef } from 'react';

export type KnobUnit =
  | 'db'
  | 'pct'
  | 'ms'
  | 'sec'
  | 'ratio'
  | 'hz'
  | 'deg'
  | 'raw';

export interface KnobProps {
  /** 旋钮下方的参数名 */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** 数值展示格式（默认 raw：两位内小数去尾零） */
  unit?: KnobUnit;
  onChange(value: number): void;
  /** 旋钮直径 px（默认 56） */
  size?: number;
  disabled?: boolean;
  /** 弧色（CSS 颜色字符串）；缺省用设计令牌的强调色 */
  accent?: string;
  /** 双击复位值；给定时才启用双击复位 */
  def?: number;
  /** 拖动中的实时回调（供可视化联动，避免每帧走 store） */
  onDragValue?(value: number): void;
}

/** 纵向拖动全量程对应的像素距离 */
const DRAG_RANGE_PX = 150;

/** 指针扫过半角（度）：轨道从 -135° 到 +135°，0° 指向正上方 */
const SWEEP_HALF_DEG = 135;

/** 与 Slider.trimNum 同规则：toFixed(2) 后去尾随零 */
function trimNum(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** 读数文案 */
export function formatKnobValue(unit: KnobUnit, v: number): string {
  switch (unit) {
    case 'db':
      return `${v > 0 ? '+' : ''}${trimNum(v)}`;
    case 'pct':
      return `${Math.round(v * 100)}%`;
    case 'ms':
      return trimNum(v);
    case 'sec':
      return v >= 1 ? v.toFixed(1) : v.toFixed(2);
    case 'ratio':
      return `${trimNum(v)}:1`;
    case 'hz':
      return v >= 1000 ? `${trimNum(v / 1000)}k` : trimNum(v);
    case 'deg':
      return `${Math.round(v)}°`;
    case 'raw':
      return trimNum(v);
  }
}

/** 独立单位小字 */
const UNIT_TEXT: Record<KnobUnit, string> = {
  db: 'dB',
  pct: '',
  ms: 'ms',
  sec: 's',
  ratio: '',
  hz: 'Hz',
  deg: '°',
  raw: '',
};

/** 极坐标 → SVG 坐标（angleDeg 以 12 点钟方向为 0°，顺时针为正） */
function polarPoint(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/** 圆弧路径（viewBox 100×100，圆心 50,50；start→end 顺时针） */
function arcPath(r: number, startDeg: number, endDeg: number): string {
  const s = polarPoint(50, 50, r, startDeg);
  const e = polarPoint(50, 50, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/** 按 step 量化并夹取到 [min, max]（toFixed 消除浮点尾差） */
function quantize(raw: number, step: number, min: number, max: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  const snapped = Number((Math.round(raw / step) * step).toFixed(decimals));
  return Math.min(max, Math.max(min, snapped));
}

export function Knob({
  label,
  value,
  min,
  max,
  step,
  unit = 'raw',
  onChange,
  size = 56,
  disabled = false,
  accent,
  def,
  onDragValue,
}: KnobProps) {
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startValue: number;
    moved: boolean;
  } | null>(null);

  const uid = useId().replace(/:/g, '');
  const bodyId = `knob-body-${uid}`;

  const range = max - min;
  const t = range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;
  const angle = -SWEEP_HALF_DEG + t * SWEEP_HALF_DEG * 2;
  const accentColor = accent ?? 'rgb(var(--flame-400))';

  const commit = (raw: number) => {
    const next = quantize(raw, step, min, max);
    if (next !== value) onChange(next);
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      /* 指针已释放时 setPointerCapture 会抛；捕获失败不影响拖拽逻辑 */
    }
    dragRef.current = {
      pointerId: ev.pointerId,
      startY: ev.clientY,
      startValue: value,
      moved: false,
    };
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    // 上拖 = 增、下拖 = 减
    const dy = drag.startY - ev.clientY;
    if (!drag.moved && Math.abs(dy) < 2) return;
    drag.moved = true;
    const raw = drag.startValue + (dy / DRAG_RANGE_PX) * range;
    const snapped = quantize(raw, step, min, max);
    onDragValue?.(snapped);
    if (snapped !== value) onChange(snapped);
  };

  const endDrag = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === ev.pointerId) dragRef.current = null;
  };

  const onDoubleClick = () => {
    if (disabled || def === undefined) return;
    commit(def);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = step * 10;
    switch (ev.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        ev.preventDefault();
        commit(value + step);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        ev.preventDefault();
        commit(value - step);
        break;
      case 'PageUp':
        ev.preventDefault();
        commit(value + big);
        break;
      case 'PageDown':
        ev.preventDefault();
        commit(value - big);
        break;
      case 'Home':
        ev.preventDefault();
        commit(min);
        break;
      case 'End':
        ev.preventDefault();
        commit(max);
        break;
    }
  };

  /** 滚轮微调：默认每次 1% 量程，Shift 降到 0.1% */
  const onWheel = (ev: React.WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const dir = ev.deltaY > 0 ? -1 : 1;
    const fine = ev.shiftKey ? 0.1 : 1;
    commit(value + dir * (range / 100) * fine);
  };

  const valueText = formatKnobValue(unit, value);
  const unitText = UNIT_TEXT[unit];
  const endPoint = polarPoint(50, 50, 36, angle);

  return (
    <div
      className={`flex shrink-0 flex-col items-center gap-1 ${
        disabled ? 'opacity-40' : ''
      }`}
      style={{ width: size }}
    >
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${valueText}${unitText ? ` ${unitText}` : ''}`}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        title={`${label}（纵向拖动 / 滚轮微调${def !== undefined ? ' / 双击复位' : ''}）`}
        className={`relative touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-flame-400/70 ${
          disabled ? 'cursor-not-allowed' : 'cursor-ns-resize'
        }`}
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true">
          <defs>
            {/* 旋钮本体的极淡穹面，只作底衬 */}
            <radialGradient id={bodyId} cx="50%" cy="32%" r="72%">
              <stop offset="0%" stopColor="rgb(var(--ink-700))" />
              <stop offset="100%" stopColor="rgb(var(--ink-800))" />
            </radialGradient>
          </defs>

          {/* 弧轨道底槽 */}
          <path
            d={arcPath(36, -SWEEP_HALF_DEG, SWEEP_HALF_DEG)}
            fill="none"
            stroke="rgb(var(--ink-800))"
            strokeWidth={5}
            strokeLinecap="round"
          />

          {/* 旋钮本体：深盘，比弧小一圈 */}
          <circle cx={50} cy={50} r={27} fill={`url(#${bodyId})`} />
          <circle
            cx={50}
            cy={50}
            r={27}
            fill="none"
            stroke="rgba(0,0,0,0.45)"
            strokeWidth={1}
          />

          {/* 彩色活动弧 */}
          {t > 0.004 && (
            <path
              d={arcPath(36, -SWEEP_HALF_DEG, angle)}
              fill="none"
              stroke={accentColor}
              strokeWidth={5}
              strokeLinecap="round"
            />
          )}

          {/* 端点圆点 —— 当前值的唯一锚点（不再画价值指针线） */}
          <circle
            cx={endPoint.x}
            cy={endPoint.y}
            r={4.2}
            fill={accentColor}
            stroke="rgb(var(--ink-950))"
            strokeWidth={1.5}
          />

          {/* 顶部小刻度，标出 0° 参考方向 */}
          <line
            x1={50}
            y1={9}
            x2={50}
            y2={13}
            stroke="rgb(var(--ink-600))"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* 下方两行：数值亮、参数名弱 */}
      <span className="max-w-full truncate text-center font-mono text-small font-semibold tabular-nums leading-none text-label-hi">
        {valueText}
        {unitText !== '' && (
          <span className="ml-px text-micro font-normal text-label-muted">
            {unitText}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-center text-micro leading-none text-label-muted">
        {label}
      </span>
    </div>
  );
}
