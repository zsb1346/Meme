import { useCallback, useRef, useState } from 'react';

/**
 * 管理键盘/指针触发的按键动画状态（闪灯 + 果冻按压）。
 * StagePage 和 StudioPage 复用同一套逻辑，避免重复代码。
 */
export function useKeyAnimations() {
  /** 外部闪灯信号：推游标后把触发结果交给 MemeKey 做 flash 动画 */
  const [lastFlash, setLastFlash] = useState<{
    keyIndex: number;
    slotIndex: number;
    triggered: boolean;
  } | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  /** 外部按压信号：触发时给 MemeKey 果冻动画 */
  const [lastPress, setLastPress] = useState<{
    keyIndex: number;
    pressed: boolean;
  } | null>(null);
  const pressTimerRef = useRef<number | null>(null);

  /** 触发果冻按压动画（260ms 自动清除） */
  const animatePress = useCallback((keyIndex: number) => {
    setLastPress({ keyIndex, pressed: true });
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = window.setTimeout(() => setLastPress(null), 260);
  }, []);

  /** 触发闪灯动画（300ms 自动清除） */
  const animateFlash = useCallback(
    (keyIndex: number, slotIndex: number, triggered: boolean) => {
      setLastFlash({ keyIndex, slotIndex, triggered });
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setLastFlash(null), 300);
    },
    [],
  );

  return { lastFlash, lastPress, animatePress, animateFlash } as const;
}
