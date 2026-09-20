/**
 * KeyMachine 控制器 hook（自 StagePage 抽出，逻辑逐行保持一致）：
 *
 *  - 水合门控的 KeyMachine 创建（machineRef 单例）；
 *  - cursors 游标状态 + syncCursors / afterMutation 同步；
 *  - handlePress：trigger + 游标回写 + 空键一次性提示（全局 toast）；
 *  - resetAllCursors / resetRowCursor / applyKeyCount；
 *  - 进入页面预热全部序列素材缓存（README §3）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { getKeyMachine, syncKeyMachine } from '../engine/key-machine-singleton';
import {
  collectReferencedSampleIds,
  prewarmBuffers,
} from '../model/buffer-cache-service';
import { ensureAudioStarted } from '../engine/core';
import { type MemeKeyPressResult } from '../components/keys/MemeKey';
import { toast } from '../components/ui/toast';
import type { Key } from '../model/types';

/** useKeyMachineController 的返回契约 */
export interface KeyMachineController {
  /** 各键当前游标（与 project.keys 等长对齐） */
  cursors: number[];
  /** 全部序列素材是否已解码入缓存 */
  prewarmReady: boolean;
  /** 演奏触发：返回 MemeKey 本地闪灯摘要；机器未就绪返回 null */
  handlePress: (keyIndex: number) => MemeKeyPressResult | null;
  /** 修改键数并同步机器/游标 */
  applyKeyCount: (n: number) => void;
  /** 所有键游标归位（引擎 + store 双写） */
  resetAllCursors: () => void;
  /** 单键游标归位（引擎 + store 双写） */
  resetRowCursor: (keyIndex: number) => void;
  /** 编辑矩阵每次 store 写入后调用：syncKeys + 刷新游标展示（README §4） */
  syncAfterMutation: () => void;
}

export function useKeyMachineController(activeKeys?: Key[]): KeyMachineController {
  const hydrated = useStore((s) => s.hydrated);
  const blobs = useStore((s) => s.blobs);
  const projectKeys = useStore((s) => s.project.keys);
  const keys = activeKeys ?? projectKeys;

  const [cursors, setCursors] = useState<number[]>([]);
  const [prewarmReady, setPrewarmReady] = useState(false);

  const emptyHintShownRef = useRef(false);

  // 用 ref 持有最新的 keys，避免 syncCursors 的 identity 随 keys 引用变化
  // 而重新创建——否则会导致 resetAllCursors → store 更新 → project 变化 →
  // playKeys 新数组 → keys 变化 → syncCursors 变化 → resetAllCursors 变化 →
  // Take-switch effect 再次触发的死循环。
  const keysRef = useRef(keys);
  keysRef.current = keys;

  // ------------------------------------------------------- KeyMachine 生命周期

  const syncCursors = useCallback(() => {
    const machine = getKeyMachine();
    if (!machine) return;
    const activeKeys = keysRef.current;
    setCursors(activeKeys.map((_, i) => machine.getCursor(i)));
  }, []);

  /** 键配置任何变更后必须调用：同步 KeyMachine 并刷新游标展示（README §4） */
  const afterMutation = useCallback(() => {
    syncKeyMachine();
    syncCursors();
  }, [syncCursors]);

  useEffect(() => {
    if (!hydrated) return;
    // 确保单例已创建
    getKeyMachine();
    syncCursors();
  }, [hydrated, syncCursors]);

  // keys（StagePage 的 playKeys）每次变化都同步给机器，
  // 覆盖掉 StudioPage syncKeyMachine() 用 project.keys 造成的错位
  useEffect(() => {
    if (!hydrated) return;
    const machine = getKeyMachine();
    machine.syncKeys(keysRef.current);
    // syncKeys 会把引擎游标夹取进新序列长度；展示游标必须同帧刷新，
    // 否则编辑/换 Take 后圆点会停在已不存在的幽灵槽位上。
    // syncCursors 只读引擎状态不写 store → 不会再触发本 effect。
    syncCursors();
  }, [keys, hydrated, syncCursors]);

  // ------------------------------------------------------------- 缓存预热 §3

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    // README §3：序列引用集预热收编至 model/buffer-cache-service（含并发合并；
    // 缺 Blob/解码失败的 id 计入 missing，流程照常完成 → ready 照常置位）
    void prewarmBuffers(
      collectReferencedSampleIds(useStore.getState().project),
    ).then(() => {
      if (!cancelled) setPrewarmReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, blobs]);

  // ------------------------------------------------------------------ 演奏触发

  const handlePress = useCallback(
    (keyIndex: number): MemeKeyPressResult | null => {
      const machine = getKeyMachine();
      if (!machine) return null;
      ensureAudioStarted();
      const result = machine.trigger(keyIndex);
      // 写回 store，圆点与声音对齐
      useStore.getState().setKeyCursor(keyIndex, result.cursorAfter);
      setCursors((prev) => {
        const next = [...prev];
        next[keyIndex] = result.cursorAfter;
        return next;
      });
      if (!result.triggered) {
        // 提示语境跟随当前 Take（keysRef = StagePage 的 playKeys），
        // 不再读全局 project.keys——避免「这行是空的」误报。
        const key = keysRef.current[keyIndex];
        if (!key || key.sequence.length === 0) {
          if (!emptyHintShownRef.current) {
            emptyHintShownRef.current = true;
            toast('此键还没装声音，去编辑模式配一个');
          }
        } else {
          toast('这个键的素材还没加载好，稍等一下再试');
        }
      }
      return { triggered: result.triggered, slotIndex: result.slotIndex };
    },
    [],
  );

  // ---------------------------------------------------------------- 键数与游标

  const applyKeyCount = useCallback(
    (n: number) => {
      useStore.getState().setKeyCount(n);
      afterMutation();
    },
    [afterMutation],
  );

  const resetAllCursors = useCallback(() => {
    const machine = getKeyMachine();
    if (!machine) return;
    machine.resetAllCursors();
    syncCursors();
    const st = useStore.getState();
    st.project.keys.forEach((_, i) => st.resetKeyCursor(i));
  }, [syncCursors]);

  const resetRowCursor = useCallback(
    (keyIndex: number) => {
      const machine = getKeyMachine();
      machine?.resetCursor(keyIndex);
      useStore.getState().resetKeyCursor(keyIndex);
      syncCursors();
    },
    [syncCursors],
  );

  /** 编辑矩阵 store 写入后调用：syncKeys + 刷新游标展示 */
  const syncAfterMutation = useCallback(() => {
    syncKeyMachine();
    syncCursors();
  }, [syncCursors]);

  return { cursors, prewarmReady, handlePress, applyKeyCount, resetAllCursors, resetRowCursor, syncAfterMutation };
}
