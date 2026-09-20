/**
 * FX 参数写入漏斗 —— MixPage 与 EffectPopup 共用的单一实现。
 *
 * 交互契约：拖动中先写本地 pending 镜像（视觉即时反馈），store 落库按
 * 防抖窗口合并（避免拖动时的保存风暴）；卸载时自动把仍在窗口内的最后
 * 一次写入落库，保留用户最终调到的位置。延迟由调用方按
 * `spec.debounceMs ?? DEFAULT_FX_DEBOUNCE_MS` 传入 —— 规格里声明了更长
 * 窗口的参数（如 reverb.decaySec = 400ms）必须被尊重。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '../model/store';
import type { EffectSettings } from '../model/types';
import type { StageId } from '../engine/effect-units/types';

/** 常规参数默认合并窗口：视觉即时更新，store 写入合并到 60ms */
export const DEFAULT_FX_DEBOUNCE_MS = 60;

/**
 * 唯一的 (级 id, 参数 key, 值) → store 关联点，走 store 的 setEffect。
 *
 * spec.key 来自同一 unit 的 params 规格，运行时恒与本 id 配对；但 TS 无法
 * 表达「这个 key 属于这个 id」的跨层关联（相关联合问题），故对 patch 做
 * 一次**精确定位断言** —— 目标是确切的 Partial<EffectSettings[K]>，
 * 并非宽化到 unknown/any 的逃逸口，配对错误会在运行时以 undefined 字段
 * 形式暴露而非静默串级。
 */
export function writeFxParam<K extends StageId>(
  id: K,
  key: string,
  value: number,
): void {
  const patch = { [key]: value } as Partial<EffectSettings[K]>;
  useStore.getState().setEffect(id, patch);
}

export interface FxParamFunnel {
  /** 拖动中的参数本地镜像：'级.字段' → 最新值。提交进 store 后即删除。 */
  pending: Record<string, number>;
  /** 只更新视觉镜像（不排程落库）。 */
  setPendingValue(fullKey: string, value: number): void;
  /** 通用防抖写入：同 key 重入会重置计时器，触发时先清镜像再落库。 */
  scheduleWrite(fullKey: string, delayMs: number, write: () => void): void;
  /** 取消单个在途写入并清掉对应镜像。 */
  cancelPending(key: string): void;
  /** 取消全部在途写入并清空镜像（一键重置/总线旁路前调用）。 */
  cancelAllPending(): void;
  /** 立即落盘全部在途写入（关闭弹层/离开页面前调用）。 */
  flushPendingWrites(): void;
}

/**
 * FX 参数写入漏斗 hook。每处挂载点独立持有自己的镜像与定时器表；
 * 卸载时自动 flush，无需调用方操心清理。
 */
export function useFxParamFunnel(): FxParamFunnel {
  const [pending, setPending] = useState<Record<string, number>>({});
  /** fullKey → { timer, write }：卸载/关闭时 flush，重置时 cancel */
  const timersRef = useRef(new Map<string, { timer: number; write(): void }>());

  const setPendingValue = useCallback((fullKey: string, value: number) => {
    setPending((p) => ({ ...p, [fullKey]: value }));
  }, []);

  const scheduleWrite = useCallback(
    (fullKey: string, delayMs: number, write: () => void) => {
      const prev = timersRef.current.get(fullKey);
      if (prev) window.clearTimeout(prev.timer);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(fullKey);
        setPending((p) => {
          if (!(fullKey in p)) return p;
          const next = { ...p };
          delete next[fullKey];
          return next;
        });
        write();
      }, delayMs);
      timersRef.current.set(fullKey, { timer, write });
    },
    [],
  );

  const cancelPending = useCallback((key: string) => {
    const prev = timersRef.current.get(key);
    if (prev) {
      window.clearTimeout(prev.timer);
      timersRef.current.delete(key);
    }
    setPending((p) => {
      if (!(key in p)) return p;
      const next = { ...p };
      delete next[key];
      return next;
    });
  }, []);

  const cancelAllPending = useCallback(() => {
    for (const { timer } of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
    setPending({});
  }, []);

  /** 立即落盘全部在途写入（关闭弹层/离开页面前调用）。 */
  const flushPendingWrites = useCallback(() => {
    for (const { timer, write } of timersRef.current.values()) {
      window.clearTimeout(timer);
      write();
    }
    timersRef.current.clear();
    setPending({});
  }, []);

  // 卸载时把仍在防抖窗口内的最后一次写入落库（保留用户最终调到的位置）
  useEffect(
    () => () => {
      for (const { timer, write } of timersRef.current.values()) {
        window.clearTimeout(timer);
        write();
      }
      timersRef.current.clear();
    },
    [],
  );

  return {
    pending,
    setPendingValue,
    scheduleWrite,
    cancelPending,
    cancelAllPending,
    flushPendingWrites,
  };
}
