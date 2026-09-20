/**
 * PowerToggle —— 电源拨杆（Wave 1 ui 套件）。
 *
 * 移植 MixPage 旁路开关的观感：胶囊轨道 + 发光圆点滑块，
 * role="switch" + aria-checked；触控热区 ≥44px 高。
 */
export interface PowerToggleProps {
  /** 当前是否开启 */
  on: boolean;
  onChange(on: boolean): void;
  /** 无障碍名（必填：纯图形控件） */
  label: string;
  disabled?: boolean;
}

export function PowerToggle({
  on,
  onChange,
  label,
  disabled = false,
}: PowerToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex min-h-[44px] items-center px-1 ${
        disabled ? 'cursor-not-allowed opacity-40' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 rounded-full border transition-colors duration-200 ${
          on ? 'border-accent/60 bg-accent/25 shadow-[0_0_12px_rgb(var(--flame-500)/0.35)]' : 'border-ink-600 bg-surface-raised'
        }`}
      >
        <span
          className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all duration-200 ${
            on
              ? 'left-[26px] bg-gradient-to-b from-flame-300 to-accent shadow-[0_0_6px_rgb(var(--flame-500)_/_0.6)]'
              : 'left-[3px] bg-slate-500'
          }`}
        />
      </span>
    </button>
  );
}
