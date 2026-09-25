import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ensureAudioContextRunning,
  ensureAudioStarted,
  getAudioContext,
} from '../engine/core';
import { getMasterChain } from '../engine/effects';
import { getKeyMachine } from '../engine/key-machine-singleton';
import { TakeRecorder } from '../engine/recorder';
import { useStore, resolveFilledSample } from '../model/store';
import { buildTakeKeys } from '../model/take-stage';
import { applyAssignment } from '../model/fill-assign';
import type { SampleId } from '../model/types';
import { prewarmProjectBuffers } from '../model/buffer-cache-service';
import { runUndo, stashForUndo } from '../model/undo-stash';
import { EmptyState } from '../components/ui/EmptyState';
import {
  createTakePlayback,
  useTakePlaybackState,
  type TakePlaybackController,
} from '../hooks/useTakePlayback';
import { registerShortcut, isEditableTarget } from '../components/ui/shortcuts';
import { findKeyIndexByKey } from '../utils/key-bindings';
import { keyPitch, isBlackMidi, midiNoteName, KEY_BASE_MIDI } from '../model/pitch-map';
import KeyLayout from '../components/keys/KeyLayout';
import MemeKey, { type MemeKeyPressResult } from '../components/keys/MemeKey';
import NotePalette from '../components/fill/NotePalette';
import { EffectPopup } from '../components/ui/EffectPopup';
import { buildCommitPatch } from './studio-commit';
import RollCanvas from '../components/roll/RollCanvas';
import ExportDialog from './ExportDialog';
import { formatTime } from '../utils/format';
import { toast } from '../components/ui/toast';
import { triggerSynthNoteAt } from '../engine/synth-preview';
import { useKeyAnimations } from '../hooks/useKeyAnimations';
import { parseMidiFile, buildMidiTake, type ParsedMidiFile } from '../engine/midi-import';
import MidiImportModal from '../components/stage/MidiImportModal';
import { RollEmptyState } from '../components/roll/RollEmptyState';
import { PageBar, Seg, Led } from '../components/ui/PageBar';
import {
  IconDownload,
  IconEffects,
  IconImportMidi,
  IconPlay,
  IconRecord,
  IconRename,
  IconStop,
  IconStudio,
  IconTrash,
  IconVolume,
  IconVolumeOff,
  IconWaveform,
} from '../components/ui/Icon';

// 缓存预热与半音决策已收编至 model 层单一真相：
//   prewarmProjectBuffers → model/buffer-cache-service（原本地 prewarmKeyBuffers）
//   resolveSemitonesIn    → model/pitch-resolve（原本地 resolveSemitones）

type TabId = 'record' | 'split' | 'listen';

/**
 * 二级 tab —— 中文名 + 图标，**不再用 emoji**。
 * emoji 在不同平台渲染不一致，且与 SVG 图标基线对不齐，
 * 是「廉价感」的固定来源。
 */
const TABS: Array<{ id: TabId; label: string; Icon: typeof IconRecord }> = [
  { id: 'record', label: '录制', Icon: IconRecord },
  { id: 'split', label: '卷帘 + 填词', Icon: IconStudio },
  { id: 'listen', label: '试听', Icon: IconWaveform },
];

// ---------------------------------------------------------------------------
// StudioPage —— 制作工作台：分屏布局外壳
//
//   ┌ 头部（标题 / 状态 / 导出）
//   ├ 二级 tab：录制 | 卷帘+填词 | 试听
//   ├ 紧凑行：take 选择器（常驻）+ 录制控制（仅 record tab 显示）
//   └ 面板：
//       record → 演奏台同款键位（KeyLayout + MemeKey，八度制 7 列网格）
//       split  → 卷帘卡（工具栏左：播放/声部/读数/装配进度/FX，右：缩放/删除）
//                选中事件按 Shift+A 唤起逐音装配命令面板（NotePalette 模态）
//       listen → TakePlayer 试听控制（播放头与卷帘同步）
//
//   传输只有一套：playback 控制器（TakePlayer 单一 lookahead 时钟），
//   「音频/电子音」仅切换声部（采样 / 合成骨架），播放头读数同源。
// ---------------------------------------------------------------------------

export default function StudioPage() {
  // ---- store 订阅 ----
  const project = useStore((s) => s.project);
  const takes = useStore((s) => s.project.takes);
  const keys = useStore((s) => s.project.keys);
  const samples = useStore((s) => s.project.samples);
  const addTake = useStore((s) => s.addTake);
  /** 音域自适应用：导入的 MIDI 超出当前音域时自动调大 */
  const setKeyCount = useStore((s) => s.setKeyCount);
  const deleteTake = useStore((s) => s.deleteTake);
  /** 半音键开关：只决定黑键摆不摆（纯视图状态，不动键集与音域） */
  const semitoneMode = useStore((s) => s.project.settings.semitoneModeEnabled);
  const setSemitoneMode = useStore((s) => s.setSemitoneMode);

  /**
   * 键域起点音高 —— MIDI 导入的映射基准。
   *
   * 键集恒为「从起点起的连续半音序列」，所以 `键下标 = 音号 − 起点`
   * 就是唯一正确的映射（音名与发声严格一致）。刻意在 `handleImportMidi`
   * 之前求值 —— 它要用。
   */
  const keyBaseMidi = keys[0] ? keyPitch(keys[0], 0) : KEY_BASE_MIDI;

  // ---- MIDI 导入状态 ----
  const [importing, setImporting] = useState(false);
  /**
   * 已解析、等着用户确认的 MIDI。
   *
   * ⚠️ 解析与落盘必须分成两段：旧实现一步到底，于是「这首歌有几条轨、
   * 音域多宽、有多少黑键、会丢几个音」这些**用户有权知道也能改变**的事，
   * 只能等 Take 已经写进工程之后用一句 toast 补说。见 MidiImportModal。
   */
  const [pendingMidi, setPendingMidi] = useState<ParsedMidiFile | null>(null);

  /**
   * 阶段一：读文件 + 逐轨体检。**不修改任何工程状态**。
   *
   * 解析失败（不是 MIDI / 一条音符都没有 / 全短于阈值）在这里如实报出，
   * 弹窗根本不会打开。
   */
  const handleImportMidi = useCallback(
    async (file: File) => {
      if (importing) return;
      setImporting(true);
      try {
        setPendingMidi(await parseMidiFile(file));
      } catch (err) {
        toast({ text: `导入失败：${(err as Error).message}`, kind: 'error' });
      } finally {
        setImporting(false);
      }
    },
    [importing],
  );

  /**
   * 阶段二：用户确认后落盘。
   *
   * 映射本身是**一步减法**（键下标 = MIDI 音号 − 键域起点），所以
   * 「音名 = 实际发声的音高」是天生成立的，不需要任何锚点平移。
   * 这里只需要处理两件「导入连带要做」的事，顺序不能反：
   *
   *  ① **黑键要先能看见**（`setSemitoneMode(true)`）。
   *     键集恒含黑键、但「半音键」默认是收起的 —— 不先打开的话，
   *     一首含升号的曲子会有近五分之一的音落在**没有可点位置**的键上，
   *     只能听、弹不出来，而且画面上看不出任何异常。
   *
   *  ② **音域不够就扩容**（`setKeyCount`）。必须放在 ① 之后：
   *     收起半音键时 `setKeyCount` 会把目标格数对齐到白键格，
   *     先扩容再开开关会平白多挪一格。
   */
  const confirmImportMidi = useCallback(
    (trackIndices: number[]) => {
      const parsed = pendingMidi;
      if (!parsed) return;
      setPendingMidi(null);
      try {
        const { take, summary } = buildMidiTake(parsed, {
          keyCount: project.settings.keyCount,
          baseMidi: keyBaseMidi,
          trackIndices,
        });
        addTake(take);
        setSelectedTakeId(take.id);

        const needSemitone = summary.blackKeyEvents > 0;
        const semitoneWasOn = project.settings.semitoneModeEnabled;
        if (needSemitone && !semitoneWasOn) setSemitoneMode(true);

        const from = project.settings.keyCount;
        const grew = summary.neededLanes > from;
        if (grew) setKeyCount(summary.neededLanes);

        /* 一句话说清「装进来了什么、顺手改了什么、丢了什么」 */
        const notes: string[] = [];
        if (needSemitone && !semitoneWasOn) {
          notes.push(`已打开半音键（${summary.blackKeyEvents} 个音在黑键上）`);
        }
        if (grew) notes.push(`键盘音域 ${from} → ${summary.neededLanes} 格`);
        const lost = summary.tooShort + summary.belowRange + summary.aboveRange + summary.truncated;
        if (lost > 0) notes.push(`${lost} 个音未导入`);

        toast({
          text:
            `已导入 ${summary.keptEvents} 个音` +
            `（${midiNoteName(summary.minMidi)}–${midiNoteName(summary.maxMidi)}）` +
            (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
          kind: 'success',
          durationMs: 4200,
        });
      } catch (err) {
        toast({ text: `导入失败：${(err as Error).message}`, kind: 'error' });
      }
    },
    [
      pendingMidi,
      project.settings.keyCount,
      project.settings.semitoneModeEnabled,
      keyBaseMidi,
      addTake,
      setKeyCount,
      setSemitoneMode,
    ],
  );

  // ---- 页面状态 ----
  const [tab, setTab] = useState<TabId>('split');
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  // ---- 录制状态 ----
  const [recording, setRecording] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [feedbackMuted, setFeedbackMuted] = useState(false);

  // ---- 键盘绑定状态（与StagePage同源：共享 store）----
  const [bindingMode, setBindingMode] = useState(false);
  const [bindingTarget, setBindingTarget] = useState<number | null>(null);
  const bindings = useStore((s) => s.project.settings.keyBindings);
  const setKeyBinding = useStore((s) => s.setKeyBinding);
  const clearKeyBinding = useStore((s) => s.clearKeyBinding);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // ---- 键盘/指针触发的按键动画（复用 StagePage 同款逻辑）----
  const { lastFlash, lastPress, animatePress } = useKeyAnimations();

  // ---- 卷帘播放高亮（填词悬停联动已随旧面板退役） ----
  const [playHighlight, setPlayHighlight] = useState<number | null>(null);

  // ---- 填词装配会话草稿（自旧填词面板上提）：eventIndex → sampleId ----
  const [drafts, setDrafts] = useState<Record<number, SampleId>>({});
  // ---- 逐音装配命令面板：非 null = 打开并编辑该下标事件 ----
  const [paletteEvent, setPaletteEvent] = useState<number | null>(null);
  /*
    卷帘高亮优先级：**正在装配的音符 > 播放中的音符**。
    装配面板打开时用户关心的是「我在改哪一个」，而不是「播到哪了」。
  */
  const rollHighlight = paletteEvent ?? playHighlight;
  const rollOuterRef = useRef<HTMLDivElement | null>(null);
  // 关窗后焦点归还卷帘外壳：←/→/Shift+A 链路不中断（Modal 卸载后用 rAF 聚焦）
  const closePalette = useCallback(() => {
    setPaletteEvent(null);
    requestAnimationFrame(() => rollOuterRef.current?.focus({ preventScroll: true }));
  }, []);
  // ---- 全局效果器弹层（自旧填词面板行内迁移至卷帘传输槽） ----
  const [fxOpen, setFxOpen] = useState(false);

  // ---- 自动修音全局开关 ----
  const autoTuneEnabled = useStore((s) => s.project.settings.autoTuneEnabled);
  const setAutoTuneEnabled = useStore((s) => s.setAutoTuneEnabled);
  /** 各键音高（与下标同序）—— 键位矩阵钢琴布局的分组依据 */
  const keyPitches = useMemo(
    () => keys.map((k, i) => keyPitch(k, i)),
    [keys],
  );

  // ---- 分屏传输：单一 playback 控制器；「音频/电子音」只是声部切换 ----
  const [transportMode, setTransportMode] = useState<'audio' | 'synth'>('audio');
  // 声部读取镜像：控制器只建一次，getVoice 每次启动现读最新模式
  const transportModeRef = useRef(transportMode);
  transportModeRef.current = transportMode;
  // scrub 存位：标尺点哪下次从哪播；自然播完 / 切 take 清零，手动停止保留
  const pendingStartRef = useRef(0);

  const recorderRef = useRef<TakeRecorder | null>(null);
  const startCtxTimeRef = useRef(0);

  // ---- 试听（createTakePlayback 统一编排：TakePlayer 单一时钟播放头）----
  const selectedTakeIdRef = useRef(selectedTakeId);
  selectedTakeIdRef.current = selectedTakeId;
  const [playback] = useState<TakePlaybackController>(() =>
    createTakePlayback({
      getTarget: () => {
        const s = useStore.getState();
        return {
          project: s.project,
          take:
            s.project.takes.find((t) => t.id === selectedTakeIdRef.current) ??
            null,
        };
      },
      getDestination: () =>
        getMasterChain(useStore.getState().project.effects).input,
      getVoice: () => (transportModeRef.current === 'synth' ? 'synth' : 'sample'),
      onEventScheduled: (index) => setPlayHighlight(index),
      onEnded: () => {
        pendingStartRef.current = 0;
        setPlayHighlight(null);
      },
    }),
  );
  // 订阅快照：playing / playheadSec 沿用旧变量名，JSX 区零改动
  const { isPlaying: playing, playheadSec } = useTakePlaybackState(playback);

  // 快捷键镜像：监听只注册一次，门禁/处理器从这里取最新值
  const shortcutMirrorRef = useRef({
    tab,
    recording,
    toggle: () => {},
    paletteOpen: false,
  });

  const selectedTake = useMemo(
    () => takes.find((t) => t.id === selectedTakeId) ?? null,
    [takes, selectedTakeId],
  );

  // 素材 id → 展示名（录制面板 MemeKey 的槽位名与演奏台同源）
  const nameById = useMemo(() => {
    const m = new Map<SampleId, string>();
    for (const s of samples) m.set(s.id, s.name);
    return m;
  }, [samples]);

  // 无选中时自动选第一条
  useEffect(() => {
    if (!selectedTakeId && takes.length > 0) setSelectedTakeId(takes[0]?.id ?? null);
  }, [takes, selectedTakeId]);

  // 卸载清理：录音机 / 键状态机 / 播放停止（含合成声部止鸣）。
  // 注意：必须用 stop() 而非 dispose() —— StrictMode 开发双挂载会走一次清理，
  // 而 playback 控制器由 useState 持有、重挂载时复用同一实例；dispose 会将其
  // 永久标记死亡导致之后点播完全没反应。stop 只掐声停表，实例保持可用。
  useEffect(() => {
    return () => {
      recorderRef.current?.dispose();
      playback.stop();
    };
  }, [playback]);

  const getRecorder = useCallback(() => {
    recorderRef.current ??= new TakeRecorder();
    return recorderRef.current;
  }, []);

  /** 懒建 KeyMachine（README §4：destination 用时现取主链 input） */
  const getMachine = useCallback(() => {
    return getKeyMachine();
  }, []);

  // 键配置变化后同步游标（README §4）——但声源必须逐 Take：
  // 录制敲击经 KeyMachine 发声，同步对象是「当前 Take 的事件态」
  // （buildTakeKeys），绝不用全局 project.keys——否则旧音色 kit 会
  // 混进录制台（一声源规则）。空槽/骨架 = 哑触发 → 电子参考音兜底。
  const takeKeys = useMemo(
    () => buildTakeKeys(project, selectedTake),
    [project, selectedTake],
  );
  useEffect(() => {
    getKeyMachine().syncKeys(takeKeys);
  }, [takeKeys]);

  // 反馈音静音开关
  useEffect(() => {
    recorderRef.current?.setFeedbackMuted(feedbackMuted);
  }, [feedbackMuted]);

  // 录制中：rAF 读 ctx 时钟刷新计时展示（禁止 Date.now 参与音乐时序）
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const tick = () => {
      setElapsedSec(Math.max(0, getAudioContext().currentTime - startCtxTimeRef.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  // 试听播放头已由 playback 控制器内部 rAF 驱动（useTakePlaybackState 订阅），
  // 此处不再保留独立 rAF —— 消灭双循环重渲染的来源之一。

  // 进入页面预热缓存，保证按键能立刻出声
  useEffect(() => {
    void prewarmProjectBuffers(useStore.getState().project);
  }, []);

  // ---- 录制控制 ----

  const startRecording = useCallback(async () => {
    if (recording) return;
    // 先确保 ctx running，再取起点时刻（与 recorder.start 内部同钟）
    startCtxTimeRef.current = ensureAudioStarted().currentTime;
    // 必须等待装配素材进入缓存后再允许录制；否则第一次按键会被误判为
    // “素材未加载”，直接落入电子音兜底，录制时就只听到电子音。
    await prewarmProjectBuffers(useStore.getState().project);
    getRecorder().start();
    setEventCount(0);
    setElapsedSec(0);
    setRecording(true);
    setTab('record'); // 跳到录制面板露出键位，方便敲击
  }, [recording, getRecorder]);

  /**
   * 演奏入口 —— 全制作台**唯一**的发声决策点。
   *
   * 四步顺序固定：① 推游标 ② 写游标到 store ③ 记录（若在录）④ 出且只出一种声。
   *
   * 四分支互斥，绝不叠加：
   *   · 采样已发声 + 录制中 → 补钢琴跟弹（参考音）
   *   · 采样已发声 + 非录制 → 不补声（采样就是全部）
   *   · 采样哑 + 录制中 → 电子音兜底（录制只记事件，不负责出声）
   *   · 采样哑 + 非录制 → 电子音兜底
   *
   * 这一改同时消灭了：
   *   · record tab 双击 —— 原 record 分支被删除，所有 tab 走同一条路
   *   · record tab 不推游标 —— 第 ① 步无条件推
   *   · record tab 不播采样 —— 第 ④ 步走同一规则
   *   · 哑键双击 —— 原来"钢琴反馈 + synth"两响，现在只有 synth
   *   · tab 依赖导致 useCallback 重建 —— 删了 tab 判断，依赖数组缩短
   */
  const wrappedTapKey = useCallback(
    (keyIndex: number): MemeKeyPressResult | null => {
      if (keyIndex < 0 || keyIndex >= keys.length) return null;
      ensureAudioStarted();

      // ① 推游标（无论 tab；record 也要推，否则录完游标脱节）
      const result = getMachine().trigger(keyIndex);

      // ② 游标写回 store（唯一真相源）
      useStore.getState().setKeyCursor(keyIndex, result.cursorAfter);

      // ③ 记录事件（recorder 内部判 running，未录返回 null）
      //    音高 = 键的固定身份（pitchMidi），不再由下标推导
      const pitchMidi = keyPitch(keys[keyIndex], keyIndex);
      const ev = getRecorder().notifyKeyPress(keyIndex, 1, pitchMidi);
      if (ev) setEventCount((n) => n + 1);

      // ④ 发声：四分支互斥，绝不叠加
      if (result.triggered) {
        // 采样已发声 → 录制中补钢琴跟弹（参考音），非录制不补
        if (ev) getRecorder().playFeedback(keyIndex, pitchMidi);
      } else {
        // 采样哑（空键 / 缓冲未就绪 / 静音模式）→ 电子音兜底
        triggerSynthNoteAt(pitchMidi, getAudioContext().currentTime);
      }

      return { triggered: result.triggered, slotIndex: result.slotIndex };
    },
    [keys, getMachine, getRecorder],
  );
  const tapKeyRef = useRef(wrappedTapKey);
  tapKeyRef.current = wrappedTapKey;

  const stopRecording = useCallback(() => {
    if (!recording) return;
    const rec = getRecorder();
    const take = rec.stop(
      `录制 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    );
    setRecording(false);
    if (take.events.length === 0) {
      toast('没有录到任何事件，已丢弃');
      return;
    }
    addTake(take);
    setSelectedTakeId(take.id);
    toast(`已保存「${take.name}」· ${take.events.length} 音`);
  }, [recording, getRecorder, addTake]);

  const cancelRecording = useCallback(() => {
    if (!recording) return;
    getRecorder().cancel();
    setRecording(false);
    setEventCount(0);
    setElapsedSec(0);
    toast('已放弃本次录制');
  }, [recording, getRecorder]);

  // ---- 桌面快捷键：自定义绑定键触发键位（非输入焦点时）
  // —— 走全局快捷键注册表（components/ui/shortcuts）：命中即短路，
  //    与空格等其他全局键位天然互斥，杜绝监听叠加导致的双激活。
  //    shortcuts.ts 内部已拦 e.repeat，演奏键不设 allowRepeat → 长按只响一次。
  useEffect(
    () =>
      registerShortcut({
        id: 'studio-digit-keys',
        keys: Object.values(bindings),
        guardInput: true,
        when: () =>
          !shortcutMirrorRef.current.paletteOpen && !bindingMode,
        handler: (e, key) => {
          if (e.repeat) return;   // 双保险（shortcuts 内部已拦，这里显式声明语义）
          const idx = findKeyIndexByKey(useStore.getState().project.settings.keyBindings, key);
          if (idx !== null && idx < useStore.getState().project.keys.length) {
            e.preventDefault();
            animatePress(idx);
            tapKeyRef.current(idx);
          }
        },
      }),
    [bindings, bindingMode, animatePress],
  );

  // 绑定键抬起 → 闭合「按住时长」（快捷键注册表只管 keydown，这里补一个受门禁的
  // window keyup：仅录制面板可见或录制进行中生效；recorder 内部对非录制态自带门禁）
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      const m = shortcutMirrorRef.current;
      if (m.tab !== 'record' && !m.recording) return;
      if (isEditableTarget(e.target)) return;
      const idx = findKeyIndexByKey(bindingsRef.current, e.key);
      if (idx !== null) getRecorder().notifyKeyRelease(idx);
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, [getRecorder]);

  // ---- 按键绑定模式：captureAll 注册（短路独占，其他快捷键不会触发）----
  const bindingTargetRef = useRef(bindingTarget);
  bindingTargetRef.current = bindingTarget;

  useEffect(() => {
    if (!bindingMode) return;
    return registerShortcut({
      id: 'studio-key-binding',
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

  // ---- 键盘出声：已由 studio-digit-keys registerShortcut 统一处理 ----
  // （见上方 studio-digit-keys 注册；animatePress + tapKeyRef 已在 handler 内）

  // ---- 传输控制（createTakePlayback 统一编排；lookahead 调度见 engine/README §6）----
  // 目标 take / 主链 destination / 声部（音频=采样 / 电子音=合成骨架）均由
  // 控制器启动时现取；这里只负责预热、解锁门禁与开关。

  const stopPlayback = useCallback(() => {
    playback.stop();
    setPlayHighlight(null);
  }, [playback]);

  const startPlayback = useCallback(async () => {
    // 解锁门禁必须【最先】调用：resume() 要在用户手势任务内同步发起，
    // 一旦前面有 await 让出，手势上下文丢失 → suspended 态拒绝 resume（点播放没反应）。
    const ok = await ensureAudioContextRunning();
    if (!ok) {
      toast('点一下页面解锁音频后再播放');
      return;
    }
    // README §3：播放前预热键序列引用的素材缓存（控制器假定缓存已就绪）
    await prewarmProjectBuffers(useStore.getState().project);
    const st = useStore.getState();
    const tk =
      st.project.takes.find((t) => t.id === selectedTakeIdRef.current) ?? null;
    const dur = tk?.durationSec ?? 0;
    const from = Math.max(0, Math.min(pendingStartRef.current, dur));
    playback.start(from);
  }, [playback]);

  /** 标尺 scrub：停播时存位（下次起播用）；播放中直接 seek（缓存已就绪，免预热重起） */
  const handleScrub = useCallback(
    (sec: number) => {
      const clamped = Math.max(0, sec);
      if (playback.getSnapshot().isPlaying) {
        const st = useStore.getState();
        const tk =
          st.project.takes.find((t) => t.id === selectedTakeIdRef.current) ??
          null;
        const dur = tk?.durationSec ?? 0;
        playback.start(Math.min(clamped, dur));
      } else {
        pendingStartRef.current = clamped;
      }
    },
    [playback],
  );

  const togglePlayback = useCallback(() => {
    if (playing) stopPlayback();
    else void startPlayback();
  }, [playing, startPlayback, stopPlayback]);

  /** 切换模式：先掐掉正在播的，再换声部配置（下次播放用新声部） */
  const switchTransportMode = useCallback(
    (next: 'audio' | 'synth') => {
      if (next === transportMode) return;
      stopPlayback();
      setTransportMode(next);
    },
    [transportMode, stopPlayback],
  );

  // 切换 take：停播并复位（含 scrub 存位）；装配草稿与命令面板随 take 蒸发
  useEffect(() => {
    playback.stop();
    pendingStartRef.current = 0;
    setPlayHighlight(null);
    setDrafts({});
    setPaletteEvent(null);
  }, [selectedTakeId, playback]);

  // 镜像刷新：一次性注册的快捷键始终读到最新门禁与处理器
  shortcutMirrorRef.current.tab = tab;
  shortcutMirrorRef.current.recording = recording;
  shortcutMirrorRef.current.toggle = togglePlayback;
  shortcutMirrorRef.current.paletteOpen = paletteEvent !== null;

  // 空格键播放/暂停（试听面板 + 分屏传输行）：非输入焦点时拦截，避免页面滚动
  // —— 走全局注册表；同一事件只会派发给一个命中的快捷键（短路分发）。
  // 两种传输共用同一控制器，处理器不再按 tab 分发。
  useEffect(
    () =>
      registerShortcut({
        id: 'studio-space-playback',
        keys: ['Space'],
        guardInput: true,
        when: () => {
          const t = shortcutMirrorRef.current.tab;
          return (
            (t === 'listen' || t === 'split') &&
            !shortcutMirrorRef.current.paletteOpen
          );
        },
        handler: (e) => {
          if (e.repeat) return;
          e.preventDefault();
          shortcutMirrorRef.current.toggle();
        },
      }),
    [],
  );

  // ---- 填词装配：命令面板提交 ----
  /**
   * 提交顺序红线：先 applyAssignment 写键序列（sample 分配 + setKeySequence），
   * 再 updateTakeEvents 写放置参数（pitchDelta/timeFactor）。
   * buildCommitPatch 展开保留 pressCount/keyIndex/tSec —— 时序连续性绝不被动。
   * pitchDelta/timeFactor 已由 NotePalette 出口归一化（默认值 = undefined）。
   */
  const handlePaletteCommit = useCallback(
    (
      eventIndex: number,
      sampleId: SampleId,
      pitch: number | undefined,
      pitchDelta: number | undefined,
      timeFactor: number | undefined,
    ) => {
      if (!selectedTake) return;
      const st = useStore.getState();
      const { nextDrafts, committedRefs } = applyAssignment(
        st.project,
        selectedTake.events,
        drafts,
        eventIndex,
        sampleId,
        {
          pitch,
          pitchDelta,
          timeFactor,
        },
      );
      setDrafts(nextDrafts);
      committedRefs.forEach((k) => st.setKeySequenceRefs(k.keyIndex, k.refs));
      st.updateTakeEvents(
        selectedTake.id,
        buildCommitPatch(
          selectedTake.events,
          eventIndex,
          pitchDelta,
          timeFactor,
          sampleId,
          pitch,
        ),
      );
      // 一声源：事件写入完成后用「本 Take 的事件态」立即同步机器，
      // 不再走 syncKeyMachine() 的全局默认——那条路会把旧全局 kit
      // 灌回录制台。全局镜像写（setKeySequenceRefs）只是无害影子。
      if (committedRefs.length > 0) {
        const stNow = useStore.getState();
        const fresh = stNow.project.takes.find((t) => t.id === selectedTake.id);
        if (fresh) getKeyMachine().syncKeys(buildTakeKeys(stNow.project, fresh));
      }
    },
    [selectedTake, drafts],
  );

  // 装配进度：键序列解析 ∨ 会话草稿，任一命中即算「已装配」
  const filledCount = useMemo(() => {
    if (!selectedTake) return 0;
    return selectedTake.events.reduce(
      (n, ev, i) =>
        n +
        ((resolveFilledSample(project, ev) ?? drafts[i] ?? null) !== null ? 1 : 0),
      0,
    );
  }, [selectedTake, project, drafts]);

  // ---- take 管理 ----

  /** 重命名：走 store.renameTake，不直接打补丁 */
  const commitRename = useCallback(
    (takeId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      useStore.getState().renameTake(takeId, trimmed);
      toast('已重命名');
    },
    [],
  );

  /** 立即删除录制 + 6s 可撤销 toast（撤销按原下标还原） */
  const handleDeleteTake = useCallback(() => {
    if (!selectedTakeId || !selectedTake) return;
    stopPlayback();
    const index = useStore
      .getState()
      .project.takes.findIndex((t) => t.id === selectedTakeId);
    const name = selectedTake.name;
    deleteTake(selectedTakeId);
    setSelectedTakeId(null);
    const undoId = stashForUndo({
      label: '删除录制',
      undo: () => useStore.getState().addTake(selectedTake, index),
    });
    toast({
      text: `已删除「${name}」`,
      action: { label: '撤销', onClick: () => runUndo(undoId) },
    });
  }, [selectedTakeId, selectedTake, deleteTake, stopPlayback]);

  // ---- 渲染 ----

  const durationSec = selectedTake?.durationSec ?? 0;
  const progressPct =
    durationSec > 0
      ? Math.min(100, (playheadSec / durationSec) * 100)
      : 0;

  // 分屏传输展示值：单一控制器快照直接供给（两种模式同一时钟同一读数）
  const splitPlaying = playing;
  const splitPlayheadSec = playheadSec;

  return (
    <section aria-label="制作台" className="flex min-h-0 flex-1 flex-col">
      {/* ═══ 单行顶栏：标题 + 状态 + 二级 tab + 导出 ═══
          旧结构是「大标题区 + 状态胶囊 + 导出按钮」占一整块、
          「二级 tab」再占一整行、「take 选择器」再占一行 —— 三行 chrome
          白吃 200px，而卷帘才是主角。现在全部收进 44px。 */}
      <PageBar
        title="制作台"
        meta={selectedTake ? `${selectedTake.name} · ${selectedTake.events.length} 音` : '录骨架 · 卷帘修'}
        status={
          <>
            <Led tone={recording ? 'danger' : 'ok'} on breathe={recording} />
            <span className="font-mono text-small text-label-muted">
              {recording ? '录制中' : selectedTake ? '就绪' : '待机'}
            </span>
          </>
        }
      >
        {/* 二级 tab：零圆角分段控件，图标 + 文字 */}
        <Seg<TabId>
          label="制作台功能区"
          value={tab}
          onChange={setTab}
          options={TABS.map((t) => ({
            value: t.id,
            label: (
              <span className="flex items-center gap-1.5">
                <t.Icon size={13} />
                {t.label}
              </span>
            ),
          }))}
        />

        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

        {/* 导入 MIDI */}
        <label
          title="导入 MIDI 骨架"
          className="flex h-ctl-sm cursor-pointer items-center gap-1.5 rounded-sm px-2 text-small font-medium text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi"
        >
          <IconImportMidi size={14} />
          <span className="hidden sm:inline">{importing ? '解析中…' : '导入'}</span>
          <input
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportMidi(f);
              e.target.value = '';
            }}
          />
        </label>

        <button
          type="button"
          onClick={() => setExportOpen(true)}
          disabled={takes.length === 0}
          title={takes.length === 0 ? '先录制或导入一段素材再导出' : '导出音频'}
          className="flex h-ctl-sm items-center gap-1.5 rounded-sm bg-flame-400 px-2.5 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-label-faint"
        >
          <IconDownload size={13} />
          导出
        </button>
      </PageBar>

      {/* ═══ take 选择行：仅在需要时占位（录制 tab 常驻，卷帘/试听随卷帘工具条） ═══ */}
      {tab === 'record' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="shrink-0 text-small text-label-muted">录制片段</span>
          {renaming && selectedTake ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                commitRename(selectedTake.id, renameDraft);
                setRenaming(false);
              }}
            >
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false);
                }}
                aria-label="重命名录制片段"
                className="h-ctl-sm min-w-0 flex-1 rounded-sm bg-ink-950 px-2 text-small text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]"
              />
              <button
                type="submit"
                className="h-ctl-sm rounded-sm bg-flame-600/25 px-2.5 text-small font-medium text-flame-300"
              >
                确定
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="h-ctl-sm rounded-sm px-2.5 text-small text-label-lo hover:bg-ink-800"
              >
                取消
              </button>
            </form>
          ) : (
            <>
              <select
                value={selectedTakeId ?? ''}
                onChange={(e) => setSelectedTakeId(e.target.value || null)}
                disabled={takes.length === 0}
                aria-label="录制片段"
                className="h-ctl-sm min-w-0 max-w-[320px] flex-1 rounded-sm bg-ink-950 px-2 text-small text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)] disabled:opacity-50 [&>option]:bg-ink-900"
              >
                {takes.length === 0 && <option value="">（暂无录制）</option>}
                {takes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.events.length} 音 · {formatTime(t.durationSec)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (!selectedTake) return;
                  setRenameDraft(selectedTake.name);
                  setRenaming(true);
                }}
                disabled={!selectedTake}
                aria-label="重命名当前录制"
                className="icon-btn h-ctl-sm w-ctl-sm"
              >
                <IconRename size={13} />
              </button>
              <button
                type="button"
                onClick={handleDeleteTake}
                disabled={!selectedTake}
                aria-label="删除当前录制"
                className="icon-btn h-ctl-sm w-ctl-sm hover:!border-danger/50 hover:!text-danger"
              >
                <IconTrash size={13} />
              </button>
            </>
          )}
          <span className="min-w-2 flex-1" />
          <span className="shrink-0 font-mono text-tiny text-label-faint">
            {recording ? `已录 ${eventCount} 音 · ${formatTime(elapsedSec)}` : ''}
          </span>
        </div>
      )}

      {/* ═══ 面板：录制（与演奏台同款键位）═══ */}
      {tab === 'record' && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {/* 录制控制条 */}
          <div
            className={`mb-3 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(var(--line))] transition-colors ${
              recording ? 'bg-danger/10 shadow-[inset_0_0_0_1px_rgb(var(--danger)/0.5)]' : 'bg-ink-900'
            }`}
          >
            <button
              type="button"
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? '停止并保存录制' : '开始录制'}
              className={`flex h-ctl-md items-center gap-2 rounded-sm px-3 text-small font-semibold transition-colors ${
                recording
                  ? 'bg-danger text-white'
                  : 'bg-danger/15 text-danger hover:bg-danger/25'
              }`}
            >
              {recording ? <IconStop size={12} /> : <IconRecord size={13} />}
              {recording ? '停止保存' : '开始录制'}
            </button>

            {recording && (
              <button
                type="button"
                onClick={cancelRecording}
                className="h-ctl-md rounded-sm px-2.5 text-small text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi"
              >
                放弃
              </button>
            )}

            <span className="min-w-2 flex-1" />

            <span
              className="flex h-ctl-sm items-center gap-1.5 rounded-sm bg-ink-950 px-2 font-mono text-small tabular-nums text-label-lo"
              title="已录事件数"
            >
              {eventCount} 音
            </span>
            <span
              className={`flex h-ctl-sm items-center gap-1.5 rounded-sm bg-ink-950 px-2 font-mono text-small tabular-nums ${
                recording ? 'text-danger' : 'text-label-lo'
              }`}
              title="已录时长"
            >
              {formatTime(elapsedSec)}
            </span>
            <button
              type="button"
              onClick={() => setFeedbackMuted((m) => !m)}
              aria-pressed={feedbackMuted}
              title={feedbackMuted ? '钢琴反馈已静音' : '钢琴反馈开启'}
              className="icon-btn h-ctl-sm w-ctl-sm"
            >
              {feedbackMuted ? <IconVolumeOff size={13} /> : <IconVolume size={13} />}
            </button>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-small font-semibold text-label-lo">演奏键位</h2>
            <div className="flex items-center gap-2">
              {/*
                半音键开关 —— **纯视图开关**：黑键一直在后台铺好了，
                这里只决定摆不摆它们。键集、音域、Take 里的音符一个都不动。
              */}
              <button
                type="button"
                onClick={() => setSemitoneMode(!semitoneMode)}
                aria-pressed={semitoneMode}
                title={
                  semitoneMode
                    ? '半音键已显示（每八度 12 键）。关掉只是把黑键收起来，音域与已装的素材都不变'
                    : '半音键已收起（每八度 7 个白键）。打开即出现全部黑键 —— 它们一直就在，不需要手动添加'
                }
                className={`h-ctl-sm rounded-sm px-2.5 text-small font-medium transition-colors ${
                  semitoneMode
                    ? 'bg-flame-600/25 text-flame-200'
                    : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
                }`}
              >
                半音键
              </button>
              <button
                type="button"
                onClick={() => {
                  setBindingMode(!bindingMode);
                  if (bindingMode) setBindingTarget(null);
                }}
                aria-pressed={bindingMode}
                className={`h-ctl-sm rounded-sm px-2.5 text-small font-medium transition-colors ${
                  bindingMode
                    ? 'bg-success/20 text-success'
                    : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
                }`}
              >
                {bindingMode ? '完成绑定' : '键盘绑定'}
              </button>
            </div>
          </div>

          <div className="touch-play-area rounded-md bg-ink-900 p-2.5 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            <KeyLayout
              keyCount={keys.length}
              keyPitches={keyPitches}
              /* 半音键收起时只摆白键（键对象还在，装配也还在） */
              hideBlackKeys={!semitoneMode}
              renderKey={(i) => {
                const k = keys[i];
                if (!k) return null;
                const binding = bindings[i];
                return (
                  <MemeKey
                    keyIndex={i}
                    label={k.label}
                    /* 黑键由**音高**决定，与半音开关无关（关掉开关不会把黑键变成白键） */
                    black={isBlackMidi(keyPitch(k, i))}
                    slotNames={bindingMode ? [] : k.sequence.map((r) => r.sampleId ? (nameById.get(r.sampleId) ?? '未知素材') : '未装配')}
                    cursor={k.cursor ?? 0}
                    interactive={!bindingMode}
                    hideSlotInfo
                    onPress={() => {
                      if (bindingMode) {
                        setBindingTarget(i);
                        return null;
                      } else {
                        animatePress(i);
                        return wrappedTapKey(i);
                      }
                    }}
                    onRelease={() => {
                      if (!bindingMode) {
                        getRecorder().notifyKeyRelease(i);
                      }
                    }}
                    binding={binding}
                    bindingTarget={bindingTarget === i}
                    externalFlash={lastFlash?.keyIndex === i ? { slotIndex: lastFlash.slotIndex, triggered: lastFlash.triggered } : null}
                    externalPress={lastPress?.keyIndex === i ? lastPress.pressed : undefined}
                  />
                );
              }}
            />
          </div>
        </div>
      )}

      {/* ===== 面板：卷帘 + 填词（占满剩余高度 —— 卷帘是这一页的主角）===== */}
      {tab === 'split' && (
        selectedTake && selectedTake.events.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col px-3 py-2.5">
            {/* 卷帘 + 传输合一：播放/声部/读数收进卷帘工具栏，省一整行 chrome。
                高度由 flex-1 决定，不再写死 70vh。 */}
            <RollCanvas
              take={selectedTake}
              keyCount={keys.length}
              keyLabels={keys.map((k) => k.label)}
              /*
                ⚠️ 必须传 lanePitches —— 少了它卷帘的左侧钢琴栏会回落到
                「旧下标映射」（lane 0 = C4），而键位的权威音高是 C3 起，
                两边**整整差一个八度**；而且回落的映射把所有行都当白键，
                于是开着半音也不显示黑键行（用户实报「卷帘没配合半音」）。
              */
              lanePitches={keyPitches}
              /*
                半音键收起时，卷帘**不隐藏**黑键行（藏起来等于藏起那行上的
                音符，用户会以为音符丢了），而是把那排键标成「关着」——
                钢琴栏画空心轮廓。键盘与卷帘因此讲同一个故事：
                位置都在，只是现在按不了。
              */
              blackLanesDisabled={!semitoneMode}
              playing={splitPlaying}
              playheadSec={splitPlayheadSec}
              highlightedEventIndex={rollHighlight}
              editingEventIndex={paletteEvent}
              onScrub={handleScrub}
              onRequestEditEvent={(i) => setPaletteEvent(i)}
              outerRef={rollOuterRef}
              transport={
                <>
                  <button
                    type="button"
                    onClick={togglePlayback}
                    disabled={selectedTake.events.length === 0}
                    aria-label={splitPlaying ? '停止播放' : '开始播放'}
                    className={`flex h-[26px] items-center gap-1.5 rounded-sm px-2.5 text-small font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      splitPlaying
                        ? 'bg-danger text-white'
                        : 'bg-flame-400 text-ink-950 hover:bg-flame-300'
                    }`}
                  >
                    {splitPlaying ? <IconStop size={12} /> : <IconPlay size={11} />}
                    {splitPlaying ? '停止' : '播放'}
                  </button>

                  <Seg<'audio' | 'synth'>
                    label="播放声部"
                    size="sm"
                    value={transportMode}
                    onChange={switchTransportMode}
                    options={[
                      { value: 'audio', label: '音频', title: '播放填词装配的采样成品' },
                      { value: 'synth', label: '电子音', title: '播放电子音骨架' },
                    ]}
                  />

                  <button
                    type="button"
                    onClick={() => setAutoTuneEnabled(!autoTuneEnabled)}
                    aria-pressed={autoTuneEnabled}
                    title={
                      autoTuneEnabled
                        ? '自动修音：开（对齐到事件音高）'
                        : '自动修音：关（只用手动半音偏移）'
                    }
                    className={`flex h-[26px] items-center gap-1 rounded-sm px-2 text-tiny font-medium transition-colors ${
                      autoTuneEnabled
                        ? 'bg-flame-500 text-ink-950 hover:bg-flame-400'
                        : 'text-label-muted hover:bg-ink-800 hover:text-flame-300'
                    }`}
                  >
                    自动修音
                  </button>

                  <span
                    className="flex h-[26px] items-center rounded-sm bg-ink-950 px-2 font-mono text-tiny tabular-nums text-label-lo"
                    title="播放头 / 总时长"
                  >
                    {formatTime(splitPlayheadSec)}
                    <span className="text-label-faint"> / {formatTime(durationSec)}</span>
                  </span>

                  <span
                    className="flex h-[26px] items-center rounded-sm bg-ink-950 px-2 font-mono text-tiny tabular-nums text-label-lo"
                    title="逐音装配进度"
                  >
                    {filledCount}/{selectedTake.events.length} 已装配
                  </span>

                  <button
                    type="button"
                    onClick={() => setFxOpen(true)}
                    aria-label="效果器"
                    title="打开效果器（全局主链）"
                    className="flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-tiny font-medium text-label-muted transition-colors hover:bg-ink-800 hover:text-flame-300"
                  >
                    <IconEffects size={13} />
                    FX
                  </button>
                </>
              }
              onChange={(updatedTake) => {
                useStore.getState().updateTakeEvents(
                  selectedTake.id,
                  updatedTake.events,
                );
              }}
            />

            {/* 逐音装配命令面板（选中事件按 Shift+A 唤起；模态浮层，不占布局） */}
            {paletteEvent !== null && selectedTake.events[paletteEvent] && (
              <NotePalette
                open={paletteEvent !== null}
                take={selectedTake}
                eventIndex={paletteEvent}
                samples={samples}
                effectiveSampleId={
                  resolveFilledSample(project, selectedTake.events[paletteEvent]) ??
                  drafts[paletteEvent] ??
                  null
                }
                initialDelta={selectedTake.events[paletteEvent].pitchDelta ?? 0}
                initialTau={selectedTake.events[paletteEvent].timeFactor ?? 1}
                onClose={closePalette}
                onCommit={handlePaletteCommit}
              />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 px-3 py-2.5">
            <div className="h-full rounded-md bg-ink-900 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
              <RollEmptyState
                onImportMidi={handleImportMidi}
                onGoRecord={() => setTab('record')}
                importing={importing}
              />
            </div>
          </div>
        )
      )}

      {/* ===== 面板：试听（TakePlayer 播放头与卷帘同步）===== */}
      {tab === 'listen' && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="rounded-md bg-ink-900 p-3 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            {selectedTake && selectedTake.events.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={playing ? stopPlayback : () => void startPlayback()}
                    className={`flex h-ctl-md items-center gap-1.5 rounded-sm px-3 text-small font-semibold transition-colors ${
                      playing
                        ? 'bg-danger text-white'
                        : 'bg-flame-400 text-ink-950 hover:bg-flame-300'
                    }`}
                  >
                    {playing ? <IconStop size={12} /> : <IconPlay size={11} />}
                    {playing ? '停止试听' : '试听装配成品'}
                  </button>
                  <p className="font-mono text-small tabular-nums text-label-lo">
                    {formatTime(playheadSec)}
                    <span className="text-label-faint"> / {formatTime(durationSec)}</span>
                  </p>
                </div>

                <div
                  className="mt-3 h-1 overflow-hidden rounded-full bg-ink-950"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progressPct)}
                  aria-label="试听进度"
                >
                  <div
                    className="h-full rounded-full bg-flame-400"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>

                <p className="mt-2 flex flex-wrap items-center gap-x-2 text-tiny text-label-faint">
                  <span>试听走主效果链（导出 = 预览）</span>
                  <span>·</span>
                  <span>切到「卷帘 + 填词」可看到播放头实时扫过事件块</span>
                  <span>·</span>
                  <kbd className="rounded-sm bg-ink-950 px-1.5 py-0.5 font-mono text-label-muted">
                    空格
                  </kbd>
                  <span>播放/暂停</span>
                </p>
              </>
            ) : (
              <GuardCard
                title="没有可试听的录制"
                body="先录制一段骨架（并在填词区装配素材），再来这里验收成品。"
              />
            )}
          </div>
        </div>
      )}

      {/* 导出对话框 */}
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* MIDI 导入确认（解析完先在弹窗里说清楚，确认后才落盘） */}
      {pendingMidi && (
        <MidiImportModal
          parsed={pendingMidi}
          keyCount={project.settings.keyCount}
          baseMidi={keyBaseMidi}
          semitoneEnabled={semitoneMode}
          onCancel={() => setPendingMidi(null)}
          onConfirm={confirmImportMidi}
        />
      )}

      {/* 全局效果器弹层（自旧填词面板迁移；卷帘传输槽唤起） */}
      {fxOpen && <EffectPopup open={fxOpen} onClose={() => setFxOpen(false)} />}
    </section>
  );
}

/** 空态引导卡（split / listen 共用） */
function GuardCard({ title, body }: { title: string; body: string }) {
  return <EmptyState title={title} description={body} />;
}
