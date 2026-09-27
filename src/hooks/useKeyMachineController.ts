/**
 * KeyMachine 控制器 hook（自 StagePage 抽出，逻辑逐行保持一致）：
 *
 *  - 水合门控的 KeyMachine 创建（machineRef 单例）；
 *  - cursors 游标状态 + syncCursors / afterMutation 同步；
 *  - handlePress：trigger + 游标回写 + 空键一次性提示（全局 toast）；
 *  - resetAllCursors / resetRowCursor / applyKeyCount（音域格数）；
 *  - 进入页面预热全部序列素材缓存（README §3）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { getKeyMachine, syncKeyMachine } from '../engine/key-machine-singleton';
import {
  collectReferencedSampleIds,
  prewarmBuffers,
  prewarmKeyTransforms,
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
  /**
   * 修改**音域格数**（= 键盘上那串连续半音序列的长度）并同步机器/游标。
   *
   * 只增删序列末尾，**不动任何幸存键的音高** —— 老工程永远不会跑音。
   * 关闭半音键时，store 会自动把目标格数对齐到下一个**可见的白键**
   * （否则「＋」会加到看不见的黑键上，用户点了没反应）。
   */
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
    /*
      ⛔ 每一轮预热开始都必须先把指示灯压回「预热」。

      这个 effect 的依赖是 [hydrated, blobs] —— 也就是**每次新增/删除素材都会重跑**。
      旧写法只在末尾 `setPrewarmReady(true)`，从不复位，于是：首轮预热完成后灯就
      永远亮着；用户之后导入一批新素材、新一轮预热正在同步阻塞主线程时，指示灯
      仍然写着「就绪」。用户照着「就绪」按下去，撞上的正是那一轮预热 —— 这是
      指示灯在说假话（用户实报的「有些时候按下去没声/很卡」里就有这一幕）。
    */
    setPrewarmReady(false);
    void prewarmBuffers(collectReferencedSampleIds(useStore.getState().project))
      /*
        解码之后紧接着预热**变换结果** —— 见 `prewarmKeyTransforms` 的注释。

        为什么这两件事要连在一起、共用同一个 prewarmReady 指示灯：
        解码只把 mp3 变成 AudioBuffer，真正贵的是整段变调（同步跑在主线程）。
        键位映射下每个键一个独立音高，所以「按下一个没按过的键」= 主线程冻结一次
        整段变换；不预热就等于把关卡设在**用户按下去的那一刻**。
        两者都在「用户开始弹之前」完成，指示灯才有意义（「就绪」= 真的可以弹了）。
      */
      .then(() =>
        prewarmKeyTransforms(keysRef.current, { isCancelled: () => cancelled }),
      )
      .then(() => {
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

  return {
    cursors,
    prewarmReady,
    handlePress,
    applyKeyCount,
    resetAllCursors,
    resetRowCursor,
    syncAfterMutation,
  };
}
