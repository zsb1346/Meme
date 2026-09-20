/**
 * LevelMeter —— 纵向电平条（VST 风格效果弹层套件）。
 *
 * 绿 → 黄 → 红渐变填充（自下而上）+ 峰值保持线。
 * 峰值经 rAF 循环缓降：信号升高立即跟随，停更后按固定速率回落，
 * 不会冻结在历史高点。纯展示组件，电平数据由调用方喂入。
 */
import { useEffect, useRef, useState } from 'react';

export interface LevelMeterProps {
  /** 当前电平（与 max 同量纲，可为任意刻度：线性 / dB 均可） */
  value: number;
  /** 满量程（value = max 时满格） */
  max: number;
  /** 底部标签 */
  label?: string;
}

/** 峰值保持后的回落速率（满量程比例 / 秒） */
const PEAK_FALL_PER_SEC = 0.35;

/** 绿 → 黄 → 红渐变（自下而上；色相锚点与暗色主题协调） */
const FILL_GRADIENT =
  'linear-gradient(to top, #059669 0%, #34d399 52%, #fbbf24 76%, #ef4444 96%)';

export function LevelMeter({ value, max, label }: LevelMeterProps) {
  const [peak, setPeak] = useState(0);
  const peakRef = useRef(0);
  // 渲染期同步最新 props 到 ref，供 rAF 循环读取而不重启循环
  const fracRef = useRef(0);
  fracRef.current = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;

  useEffect(() => {
    let raf = 0;
    let lastMs = performance.now();
    const tick = (nowMs: number) => {
      const dt = Math.min((nowMs - lastMs) / 1000, 0.1);
      lastMs = nowMs;
      const cur = fracRef.current;
      if (cur >= peakRef.current) {
        peakRef.current = cur;
      } else {
        peakRef.current = Math.max(cur, peakRef.current - PEAK_FALL_PER_SEC * dt);
      }
      // 值不变时 React 直接 bail-out，不触发多余渲染
      setPeak(peakRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const frac = fracRef.current;

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-label={label ?? '电平'}
        className="relative h-20 w-6 overflow-hidden rounded-full border border-ink-700 bg-ink-950 shadow-inner"
      >
        {/* 填充区（内缩 3px 的圆角槽） */}
        <div className="absolute inset-x-[3px] bottom-[3px] top-[3px] flex flex-col justify-end overflow-hidden rounded-full">
          <div
            className="w-full rounded-full transition-[height] duration-75"
            style={{ height: `${frac * 100}%`, background: FILL_GRADIENT }}
          />
        </div>
        {/* 峰值保持线 */}
        <div
          aria-hidden="true"
          className="absolute inset-x-1 h-[2px] rounded-full bg-slate-100 shadow-[0_0_4px_rgba(255,255,255,0.8)]"
          style={{ bottom: `calc(3px + (100% - 6px) * ${peak})` }}
        />
      </div>
      {label !== undefined && (
        <span className="text-center text-[10px] leading-tight text-slate-500">{label}</span>
      )}
    </div>
  );
}
