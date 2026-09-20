/**
 * EnginePicker —— 装配面板里的「变调引擎」切换器（实验分支 feat/lib-engines）。
 *
 * 为什么单独一个文件：整块实验能力要能**一次性摘掉**。回退时删掉本文件 +
 * `NotePalette` 里那一行 `<EnginePicker />` + `external-shift.ts` +
 * `soundtouch-engine.ts` + `playSample` 里的外部分支即可，不牵动别处。
 *
 * ── 交互契约 ──
 *  - 默认停在「我们的 PSOLA」= 项目原有链路，不动任何既有行为；
 *  - 点某个第三方引擎 → **先 await 把库下下来**，成功了才切偏好。
 *    下载过程中 chip 上显示「载入中」，按钮禁用，避免切到一个加载失败的引擎
 *    让试听静默回退（用户会以为「换了引擎没区别」）；
 *  - τ ≠ 1 时需要时间伸缩内核，切换时**必须等它就绪**（见 `pick` 里的注释：
 *    不 await 的话，切完的第一声永远还是旧引擎）；
 *  - 选择写入 localStorage（`external-shift.ts` 的 PREF_KEY），
 *    刷新/重开面板都还在 —— 试听与导出走同一个偏好，这是刻意的：
 *    不能让「听着是这个声、导出来是另一个声」。
 *
 * ── 为什么必须显示「实际生效的引擎」而不是「用户选的那个」 ──
 * 这是这个组件最容易做错的地方，也是 2026-09-20 那一轮修复的核心。
 * 「选中了谁」与「那个库真的能用了吗」是**两件独立的事**：前者活在 localStorage
 * 里能过刷新，后者只是模块内存。任何只看 `getEngineChoice()` 的地方都可能
 * 与实际播放不一致 —— 因为 `playSample` 只认 `getActiveShift()`，它为 null 时
 * 整个外部分支被**静默**跳过。用户看到的是「有时生效有时不生效」，
 * 从界面上完全看不出来。
 * 所以：chip 高亮 = 用户的选择（不改），下面那行说明**始终描述正在发生的事**
 * （`getEffectiveEngine()`），未就绪时还要明说「现在实际走的是我们的 PSOLA」。
 *
 * ── 为什么按**算法域**分组（而不是按项目）──
 * 早先只有 5+3 个引擎，按项目分就够（一方一排）。`@audio/shift` 的 15 个算法
 * 全接进来之后，按项目分等于「15 个挤成一排」——看不出该点哪个。
 * 改成按算法域（与该库 README 的分类一致），因为那才是听感差异的来源：
 * 频域一族的 artifact 是拖尾/phasiness，时域一族是颗粒感/打断，
 * 源-滤波那一支才保共振峰。项目来源写进 tooltip 与说明行。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EXTERNAL_ENGINES,
  ensureEngine,
  ensureStretchReady,
  getEffectiveEngine,
  getEngineChoice,
  getEngineMeta,
  getEngineStatus,
  isEngineLoading,
  setEngineChoice,
  subscribeEngine,
  type EngineChoice,
  type EngineFamily,
} from '../../engine/external-shift';
import { toast } from '../ui/toast';

const CHIP_BASE =
  'shrink-0 rounded-sm px-1.5 py-0.5 text-micro transition-colors disabled:cursor-wait';
const CHIP_ON = 'bg-flame-400 font-semibold text-ink-950';
const CHIP_OFF = 'text-label-lo hover:bg-ink-800 hover:text-label-hi';

/** 分组标题（UI 专用文案，与 `EngineFamily` 一一对应） */
const FAMILY_LABEL: Record<EngineFamily, string> = {
  freq: '频域',
  time: '时域',
  other: '源-滤波',
  soundtouchjs: 'SoundTouchJS',
};

/** 分组顺序：先频域（声码器一族），再时域，再源-滤波/混合，最后另一个项目 */
const FAMILY_ORDER: readonly EngineFamily[] = ['freq', 'time', 'other', 'soundtouchjs'];

/** 按 family 归拢，保持 EXTERNAL_ENGINES 里的声明顺序 */
const FAMILIES = FAMILY_ORDER.map((family) => ({
  family,
  engines: EXTERNAL_ENGINES.filter((e) => e.family === family),
})).filter((g) => g.engines.length > 0);

/** 「我们的 PSOLA」的说明（`getEngineMeta('wasm')` 返回 null，所以单独放一份） */
const WASM_NOTE =
  '项目原有内核：单段式 TD-PSOLA，共振峰不动（PitchNet 的听感之所以"干净又舒服"，一半来自它也只换 F0）。';

/** 分组标签列宽：`SoundTouchJS` 是最长的一个，按它对齐 */
const LABEL_COL = 'w-[3.9rem] shrink-0 pt-0.5 text-micro leading-[1.3] text-label-faint/70';

/**
 * 极简富文本：只认 `**粗体**`。
 *
 * 为什么需要它：说明文案是「一句话讲清算法类别与代价」的地方，重点
 * （「不保时长」「保共振峰」「HNR 10.40」）不加粗就淹在浅灰句子中间，
 * 用户会整行跳过。用 markdown 记号的理由是**写起来顺手** —— 文案是在
 * TS 字符串里维护的，改成 `<b>` 就得把每句话拆成 JSX 数组，
 * 以后改一个字都要动结构。
 *
 * ⚠️ 这里踩过一次：文案里先写了 `**不保时长**` 而组件直接当纯文本渲染，
 * 界面上原样显示出两个星号。所以渲染端与文案端必须同时存在，不能只留一边。
 */
function RichText({ text }: { text: string }) {
  const parts = text.split('**');
  return (
    <>
      {parts.map((seg, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-label-hi">
            {seg}
          </strong>
        ) : (
          <span key={i}>{seg}</span>
        ),
      )}
    </>
  );
}

/** 剥掉 `**` 记号 —— 给 `title` 用（原生 tooltip 不认 markdown，会照原样显示星号） */
const plain = (s: string) => s.replace(/\*\*/g, '');

export interface EnginePickerProps {
  /**
   * 切换成功后的回调。面板用它**立刻重放一遍**当前 staging ——
   * 点一下 chip 就听到差别，不用再手动按一次 Shift+P。
   * 注意时序：偏好是模块级同步写入的，所以回调里 `playSample` 读到的已是新引擎。
   */
  onChange?: () => void;
}

export function EnginePicker({ onChange }: EnginePickerProps) {
  /** 订阅模块状态变化用的重渲染计数器（状态本身在模块里，不在这里） */
  const [, bump] = useState(0);
  /** 正在下载的引擎（null = 空闲）；用它把 chip 置灰并显示「载入中」 */
  const [busy, setBusy] = useState<EngineChoice | null>(null);
  /**
   * `busy` 的**同步**影子。
   *
   * 为什么不能只靠上面那个 state 当互斥锁：`setBusy()` 不是同步生效的，
   * 而 `pick` 里有 `await`。同一帧内连点两个 chip（触控板很容易发生）时，
   * 两次调用都会读到还没更新的 `busy` → 两个引擎同时开始加载，
   * 后一个的 `setEngineChoice`/重放会盖掉前一个，状态就乱了。
   * ref 是同步写的，用它做锁才真正互斥。
   */
  const busyRef = useRef<EngineChoice | null>(null);

  useEffect(() => subscribeEngine(() => bump((n) => n + 1)), []);

  /*
    刷新 / HMR 之后补一次恢复。

    模块级已经 `void restoreEngine()` 踢过一次（见 `external-shift.ts` 末尾），
    这里补第二次是为了覆盖「上一次加载失败」——那种情况下模块级不会自动重试，
    而用户当时唯一能做的动作就是再点一下 chip，太隐蔽了。
    幂等：已加载时 `ensureEngine` 立刻返回 true，不会重复下载。
  */
  useEffect(() => {
    const cur = getEngineChoice();
    if (cur === 'wasm' || getEngineStatus().ready) return;
    let alive = true;
    void ensureEngine(cur).then((ok) => {
      if (alive && ok) void ensureStretchReady();
    });
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback(
    async (next: EngineChoice) => {
      if (busyRef.current) return;

      /*
        能早退的唯一情况：已经切到它**而且它真的就绪**。
        不能只判 `next === choice` —— 刷新后正是「选中了但没加载」，
        这时再点一下必须**重试加载**，否则用户没有任何办法把它救回来
        （早先的实现在这里直接 return，于是「切了没反应」）。
      */
      const st = getEngineStatus();
      if (next === st.choice && st.ready) return;

      if (next !== 'wasm') {
        busyRef.current = next;
        setBusy(next);
        const ok = await ensureEngine(next);
        if (!ok) {
          busyRef.current = null;
          setBusy(null);
          const label = getEngineMeta(next)?.label ?? next;
          toast(`引擎「${label}」加载失败，仍用我们的 PSOLA`);
          return;
        }
        /*
          变速内核必须在**放音之前**就绪。
          τ ≠ 1 时它是串联的第二级，缺了它 `playSample` 会整体回退 wasm ——
          表现为「刚切完的第一声还是旧的引擎，第二声才对」。
          早先是 `void ensureStretchReady()`（不 await），所以切换后的**第一次**
          试听永远落在 wasm 上 —— 这正是「时好时坏」的来源之一。
        */
        await ensureStretchReady();
        busyRef.current = null;
        setBusy(null);
      }

      setEngineChoice(next);
      onChange?.();
    },
    [onChange],
  );

  const status = getEngineStatus();
  /** 用户选的那个（chip 高亮依据） */
  const selectedMeta = getEngineMeta(status.choice);
  /** **实际**会出声的那个 —— 说明文案一律以它为准 */
  const effective = getEffectiveEngine();
  const effectiveMeta = getEngineMeta(effective);
  const effectiveNote = effectiveMeta?.note ?? WASM_NOTE;
  /** 选了第三方引擎但它还不能用（在下载，或还没开始） */
  const pendingLoad = status.choice !== 'wasm' && !status.ready;
  /** 变调内核好了，但变速内核坏了 → τ≠1 时会整体退回 wasm */
  const stretchBroken = status.ready && status.stretchFailed;
  /**
   * 实际生效的引擎**不保时长**（目前只有 `lib-sample`）。
   * 它长度合规、f0 也对，只是内容被按 ratio 压过 —— 降调时尾巴整段丢掉。
   * 这种「指标全绿但东西是坏的」必须大声说出来，不能只写在 tooltip 里。
   */
  const durationUnsafe = effectiveMeta !== null && !effectiveMeta.durationSafe;

  const chip = (id: EngineChoice, label: string, title: string) => {
    const on = status.choice === id;
    const loading = id !== 'wasm' && (busy === id || isEngineLoading(id));
    return (
      <button
        key={id}
        type="button"
        onClick={() => void pick(id)}
        disabled={busy !== null}
        className={`${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF}`}
        title={title}
        data-engine-id={id}
      >
        {label}
        {loading ? ' …' : ''}
      </button>
    );
  };

  return (
    <div
      className="flex shrink-0 flex-col gap-1 rounded-sm bg-ink-950 px-2 py-1.5 shadow-[inset_0_0_0_1px_rgb(var(--line))]"
      data-engine-picker="true"
      /*
        给探针的钩子：`effective` 是**实际会出声**的引擎，`status` 是就绪状态。
        断言「界面不骗人」只能靠这两个值 —— 读 chip 高亮只能知道用户选了谁。
      */
      data-engine-effective={effective}
      data-engine-status={
        status.failed ? 'failed' : pendingLoad ? 'loading' : status.ready ? 'ready' : 'idle'
      }
      data-engine-stretch={
        status.stretchFailed ? 'failed' : status.stretchReady ? 'ready' : 'idle'
      }
      /* `durationSafe=false` 的引擎实际生效时置 'false'，让探针能钉住这条警告 */
      data-engine-duration={durationUnsafe ? 'unsafe' : 'safe'}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="shrink-0 text-micro text-label-faint">
          变调引擎
          <span className="text-label-faint/60">（@audio/shift 15 + SoundTouchJS 3）</span>
        </span>
        {chip(
          'wasm',
          '我们的 PSOLA',
          '项目原有的 wasm 内核：单段式 TD-PSOLA（保共振峰），失效时依次退到 SOLA / 原声',
        )}
      </div>

      {/*
        ⛔ 这里**不许**再写死 `max-h`。曾经是 `max-h-[7.5rem] overflow-y-auto`，
        理由是「18 个 chip 平铺会把面板顶得老高」—— 但那个上限是按**宽**布局算的
        （四组各一行 ≈ 76px）。装配面板在 ≥lg 时是两列（`NotePalette` 的
        `flex-col lg:flex-row`），选择器所在那一列只有 **244px 宽**，chips 换行后
        实际需要 **157px**：于是 `overflow-y-auto` 把最后整组（SoundTouchJS 三个）
        推到可视区之外，**界面上看起来就像那几个引擎被删掉了**
        （2026-09-20 用 `measure-picker-clip.mjs` 量到 scrollH 157 / clientH 120）。

        「顶得老高」是可接受的：外层面板内容区本来就会滚动（样本列表自己
        也有 `max-h-[248px]`），而**藏掉一个引擎**是不可接受的。
        高度自然撑开，任何一个引擎都不许被裁掉 —— 回归见 `_probe-palette.mjs` 第 11 节。
      */}
      <div
        className="flex flex-col gap-y-1"
        data-engine-groups={FAMILIES.length}
      >
        {FAMILIES.map(({ family, engines }) => (
          <div key={family} className="flex items-start gap-1">
            <span className={LABEL_COL}>{FAMILY_LABEL[family]}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {engines.map((e) => chip(e.id, e.label, plain(e.note)))}
            </span>
          </div>
        ))}
      </div>

      {/*
        四种状态的说明，**都必须说真话**：
          · 不保时长 → 最高优先级：这个引擎「指标全绿但内容是坏的」，
            必须让人在按下导出之前看见（详情见 durationUnsafe 的注释）；
          · 没加载成功 → 明说现在实际是 wasm，并提示可重试（最要紧的一条：
            早先这里静默无声，用户只会觉得「切了没反应」）；
          · 正在下载 → 说清此刻还是 wasm，别让他现在就下结论；
          · 就绪 → 显示**实际生效**那个引擎的说明（不是用户选的那个）。
      */}
      {durationUnsafe ? (
        <p className="text-micro leading-snug text-danger">
          ⚠️「{effectiveMeta?.label}」<RichText text="**不保时长**" />
          ：输出数组长度是对的，但内容被按 ratio 压过，降调时会丢掉素材尾巴（实测尾巴能量 0.000）。
          只当「纯重采样」的听感参照，别用它出成品。
        </p>
      ) : status.failed ? (
        <p className="text-micro leading-snug text-danger">
          「{selectedMeta?.label ?? status.choice}」没加载成功 —— 现在
          <RichText text="**实际**" />
          走的是「我们的 PSOLA」。点一下那个 chip 可以重试。
        </p>
      ) : pendingLoad ? (
        <p className="text-micro leading-snug text-flame-400">
          正在载入「{selectedMeta?.label ?? status.choice}」…（此刻听到的仍是我们的 PSOLA）
        </p>
      ) : stretchBroken ? (
        <p className="text-micro leading-snug text-danger">
          变速内核没加载成功 —— 时长不是 ×1 时会整体退回「我们的 PSOLA」（连变调也一起变回去）。
          时长保持 ×1 时不受影响。
        </p>
      ) : (
        <p className="text-micro leading-snug text-label-faint">
          {effectiveMeta !== null && (
            <span className={effectiveMeta.keepsFormant ? 'text-flame-400' : 'text-label-faint/60'}>
              {effectiveMeta.keepsFormant ? '保共振峰 · ' : '共振峰随音高走 · '}
            </span>
          )}
          <RichText text={effectiveNote} />
        </p>
      )}
    </div>
  );
}
