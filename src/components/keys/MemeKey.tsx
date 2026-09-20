/**
 * MemeKey 单键组件（计划 §3 / engine README §4 对接）：
 * - pointerdown 触发（多指各自独立派发 → 天然支持同时按多个键）；
 *   触发逻辑由父级注入（StagePage 持有 KeyMachine），本组件只管表现层。
 * - 果冻按压动画（indie-game jelly）：按下 = scale 收缩 + 轻微倾斜 + 纵向压扁；
 *   松开 = 弹性回弹（overshoot cubic-bezier，回弹时冲过头再落定）。
 *   纯 transform、GPU 友好；prefers-reduced-motion 时退化为普通 scale。暖光晕保留。
 * - onRelease（可选）：pointerup / pointercancel / pointerleave（此前按下过才发）
 *   以及 Space/Enter keyup 时回调，供录制侧闭合「按住时长」。
 * - 游标指示：≤12 槽位画点阵（当前游标 = 下一个要响的槽，高亮），更多则显示 n/len 计数；
 * - 刚触发的槽位短暂闪白，给出「这次轮到它了」的因果反馈。
 */

import { useEffect, useRef, useState } from 'react';

export interface MemeKeyPressResult {
  /** 是否真的出声（哑触发 = false） */
  triggered: boolean;
  /** 本次实际播放的槽位下标（0-based；空序列为 null） */
  slotIndex: number | null;
}

export interface MemeKeyProps {
  keyIndex: number;
  label: string;
  /** 每个槽位的素材展示名（与 sequence 等长；缺失元数据时传占位名） */
  slotNames: string[];
  /** 当前游标（0-based，指向下一个要播放的槽位） */
  cursor: number;
  /** false 时仅展示不可触发（编辑模式） */
  interactive: boolean;
  /** 触发回调：返回 KeyMachine.trigger 的摘要供本地闪灯；返回 null 表示未触发 */
  onPress?: () => MemeKeyPressResult | null;
  /** 松开回调（按下过的键在 up / cancel / leave / keyup 时触发一次） */
  onRelease?: () => void;
  /** 按键绑定模式下额外显示的文字 badge（如已绑定键名或 "…"） */
  extraBadge?: string;
  /** 隐藏素材信息（录制模式：不显示素材名/未配置/圆点） */
  hideSlotInfo?: boolean;
  /** 外部触发闪灯（键盘绑定等非指针路径）：变化时触发一次 flash 动画 */
  externalFlash?: { slotIndex: number; triggered: boolean } | null;
  /** 外部触发按压动画（键盘绑定等非指针路径）：true = 按下果冻，false = 松开 */
  externalPress?: boolean;
  /** 键盘绑定的键名（如 "a", "Space" 等） */
  binding?: string;
  /** 是否为当前绑定目标（等待用户按键） */
  bindingTarget?: boolean;
}

const MAX_DOTS = 12;
const FLASH_MS = 260;

/** 订阅 prefers-reduced-motion（SSR 安全：默认 false） */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    setReduce(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

export default function MemeKey({
  keyIndex,
  label,
  slotNames,
  cursor,
  interactive,
  onPress,
  onRelease,
  extraBadge,
  externalFlash,
  externalPress,
  binding,
  bindingTarget,
  hideSlotInfo,
}: MemeKeyProps) {
  const [pressed, setPressed] = useState(false);
  const [flash, setFlash] = useState<{ slot: number | null; ok: boolean } | null>(
    null,
  );
  const flashTimer = useRef<number | null>(null);
  const prevFlashRef = useRef(externalFlash ?? null);
  /** 是否处于「按下未松」状态：onRelease 只在此为真时触发一次 */
  const heldRef = useRef(false);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // 外部触发闪灯（键盘绑定等非指针路径）
  useEffect(() => {
    if (!externalFlash || externalFlash === prevFlashRef.current) return;
    prevFlashRef.current = externalFlash;
    setFlash({ slot: externalFlash.slotIndex, ok: externalFlash.triggered });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, [externalFlash]);

  // 外部触发按压果冻动画（键盘绑定等非指针路径）
  const pressTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (externalPress) {
      setPressed(true);
    } else {
      setPressed(false);
    }
    return () => {
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };
  }, [externalPress]);

  const len = slotNames.length;
  const empty = len === 0;
  const nextName = hideSlotInfo ? '' : (empty ? '未配置' : (slotNames[cursor] ?? '？'));

  // 倾斜方向按键位奇偶交替，果冻被按歪一点点
  const tilt = keyIndex % 2 === 0 ? -1.8 : 1.8;
  const pressedTransform = reduceMotion
    ? 'scale(0.96)'
    : `translateY(3px) scale(0.94) rotate(${tilt}deg) scaleY(0.88)`;

  const fire = () => {
    heldRef.current = true;
    setPressed(true);
    const result = onPress?.();
    if (result && result.slotIndex !== null) {
      setFlash({ slot: result.slotIndex, ok: result.triggered });
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    }
  };

  const release = () => {
    if (!heldRef.current) return; // 没按下过就不发
    heldRef.current = false;
    setPressed(false);
    onRelease?.();
  };

  return (
    <button
      type="button"
      data-key-index={keyIndex}
      aria-label={hideSlotInfo ? `键 ${label}` : `键 ${label}${empty ? '（未配置）' : `，下一个：${nextName}`}`}
      disabled={!interactive}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.preventDefault(); // 防止合成 mouse 事件 / 长按选中
        fire();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onKeyDown={(e) => {
        if (!interactive || e.repeat) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          fire();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') release();
      }}
      onContextMenu={(e) => e.preventDefault()} // 移动端长按菜单
      className={[
        // 基底：浮起面（含 iOS 按钮式微渐变 + 顶部内高光 + 极淡投影）。
        // 层次由「面差 + 内高光 + 淡投影」表达，不用外发光。
        'relative flex h-full w-full select-none flex-col items-center justify-center gap-0.5',
        'outline-none',
        'focus-visible:ring-2 focus-visible:ring-flame-400/70',
        'rounded-md border',
        pressed
          ? 'border-flame-400 bg-flame-600/20 shadow-[inset_0_2px_6px_rgb(0_0_0/0.5)]'
          : empty
            ? // 空槽：**不用虚线边框**。14 个键里通常 10 个是空的，
              // 十道虚线框会把画面变成施工图。改为「压暗 + 实线」即可。
              'border-line bg-ink-900 shadow-none'
            : // 浮起键帽：顶部内高光 + 极淡投影。
              // 投影值必须**字面写出**，不能写成 `var(--elev-1)` ——
              // Tailwind 的任意值解析对 `var()` 有歧义（会当成颜色），
              // 混在多层简写里的 `shadow-[A,var(--b)]` 会整条失效（静默）。
              'border-line bg-gradient-to-b from-white/[0.05] to-black/[0.04] shadow-[inset_0_1px_0_rgb(var(--hl)),0_1px_2px_rgb(0_0_0/0.35)] hover:border-line-hot',
      ].join(' ')}
      style={{
        touchAction: 'none',
        transform: pressed ? pressedTransform : 'scale(1) rotate(0deg) scaleY(1)',
        // 按下快而软（110ms），松开用 overshoot 贝塞尔弹过头再落定 = 果冻回弹（520ms）。
        // 这个不对称是「果冻感」的全部秘密（设计系统戒律三：手）。
        transition: reduceMotion
          ? 'transform 120ms ease-out, box-shadow 120ms ease-out, background-color 120ms ease-out'
          : pressed
            ? 'transform 110ms cubic-bezier(0.3, 0.9, 0.35, 1), box-shadow 110ms ease-out, background-color 110ms ease-out'
            : 'transform 520ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 260ms ease-out, background-color 260ms ease-out',
      }}
    >
      {/* 键名 */}
      <span
        className={`text-lead font-bold leading-none tracking-[-0.01em] transition-colors ${
          pressed ? 'text-flame-300' : empty ? 'text-label-muted' : 'text-label-hi'
        }`}
      >
        {label}
      </span>

      {/* 下一个素材名 */}
      {hideSlotInfo ? null : (
        <span
          className={`max-w-full truncate px-2 text-tiny leading-tight ${
            empty ? 'text-label-faint' : 'text-label-muted'
          }`}
        >
          {nextName}
        </span>
      )}

      {/*
        游标指示：**小竖条阵**（5×4 圆角 2）而非圆点。
        竖条像琴键的「指板」，也让「当前游标跳起 + 触发格闪白」两个微交互
        有明确的高度变化可读（圆点只能变大小，可读性弱得多）。
        竖条绝对定位贴底 —— 不参与内容流，故键帽内容始终垂直居中。
      */}
      {!hideSlotInfo && (
        <span
          className="pointer-events-none absolute inset-x-0 bottom-1.5 flex h-2 items-end justify-center gap-[3px]"
          aria-hidden="true"
        >
          {empty ? null : len <= MAX_DOTS ? (
            Array.from({ length: len }, (_, d) => {
              const isCursor = d === cursor;
              const isFlash = flash !== null && flash.slot === d;
              return (
                <span
                  key={d}
                  className={[
                    'w-[5px] rounded-[2px] transition-all duration-150',
                    isFlash
                      ? flash?.ok
                        ? 'h-2 bg-white'
                        : 'h-2 bg-label-muted'
                      : isCursor
                        ? 'h-2 bg-flame-400'
                        : 'h-1 bg-ink-600',
                  ].join(' ')}
                />
              );
            })
          ) : (
            <span className="font-mono text-micro tabular-nums text-label-muted">
              {cursor + 1}/{len}
            </span>
          )}
        </span>
      )}

      {/* 按键绑定 badge：改用等宽小字 + 强调色，不再用绿色实心块 */}
      {(binding || extraBadge) && (
        <span className="absolute right-1.5 top-1.5 rounded-sm bg-flame-600/25 px-1 font-mono text-micro font-semibold leading-tight text-flame-300">
          {binding || extraBadge}
        </span>
      )}

      {/* 绑定目标指示器 */}
      {bindingTarget && (
        <span className="absolute inset-0 flex items-center justify-center rounded-md bg-flame-600/20 text-small font-semibold text-flame-200">
          按任意键绑定
        </span>
      )}
    </button>
  );
}
