/**
 * palette-reducer —— NotePalette 命令面板的纯状态机（零 React、零 store 依赖）。
 *
 * 职责：逐音装配的「staging（暂存）」语义 —— 用户在模态面板里过滤/导航/调音/变速，
 * 一切改动只写入本 reducer 的 staged 快照；直到 Apply/Cancel 落定 decision，
 * 组件层才据此调用 onCommit（写 store）或直接 onClose（零写入）。
 *
 * ── 搜索：拼音 / 首字母（复用 src/utils/sample-search.ts，与素材箱同一套算法）──
 *  `张三.mp3` 可被「张三」「zhang」「zs」「zhangsan」四种输入命中；多音字由
 *  pinyin-pro 依上下文消歧（重庆 → chongqing / cq）。命中按相关度打分排序。
 *
 * ── 候选选择：双保险（two-step arm → confirm）──
 *  历史上「光标在哪 = 会应用谁」，而光标又跟着鼠标悬停跑，于是用户常常
 *  不知道自己按下去的是哪个素材。现在拆成两个独立概念：
 *
 *    · 光标（activeIdx）    —— 键盘 ↑↓ 与鼠标悬停移动，只表示「我正在看这一行」；
 *    · 选择性高亮（armedId）—— 用户**明确选中**的候选，视觉上整行变色。
 *
 *  规则（与鼠标操作同构，两个动作才算确认）：
 *    · 光标行 ≠ 已选中行，按 Enter  → 把光标行**选中**（不提交）；
 *    · 光标行 = 已选中行，按 Enter  → **真正确认**，提交并关闭；
 *    · 鼠标单击某行                   → 光标移到该行**并直接选中它**（同样不提交）；
 *    · 鼠标双击某行                   → 等价于「单击选中 + 再次确认」；
 *    · 「应用」按钮                   → 直接确认，目标 = resolveTargetId（见下）。
 *
 *  于是「悬停」这种无意识动作永远无法改变提交目标 —— 这正是双保险要挡的失误。
 *  armedId 存的是 **sampleId 而非下标**：过滤会重排列表，下标会漂。
 *  过滤后已选中项若被筛掉（列表里找不到），arm 自动失效并清空，避免提交到一个
 *  用户根本看不见的候选。
 *
 * ── 「这条音符已经装了素材」也算一种选中（2026-09-20）──
 *  早期把「有可调目标」等同成「用户按过 Enter」（`armedId != null`），于是对着
 *  一块**已经装好素材**的音符按 Shift+A 进来调音，会被拦下并提示
 *  「还没有选择素材 请按Enter选择素材」—— 而它明明已经有素材了。
 *  现在把两个事实分开：
 *    · armedId  —— 用户**本次明确选中**的候选（可能是换一个素材）；
 *    · placedId —— 这条音符**本来就装着的**素材（打开面板那一刻的事实）。
 *  它们都能当目标，优先级与用途见 `resolveTargetId` / `tuneTargetId`。
 *
 * 决策：
 *  - → 键 = Cancel（Esc 由 Modal 全局注册表转 onClose，语义同为取消）；
 *  - decision 落定后 reducer 进入终态，任何后续动作不再改写（防双击/竞态双提交）。
 *
 * 步进数学（与 WASM 相位声码器 τ 语义对齐，见 engine/sample-player PlaySampleOptions）：
 *  - computeStepSec：每次点击改变「输出时长」的秒数上限 0.05s，下限 0.05s 兜底
 *    （durationSec=0 的未解码素材与极短素材都恒得 0.05，杜绝步进为 0 的死锁）；
 *  - τ 增量 = stepSec / sampleDur（时长加/减一个固定步长 ⇔ τ 按比例走）；
 *  - clampTau：下限 stepSec/sampleDur（拉伸结果不少于一个步长，默认即 0.05/dur）、
 *    上限 8 倍。
 *  - **半音增量走 `clampSemitoneDelta`（±24）** —— 与 τ 对称地夹取。
 *    早先这里**没有**夹取（注释还写着「pitch 无夹取」），而 Shift+↑/↓ 是按住
 *    连发的，于是几秒就能把增量推到 ±60：那个档位上多数引擎会退化成静音或
 *    32 倍爆音（实测见 `model/pitch-limits.ts`），且这个坏值会被持久化进事件，
 *    之后回放/导出一直是坏的 —— 用户看到的就是「这条素材没声音」。
 */
import { searchByName } from '../../utils/sample-search';
import { clampSemitoneDelta } from '../../model/pitch-limits';
import type { SampleId } from '../../model/types';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 面板渲染所需的素材最小投影（避免耦合 store 的完整 Sample） */
export interface PaletteSample {
  id: SampleId;
  name: string;
  durationSec: number;
}

/** 暂存中的装配组合（提交前只活在这里） */
export interface Staged {
  /** 当前高亮候选（跟随 activeIdx / 过滤结果同步）；null = 无可提交目标 */
  candidateId: SampleId | null;
  /** 本放置专属移调增量（带符号半音），叠加在 resolveSemitones 基准之上 */
  semitoneDelta: number;
  /** 本放置专属时长因子 τ（输出/输入时长比） */
  timeFactor: number;
  /** 变速步进（秒）：每次点击让输出时长变化 |stepSec| */
  stepSec: number;
}

export type FocusTarget = 'input' | 'pitch' | 'stretch';

/** 面板终态决策：组件据此走 onCommit+close 或纯 close */
export type PaletteDecision =
  | {
      kind: 'apply';
      sampleId: SampleId;
      semitoneDelta: number;
      timeFactor: number;
    }
  | { kind: 'cancel' };

export interface PaletteState {
  filter: string;
  /** 过滤结果中的高亮下标（「我正在看这一行」；跟随 ↑↓ 与鼠标悬停） */
  activeIdx: number;
  /**
   * 选择性高亮：用户**明确选中**的候选 id（双保险的第一道）。
   * null = 尚未选中任何候选（此时第一次 Enter 只做「选中」）。
   * 注意存的是 id 而非下标 —— 过滤会重排列表。
   */
  armedId: SampleId | null;
  /**
   * 这条音符**本来就装配着**的素材 id（打开面板那一刻的事实，之后不再变）。
   *
   * 为什么不复用 `staged.candidateId`：那个字段跟着**光标**跑，鼠标悬停就会把它
   * 改掉；而 `placedId` 只由打开面板时的 `effectiveSampleId` 决定，与光标无关。
   * 这正是它能当调音目标的原因 —— 光标是噪声，它是事实。
   * null = 这条音符还没装任何素材（只有这种情况才真的是「没有素材可调」）。
   */
  placedId: SampleId | null;
  focus: FocusTarget;
  staged: Staged;
  decision: PaletteDecision | null;
}

export type PaletteAction =
  | { type: 'SetFilter'; filter: string; filtered: PaletteSample[] }
  | { type: 'NavDelta'; delta: number; filtered: PaletteSample[] }
  /** 鼠标单击：光标移到该行并同时**选中**它（等价于「移动 + 第一次 Enter」） */
  | { type: 'Arm'; index: number; filtered: PaletteSample[] }
  /** 回车：光标行未选中 → 选中；已选中 → 真正确认并提交 */
  | { type: 'Confirm' }
  | { type: 'TabFocus' }
  | { type: 'AdjustPitch'; delta: number }
  | { type: 'AdjustStretch'; direction: number; sampleDur: number }
  | { type: 'ResetFocusValue'; target: 'pitch' | 'stretch' }
  | { type: 'SetStep'; stepSec: number }
  /** 应用按钮 / 代码侧显式提交：目标 = 已选中行（无则光标行） */
  | { type: 'Apply' }
  | { type: 'Cancel' };

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/**
 * 过滤谓词：名称走 **拼音感知 + 相关度排序** 的搜索（与素材箱同一套
 * `searchByName`），并保留 id 子串兜底（旧面板 CustomPicker 行为）。
 *
 * `张三.mp3` 的可命中输入：
 *   张三（原文子串）/ zhang（全拼前缀）/ zs（首字母）/ zhangsan（全拼）
 *
 * 排序：有查询时按相关度降序（精准 > 名称子串 > 首字母 > 拼音），
 * 只被 id 命中的排在名称命中之后；空查询原样返回（不排序，保持素材箱顺序）。
 */
export function filterSamples(
  samples: PaletteSample[],
  filter: string,
): PaletteSample[] {
  const q = filter.trim();
  if (!q) return samples;

  const byName = searchByName(samples, q);
  const hit = new Set(byName.map((s) => s.id));
  const lower = q.toLowerCase();
  const byId = samples.filter(
    (s) => !hit.has(s.id) && s.id.toLowerCase().includes(lower),
  );
  return byId.length ? [...byName, ...byId] : byName;
}

/** 变速步进默认值：min(0.05, dur×0.2)，下限 0.05 兜底（未解码/极短素材恒 0.05） */
export function computeStepSec(sampleDur: number): number {
  const STEP_FLOOR = 0.05;
  if (!Number.isFinite(sampleDur) || sampleDur <= 0) return STEP_FLOOR;
  return Math.max(STEP_FLOOR, Math.min(STEP_FLOOR, sampleDur * 0.2));
}

/** τ 夹取：下限 stepSec/sampleDur（dur 非法时退化为 stepSec），上限 8 */
export function clampTau(tau: number, stepSec: number, sampleDur: number): number {
  const floor = sampleDur > 0 ? stepSec / sampleDur : stepSec;
  return Math.max(floor, Math.min(8, tau));
}

/**
 * 半音步进量：**1 半音**。
 *
 * 为什么把这个数写出来：它与 `clampSemitoneDelta` 的 ±24 一起决定了
 * 「按住 Shift+↑ 能走多远」——24 步。写成常量是为了让「上限 24」和
 * 「每步 1」在同一个文件里可读，改一个不用去翻另一个。
 */
export const PITCH_STEP_SEMITONE = 1;

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------

export interface CreateInitialArgs {
  samples: PaletteSample[];
  /** 该音符当前生效的装配值（effectiveSampleId）：命中则高亮定位到该行 */
  initialCandidateId?: SampleId | null;
  /** 事件已有的 pitchDelta（无则 0） */
  semitoneDelta?: number;
  /** 事件已有的 timeFactor（无则 1） */
  timeFactor?: number;
}

export function createInitialState(args: CreateInitialArgs): PaletteState {
  const { samples } = args;
  const idx = args.initialCandidateId
    ? samples.findIndex((s) => s.id === args.initialCandidateId)
    : -1;
  const activeIdx = idx >= 0 ? idx : 0;
  const cand = samples[activeIdx] ?? null;
  return {
    filter: '',
    activeIdx,
    // 打开面板时**不预置**选中项：用户必须自己「选中」一次，
    // 否则首次 Enter 会直接提交，双保险形同虚设。
    // （注意这与 placedId 不冲突：placedId 不是「选中」，是「本来就装着的」，
    //   它刻意**不**让首次 Enter 变成提交 —— Enter 仍然只做「选中」。）
    armedId: null,
    // 只有该素材真的在候选列表里（找得到 idx）才算「已装配」：
    // 找不到就没有 durationSec 可用来算 τ 步进，界面上也指不出是哪一行。
    placedId: idx >= 0 ? (args.initialCandidateId ?? null) : null,
    focus: 'input',
    staged: {
      candidateId: cand?.id ?? null,
      // 已有事件的值也过一遍夹取：夹取上线之前存下来的档位可能是 ±60，
      // 不在这里收口的话，面板一打开就把那个坏值原样显示并再次提交。
      semitoneDelta: clampSemitoneDelta(args.semitoneDelta ?? 0),
      timeFactor: Number.isFinite(args.timeFactor) && args.timeFactor! > 0 ? args.timeFactor! : 1,
      stepSec: computeStepSec(cand?.durationSec ?? 0),
    },
    decision: null,
  };
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

const FOCUS_CYCLE: Record<FocusTarget, FocusTarget> = {
  input: 'pitch',
  pitch: 'stretch',
  stretch: 'input',
};

function clampIdx(raw: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(len - 1, raw));
}

/**
 * 已选中项是否还在当前过滤结果里。
 * 过滤词一变，列表可能不再包含它 —— 此时必须让 arm 失效，否则「应用」会提交一个
 * 用户在界面上根本看不到的候选（最坏情况：改了搜索词后误提交旧目标）。
 */
function armSurvives(armedId: SampleId | null, filtered: PaletteSample[]): boolean {
  return armedId != null && filtered.some((s) => s.id === armedId);
}

/**
 * 调音 / 变速 / 试听的**严格目标**：`armedId` → `placedId`，**不含光标兜底**。
 *
 * null = 真的没有可调对象（这条音符没装素材，用户也没选中任何候选）
 * → 这才是唯一该被拦下并提示「还没有选择素材」的情形。
 *
 * 为什么**不给**光标兜底：光标会被鼠标悬停带走，把它当调音目标就会出现
 * 「改了路过的那一行，而听感上『改了』和『没改』当场分不出来」——
 * 这正是当初把目标从光标收到 `armedId` 上的原因。
 * `placedId` 之所以能补进来，是因为它**不随光标变**：它是这条放置的现状。
 */
export function tuneTargetId(state: PaletteState): SampleId | null {
  return state.armedId ?? state.placedId;
}

/**
 * 「应用」按钮的目标：在 `tuneTargetId` 之后仍无解时，才兜底到**光标行**
 * （`staged.candidateId`）。这条兜底是既有契约：音符还没装素材时，
 * 「应用」按光标所在行落 —— 保持原行为不变。
 *
 * ⚠️ 调音不走这条兜底，只有提交走。两者的差别是刻意的：
 * 提交有「已选中就整行实色 + 页脚指名道姓」两重可见性，
 * 而调音只是一声响，用户无法当场分辨目标对不对。
 */
export function resolveTargetId(state: PaletteState): SampleId | null {
  return tuneTargetId(state) ?? state.staged.candidateId;
}

export function reducer(
  state: PaletteState,
  action: PaletteAction,
): PaletteState {
  // 决策落定即终态：忽略一切后续动作（防 StrictMode/双击竞态下二次提交）
  if (state.decision) return state;

  switch (action.type) {
    case 'SetFilter': {
      const cand = action.filtered[0] ?? null;
      return {
        ...state,
        filter: action.filter,
        activeIdx: 0,
        // 选中项被筛掉 → 清空；仍在列表里 → 保留（用户的选择不该被打字清掉）
        armedId: armSurvives(state.armedId, action.filtered) ? state.armedId : null,
        staged: { ...state.staged, candidateId: cand?.id ?? null },
      };
    }

    case 'NavDelta': {
      const next = clampIdx(state.activeIdx + action.delta, action.filtered.length);
      const cand = action.filtered[next] ?? null;
      return {
        ...state,
        activeIdx: next,
        // 移动光标**不动**选中项：悬停/↑↓ 是无意识动作，不能改变提交目标
        staged: { ...state.staged, candidateId: cand?.id ?? null },
      };
    }

    case 'Arm': {
      const cand = action.filtered[action.index] ?? null;
      if (!cand) return state;
      return {
        ...state,
        activeIdx: action.index,
        armedId: cand.id,
        staged: { ...state.staged, candidateId: cand.id },
      };
    }

    case 'Confirm': {
      /*
        ⚠️ Enter 刻意仍然只看**光标行**（`staged.candidateId`），不认 `placedId`。
        这是刻意的对比：Enter 的语义是「我要这一行」—— 一个用户主动指向的动作；
        而调音（tuneTargetId）是「调我这条放置」—— 不需要指向。
        要是这里也认 placedId，那「第一次 Enter 只选中、第二次才提交」的双保险
        会在**光标恰好停在已装配素材上**时失效（首次 Enter 直接变成提交）。
      */
      const cand = state.staged.candidateId;
      // 空列表兜底：与旧 Apply 一致，无可装配目标时退化为取消
      if (!cand) return { ...state, decision: { kind: 'cancel' } };
      // 已选中 → 真正确认
      if (state.armedId === cand) {
        return {
          ...state,
          decision: {
            kind: 'apply',
            sampleId: cand,
            semitoneDelta: state.staged.semitoneDelta,
            timeFactor: state.staged.timeFactor,
          },
        };
      }
      // 第一次 Enter：只做「选中」，不提交
      return { ...state, armedId: cand };
    }

    case 'TabFocus':
      return { ...state, focus: FOCUS_CYCLE[state.focus] };

    case 'AdjustPitch':
      return {
        ...state,
        staged: {
          ...state.staged,
          // ⚠️ 必须夹取：这个 case 会被**按键连发**反复命中（`e.repeat` 一路传下来），
          // 不夹取就能一路走到「引擎集体退化」的档位。理由与实测见
          // `model/pitch-limits.ts`；`nudgePitch` 的即时试听用的是同一个函数。
          semitoneDelta: clampSemitoneDelta(state.staged.semitoneDelta + action.delta),
        },
      };

    case 'AdjustStretch': {
      const { stepSec, timeFactor } = state.staged;
      if (!Number.isFinite(action.sampleDur) || action.sampleDur <= 0) return state;
      const tauStep = stepSec / action.sampleDur;
      return {
        ...state,
        staged: {
          ...state.staged,
          timeFactor: clampTau(timeFactor + action.direction * tauStep, stepSec, action.sampleDur),
        },
      };
    }

    case 'ResetFocusValue': {
      // Home 键：复位指定 spinbutton（pitch→0 半音 / stretch→×1.0）。
      // target 由组件按事件源传入：鼠标点选 spinbutton 时 DOM 焦点可偏离 state.focus。
      if (action.target === 'pitch')
        return { ...state, staged: { ...state.staged, semitoneDelta: 0 } };
      return { ...state, staged: { ...state.staged, timeFactor: 1 } };
    }

    case 'SetStep': {
      const { stepSec } = action;
      if (!Number.isFinite(stepSec) || stepSec <= 0) return state;
      return { ...state, staged: { ...state.staged, stepSec } };
    }

    case 'Apply': {
      // 应用按钮 / 显式提交：已选中行优先，其次「本来就装着的」，最后才兜底光标行
      const cand = resolveTargetId(state);
      if (!cand) return { ...state, decision: { kind: 'cancel' } };
      return {
        ...state,
        decision: {
          kind: 'apply',
          sampleId: cand,
          semitoneDelta: state.staged.semitoneDelta,
          timeFactor: state.staged.timeFactor,
        },
      };
    }

    case 'Cancel':
      return {
        ...state,
        armedId: null,
        staged: {
          candidateId: null,
          semitoneDelta: 0,
          timeFactor: 1,
          stepSec: state.staged.stepSec,
        },
        decision: { kind: 'cancel' },
      };

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
