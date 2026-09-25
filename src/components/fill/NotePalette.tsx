/**
 * NotePalette —— 逐音装配命令面板（Wave 2：替代旧内联下拉的浮动模态）。
 *
 * 交互契约（全部经 palette-reducer 纯状态机驱动，提交前对 store 零写入）：
 *  - 打开即聚焦搜索框；输入过滤走**拼音感知搜索**（与素材箱同一套
 *    `utils/sample-search`）：`张三.mp3` 可被「张三 / zhang / zs / zhangsan」
 *    四种输入命中，多音字按上下文消歧（重庆 → chongqing / cq），结果按相关度排序；
 *  - ↑/↓ 在候选间导航（两端夹取）；点击/悬停行同步**光标**；
 *  - Tab 循环焦点：搜索框 → 调音 spinbutton → 变速 spinbutton；
 *    spinbutton 聚焦时 ↑/↓ 步进、Home 复位（0 半音 / ×1.00）；
 *  - Shift+↑↓ 直接调音高、Shift+←→ 直接变速（焦点无关，步进配置框除外），
 *    每步 dispatch + 试听；**按住不放时只改数值不试听**，值落定（松手）后
 *    再完整试听一次 —— 否则连按会互相掐掉（每次只响一点点）并把同步变换排成长队。
 *    Shift+P 试听当前 staging 组合：上一段交给 `playSample` 在**新一段即将出声时**
 *    才停（`replacePrevious`），中间不留空档（裸 Shift 不再试听，避免 Shift+方向键时一声变两声）；
 *  - **变调 / 拉伸 / 试听的共同目标 = `tuneTargetId`**：
 *      ① 已选中行（Enter / 单击明确选中的候选）；否则
 *      ② **这条音符本来就装着的素材**（`placedId`）。
 *    两者都是「明确的对象」；只有**两者都没有**（音符没装素材、用户也没选中候选）才拦下
 *    → 提示「还没有选择素材 请按Enter选择素材」，且不做任何改动。
 *    为什么 ② 也算目标：对着**已经装好素材**的音符按 Shift+A 进来调音，意图显然是
 *    「调这条」—— 明明有素材却被告知「还没有选择素材」是说不通的（2026-09-20 用户实报）。
 *    为什么**不给光标行兜底**：光标会被鼠标悬停带走，拿它当目标就会改到「路过的那一行」，
 *    而听感上「改了」和「没改」很难当场分辨 —— 这是当初把目标收窄的原因；
 *    `placedId` 不随光标变，所以能安全地补进目标集合。（「应用」按钮另有一层光标兜底，
 *    见 reducer 的 `resolveTargetId`。）
 *    对应地，页脚的调音 / 变速控件与快捷键提示都跟着这个条件启用 / 变暗。
 *  - **候选选择 = 双保险**（详见 palette-reducer 头注释）：
 *      单击素材行   → 整行实色高亮（「已选中」），**不**提交；
 *      回车         → 光标行未选中时先「选中」，已选中时才真正确认并提交；
 *      双击素材行   → 等价「单击选中 + 再确认」；
 *      「应用」按钮 → 直接确认，目标 = 已选中行（无则光标行）。
 *    鼠标悬停只移动光标，**永远不会**改变提交目标 —— 这是双保险要挡的失误；
 *  - → / Esc / 点遮罩 = 取消；
 *  - 应用 → onCommit(eventIndex, sampleId, delta||undefined, τ===1?undefined:τ) 后关闭；
 *    取消 → 直接关闭，staging 蒸发，绝不触碰 store。
 *
 * 生命周期红线：卸载/关闭只 stop 自己发起的预览句柄，绝不 dispose 共享
 * 控制器（master chain / AudioContext / KeyMachine）—— StrictMode 开合重挂必须无恙。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { ensureAudioStarted } from '../../engine/core';
import { getMasterChain } from '../../engine/effects';
import {
  cacheBuffer,
  decodeAudioBlobShared,
  getCachedBuffer,
  playSample,
} from '../../engine/sample-player';
import type { PlayingSample } from '../../engine/sample-player';
import { useStore } from '../../model/store';
import { resolveSemitones } from '../../model/pitch-resolve';
import { clampSemitoneDelta } from '../../model/pitch-limits';
import { EffectPopup } from '../ui/EffectPopup';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/toast';
import { registerShortcut } from '../ui/shortcuts';
import { PitchDisplay } from './PitchDisplay';
import { EnginePicker } from './EnginePicker';
import { midiNoteName } from '../../model/pitch-map';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconEffects,
  IconLibrary,
  IconMinus,
  IconPlus,
  IconSearch,
} from '../ui/Icon';
import {
  clampTau,
  createInitialState,
  filterSamples,
  reducer,
  resolveTargetId,
  tuneTargetId,
} from './palette-reducer';
import type { Sample, SampleId, Take } from '../../model/types';

/**
 * 「按住不放」时，值落定之后等多久才试听（ms）。
 *
 * 数值本身**不等**——每次重复事件都立刻 dispatch，所以读数一路在涨；
 * 等的只是那一次试听。160ms 比常见按键重复间隔（~30ms）宽得多，
 * 又短到「手一停就听到结果」。
 */
const SETTLE_MS = 160;

/**
 * 让浏览器把这一帧画完再继续（尽最大努力，绝不卡死）。
 *
 * ══ 为什么需要（2026-09-20 用户实报「调音会有一点点粘滞的手感」）══
 *
 * 变调 / 拉伸是**同步**跑在主线程上的（实测 1.0s 素材 480~580ms，
 * 见 `_probe-palette.mjs` 第 15 节）。React 的提交虽然发生在事件处理末尾，
 * **绘制**却要等主线程空出来 —— 于是「按下 Shift+↑」的真实体感是
 * 「数字不出现、界面整个冻住约 0.6 秒」，这就是粘滞。
 * 让出一个宏任务再跑变换，数字就先画出来了：那 0.6 秒的冻结落在
 * 「声音晚一点到」上，而不是「按键像没反应」上。
 *
 * `rAF` → `setTimeout(0)`：rAF 回调跑在绘制**之前**，再退一个宏任务才基本
 * 可以确定这一帧已经画完。后台标签页里 rAF 根本不跑，所以留一个超时兜底 ——
 * 为了「画一帧」而把试听永远卡住是不可接受的。
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let guard = 0;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(guard);
      resolve();
    };
    guard = window.setTimeout(finish, 80);
    requestAnimationFrame(() => window.setTimeout(finish, 0));
  });
}

export interface NotePaletteProps {
  open: boolean;
  /** 目标录制（null = 防御性兜底，界面降级为不可提交） */
  take: Take | null;
  /** take.events 下标 */
  eventIndex: number;
  /** 全量素材（store 投影，只读） */
  samples: Sample[];
  /** 该音符当前生效的装配值（键序列解析所得），用于高亮定位与展示 */
  effectiveSampleId: SampleId | null;
  /** 事件已有 pitchDelta（无则 0） */
  initialDelta: number;
  /** 事件已有 timeFactor（无则 1） */
  initialTau: number;
  onClose(): void;
  onCommit(
    eventIndex: number,
    sampleId: SampleId,
    pitch: number | undefined,
    pitchDelta: number | undefined,
    timeFactor: number | undefined,
  ): void;
}

export default function NotePalette({ open, ...rest }: NotePaletteProps) {
  if (!open) return null;
  // key 绑定目标音符：换音符 = 全量重挂，staging 天然归零，无需同步 effect
  return <PaletteBody key={`${rest.take?.id ?? 'none'}:${rest.eventIndex}`} {...rest} />;
}

// ---------------------------------------------------------------------------
// 候选行的四种视觉状态
// ---------------------------------------------------------------------------

/**
 * 「光标」与「已选中」必须是**两种量级不同**的视觉，用户才可能一眼分清
 * 「我正在看哪一行」和「按下去会应用哪一行」。故刻意拉开：
 *
 *   plain        淡文字，悬停才浮出底色       —— 与我无关
 *   active       淡色底（同一强调色的 28%）   —— 光标停在这里（悬停/↑↓）
 *   armed        整行实色 + 白字 + 勾选图标   —— **已选中，回车就是它**
 *   armedActive  更亮的实色 + 深字 + 内描边   —— 光标正停在已选中项上（此时回车=提交）
 *
 * 只有 armed / armedActive 用「整行变色」，因为只有它们代表「确认」。
 */
type RowTone = 'plain' | 'active' | 'armed' | 'armedActive';

function rowTone(armed: boolean, active: boolean): RowTone {
  if (armed) return active ? 'armedActive' : 'armed';
  return active ? 'active' : 'plain';
}

const ROW_CLASS: Record<RowTone, string> = {
  plain: 'text-label-lo hover:bg-ink-800',
  /*
    ⚠️ 透明度修饰符**必须在 Tailwind 的 opacity 刻度内**（15/20/25/30/…），
    否则类名会被静默丢弃、样式无声消失 —— 这里原本写的 `/28` 就中招了：
    生成物里根本没有这条规则，导致「光标高亮」长期是不可见的（探针实测
    getComputedStyle 返回 rgba(0,0,0,0)）。需要非刻度值就用 `/[0.28]` 写法。
    这正是本次改造要区分的两种高亮，所以尤其不能哑掉。
  */
  active: 'bg-flame-600/25 text-flame-200',
  armed: 'bg-flame-600 font-semibold text-white',
  armedActive:
    'bg-flame-400 font-semibold text-ink-950 shadow-[inset_0_0_0_2px_rgb(var(--flame-200))]',
};

/** 行内次要文字（时长）在各底色上的可读色 */
const ROW_META_CLASS: Record<RowTone, string> = {
  plain: 'text-label-muted',
  active: 'text-label-muted',
  armed: 'text-white/75',
  armedActive: 'text-ink-950/70',
};

// ---------------------------------------------------------------------------
// 面板本体（仅在 open 时挂载，hooks 无条件执行）
// ---------------------------------------------------------------------------

type BodyProps = Omit<NotePaletteProps, 'open'>;

function PaletteBody({
  take,
  eventIndex,
  samples,
  effectiveSampleId,
  initialDelta,
  initialTau,
  onClose,
  onCommit,
}: BodyProps) {
  const keys = useStore((s) => s.project.keys);
  const setActivePage = useStore((s) => s.setActivePage);
  const [fxOpen, setFxOpen] = useState(false);
  /** 自动音高：开 = 以事件目标 MIDI 为准自动算变调；关 = 只走手动半音偏移 */
  const autoTune = useStore((s) => s.project.settings.autoTuneEnabled);

  const paletteSamples = useMemo(
    () =>
      samples.map((s) => ({
        id: s.id,
        name: s.name,
        durationSec: s.durationSec,
      })),
    [samples],
  );

  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState({
      samples: paletteSamples,
      initialCandidateId: effectiveSampleId,
      semitoneDelta: initialDelta,
      timeFactor: initialTau,
    }),
  );

  const filtered = useMemo(
    () => filterSamples(paletteSamples, state.filter),
    [paletteSamples, state.filter],
  );

  const ev = take?.events[eventIndex] ?? null;
  const keyMissing = !ev || !keys[ev.keyIndex];
  const keyLabel = ev ? (keys[ev.keyIndex]?.label ?? `键${ev.keyIndex + 1}`) : '—';
  /*
    事件所在键道 = ev.keyIndex（卷帘的行就是键下标，无需再绕音高推算）。
    键的音名 = keys[keyIndex].pitchMidi（迁移后必有；缺省回落 C4）。
  */
  const keyPitchMidi = ev ? (keys[ev.keyIndex]?.pitchMidi ?? 60) : 60;
  const title = `装配第${eventIndex + 1}音 · ${keyLabel} · 第${ev?.pressCount ?? '?'}按`;

  const effectiveSample = effectiveSampleId
    ? samples.find((s) => s.id === effectiveSampleId) ?? null
    : null;

  /*
    ── 目标解析（只在这里算一次，别在别处再推一遍）──

      tuneTargetId     → 调音 / 变速 / 试听 / 音高读数（严格：不含光标兜底）
      resolveTargetId  → 「应用」按钮（多一层光标兜底，保持既有契约）

    两者的完整理由在 `palette-reducer` 的头注释里 —— 那里是契约的唯一事实来源。
  */
  const armedId = state.armedId;
  const targetId = tuneTargetId(state);
  const applyId = resolveTargetId(state);
  /** 已选中（双保险第一道已过）的候选。用于页脚文案指名道姓，避免"我到底在应用哪个"。 */
  const armedSample = armedId
    ? paletteSamples.find((s) => s.id === armedId) ?? null
    : null;
  /** 调音目标的素材投影：已选中行，否则「这条音符本来就装着的」那一行 */
  const targetSample = targetId
    ? paletteSamples.find((s) => s.id === targetId) ?? null
    : null;
  /**
   * 变速步进的基准时长 = **调音目标**的时长。
   *
   * ⚠️ 不能再用 `armedSample?.durationSec`：现在目标可能来自 `placedId`（用户没回车），
   * 那时 armedSample 是 null → 基准时长 0 → 变速整组被判成「不可用」而按死，
   * 表现为「Shift+→ 完全没反应」，且看不出是这一处的锅。
   */
  const targetDur = targetSample?.durationSec ?? 0;
  /** 「应用」按钮文案用的名字（与 reducer 的 resolveTargetId 同源，不另算一套） */
  const applyTargetName = applyId
    ? paletteSamples.find((s) => s.id === applyId)?.name ?? null
    : null;

  // ---- refs ----
  const inputRef = useRef<HTMLInputElement>(null);
  const pitchRef = useRef<HTMLSpanElement>(null);
  const stretchRef = useRef<HTMLSpanElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement | null>());
  const previewRef = useRef<PlayingSample | null>(null);
  /** 预览请求序号：await 后校验是否仍是最新请求，丢弃过期结果（防叠加） */
  const previewSeqRef = useRef(0);
  /** 「按住不放」期间的落定计时器（见 `queueSettledPreview`）；null = 没有排队的试听 */
  const settleTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const decidedRef = useRef(false);

  // ---- 卸载清理：只停自己发起的预览句柄，绝不 dispose 共享控制器 ----
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      previewRef.current?.stop(0.03);
      previewRef.current = null;
    };
  }, []);

  // ---- Tab 焦点循环 → 同步 DOM 焦点 ----
  useEffect(() => {
    const el =
      state.focus === 'input'
        ? inputRef.current
        : state.focus === 'pitch'
          ? pitchRef.current
          : stretchRef.current;
    el?.focus();
  }, [state.focus]);

  // ---- 高亮行滚入视野 ----
  useEffect(() => {
    rowRefs.current.get(state.activeIdx)?.scrollIntoView({ block: 'nearest' });
  }, [state.activeIdx]);

  // ---- FX 弹层打开时吞掉注册表 Esc：只关 FX，不连带关面板 ----
  useEffect(() => {
    if (!fxOpen) return;
    return registerShortcut({
      id: 'note-palette-fx-esc',
      keys: ['Escape'],
      guardInput: false,
      priority: 10,
      handler: () => setFxOpen(false),
    });
  }, [fxOpen]);

  // ---- 决策落定 → 一次性执行提交/取消 ----
  useEffect(() => {
    const d = state.decision;
    if (!d || decidedRef.current) return;
    decidedRef.current = true;
    if (d.kind === 'apply') {
      onCommit(
        eventIndex,
        d.sampleId,
        autoTune ? ev?.pitch : undefined,
        d.semitoneDelta || undefined,
        d.timeFactor === 1 ? undefined : d.timeFactor,
      );
    }
    onClose();
  }, [state.decision, eventIndex, onCommit, onClose, autoTune, ev?.pitch]);

  const { semitoneDelta, timeFactor } = state.staged;

  /**
   * staging 值的最新镜像。
   *
   * 为什么需要：连按期间 `semitoneDelta` 是**渲染闭包**里的值，同一个 task 里
   * 连发两次 dispatch 时第二次拿到的还是旧的。而「按住之后落定时试听哪一档」
   * 必须取**落定那一刻**的读数，不能让调用点把值传进来（会落后一步）。
   */
  const stagedRef = useRef(state.staged);
  useEffect(() => {
    stagedRef.current = state.staged;
  }, [state.staged]);

  /*
    ── 变调 / 拉伸 / 试听的共同闸门 ──

    旧版闸门写的是 `if (armedId) return true;` —— 把「有目标」等同成「用户按过 Enter」。
    于是对着**已经装好素材**的音符（Shift+A 进来最常见的情形）按 Shift+↑，
    会被拦下并提示「还没有选择素材 请按Enter选择素材」：明明有素材，却被告知没选素材。
    现在闸门看的是 `targetId = 已选中行 ?? 这条音符本来就装着的素材`。

    `fromRepeat` 用于按键重复（`e.repeat`）：按住 Shift+↑ 时不该把提示刷屏。
  */
  const guardTarget = useCallback(
    (fromRepeat = false): boolean => {
      if (targetId) return true;
      if (!fromRepeat) toast('还没有选择素材 请按Enter选择素材');
      return false;
    },
    [targetId],
  );

  // ---- 显式值试听（步进/复位/Shift+P 共用；dispatch 与试听用同一份"下一步"值） ----
  const previewWith = useCallback(
    async (delta: number, tau: number) => {
      /*
        ⚠️ 试听用的素材必须与 `dispatch` 的那一次**同一个目标**（targetId），
        否则会出现「听到的是 A、提交下去的是 B」——这类错听感上分辨不出来。
      */
      if (!targetId) return;

      // 每次调用递增 token；await 后校验，过期请求直接丢弃
      const mySeq = ++previewSeqRef.current;

      /*
        ⚠️ 上一段**不在这里停**。

        用户实报「调音的时候声音响了，但只响一点点」。真因：
        这里原本先 `stop()` 掉上一段，而下一段的整段变换是**同步**跑在主线程上的
        （实测 1.0s 素材 480~580ms）—— 于是「新的还没算完，旧的就先掐了」。
        实测（`_probe-palette.mjs` 第 15 节，按住 Shift+↑ 连按 5 次）：
        第 2~5 段各自只响 69~240ms（满长 1012ms），段间还留 558~590ms 空档。

        改成把上一段交给 `playSample`，由它在**新一段即将出声的那一刻**去停
        （`replacePrevious`）—— 旧的响到新的能接上为止，不留空档。
        所以这里只**读**不**清**：清掉的话，被本请求取代的那一次就拿不到
        这个句柄、也就没人去停它，会留下一段永远响着的音频。
      */
      const prev = previewRef.current;
      ensureAudioStarted();
      // 只解码当前目标。旧实现每次 Shift+方向键都遍历预热全部素材，
      // 装配素材越多越卡；共享解码入口已足够保证当前素材不重复解码。

      let buffer = getCachedBuffer(targetId);
      if (!buffer) {
        const blob = useStore.getState().blobs[targetId];
        if (blob) {
          try {
            const decoded = await decodeAudioBlobShared(targetId, blob);
            buffer = decoded.buffer;
            cacheBuffer(targetId, buffer);
          } catch (err) {
            toast(`试听失败：素材解码出错（${(err as Error).message}）`);
            return;
          }
        }
      }
      if (!buffer) {
        toast('试听失败：该素材的音频数据已丢失');
        return;
      }

      // 检查：解码是异步的（也可能又走 fallback），await 之后必须重新校验
      if (!mountedRef.current || mySeq !== previewSeqRef.current) return;

      /*
        ── 先把这一步的数值交给浏览器画出来，再去跑同步变换 ──

        「粘滞的手感」不是音频层的：`playSample` 的整段变换同步占住主线程
        （实测每次按键 **595~682ms**，最长一个长任务 881ms），而 React 的提交
        虽然发生在事件处理末尾、**绘制**却要等主线程空出来 ——
        于是「按下 Shift+↑」的真实体感是：数字迟迟不出现、整个界面冻住半秒多。

        让出一个宏任务，数字就先画出来了：后续那半秒的冻结落在
        「声音晚一点到」上，而不是「按键像没反应」上。
        顺带还白拿一个好处：让出期间到达的连按会推进 `previewSeqRef`，
        本请求于是在这里自然退场 —— 连按只会试听**最后**那一档，不会补跑中间档。
      */
      await yieldToPaint();
      if (!mountedRef.current || mySeq !== previewSeqRef.current) return;

      try {
        previewRef.current = playSample({
          buffer,
          destination: getMasterChain(useStore.getState().project.effects).input,
          semitones: resolveSemitones(targetId, autoTune ? ev?.pitch : undefined) + delta,
          timeFactor: tau,
          gainLinear: 1,
          transformMode: 'psola',
          replacePrevious: prev,
        });
      } catch (err) {
        toast(`试听失败：${(err as Error).message}`);
      }
    },
    [targetId, autoTune, ev?.pitch],
  );

  /**
   * 把排队中的那次试听放出来（幂等：没排队就什么都不做）。
   *
   * 取的是**当前** staging 值，不是排队时的值 —— 连按期间闭包会落后一步，
   * 而「落定后该试听哪一档」的答案在落定那一刻才确定。
   */
  const fireSettledPreview = useCallback(() => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    void previewWith(stagedRef.current.semitoneDelta, stagedRef.current.timeFactor);
  }, [previewWith]);

  /**
   * 先改数值，**等值落定**再试听一次。
   *
   * ══ 为什么按键重复不能直接试听（2026-09-20 用户实报）══
   *
   * 一次「调音」（按一下 / 按住后松手）该响一次；而按住不放时按键重复
   * 每秒会送来约 30 个事件。每个事件都试听一次的话：
   *   · 每次试听都会把上一次掐掉 → **每一次都只响一点点**（用户报的第一个症状）；
   *   · 每次试听都要跑一遍同步变换 → 5 次连按实测占住主线程 5 × ~600ms，
   *     事件越积越多、数值半天不更新 → **粘滞**（用户报的第二个症状）。
   * 两者是同一个决定的后果，所以一起改：重复事件只改数值，值落定后试听一次。
   *
   * 兜底用防抖，正常路径是 keyup（见 `handleKeyUp`）—— 松手是用户心里
   * 「调完了」的那一刻，不该再等一个防抖窗口。
   */
  const queueSettledPreview = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(fireSettledPreview, SETTLE_MS);
  }, [fireSettledPreview]);

  // ---- 步进+即时试听（数学与 reducer 逐位一致：pitch 与 stretch 各自走同一个 clamp） ----
  const nudgePitch = useCallback(
    (d: number, fromRepeat = false) => {
      if (!guardTarget(fromRepeat)) return;
      dispatch({ type: 'AdjustPitch', delta: d });
      /*
        ⚠️ 试听用的值必须和 reducer 那一次 **逐位相同**。
        早先两边都是裸加法、reducer 也不夹取，所以「数学一致」是自动成立的；
        现在 reducer 夹取了 ±24，这里若还写 `semitoneDelta + d`，按住 Shift+↑ 到顶之后
        就会「听到 25 半音的声、提交下去 24 半音」—— 一个只在边界上出现、
        听完还分辨不出来的错。所以两边调**同一个** `clampSemitoneDelta`。
      */
      if (fromRepeat) queueSettledPreview();
      else void previewWith(clampSemitoneDelta(semitoneDelta + d), timeFactor);
    },
    [guardTarget, previewWith, queueSettledPreview, semitoneDelta, timeFactor],
  );
  const nudgeStretch = useCallback(
    (dir: number, fromRepeat = false) => {
      if (!guardTarget(fromRepeat)) return;
      if (!Number.isFinite(targetDur) || targetDur <= 0) return;
      const next = clampTau(
        timeFactor + (dir * state.staged.stepSec) / targetDur,
        state.staged.stepSec,
        targetDur,
      );
      dispatch({ type: 'AdjustStretch', direction: dir, sampleDur: targetDur });
      if (fromRepeat) queueSettledPreview();
      else void previewWith(semitoneDelta, next);
    },
    [
      guardTarget,
      previewWith,
      queueSettledPreview,
      semitoneDelta,
      timeFactor,
      targetDur,
      state.staged.stepSec,
    ],
  );

  // ---- 键盘契约（React onKeyDown 挂在面板内容容器，捕获冒泡） ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inStepInput = target === stepRef.current;
      const onPitch = target === pitchRef.current;
      const onStretch = target === stretchRef.current;

      // Shift+P 试听当前 staging（裸 Shift 不再试听）。
      // 注意：过滤框内 Shift+P 打不出大写 P（小写 p 照常过滤，匹配不分大小写）。
      if (e.shiftKey && e.key.toLowerCase() === 'p') {
        if (e.repeat) return;
        e.preventDefault();
        if (!guardTarget()) return;
        void previewWith(semitoneDelta, timeFactor);
        return;
      }
      /*
        Shift+↑↓ / Shift+←→ 都只作用于「调音目标」。
        按住不放时 `e.repeat` 为真 —— 那时只改数值、**不试听**：
        每次重复都试听一次会互相掐掉（每次都只响一点点）并把同步变换排成长队
        （实测 5 次连按 = 主线程被占 5 × ~600ms，手感粘滞）。
        数值落定后（keyup，兜底 160ms 防抖）再试听一次完整的结果，
        详见 `queueSettledPreview`。提示同理：只有第一次按下去会弹。
      */
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (inStepInput) return;
        e.preventDefault();
        nudgePitch(e.key === 'ArrowUp' ? 1 : -1, e.repeat);
        return;
      }
      // Shift+←→ 直接变速（纯 → = 取消的逻辑在下面，Shift 修饰走这里）
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (inStepInput) return;
        e.preventDefault();
        nudgeStretch(e.key === 'ArrowRight' ? 1 : -1, e.repeat);
        return;
      }
      // 开窗和弦（Shift+A）手指未松时的单字符重复直接丢弃，防过滤框吞入一串 A
      if (e.repeat && e.key.length === 1) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        dispatch({ type: 'TabFocus' });
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (inStepInput) return; // 数字输入框走原生步进
        e.preventDefault();
        // 上 = 加（音更高/更长），与直觉一致；候选导航除外（列表语义：下=下一项）
        if (onPitch) nudgePitch(e.key === 'ArrowUp' ? 1 : -1, e.repeat);
        else if (onStretch) nudgeStretch(e.key === 'ArrowUp' ? 1 : -1, e.repeat);
        else dispatch({ type: 'NavDelta', delta: e.key === 'ArrowDown' ? 1 : -1, filtered });
        return;
      }
      if (e.key === 'Home') {
        if (onPitch) {
          e.preventDefault();
          if (!guardTarget()) return;
          dispatch({ type: 'ResetFocusValue', target: 'pitch' });
          void previewWith(0, timeFactor);
        } else if (onStretch) {
          e.preventDefault();
          if (!guardTarget()) return;
          dispatch({ type: 'ResetFocusValue', target: 'stretch' });
          void previewWith(semitoneDelta, 1);
        }
        return;
      }
      if (e.key === 'Enter') {
        // 按钮走原生激活（「应用」按钮本身就是显式确认）；步进配置框不劫持回车
        if (inStepInput || target.closest('button')) return;
        e.preventDefault();
        /*
          双保险：第一次回车只「选中」光标行，光标已在选中行上时才真正确认。
          提交前必须让用户看清是哪一行 —— 详见 palette-reducer 头注释。
        */
        dispatch({ type: 'Confirm' });
        return;
      }
      if (e.key === 'ArrowRight') {
        if (inStepInput) return; // 光标右移
        e.preventDefault();
        dispatch({ type: 'Cancel' });
      }
    },
    [previewWith, semitoneDelta, timeFactor, nudgePitch, nudgeStretch, filtered, guardTarget],
  );

  /**
   * 松手 = 一次「按住调音」的结束 → 把排队的那次试听（当前值）放出来。
   *
   * 为什么靠 keyup 而不是只靠防抖：松手是用户心里「调完了」的那一刻，
   * 立刻听到结果才对得上手感；只靠 160ms 防抖会晚一拍。
   * 防抖仍然留着，它兜的是「keyup 收不到」的情形（焦点丢失、切窗口、拖到别的控件上）。
   *
   * 不看 `shiftKey`：Shift 与方向键谁先松手都可能，只要松的是方向键就算落定。
   */
  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        fireSettledPreview();
      }
    },
    [fireSettledPreview],
  );

  /**
   * 鼠标单击候选行：光标移到该行**并直接选中它**。
   * 与键盘同构 —— 单击 = 「移动 + 第一次回车」，仍需再来一次动作才算确认
   * （双击 / 点「应用」/ 回车）。点完把焦点还给搜索框，后续 ↑↓/回车 语义连续。
   */
  const armRow = useCallback(
    (i: number) => {
      dispatch({ type: 'Arm', index: i, filtered });
      inputRef.current?.focus();
    },
    [filtered],
  );

  const pitchText = `${state.staged.semitoneDelta > 0 ? '+' : ''}${state.staged.semitoneDelta} 半音`;
  const tauText = `×${state.staged.timeFactor.toFixed(2)}`;
  /*
    「应用」是否可用：与 reducer 的 `resolveTargetId` 同源。
    不能再看 `staged.candidateId` —— 音符已装素材时目标可能是 `placedId`（用户没回车），
    而光标行此刻完全可能是别的行（甚至被过滤筛掉），拿它判可用会把按钮按死。
  */
  const canApply = !keyMissing && applyId !== null && !state.decision;
  /** 未选中（Enter 高亮）→ 调音 / 变速控件禁用。见头部契约。 */
  /**
   * 调音 / 变速 / 试听的可用性 —— 与 `tuneTargetId` 是**同一个条件**，
   * 同时也决定快捷键提示是否置灰、就地提示是否出现。
   * 名字叫 `tunable`（而不是 `armed`）是刻意的：它不等于「用户按过 Enter」，
   * 只要这条音符**本来就有素材**就已经可调了。
   */
  const tunable = targetId !== null;
  /**
   * 音高读数跟着**调音目标**走，而不是光标行 —— 否则读数和会被改的那一行对不上。
   * 目标可能是「已选中行」，也可能是「这条音符本来就装着的素材」。
   */
  const displaySemitones = targetId
    ? resolveSemitones(targetId, autoTune ? ev?.pitch : undefined) + state.staged.semitoneDelta
    : 0;

  // ---- 步进配置（本地文本态：容忍输入中间态「0.」，落值仍走 reducer 校验） ----
  const [stepText, setStepText] = useState(() => String(state.staged.stepSec));
  const onStepChange = (v: string) => {
    setStepText(v);
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) dispatch({ type: 'SetStep', stepSec: n });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      centered
      footer={
        paletteSamples.length === 0 ? undefined : (
          /*
            页脚拆两行（lg 以上）。
            教训：把「调音 + 变速 + 步进 + FX + 取消 + 应用」6 组控件全挤进一行，
            在 max-w-lg（512px）下必然溢出，主操作「应用」会被挤出弹层右缘。
            现在：上排参数（可换行），下排主操作（独占一行、右对齐）。
          */
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {/*
                ── 调音 / 变速 ──
                未选中素材时整组**禁用**：Δ 与 τ 属于「这一条放置」，
                没有目标就无处可施 —— 让按钮看得出来按不动，
                比按下去才弹提示更省一次试错。
              */}
              <div
                className={`flex shrink-0 items-center gap-1 ${tunable ? '' : 'opacity-40'}`}
                data-transform-group="pitch"
                data-disabled={tunable ? undefined : 'true'}
              >
                <span className="text-small text-label-muted">调音</span>
                <button
                  type="button"
                  aria-label="降低半音"
                  title={tunable ? '降低半音（Shift+↓）' : '先按 Enter 选择素材'}
                  onClick={() => nudgePitch(-1)}
                  disabled={!tunable}
                  className="icon-btn h-ctl-sm w-ctl-sm"
                >
                  <IconMinus size={13} />
                </button>
                <span
                  ref={pitchRef}
                  role="spinbutton"
                  tabIndex={0}
                  aria-label="移调增量（半音）"
                  aria-valuenow={state.staged.semitoneDelta}
                  aria-valuetext={pitchText}
                  className="flex h-ctl-sm min-w-[52px] items-center justify-center rounded-sm bg-ink-950 px-1 font-mono text-small tabular-nums text-flame-300 outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.8)]"
                >
                  {state.staged.semitoneDelta > 0 ? '+' : ''}
                  {state.staged.semitoneDelta}
                </span>
                <button
                  type="button"
                  aria-label="升高半音"
                  title={tunable ? '升高半音（Shift+↑）' : '先按 Enter 选择素材'}
                  onClick={() => nudgePitch(1)}
                  disabled={!tunable}
                  className="icon-btn h-ctl-sm w-ctl-sm"
                >
                  <IconPlus size={13} />
                </button>
              </div>

              {/* ── 变速：− 值 ＋ ── */}
              <div
                className={`flex shrink-0 items-center gap-1 ${tunable ? '' : 'opacity-40'}`}
                data-transform-group="stretch"
                data-disabled={tunable ? undefined : 'true'}
              >
                <span className="text-small text-label-muted">变速</span>
                <button
                  type="button"
                  aria-label="缩短时长"
                  title={tunable ? '缩短时长（Shift+←）' : '先按 Enter 选择素材'}
                  onClick={() => nudgeStretch(-1)}
                  disabled={!tunable || targetDur <= 0}
                  className="icon-btn h-ctl-sm w-ctl-sm"
                >
                  <IconMinus size={13} />
                </button>
                <span
                  ref={stretchRef}
                  role="spinbutton"
                  tabIndex={0}
                  aria-label="时长因子"
                  aria-valuenow={Number(state.staged.timeFactor.toFixed(4))}
                  aria-valuetext={tauText}
                  className="flex h-ctl-sm min-w-[48px] items-center justify-center rounded-sm bg-ink-950 px-1 font-mono text-small tabular-nums text-flame-300 outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.8)]"
                >
                  {tauText}
                </span>
                <button
                  type="button"
                  aria-label="拉长时长"
                  title={tunable ? '拉长时长（Shift+→）' : '先按 Enter 选择素材'}
                  onClick={() => nudgeStretch(1)}
                  disabled={!tunable || targetDur <= 0}
                  className="icon-btn h-ctl-sm w-ctl-sm"
                >
                  <IconPlus size={13} />
                </button>
              </div>

              {/*
                没有可调目标时的就地说明。用户按 Shift+↑ 而什么都没发生时，
                需要一句「为什么」——提示气泡会消失，这行字不会。

                ⚠️ 只有在**这条音符没装素材、用户也没选中任何候选**时才出现。
                「已经有装配素材」不算没有目标（2026-09-20 用户实报的正是这一条）。
              */}
              {!tunable && (
                <span
                  className="shrink-0 text-micro text-flame-300/80"
                  data-arm-required="true"
                >
                  还没有选择素材 请按Enter选择素材
                </span>
              )}

              {/* ── 步进配置 ── */}
              <label className="flex shrink-0 items-center gap-1 text-small text-label-muted">
                步进
                <input
                  ref={stepRef}
                  type="number"
                  min={0.005}
                  step={0.005}
                  value={stepText}
                  onChange={(e) => onStepChange(e.target.value)}
                  onBlur={() => setStepText(String(state.staged.stepSec))}
                  aria-label="变速步进（秒）"
                  className="h-ctl-sm w-[52px] rounded-sm bg-ink-950 px-1 text-center font-mono text-small tabular-nums text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.8)]"
                />
                <span className="text-micro text-label-faint">s</span>
              </label>

              {/* ── FX ── */}
              <button
                type="button"
                onClick={() => setFxOpen(true)}
                aria-label="效果器"
                title="打开效果器（全局主链）"
                className="icon-btn h-ctl-sm w-ctl-sm"
              >
                <IconEffects size={13} />
              </button>
            </div>

            {/* ── 主操作独占一行 ── */}
            <div className="flex items-center justify-end gap-2">
              {/*
                状态化提示：已选中时**指名道姓**写出即将应用的素材。
                这是双保险的第二半 —— 光有整行变色还不够，文字再确认一次，
                用户才不必靠记忆判断「现在按回车会装哪个」。
              */}
              <span className="mr-auto hidden min-w-0 items-baseline gap-1 text-micro text-label-faint sm:flex">
                {armedSample ? (
                  <>
                    <span className="shrink-0">已选中</span>
                    <span className="max-w-[9rem] truncate font-medium text-flame-300">
                      {armedSample.name}
                    </span>
                    <span className="shrink-0">· 回车应用</span>
                  </>
                ) : targetSample ? (
                  /*
                    第三态：没按过 Enter，但**这条音符本来就装着素材** ——
                    此时调音已经有目标了，页脚必须说清楚是哪一个，
                    否则用户不知道 Shift+↑ 到底改了谁。
                  */
                  <>
                    <span className="shrink-0">调音作用在</span>
                    <span className="max-w-[9rem] truncate font-medium text-flame-300">
                      {targetSample.name}
                    </span>
                    <span className="shrink-0">（当前装配）</span>
                  </>
                ) : (
                  <span className="shrink-0">回车选中 · 再回车应用</span>
                )}
                <span className="shrink-0 pl-1 text-label-faint/60">·</span>
                <span className="shrink-0">→/Esc 取消</span>
              </span>
              <button
                type="button"
                onClick={() => dispatch({ type: 'Cancel' })}
                className="h-ctl-md shrink-0 rounded-sm px-3 text-small font-medium text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'Apply' })}
                disabled={!canApply}
                title={applyTargetName ? `应用到「${applyTargetName}」` : '应用'}
                className="h-ctl-md min-w-[72px] shrink-0 rounded-sm bg-flame-400 px-3.5 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-label-faint"
              >
                应用
              </button>
            </div>
          </div>
        )
      }
    >
      {/*
        骨架与 SampleEditorModal 保持一致：
        内容区自身滚动，操作条固定在 footer —— 所以参数再多也不会把弹层撑高。
        旧版把调音/变速/应用全部堆在内容末尾，是「一多就挤」的根因。
      */}
      <div
        className="flex flex-col gap-2.5 lg:flex-row"
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* ===== 键位失效警告 ===== */}
          {keyMissing && (
            <p className="flex items-start gap-1.5 rounded-sm bg-danger/[0.12] px-2.5 py-1.5 text-small leading-relaxed text-danger shadow-[inset_0_0_0_1px_rgb(var(--danger)/0.4)]">
              <IconAlert size={13} className="mt-px shrink-0" />
              键位不存在：该事件指向的键已被删除，无法装配。请回演奏台修复键位。
            </p>
          )}

          {/*
            ══ 键位徽章（要看清楚正在装配卷帘的哪一行，不用左右来回找）══

            左侧大字 = 键的音名（Key.pitchMidi → C4 / D#5），
            与卷帘键盘栏逐行标注的音名严格同源 —— 用户对照一次就够。
            右侧 = 事件自身的音高（含导入 MIDI 的黑键），与 PitchDisplay 互证。
          */}
          {!keyMissing && ev && (
            <div className="flex shrink-0 items-center gap-3 rounded-sm bg-ink-950 px-3 py-2 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
              <span
                aria-hidden="true"
                className="h-9 w-1 shrink-0 rounded-full bg-flame-400"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-[22px] font-bold leading-none tracking-[-0.02em] text-flame-300">
                  {midiNoteName(keyPitchMidi)}
                </span>
                <span className="mt-1 whitespace-nowrap font-mono text-micro tabular-nums text-label-muted">
                  键道 {ev.keyIndex}
                  <span className="mx-1 text-label-faint">·</span>第 {ev.pressCount} 按
                </span>
              </span>
              <span className="min-w-2 flex-1" />
              <span className="flex shrink-0 flex-col items-end">
                <span className="font-mono text-body font-semibold tabular-nums text-label-hi">
                  {midiNoteName(ev.pitch ?? keyPitchMidi)}
                </span>
                <span className="font-mono text-micro tabular-nums text-label-muted">
                  事件音高
                </span>
              </span>
            </div>
          )}

          {paletteSamples.length === 0 ? (
            /* ===== 素材箱为空 ===== */
            <div className="flex flex-col items-center gap-2.5 py-8">
              <IconLibrary size={32} className="text-label-faint" />
              <p className="text-body font-medium text-label-lo">素材箱还是空的</p>
              <p className="text-small text-label-faint">装配音符需要至少一个音频素材。</p>
              <button
                type="button"
                onClick={() => {
                  setActivePage('material');
                  onClose();
                }}
                className="mt-1 h-ctl-md rounded-sm bg-flame-400 px-3.5 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300"
              >
                去素材箱上传
              </button>
            </div>
          ) : (
            <>
              {/* ===== 当前装配 / 待填：一行状态条 ===== */}
              <div className="flex shrink-0 items-center gap-1.5 rounded-sm bg-ink-950 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
                <IconCheck
                  size={12}
                  className={effectiveSample ? 'shrink-0 text-flame-300' : 'shrink-0 text-label-faint'}
                />
                <span className="shrink-0 text-micro text-label-faint">当前装配</span>
                {effectiveSample ? (
                  <>
                    <span className="min-w-0 truncate text-small text-label-hi">
                      {effectiveSample.name}
                    </span>
                    <span className="shrink-0 font-mono text-micro tabular-nums text-label-muted">
                      {effectiveSample.durationSec.toFixed(1)}s
                    </span>
                  </>
                ) : (
                  <span className="text-small text-label-muted">待填</span>
                )}
              </div>

              {/* ===== 过滤输入（带搜索图标）===== */}
              <label className="flex h-ctl-md shrink-0 items-center gap-1.5 rounded-sm bg-ink-950 px-2 shadow-[inset_0_0_0_1px_rgb(var(--line))] transition-shadow focus-within:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]">
                <IconSearch size={13} className="shrink-0 text-label-faint" />
                <input
                  ref={inputRef}
                  autoFocus
                  type="text"
                  placeholder="搜索素材（名称 / 拼音 / 首字母）"
                  value={state.filter}
                  aria-label="搜索素材"
                  onChange={(e) => {
                    const f = e.target.value;
                    dispatch({
                      type: 'SetFilter',
                      filter: f,
                      filtered: filterSamples(paletteSamples, f),
                    });
                  }}
                  className="min-w-0 flex-1 bg-transparent text-small text-label-hi outline-none placeholder:text-label-faint"
                />
                {state.filter !== '' && (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() =>
                      dispatch({ type: 'SetFilter', filter: '', filtered: paletteSamples })
                    }
                    className="shrink-0 text-label-faint transition-colors hover:text-label-lo"
                  >
                    <IconClose size={12} />
                  </button>
                )}
              </label>

              {/* ===== 候选列表：吃满剩余高度 ===== */}
              <div
                role="listbox"
                aria-label="素材候选"
                className="max-h-[248px] min-h-[96px] flex-1 overflow-y-auto rounded-sm shadow-[inset_0_0_0_1px_rgb(var(--line))]"
              >
                {filtered.length === 0 ? (
                  <p className="px-3 py-5 text-center text-small text-label-muted">无匹配素材</p>
                ) : (
                  filtered.map((s, i) => {
                    const active = i === state.activeIdx;
                    const armed = s.id === state.armedId;
                    const tone = rowTone(armed, active);
                    return (
                      <button
                        key={s.id}
                        ref={(el) => {
                          rowRefs.current.set(i, el);
                        }}
                        type="button"
                        role="option"
                        // aria-selected 表达的是**真正确认**的选中项，不是光标位置
                        aria-selected={armed}
                        data-cursor={active ? 'true' : undefined}
                        title={
                          armed
                            ? `已选中：${s.name}（回车 / 双击 / 点「应用」即确认）`
                            : `单击选中：${s.name}`
                        }
                        onClick={() => armRow(i)}
                        onMouseEnter={() =>
                          // 悬停只移动光标，**不动**选中项：无意识动作不能改变提交目标
                          dispatch({ type: 'NavDelta', delta: i - state.activeIdx, filtered })
                        }
                        onDoubleClick={() => dispatch({ type: 'Confirm' })}
                        className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-small transition-colors ${ROW_CLASS[tone]}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {armed && (
                          <IconCheck
                            size={12}
                            className={
                              tone === 'armedActive'
                                ? 'shrink-0 text-ink-950'
                                : 'shrink-0 text-white'
                            }
                          />
                        )}
                        <span
                          className={`shrink-0 font-mono text-micro tabular-nums ${ROW_META_CLASS[tone]}`}
                        >
                          {s.durationSec.toFixed(1)}s
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {/*
                ===== 变调引擎切换（实验分支 feat/lib-engines）=====
                放在试听快捷键提示的正上方：用户就是在这里按 Shift+P / Shift+↑↓
                反复听的，切换器得在视线落点上。
                偏好是全局的（localStorage），试听与导出走同一个 —— 见
                `engine/external-shift.ts` 的四条设计约束。
              */}
              <EnginePicker onChange={() => void previewWith(semitoneDelta, timeFactor)} />

              {/*
                ===== 快捷键提示：贴底一行，不再占独立段落 =====
                两处随状态变，都要写实：
                  · 「回车」—— 未按过 Enter 时是「选中」，已选中时才是「应用」；
                  · 「Shift+P / Shift+↑↓ / Shift+←→」—— 只在**真的没有可调目标**时
                    整条置灰。注意「这条音符本来就装着素材」也算有目标，那时是亮的
                    （它和调音目标同源：`tuneTargetId`）。
                用户不用猜自己按下去会发生什么。

                `data-tunable` / `data-tune-target` 是给探针查证的钩子：
                「控件亮着但目标是光标行」这类错只能靠读实际属性发现。
              */}
              <p
                className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 text-micro text-label-faint"
                data-tunable={tunable ? 'true' : 'false'}
                data-tune-target={targetId ?? ''}
              >
                <span className={tunable ? undefined : 'opacity-40'}>
                  <kbd className="rounded-sm bg-ink-950 px-1 py-px font-mono text-label-muted">Shift+P</kbd>{' '}
                  试听
                </span>
                <span className="text-label-faint/50">·</span>
                <span className={tunable ? undefined : 'opacity-40'}>
                  <kbd className="rounded-sm bg-ink-950 px-1 py-px font-mono text-label-muted">Shift+↑↓</kbd>{' '}
                  音高
                </span>
                <span className="text-label-faint/50">·</span>
                <span className={tunable ? undefined : 'opacity-40'}>
                  <kbd className="rounded-sm bg-ink-950 px-1 py-px font-mono text-label-muted">Shift+←→</kbd>{' '}
                  变速
                </span>
                <span className="text-label-faint/50">·</span>
                <span>
                  <kbd className="rounded-sm bg-ink-950 px-1 py-px font-mono text-label-muted">单击</kbd>{' '}
                  选中
                </span>
                <span className="text-label-faint/50">·</span>
                <span className={armedSample ? 'font-medium text-flame-300' : undefined}>
                  <kbd className="rounded-sm bg-ink-950 px-1 py-px font-mono text-label-muted">回车</kbd>{' '}
                  {armedSample ? '应用' : '选中'}
                </span>
              </p>
            </>
          )}
        </div>

        {/* 读数跟着**调音目标**走：读数和会被改的那一个必须一致 */}
        <PitchDisplay sampleId={targetId} semitones={displaySemitones} />
      </div>

      {/* ===== 全局效果弹层（嵌套于面板之上，Esc 优先关它） ===== */}
      {fxOpen && <EffectPopup open={fxOpen} onClose={() => setFxOpen(false)} />}
    </Modal>
  );
}
