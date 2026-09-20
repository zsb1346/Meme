/**
 * 演奏台 StagePage（计划 §3「Stage+Edit」行）—— 薄组合壳：
 *
 *  - 水合门控 + 氛围背景 + 头部/模式切换（保留原 markup）；
 *  - 演奏模式 → PlayModeView（纯 props）；
 *  - 编辑模式 → EditMatrixView + SlotEditorModal（纯 props）；
 *  - 引擎生命周期 → useKeyMachineController（KeyMachine + 缓存预热 + 游标）；
 *  - 行预览 / 试听逻辑保留在页面（涉及 refs 管理与计时器清理）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, createEmptyTake } from '../model/store';
import type { SampleId, TakeEvent, TakeId } from '../model/types';
import {
  getCachedBuffer,
  playSample,
  type PlayingSample,
} from '../engine/sample-player';
import { getMasterChain } from '../engine/effects';
import { ensureAudioStarted, getAudioContext } from '../engine/core';
import { resolveSemitones } from '../model/pitch-resolve';
import { useKeyMachineController } from '../hooks/useKeyMachineController';
import type { MemeKeyPressResult } from '../components/keys/MemeKey';
import PlayModeView, { type CountOption } from '../components/stage/PlayModeView';
import EditMatrixView from '../components/stage/EditMatrixView';
import SlotEditorModal, { type EditorTarget } from '../components/stage/SlotEditorModal';
import ImportConfirmModal from '../components/stage/ImportConfirmModal';
import { toast } from '../components/ui/toast';
import { triggerSynthNoteAt } from '../engine/synth-preview';
import { findKeyIndexByKey } from '../utils/key-bindings';
import { registerShortcut } from '../components/ui/shortcuts';
import { useKeyAnimations } from '../hooks/useKeyAnimations';
import { useStageShare } from '../hooks/useStageShare';
import { PageBar, Seg, Led } from '../components/ui/PageBar';
import { IconPackage, IconPlus, IconUpload } from '../components/ui/Icon';
import {
  appendTakeSlot,
  buildTakeKeys,
  removeTakeSlot,
  replaceTakeSlot,
} from '../model/take-stage';
import { getKeyMachine } from '../engine/key-machine-singleton';


// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

type StageMode = 'play' | 'edit';

export default function StagePage() {
  const hydrated = useStore((s) => s.hydrated);
  const project = useStore((s) => s.project);

  // ---- 页面状态 ----
  const [mode, setMode] = useState<StageMode>('play');
  const [countOption, setCountOption] = useState<CountOption>(() =>
    project.settings.keyCount === 7
      ? '7'
      : project.settings.keyCount === 14
        ? '14'
        : project.settings.keyCount === 21
          ? '21'
          : 'custom',
  );
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [previewingKey, setPreviewingKey] = useState<number | null>(null);

  // ---- 演奏模式：声部 / Take / 按键绑定 ----
  const [voiceMode, setVoiceMode] = useState<'audio' | 'synth'>('audio');
  const [selectedTakeId, setSelectedTakeId] = useState<TakeId | null>(() => {
    const takes = project.takes;
    return takes.length > 0 ? takes[0].id : null;
  });
  const selectedTake = useMemo(
    () => project.takes.find((take) => take.id === selectedTakeId) ?? null,
    [project.takes, selectedTakeId],
  );
  const playKeys = useMemo(
    () => buildTakeKeys(project, selectedTake),
    [project, selectedTake],
  );

  // ---- 控制器（KeyMachine + 缓存预热 + 游标）----
  const {
    cursors,
    prewarmReady,
    handlePress,
    applyKeyCount,
    resetAllCursors,
    resetRowCursor,
    syncAfterMutation,
  } = useKeyMachineController(playKeys);
  const [bindingMode, setBindingMode] = useState(false);
  const [bindingTarget, setBindingTarget] = useState<number | null>(null);
  const bindings = useStore((s) => s.project.settings.keyBindings);
  const setKeyBinding = useStore((s) => s.setKeyBinding);
  const clearKeyBinding = useStore((s) => s.clearKeyBinding);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const { lastFlash, lastPress, animatePress, animateFlash } = useKeyAnimations();

  // ---- 导入/导出 ----
  const { exportStage, pickFile, pending, confirm, cancel, dragOver, dragProps } =
    useStageShare();
  const addTake = useStore((s) => s.addTake);

  // takes 被外部重置（如导入）后，selectedTakeId 若失效则切到第一个
  useEffect(() => {
    if (project.takes.length === 0) {
      if (selectedTakeId !== null) setSelectedTakeId(null);
      return;
    }
    if (!selectedTakeId || !project.takes.some((t) => t.id === selectedTakeId)) {
      setSelectedTakeId(project.takes[0].id);
    }
  }, [project.takes, selectedTakeId]);

  // 旧存档的自动种入（进场即用全局 keys 造 Take）已删除：
  // 一声源规则下，全局装配不再是当前 Take 的声音来源，任何时刻都不
  // 应被自动复活进演奏内容。空工程就是空 Take；要迁移请显式导入乐器包。

  // Take 切换后：将 Take 专属的键序列同步到 KeyMachine 单例并归位游标。
  // 注意：不能把 playKeys 放入 deps——playKeys 由 project 派生，resetAllCursors
  // 内部的 resetKeyCursor 会 touch project，导致 playKeys 新引用 → effect 再触发 →
  // 死循环。因此用 refs 持有最新的 playKeys / resetAllCursors，effect 只监听
  // selectedTakeId。
  const playKeysRef = useRef(playKeys);
  playKeysRef.current = playKeys;
  const resetAllCursorsRef = useRef(resetAllCursors);
  resetAllCursorsRef.current = resetAllCursors;

  useEffect(() => {
    if (!selectedTakeId) return;
    getKeyMachine().syncKeys(playKeysRef.current);
    resetAllCursorsRef.current();
  }, [selectedTakeId]);

  // ---- 新建 Take ----
  const newTake = useCallback(() => {
    const n = project.takes.length + 1;
    const take = createEmptyTake(`演奏 ${n}`);
    addTake(take, 0);
    setSelectedTakeId(take.id);
  }, [addTake, project.takes.length]);

  /** 统一演奏入口：无论采样/电子音，都走 handlePress 推游标 + 出动画；
   *  电子音模式额外叠加 triggerSynthNoteAt 发声。 */
  const playNote = useCallback(
    (keyIndex: number): MemeKeyPressResult | null => {
      ensureAudioStarted();
      const result = handlePress(keyIndex);
      if (voiceMode === 'synth') {
        triggerSynthNoteAt(keyIndex, getAudioContext().currentTime);
      }
      // 非指针路径（键盘绑定）的按压 + 闪灯信号
      animatePress(keyIndex);
      if (result && result.slotIndex !== null) {
        animateFlash(keyIndex, result.slotIndex, result.triggered);
      }
      return result;
    },
    [voiceMode, handlePress, animatePress, animateFlash],
  );

  const previewStopsRef = useRef<PlayingSample[]>([]);
  const previewTimerRef = useRef<number | null>(null);

  const keyCount = project.settings.keyCount;

  // ---------------------------------------------------------------- 编辑动作
  //
  // 编辑模式的唯一写入口：所有 装/换/删 都改「选中 Take 的 events」，
  // 绝不写全局 project.keys——否则声音会跨 Take、跨刷新残留（旧 bug 根因）。

  const mutateSelectedTake = useCallback(
    (fn: (events: TakeEvent[]) => TakeEvent[]) => {
      const st = useStore.getState();
      let tid = selectedTakeId;
      let take = tid ? st.project.takes.find((t) => t.id === tid) ?? null : null;
      if (!take || !tid) {
        // 无有效 Take：一律建空 Take。绝不从全局 keys 种入——
        // 旧装配不是本 Take 的声音来源（一声源规则）。
        take = createEmptyTake('演奏 1');
        st.addTake(take, 0);
        setSelectedTakeId(take.id);
        tid = take.id;
      }
      const fresh = useStore.getState().project.takes.find((t) => t.id === tid)!;
      st.updateTakeEvents(tid, fn(fresh.events));
    },
    [selectedTakeId, setSelectedTakeId],
  );

  const appendSlotWith = useCallback(
    (keyIndex: number, sampleId: SampleId) => {
      mutateSelectedTake((events) => appendTakeSlot(events, keyIndex, sampleId));
    },
    [mutateSelectedTake],
  );

  const replaceSlotWith = useCallback(
    (keyIndex: number, slotIndex: number, sampleId: SampleId) => {
      const row = playKeysRef.current[keyIndex];
      if (!row || slotIndex >= row.sequence.length) return;
      mutateSelectedTake((events) =>
        replaceTakeSlot(events, keyIndex, slotIndex, sampleId),
      );
    },
    [mutateSelectedTake],
  );

  const clearSlot = useCallback(
    (keyIndex: number, slotIndex: number) => {
      mutateSelectedTake((events) => removeTakeSlot(events, keyIndex, slotIndex));
    },
    [mutateSelectedTake],
  );

  const removeLastSlot = useCallback(
    (keyIndex: number) => {
      const row = playKeysRef.current[keyIndex];
      if (!row || row.sequence.length === 0) return;
      clearSlot(keyIndex, row.sequence.length - 1);
    },
    [clearSlot],
  );

  const chooseSample = useCallback(
    (sampleId: SampleId) => {
      if (!editor) return;
      const { keyIndex, slotIndex } = editor;
      const row = playKeysRef.current[keyIndex];
      if (!row) {
        setEditor(null);
        return;
      }
      if (slotIndex >= row.sequence.length) appendSlotWith(keyIndex, sampleId);
      else replaceSlotWith(keyIndex, slotIndex, sampleId);
      setEditor(null);
    },
    [editor, appendSlotWith, replaceSlotWith],
  );

  const nameById = useMemo(() => {
    const m = new Map<SampleId, string>();
    for (const s of project.samples) m.set(s.id, s.name);
    return m;
  }, [project.samples]);

  const sampleDurationById = useMemo(() => {
    const m = new Map<SampleId, number>();
    for (const s of project.samples) m.set(s.id, s.durationSec);
    return m;
  }, [project.samples]);

  // 水合后 keyCount 可能被存档改写 → 同步分段选择器（八度制预设 7/14/21，其余归自定义）
  useEffect(() => {
    setCountOption(
      keyCount === 7 ? '7' : keyCount === 14 ? '14' : keyCount === 21 ? '21' : 'custom',
    );
  }, [keyCount]);

  // ------------------------------------------------------------ 试听 / 行预览

  const auditionSample = useCallback((sampleId: SampleId) => {
    const buffer = getCachedBuffer(sampleId);
    if (!buffer) {
      toast('素材还没解码完成，稍候再试');
      return;
    }
    ensureAudioStarted();
    playSample({
      buffer,
      destination: getMasterChain(useStore.getState().project.effects).input,
      semitones: resolveSemitones(sampleId),
      gainLinear: 0.9,
    });
  }, []);

  const stopPreviews = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    previewStopsRef.current.forEach((s) => s.stop());
    previewStopsRef.current = [];
    setPreviewingKey(null);
  }, []);

  /** 行内 ▶：直接 playSample 顺序预览本 Take 第 1..n 格（不走 KeyMachine，不动游标） */
  const previewSequence = useCallback(
    (keyIndex: number) => {
      stopPreviews();
      const key = playKeysRef.current[keyIndex];
      if (!key || key.sequence.length === 0) {
        toast('这一行还没有槽位');
        return;
      }
      ensureAudioStarted();
      const ctx = getAudioContext();
      const chain = getMasterChain(useStore.getState().project.effects);
      const startAt = ctx.currentTime + 0.08;
      let t = startAt;
      const stops: PlayingSample[] = [];
      for (const ref of key.sequence) {
        if (!ref.sampleId) continue; // Take 矩阵里的 padding 空槽直接跳过
        const buffer = getCachedBuffer(ref.sampleId);
        if (buffer) {
          stops.push(
            playSample({
              buffer,
              destination: chain.input,
              when: t,
              semitones: resolveSemitones(ref.sampleId),
              gainLinear: 0.85,
            }),
          );
        }
        t += Math.min(0.8, Math.max(0.35, (buffer?.duration ?? 0.4) * 0.9));
      }
      previewStopsRef.current = stops;
      setPreviewingKey(keyIndex);
      previewTimerRef.current = window.setTimeout(
        () => {
          previewStopsRef.current = [];
          setPreviewingKey(null);
        },
        Math.ceil((t - startAt) * 1000) + 150,
      );
    },
    [stopPreviews],
  );

  // 切回演奏模式 / 卸载时收尾
  useEffect(() => {
    if (mode === 'play') stopPreviews();
  }, [mode, stopPreviews]);
  useEffect(() => () => { stopPreviews(); }, [stopPreviews]);

  // Esc 关闭编辑弹层
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);

  // ---- 按键绑定模式：键盘监听（与StagePage同源）----
  const bindingTargetRef = useRef(bindingTarget);
  bindingTargetRef.current = bindingTarget;

  useEffect(() => {
    if (!bindingMode) return;
    return registerShortcut({
      id: 'stage-key-binding',
      keys: [],
      captureAll: true,
      priority: 1000,
      guardInput: false,
      handler: (e) => {
        const target = bindingTargetRef.current;
        if (target !== null) {
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            clearKeyBinding(target);
            setBindingTarget(null);
            return;
          }
          e.preventDefault();
          const current = useStore.getState().project.settings.keyBindings;
          for (const [ki, k] of Object.entries(current)) {
            if (k === e.key && Number(ki) !== target) {
              clearKeyBinding(Number(ki));
            }
          }
          setKeyBinding(target, e.key);
          setBindingTarget(null);
          return;
        }
        if (e.key === 'Escape') {
          setBindingMode(false);
          setBindingTarget(null);
        }
      },
    });
  }, [bindingMode, setKeyBinding, clearKeyBinding]);

  // ---- 演奏键位：registerShortcut（shortcuts.ts 内部拦 e.repeat → 长按只响一次）----
  useEffect(
    () =>
      registerShortcut({
        id: 'stage-play-keys',
        keys: Object.values(bindings),
        guardInput: true,
        when: () => !bindingMode && !editor,
        handler: (e, key) => {
          if (e.repeat) return;
          const keyIndex = findKeyIndexByKey(bindingsRef.current, key);
          if (keyIndex === null) return;
          e.preventDefault();
          playNote(keyIndex);
        },
      }),
    [bindings, bindingMode, editor, playNote],
  );

  // ------------------------------------------------------------------ 水合门

  if (!hydrated) {
    return (
      <section className="flex min-h-0 flex-1 flex-col">
        <PageBar title="演奏台" meta="正在恢复工程…" />
        <div className="grid grid-cols-7 gap-2 p-3">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-md bg-ink-800/70" />
          ))}
        </div>
      </section>
    );
  }

  // 编辑矩阵的一切派生（列数/弹层行/头部 LED）都以选中 Take 的 playKeys 为准，
  // 不再读全局 project.keys——保证「编辑所见 = 演奏所听」。
  const playHasAnySound = playKeys.some((k) =>
    k.sequence.some((ref) => ref.sampleId.length > 0),
  );
  const maxLen = playKeys.reduce((m, k) => Math.max(m, k.sequence.length), 0);
  const colCount = Math.max(maxLen, 1);
  const editorKey = editor !== null ? playKeys[editor.keyIndex] : undefined;

  return (
    <section
      {...dragProps}
      className="relative flex min-h-0 flex-1 flex-col"
      aria-label="演奏台"
    >
      {/* ═══ 单行顶栏：标题 + 模式切换 + 工程动作 ═══ */}
      <PageBar
        title="演奏台"
        meta={
          playHasAnySound
         ? prewarmReady
              ? `${selectedTake ? `${selectedTake.name} · ` : ''}音色已就绪`
              : '音色预热中…'
            : '每个键都是一台序列状态机'
        }
        status={
          playHasAnySound ? (
            <>
              <Led tone={prewarmReady ? 'ok' : 'accent'} on breathe={!prewarmReady} />
              <span className="hidden font-mono text-small text-label-muted sm:inline">
                {prewarmReady ? '就绪' : '预热'}
              </span>
            </>
          ) : undefined
        }
      >
        {/* 模式切换：演奏 / 编辑（旧实现是毛玻璃圆角胶囊，现为零圆角分段控件） */}
        <Seg<StageMode>
          label="模式"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'play', label: '演奏' },
            { value: 'edit', label: '编辑' },
          ]}
        />

        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

        <HeaderButton onClick={pickFile} label="导入乐器包">
          <IconUpload size={13} />
          导入
        </HeaderButton>
        <HeaderButton onClick={() => void exportStage()} label="导出乐器包">
          <IconPackage size={13} />
          导出
        </HeaderButton>
        <HeaderButton onClick={newTake} label="新建一个空 Take">
          <IconPlus size={13} />
          新建
        </HeaderButton>
      </PageBar>

      {/* ═══ 内容区：铺满剩余高度（不再 max-w-5xl 居中） ═══ */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8 pt-3">
        {/* ------------------------------------------------------ 演奏模式 */}
        {mode === 'play' && (
          <PlayModeView
            keys={playKeys}
            keyCount={keyCount}
            countOption={countOption}
            onCountOption={(opt) => {
              setCountOption(opt);
              if (opt !== 'custom') applyKeyCount(Number(opt));
            }}
            onApplyKeyCount={applyKeyCount}
            onResetAll={resetAllCursors}
            prewarmReady={prewarmReady}
            hasAnySound={playKeys.some((key) => key.sequence.some((ref) => ref.sampleId))}
            cursors={cursors}
            nameById={nameById}
            onPress={bindingMode ? undefined : playNote}
            /* 声部 */
            voiceMode={voiceMode}
            onVoiceModeChange={setVoiceMode}
            /* Take 选择器 */
            takes={project.takes}
            selectedTakeId={selectedTakeId}
            onTakeChange={setSelectedTakeId}
            /* 按键绑定 */
            bindingMode={bindingMode}
            onBindingModeChange={(on) => {
              setBindingMode(on);
              if (!on) setBindingTarget(null);
            }}
            bindingTarget={bindingTarget}
            onBindingTargetChange={setBindingTarget}
            bindings={bindings}
            lastFlash={lastFlash}
            lastPress={lastPress}
          />
        )}

        {/* ------------------------------------------------------ 编辑模式 */}
        {mode === 'edit' && (
          <EditMatrixView
            keys={playKeys}
            nameById={nameById}
            sampleDurationById={sampleDurationById}
            colCount={colCount}
            previewingKey={previewingKey}
            hasAnySound={playHasAnySound}
            onSlotClick={(ki, si) =>
              setEditor({ keyIndex: ki, slotIndex: si, picking: false })
            }
            onAppendClick={(ki) =>
              setEditor({
                keyIndex: ki,
                slotIndex: playKeys[ki]?.sequence.length ?? 0,
                picking: true,
              })
            }
            onPreviewRow={previewSequence}
            onRemoveLast={removeLastSlot}
            onResetRow={resetRowCursor}
          />
        )}
      </div>

      {/* ------------------------------------------------------ 编辑弹层 */}
      {editor && editorKey && (
        <SlotEditorModal
          editor={editor}
          editorKey={editorKey}
          samples={project.samples}
          onClose={() => setEditor(null)}
          onPick={chooseSample}
          onAudition={auditionSample}
          onSwitchToPicking={() => setEditor({ ...editor, picking: true })}
        />
      )}

      {/* ------------------------------------------------------ 拖拽覆盖层 */}
      {dragOver && <div className="stage-drop-overlay">松开以载入乐器</div>}

      {/* ------------------------------------------------------ 导入确认弹窗 */}
      {pending && (
        <ImportConfirmModal
          pack={pending}
          onConfirm={() => {
            confirm();
            syncAfterMutation();
          }}
          onCancel={cancel}
        />
      )}
    </section>
  );
}

/** 顶栏内的小按钮：26px，无边框，靠 hover 底色区分 */
function HeaderButton({
  onClick,
  label,
  children,
}: {
  onClick(): void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex h-ctl-sm items-center gap-1.5 rounded-sm px-2 text-small font-medium text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi"
    >
      {children}
    </button>
  );
}
