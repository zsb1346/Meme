/**
 * SynthPanel —— 音色设计面板（合成声部的音色编辑器）。
 *
 * ══ 它替代的是什么 ══
 *
 * 旧实现是两处各写一遍的「三角波 PolySynth + 快衰减」（`synth-preview.ts`
 * 与 `recorder.ts::FeedbackPiano`），参数只有一个音量。用户评价：难听。
 * 现在这一层是**唯一**的合成声部，参数 117 个（95 旋钮 + 21 段控 + 32 谐波曲线）、
 * 27 款预设，功能对齐原型 `原型/效果器/VFX声音设计/VFX.html`。
 *
 * ══ 四条设计决定 ══
 *
 * ① **不进导出**。合成声部只服务试听与按键反馈（空槽键兜底、录制跟弹参考音），
 *    与主效果链物理隔离、独立干路直连输出。所以这里改音色**不会**改变已导出
 *    的成品 —— 这是一个刻意的边界，不是遗漏。
 *
 * ② **预设名是「算出来的」，不是记住的**。每次渲染把当前 patch 与 27 款预设
 *    逐一比对，命中谁就显示谁，都不命中显示「自定义」。用 state 记住上一个
 *    点过的预设名，会在「点了预设 → 又拧了两个旋钮」之后继续显示预设名 ——
 *    那种小谎话在音色编辑器里最要命（用户以为自己在听预设，其实不是）。
 *
 * ③ **拖动只走引擎，落库走防抖**。`project` 是全局 store 的大对象，每一个
 *    pointermove 都写进去会让制作台整页重渲染（卷帘画布也在里面）。
 *    所以：拖动期间引擎实时响应（`updateSynthParam`）+ 本地草稿负责读数，
 *    120ms 后的尾随防抖才写 store；关面板/换预设/试听前强制 flush。
 *
 * ④ **分组按引擎过滤，和原型一致**。原型就是「选波表才长出波表卡，选 FM 才长出
 *    算子卡」；把粒子参数摆在经典引擎下只会让人拧到「拧了没反应」。
 *    ⛔ 但**参数本身一个不少**：切到对应引擎，那一组就在。为了让这条不是空话，
 *    面板底部常驻一行「其它引擎的分组」清单（见 `OtherEngineGroups`），
 *    用户不必靠猜。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Knob } from '../ui/Knob';
import { Seg } from '../ui/PageBar';
import { toast } from '../ui/toast';
import { IconPlay, IconStop } from '../ui/Icon';
import { useStore } from '../../model/store';
import { ensureAudioStarted, getAudioContext } from '../../engine/core';
import {
  DEFAULT_SYNTH_PATCH,
  ENGINE_OPTIONS,
  SYNTH_PRESET_NAMES,
  patchFromPreset,
  type EngineType,
  type SynthPatch,
} from '../../engine/synth/patch';
import {
  ensureSynthReady,
  playSynthNote,
  releaseAllSynthNotes,
  updateSynthParam,
} from '../../engine/synth';
import { SYNTH_GROUPS, visibleGroups, visibleKnobs, specOf, type SynthGroup } from './synth-params';
import { FmAlgoEditor, HarmEditor, MacroLegend, ModMatrixEditor, WtBrowser } from './editors';

export interface SynthPanelProps {
  open: boolean;
  onClose(): void;
}

/** 落库防抖：拖动结束后多久把草稿写进 store */
const COMMIT_DEBOUNCE_MS = 120;

/** 试听音阶：C4 E4 G4 C5 —— 能听出起音/衰减/混响，也不至于糊成一团 */
const AUDITION_NOTES = [60, 64, 67, 72];
const AUDITION_STEP_SEC = 0.16;

/** 「自定义」这一档不属于预设表，单独用一个不会撞名（含空格）的哨兵值 */
const CUSTOM_VALUE = ' custom';

/** 两个 patch 是否等价（浮点留一点余量；预设值是十进制字面量，不会有惊人误差） */
function patchEquals(a: SynthPatch, b: SynthPatch): boolean {
  for (const key of Object.keys(a) as Array<keyof SynthPatch>) {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') {
      if (Math.abs(va - vb) > 1e-6) return false;
    } else if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length || va.some((x, i) => x !== vb[i])) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

/**
 * 草稿 + 防抖落库。
 *
 * 返回的 `draft` 是**读数与旋钮的唯一数据源**；`edit` 立刻更新草稿并通知引擎，
 * `scheduleCommit` 排一次尾随写库。
 */
function usePatchDraft(
  storePatch: SynthPatch,
  commit: (patch: SynthPatch, opts?: { load?: boolean }) => void,
): {
  draft: SynthPatch;
  edit(p: keyof SynthPatch, value: unknown): void;
  replace(patch: SynthPatch): void;
  flush(): void;
} {
  const [draft, setDraft] = useState<SynthPatch>(storePatch);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 有未落库的改动时不接受外部同步，否则拖动中会被旧存档把读数拽回去 */
  const pending = useRef(false);

  useEffect(() => {
    if (pending.current) return;
    setDraft(storePatch);
  }, [storePatch]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!pending.current) return;
    pending.current = false;
    commit(draftRef.current);
  }, [commit]);

  const scheduleCommit = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!pending.current) return;
      pending.current = false;
      commit(draftRef.current);
    }, COMMIT_DEBOUNCE_MS);
  }, [commit]);

  /**
   * 单参数改动：先问引擎，**拿它的返回值当新草稿**。
   *
   * ⛔ 这里不能只写 `{...prev, [p]: value}`。原因只有一个但很致命：
   * **宏不是单参数**。拖「空间」宏时引擎侧会同时改掉 `reverbMix` / `reverbSize` /
   * `delayMix` / `delayFb`（`applyMacroToPatch`），而草稿里只有 `macroSpace` 变了。
   * 如果拿这份草稿落库，120ms 之后 `store → engine.setPatch(整份 draft)` 会把
   * 宏刚联动出来的四个参数**写回旧值** —— 听感就是「拖动时有效果、松手一秒后
   * 又弹回去了」，而且因为防抖恰好是 120ms，这个回弹很容易被当成「耳朵错觉」。
   *
   * 取 `updateSynthParam` 的返回值（它返回引擎侧权威的那份 patch）还顺带解决两件事：
   *   · 读数与引擎**永远一致**（夹取、量化、`sanitizeSynthPatch` 之后的真实值）；
   *   · 阵列参数（`addHarm`）走的是 `fitHarm`，定长 32 —— 草稿不会出现 31 条。
   */
  const edit = useCallback(
    (p: keyof SynthPatch, value: unknown) => {
      pending.current = true;
      setDraft(updateSynthParam(p, value));
      scheduleCommit();
    },
    [scheduleCommit],
  );

  /**
   * 整体替换（预设 / 重置）：立即落库，走 `load` 路径。
   *
   * ⛔ 必须带 `load`：那是「整份装载」，引擎会顺带**清掉宏基准**
   * （见 `engine/synth/index.ts::loadSynthPatch`）。不清的话，切到新预设后
   * 第一次拖宏会以上一份预设的宏基准出发，把新预设调好的值一起改掉。
   * 而 120ms 尾随落库**不能**带这个标记 —— 它写进去的 patch 里已经带着宏联动
   * 出来的值，清基准会让下一次拖宏指数漂移。
   */
  const replace = useCallback(
    (patch: SynthPatch) => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = false;
      setDraft(patch);
      commit(patch, { load: true });
    },
    [commit],
  );

  // 卸载（含关闭弹层）时把在途改动落库，避免「拧完直接关掉 → 没保存」
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  return { draft, edit, replace, flush };
}

/** 示波器 + 频谱：让每一次拧动都有可见的反馈 */
function SynthViz({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 面板打开本身是用户手势，这里建上下文是安全的
    const analyser = ensureSynthReady();
    const g = canvas.getContext('2d');
    if (!g) return;

    let raf = 0;
    // fftSize / frequencyBinCount 在一次会话里是常量，**只分配一次**
    // （放在绘制循环里每帧判断长度再分配，既浪费又会让 TS 推成
    //   `Uint8Array<ArrayBufferLike>`，与 DOM 签名要求的 `ArrayBuffer` 不符）
    const time = new Uint8Array(analyser.fftSize);
    const freq = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      g.clearRect(0, 0, w, h);

      // 中线
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();

      analyser.getByteTimeDomainData(time);
      g.strokeStyle = '#409cff';
      g.lineWidth = Math.max(1.1, 1.4 * dpr);
      g.lineJoin = 'round';
      g.beginPath();
      const step = w / time.length;
      for (let i = 0; i < time.length; i++) {
        const v = (time[i] - 128) / 128;
        const y = h / 2 - v * h * 0.42;
        if (i === 0) g.moveTo(i * step, y);
        else g.lineTo(i * step, y);
      }
      g.stroke();

      // 频谱：64 根竖条，按平方分布取桶（低频不被挤扁）
      const bins = analyser.frequencyBinCount;
      analyser.getByteFrequencyData(freq);
      const bars = 64;
      g.fillStyle = 'rgba(64,156,255,0.22)';
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const lo = Math.floor(Math.pow(i / bars, 2.2) * bins * 0.85);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 2.2) * bins * 0.85));
        let sum = 0;
        let cnt = 0;
        for (let j = lo; j < hi && j < bins; j++) {
          sum += freq[j];
          cnt++;
        }
        const v = cnt ? sum / cnt / 255 : 0;
        const bh = Math.max(1, v * h * 0.9);
        g.fillRect(i * bw, h - bh, Math.max(1, bw - 1.5 * dpr), bh);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="h-14 w-full rounded-sm border border-line bg-ink-950"
    />
  );
}

/** 引擎中文名（分段选项里那套，单一来源） */
function engineLabel(et: EngineType): string {
  const hit = ENGINE_OPTIONS.find(([v]) => v === et);
  return hit ? hit[1] : String(et);
}

/**
 * 其它引擎的分组清单。
 *
 * 它存在的唯一理由：面板按引擎过滤分组（与原型一致），但那会让「切到经典引擎
 * 就找不到粒子旋钮」看起来像功能缺失。把清单常驻在底部，用户一眼就知道
 * 「不是没有，是换引擎才出现」。
 */
function OtherEngineGroups({ engineType }: { engineType: EngineType }) {
  const others = useMemo(
    () => SYNTH_GROUPS.filter((g) => g.engines && g.engines.indexOf(engineType) < 0),
    [engineType],
  );
  if (others.length === 0) return null;
  return (
    <p className="text-micro leading-relaxed text-label-muted">
      另有 {others.length} 组属于其它引擎：{others.map((g) => g.title).join(' · ')}
      　—　在「振荡器 · 引擎」里切换引擎后出现（切换只换发声方式，不动已调好的参数）。
    </p>
  );
}

/** 分组正文：先段控，再专用编辑器，最后旋钮网格 */
function GroupBody({
  group,
  draft,
  edit,
}: {
  group: SynthGroup;
  draft: SynthPatch;
  edit(p: keyof SynthPatch, value: unknown): void;
}) {
  const accent = group.accent;
  const knobs = visibleKnobs(group);

  // 引擎分组里的「引擎」段控单独拉到最上面（它是这一组的主题，不是普通选项）
  const engineSeg = group.id === 'osc' ? group.segs.find((s) => s.p === 'engineType') : undefined;
  const restSegs = engineSeg ? group.segs.filter((s) => s !== engineSeg) : group.segs;
  /**
   * ⛔ 调制矩阵的 8 个源/目标段控**和 4 个深度旋钮**都由 `ModMatrixEditor`
   * 自己渲染（`<select>` + 行内旋钮）。
   * 这里必须把它们都排除掉：否则同一批参数会被画两遍 —— 上一条渲染出来的
   * 是一排被挤到 30px 宽、中文竖排换行的 `Seg` 按钮，看起来像界面崩了；
   * 下一条则把四个深度旋钮从各自的槽里拆散，挪到底部的旋钮格里。
   */
  const ownRenderer = group.id === 'matrix';
  const showSegRow = restSegs.length > 0 && !ownRenderer;

  return (
    <>
      {engineSeg && (
        <div className="mb-3 flex flex-col gap-2 rounded-sm border border-line bg-ink-900/60 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-micro text-label-muted">{engineSeg.label}</span>
            <Seg
              label={engineSeg.label}
              size="sm"
              value={String(draft[engineSeg.p])}
              options={engineSeg.options.map(([v, l]) => ({ value: String(v), label: l }))}
              onChange={(v) => edit(engineSeg.p, v)}
            />
            <span className="ml-auto shrink-0 rounded-sm bg-ink-800 px-1.5 py-0.5 text-micro font-medium text-label-hi">
              当前 · {engineLabel(draft.engineType)}
            </span>
          </div>
          <p className="text-micro leading-snug text-label-muted">
            引擎换了之后，下面会多出 / 收起对应的专用分组（波表 · FM 算阵 · 加法合成 ·
            弦鸣 · 粒子 · 噪声引擎）。
          </p>
        </div>
      )}

      {showSegRow && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {restSegs.map((seg) => (
            <div key={String(seg.p)} className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-micro text-label-muted">{seg.label}</span>
              <Seg
                label={seg.label}
                size="sm"
                value={String(draft[seg.p])}
                options={seg.options.map(([v, l]) => ({ value: String(v), label: l }))}
                onChange={(v) => edit(seg.p, seg.numeric ? Number(v) : v)}
              />
            </div>
          ))}
        </div>
      )}

      {/* ---- 专用编辑器（原型里那些「不是旋钮」的控件） ---- */}
      {group.id === 'wt' && (
        <div className="mb-3">
          <WtBrowser
            cat={draft.wtCat}
            table={draft.wtTable}
            pos={draft.wtPos}
            accent={accent}
            onPickTable={(i) => edit('wtTable', i)}
          />
        </div>
      )}
      {group.id === 'fm' && (
        <div className="mb-3">
          <FmAlgoEditor value={draft.fmAlgo} accent={accent} onChange={(v) => edit('fmAlgo', v)} />
        </div>
      )}
      {group.id === 'add' && (
        <div className="mb-3">
          <HarmEditor value={draft.addHarm} accent={accent} onChange={(v) => edit('addHarm', v)} />
        </div>
      )}
      {group.id === 'matrix' && (
        <ModMatrixEditor patch={draft} edit={edit} accent={accent} />
      )}
      {group.id === 'macro' && (
        <div className="mb-3">
          <MacroLegend />
        </div>
      )}

      {knobs.length > 0 && !ownRenderer && (
        <div className="grid grid-cols-4 justify-items-center gap-x-1 gap-y-3 sm:grid-cols-6 lg:grid-cols-7">
          {knobs.map((k) => {
            const spec = specOf(k.p);
            return (
              <Knob
                key={k.p}
                label={k.label}
                value={draft[k.p]}
                min={spec.min}
                max={spec.max}
                step={spec.step ?? 0.001}
                curve={spec.curve ?? 'linear'}
                def={spec.def}
                accent={accent}
                formatText={k.fmt}
                unitText={k.unitText}
                size={48}
                onChange={(v) => edit(k.p, v)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export function SynthPanel({ open, onClose }: SynthPanelProps) {
  const storePatch = useStore((s) => s.project.settings.synthPatch);
  const commitPatch = useStore((s) => s.setSynthPatch);

  const commit = useCallback(
    (patch: SynthPatch, opts?: { load?: boolean }) => {
      commitPatch(patch, opts);
    },
    [commitPatch],
  );

  const { draft, edit, replace, flush } = usePatchDraft(storePatch, commit);

  const groups = useMemo(() => visibleGroups(draft.engineType), [draft.engineType]);
  const [groupId, setGroupId] = useState(groups[0].id);

  // 切引擎会让当前分组消失（比如从「波表」切到「经典」）→ 落回第一组
  useEffect(() => {
    if (!groups.some((g) => g.id === groupId)) setGroupId(groups[0].id);
  }, [groups, groupId]);

  const group = useMemo(
    () => groups.find((g) => g.id === groupId) ?? groups[0],
    [groups, groupId],
  );

  /** 预设名 = 当前 patch 与预设表比对的**结果**（不是记住的状态） */
  const matchedPreset = useMemo(() => {
    for (const name of SYNTH_PRESET_NAMES) {
      if (patchEquals(draft, patchFromPreset(name))) return name;
    }
    return null;
  }, [draft]);

  const audition = useCallback(() => {
    ensureAudioStarted();
    const t0 = getAudioContext().currentTime + 0.06;
    AUDITION_NOTES.forEach((midi, i) => {
      playSynthNote(midi, {
        whenCtxSec: t0 + i * AUDITION_STEP_SEC,
        durationSec: 0.9,
        velocity: 0.9,
      });
    });
  }, []);

  const handleClose = useCallback(() => {
    // 关面板前把在途改动落库并止鸣，避免「听完就关」留下未保存/拖尾
    flush();
    releaseAllSynthNotes();
    onClose();
  }, [flush, onClose]);

  // 关闭时也保证止鸣（onClose 由外部调用，如 Esc / 遮罩点击）
  useEffect(() => {
    if (!open) releaseAllSynthNotes();
  }, [open]);

  const onPresetChange = useCallback(
    (name: string) => {
      if (name === CUSTOM_VALUE) return;
      replace(patchFromPreset(name));
      releaseAllSynthNotes();
      audition();
    },
    [replace, audition],
  );

  return (
    <Modal open={open} onClose={handleClose} title="音色设计" size="xl">
      <div className="flex flex-col gap-3">
        {/* ---- 顶栏：预设 / 试听 / 停止 / 重置 ---- */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-micro text-label-muted">音色预设</span>
            <select
              value={matchedPreset ?? CUSTOM_VALUE}
              onChange={(e) => onPresetChange(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-ink-800 px-2 text-small text-label-hi outline-none focus-visible:ring-2 focus-visible:ring-flame-400/60"
            >
              {matchedPreset === null && <option value={CUSTOM_VALUE}>（自定义）</option>}
              {SYNTH_PRESET_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={audition}
            title="按 C4 E4 G4 C5 试听当前音色"
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-line bg-ink-800 px-2.5 text-small font-medium text-label-hi transition-colors hover:bg-ink-700"
          >
            <IconPlay size={13} />
            试听
          </button>
          <button
            type="button"
            onClick={() => releaseAllSynthNotes()}
            title="停掉所有正在响的音"
            className="inline-flex h-7 items-center gap-1 rounded-sm border border-line bg-ink-800 px-2.5 text-small font-medium text-label-muted transition-colors hover:bg-ink-700 hover:text-label-hi"
          >
            <IconStop size={13} />
            停止
          </button>
          <button
            type="button"
            onClick={() => {
              replace({ ...DEFAULT_SYNTH_PATCH });
              toast('音色已恢复出厂（参考音 · 清铃）');
            }}
            className="h-7 rounded-sm border border-line bg-ink-800 px-2.5 text-small font-medium text-label-muted transition-colors hover:bg-ink-700 hover:text-label-hi"
          >
            重置
          </button>
        </div>

        <SynthViz active={open} />

        {/* ---- 分组切换：横向可滚，手机上不换行 ---- */}
        <div
          role="tablist"
          aria-label="音色参数分组"
          className="-mx-3 flex gap-1 overflow-x-auto px-3 pb-1"
        >
          {groups.map((g) => {
            const on = g.id === group.id;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setGroupId(g.id)}
                className={`h-7 shrink-0 rounded-sm px-2.5 text-small font-medium transition-colors ${
                  on
                    ? 'bg-flame-400/15 text-flame-300'
                    : 'text-label-muted hover:bg-ink-800 hover:text-label-hi'
                }`}
              >
                {g.title}
              </button>
            );
          })}
        </div>

        {/* ---- 当前分组 ---- */}
        <section className="rounded-lg border border-line bg-ink-950/60 p-3">
          <header className="mb-2.5 flex items-baseline gap-2">
            <h4 className="text-small font-semibold text-label-hi">{group.title}</h4>
            <p className="min-w-0 flex-1 text-micro leading-snug text-label-muted">
              {group.hint}
            </p>
          </header>
          <GroupBody group={group} draft={draft} edit={edit} />
        </section>

        <OtherEngineGroups engineType={draft.engineType} />

        <p className="text-micro leading-relaxed text-label-muted">
          这套音色只作用于试听与按键反馈（空槽键兜底声、录制跟弹参考音），
          不进导出 —— 导出仍按素材本身渲染。
        </p>
      </div>
    </Modal>
  );
}
