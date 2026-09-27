import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FLASH_MS,
  clearFlashIn,
  pressKeyIn,
  releaseKeyFrom,
  setFlashIn,
  type KeyFlash,
} from './key-anim-state';

/**
 * 按键动画状态（按下 = 集合、闪灯 = 映射）。StagePage 与 StudioPage 共用。
 *
 * ══ 旧实现的两条症状与根因 ══
 *
 * 旧版是**单槽 + 自动松手**：
 *
 *     lastPress: { keyIndex, pressed } | null   ← 全局只有一个槽位
 *     pressTimerRef = setTimeout(() => setLastPress(null), 260)   ← 到点强制松开
 *
 *   · 多键同按 → 后按的键占住槽位，先按的键的 `externalPress` 变 undefined，
 *     MemeKey 里那句 `else setPressed(false)` 把它画回未按下 ——
 *     手指还在屏幕上，画面先弹回去了。用户原话「这样就很割裂」。
 *   · 长按 → 260ms 到点槽位清空，同一个效果：还在按着，动画自己结束。
 *
 * 换句话说：**旧版根本没有「按住」这个状态，只有「最近一次触发后的 260ms」**。
 * 所以修法不是打补丁，而是把状态粒度改对，并由事件驱动（按下/松开各一次），
 * 不再有任何一个定时器去改「按下」。
 *
 * ══ 只有闪灯仍有定时器，而它天生就该有 ══
 *
 * 闪灯（游标槽位短闪白）是一次性的因果反馈，必须自己结束；
 * 「按下」是持续态，只能由松开事件结束。两者混在一个定时器里，就是旧版的病根。
 */

export interface UseKeyAnimations {
  /** 当前处于**按住**状态的键下标。UI 用它渲染按下态（可同时多个）。 */
  readonly pressedKeys: ReadonlySet<number>;
  /** 每键一份的闪灯。键不存在 = 该键此刻没在闪。 */
  readonly flashes: ReadonlyMap<number, KeyFlash>;
  /** 记一次按下（幂等）。指针路径与键盘路径都调它。 */
  pressKey(keyIndex: number): void;
  /** 松开一个键（幂等，只影响它自己）。 */
  releaseKey(keyIndex: number): void;
  /** 全部松开。窗口失焦等「松开事件永远收不到」的场景由本 hook 内部调用。 */
  clearPressed(): void;
  /** 触发一次闪灯（自带 FLASH_MS 后自动结束）。 */
  flashKey(keyIndex: number, slotIndex: number | null, triggered: boolean): void;
}

export function useKeyAnimations(): UseKeyAnimations {
  const [pressedKeys, setPressedKeys] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const [flashes, setFlashes] = useState<ReadonlyMap<number, KeyFlash>>(
    () => new Map<number, KeyFlash>(),
  );
  /** 每个键一个定时器（旧版是全局一个 → 后触发的会顶掉前一个的收尾） */
  const flashTimersRef = useRef(new Map<number, number>());
  const tokenRef = useRef(0);

  const pressKey = useCallback((keyIndex: number) => {
    setPressedKeys((prev) => pressKeyIn(prev, keyIndex));
  }, []);

  const releaseKey = useCallback((keyIndex: number) => {
    setPressedKeys((prev) => releaseKeyFrom(prev, keyIndex));
  }, []);

  const clearPressed = useCallback(() => {
    setPressedKeys((prev) => (prev.size === 0 ? prev : new Set<number>()));
  }, []);

  const flashKey = useCallback(
    (keyIndex: number, slotIndex: number | null, triggered: boolean) => {
      const token = ++tokenRef.current;
      setFlashes((prev) => setFlashIn(prev, keyIndex, slotIndex, triggered, token));
      const timers = flashTimersRef.current;
      const old = timers.get(keyIndex);
      if (old !== undefined) window.clearTimeout(old);
      timers.set(
        keyIndex,
        window.setTimeout(() => {
          timers.delete(keyIndex);
          // 带 token → 若这期间该键又被触发过，这次到点必须让位（见 KeyFlash.token）
          setFlashes((prev) => clearFlashIn(prev, keyIndex, token));
        }, FLASH_MS),
      );
    },
    [],
  );

  /*
    兜底：**松开事件是会丢的**。

    ・按住键的同时切走窗口（Alt+Tab / 切标签 / 锁屏）→ 那一下 keyup 落在别的窗口，
      本页永远收不到 → 键位卡在按下态，切回来还亮着。
    ・指针路径同理：按住鼠标拖出浏览器窗口再松开，pointerup 不一定回到按钮上
      （MemeKey 用 pointerleave 兜了一层，但拖到窗口外就兜不住了）。

    这类「卡住的按下态」是纯视觉故障，会一直挂着直到用户再点一次那个键。
    所以在这里集中兜底：只要窗口失焦或页面被隐藏，就认为所有手指都离开了。
    （⛔ 只清「按下」，不清闪灯 —— 闪灯自己有定时器会结束。）
  */
  useEffect(() => {
    const onBlur = () => clearPressed();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clearPressed();
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [clearPressed]);

  // 卸载：清掉所有闪灯定时器，避免对已卸载组件 setState
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { pressedKeys, flashes, pressKey, releaseKey, clearPressed, flashKey };
}
