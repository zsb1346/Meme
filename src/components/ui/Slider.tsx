/**
 * Slider —— 带标签与数值徽章的机架滑条（Wave 1 ui 套件）。
 *
 * 移植 MixPage FxSlider 的观感：透明轨道叠在背景槽上，
 * 火焰渐变填充条 + 28px 渐变拇指；input 高 44px 保证纵向触控目标。
 * 徽章按 unit 格式化（与 MixPage formatValue 同规则），
 * 可用 format 覆盖为任意自定义格式。
 */
import { formatHz } from '../../utils/format';

export type SliderUnit = 'db' | 'pct' | 'ms' | 'sec' | 'ratio' | 'hz' | 'deg' | 'raw';

export interface SliderProps {
  /** 左侧参数名 */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** 数值徽章格式（默认 raw：两位内小数去尾零） */
  unit?: SliderUnit;
  onChange(value: number): void;
  disabled?: boolean;
  /** 滑条下方的弱化提示行 */
  hint?: string;
  /** 完全自定义徽章文案（优先于 unit 规则） */
  format?(value: number): string;
}

/** 与 MixPage trimNum 同规则：toFixed(2) 后去尾随零 */
function trimNum(n: number): string {
  return String(Number(n.toFixed(2)));
}

function defaultFormat(unit: SliderUnit, v: number): string {
  switch (unit) {
    case 'db':
      return `${v > 0 ? '+' : ''}${trimNum(v)} dB`;
    case 'pct':
      return `${Math.round(v * 100)}%`;
    case 'ms':
      return `${trimNum(v)} ms`;
    case 'sec':
      return `${v.toFixed(1)} s`;
    case 'ratio':
      return `${trimNum(v)} : 1`;
    case 'hz':
      return formatHz(v);
    case 'deg':
      return `${Math.round(v)}°`;
    case 'raw':
      return trimNum(v);
  }
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = 'raw',
  onChange,
  disabled = false,
  hint,
  format,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  const badgeText = format ? format(value) : defaultFormat(unit, value);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-400">{label}</span>
        <span
          aria-label={`${label}当前值`}
          className="select-none rounded-md border border-white/[0.06] bg-ink-950/60 px-2 py-1 font-mono text-xs tabular-nums tracking-tight text-flame-300 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]"
        >
          {badgeText}
        </span>
      </div>

      <div className="relative flex h-11 w-full items-center">
        {/* 背景槽 */}
        <div className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-ink-700 shadow-inner" />
        {/* 已划过填充 */}
        <div
          className={`pointer-events-none absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-flame-600 to-flame-300 shadow-[0_0_8px_rgb(var(--flame-500)/0.45)] ${
            disabled ? 'opacity-30' : ''
          }`}
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(ev) => onChange(Number(ev.target.value))}
          className="relative z-10 h-11 w-full cursor-pointer appearance-none bg-transparent focus:outline-none disabled:cursor-not-allowed [&::-moz-range-thumb]:h-7 [&::-moz-range-thumb]:w-7 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-flame-400 [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-11px] [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-flame-600/80 [&::-webkit-slider-thumb]:bg-gradient-to-b [&::-webkit-slider-thumb]:from-flame-300 [&::-webkit-slider-thumb]:to-flame-500 [&::-webkit-slider-thumb]:shadow-[0_2px_6px_rgba(0,0,0,0.5),0_0_0_4px_rgb(var(--flame-500)_/_0.12)] disabled:[&::-moz-range-thumb]:bg-slate-600 disabled:[&::-webkit-slider-thumb]:border-slate-600 disabled:[&::-webkit-slider-thumb]:from-slate-600 disabled:[&::-webkit-slider-thumb]:to-slate-700 disabled:[&::-webkit-slider-thumb]:shadow-none"
        />
      </div>

      {hint !== undefined && (
        <p className="-mt-1.5 text-[11px] leading-snug text-amber-400/80">
          ※ {hint}
        </p>
      )}
    </div>
  );
}
