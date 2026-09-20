import { useEffect, useRef, useState } from 'react';
import ExportDialog from './ExportDialog';
import { useStore, DEFAULT_EFFECTS } from '../model/store';
import {
  useFxParamFunnel,
  writeFxParam,
  DEFAULT_FX_DEBOUNCE_MS,
} from '../hooks/useFxParamFunnel';
import { getMasterChain } from '../engine/effects';
import { EFFECT_UNITS } from '../engine/effect-units/registry';
import type { AnyEffectUnit, AnyParamSpec, StageId } from '../engine/effect-units/types';
import { Knob } from '../components/ui/Knob';
import EqRackPanel from '../components/ui/EqRackPanel';
import { PageBar, Led } from '../components/ui/PageBar';
import {
  ChorusViz,
  CompressorViz,
  GainReductionMeter,
  ReverbViz,
} from '../components/ui/EffectViz';
import { IconDownload, IconGrip, IconChevronDown, IconUndo } from '../components/ui/Icon';
import type { EqBand } from '../model/types';

/**
 * MixPage —— 混音台（效果器架）。
 *
 * 布局语言（用户定稿：一排排、点击展开、左可视化 / 右参数）：
 *
 *   ┌ 单行顶栏 44px ──────────────────────────────────────┐
 *   │ 混音台   [信号流带 IN→EQ→COMP→CHORUS→VERB→OUT]  工具 │
 *   ├ 效果器架 ───────────────────────────────────────────┤
 *   │ ▸ 均衡器 EQ3            +2 0 −1        [○] [⌄] 44px │
 *   │ ▾ 混响  Reverb          2.2s · 18%     [○] [⌃]      │
 *   │   ┌─ 可视化 ─────────┐ ┌─ 参数 ──────┐              │
 *   │   │  脉冲响应          │ │ ◯ ◯ ◯      │              │
 *   │   └───────────────────┘ └────────────┘              │
 *   └─────────────────────────────────────────────────────┘
 *
 * 相对旧实现的三个关键改进：
 *   1. **闭合行自带迷你读数**（`+2 0 −1` / `2.2s · 18%`）。
 *      旧实现折叠后整排只有名字，用户必须逐排展开才知道状态 ——
 *      这才是「占操作空间」的真正来源：展开是常态就说明折叠没意义。
 *   2. **展开用 grid-template-rows 0fr→1fr**，高度连续，邻排不跳；
 *      旧实现（以及全部 4 张原型卡）用 display:none，高度突变且
 *      展开瞬间子元素尺寸为 0，canvas/SVG 首帧空白。
 *   3. **每级一个与参数真实相关的专属可视化**。
 *      原型的 effects-rack.html 画的是与旋钮无关的假曲线。
 */
export default function MixPage() {
  const effects = useStore((s) => s.project.effects);
  const [exportOpen, setExportOpen] = useState(false);

  // 共享漏斗：pending 镜像 + 防抖落库 + 卸载自动 flush
  const { pending, setPendingValue, scheduleWrite, cancelPending, cancelAllPending } =
    useFxParamFunnel();

  /** 总线旁路快照：恢复「一键全关前」的各分级开关状态 */
  const bypassSnapshotRef = useRef<boolean[] | null>(null);
  /** 展开的行（默认展开 EQ 与混响 —— 用户最常调的两级） */
  const [openRows, setOpenRows] = useState<Set<StageId>>(
    () => new Set<StageId>(['eq', 'reverb']),
  );
  /** 当前选中的 EQ 段（曲线高亮 + 滚轮调 Q 的兜底目标） */
  const [eqBand, setEqBand] = useState(1);

  // 实时链对接：effects 引用变化 → 幂等 apply 到单例链。
  useEffect(() => {
    let prev = useStore.getState().project.effects;
    getMasterChain(prev);
    return useStore.subscribe((s) => {
      if (s.project.effects !== prev) {
        prev = s.project.effects;
        getMasterChain(s.project.effects);
      }
    });
  }, []);

  const changeParam = (unit: AnyEffectUnit, spec: AnyParamSpec, v: number) => {
    const fullKey = `${unit.id}.${spec.key}`;
    setPendingValue(fullKey, v);
    scheduleWrite(fullKey, spec.debounceMs ?? DEFAULT_FX_DEBOUNCE_MS, () =>
      writeFxParam(unit.id, spec.key, v),
    );
  };

  /** 双击旋钮：取消在途写入并直接落默认值 */
  const resetParam = (unit: AnyEffectUnit, spec: AnyParamSpec) => {
    const fullKey = `${unit.id}.${spec.key}`;
    cancelPending(fullKey);
    setPendingValue(fullKey, spec.def);
    scheduleWrite(fullKey, spec.debounceMs ?? DEFAULT_FX_DEBOUNCE_MS, () =>
      writeFxParam(unit.id, spec.key, spec.def),
    );
  };

  /** 一键重置：全部参数回到出厂默认 */
  const resetAllEffects = () => {
    cancelAllPending();
    const d = structuredClone(DEFAULT_EFFECTS);
    const s = useStore.getState();
    EFFECT_UNITS.forEach((u) => s.setEffect(u.id, d[u.id]));
  };

  // 总线旁路：派生状态 = 各级全关
  const stageFlags = EFFECT_UNITS.map((u) => effects[u.id].enabled);
  const busBypassed = stageFlags.every((x) => !x);

  const toggleBusBypass = () => {
    cancelAllPending();
    if (!busBypassed) {
      bypassSnapshotRef.current = EFFECT_UNITS.map((u) => effects[u.id].enabled);
      EFFECT_UNITS.forEach((u) => useStore.getState().setEffect(u.id, { enabled: false }));
    } else {
      const snap = bypassSnapshotRef.current;
      const target = snap && snap.some(Boolean) ? snap : EFFECT_UNITS.map(() => true);
      EFFECT_UNITS.forEach((u, i) =>
        useStore.getState().setEffect(u.id, { enabled: target[i] }),
      );
    }
  };

  const toggleRow = (id: StageId) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 显示值：拖动镜像优先，否则读 store */
  const displayValue = (unit: AnyEffectUnit, spec: AnyParamSpec): number =>
    pending[`${unit.id}.${spec.key}`] ?? unit.readValue(effects[unit.id], spec.key);

  const val = (id: StageId, key: string, fallback: number): number =>
    pending[`${id}.${key}`] ?? fallback;

  /**
   * 闭合行右侧的迷你读数。
   * 这是本页最重要的空间优化：不展开就能读出当前状态。
   */
  const readout = (unit: AnyEffectUnit): string => {
    /*
      两处防护，缺一不可：
        1. `?? fb` —— pending 镜像里可能有值、store 里也可能缺字段（老存档）；
        2. `Number.isFinite` 兜底 —— 万一拿到 undefined/NaN，
           `undefined.toFixed()` 会抛 TypeError，而它发生在**渲染期**，
           会让整页被 React 卸载（表现为「切过去画面变黑」）。
      读数是纯展示，任何情况下都不该有能力搞崩整页。
    */
    const v = (key: string, fb: number): number => {
      const raw = val(unit.id, key, fb);
      return Number.isFinite(raw) ? raw : (Number.isFinite(fb) ? fb : 0);
    };
    switch (unit.id) {
      case 'eq': {
        // EQ 的读数改成「非零段摘要」：列出所有增益不为 0 的段，
        // 而不是把 5 个数字全铺一遍（5 个数字里通常 4 个是 0，读不出信息）。
        const active = effects.eq.bands
          .map((b, i) => ({ i, b }))
          .filter(({ b }) => b.enabled && Math.abs(b.gainDb) >= 0.05);
        if (active.length === 0) return `${effects.eq.bands.length} 段 · 平坦`;
        return active
          .map(
            ({ i, b }) =>
              `${i + 1}${b.gainDb > 0 ? '+' : ''}${b.gainDb.toFixed(1)}`,
          )
          .join(' ');
      }
      case 'compressor':
        return `${v('thresholdDb', effects.compressor.thresholdDb).toFixed(0)}dB · ${v(
          'ratio',
          effects.compressor.ratio,
        ).toFixed(1)}:1`;
      case 'chorus':
        return `${v('rateHz', effects.chorus.rateHz).toFixed(1)}Hz · ${Math.round(
          v('wet', effects.chorus.wet) * 100,
        )}%`;
      case 'reverb':
        return `${v('decaySec', effects.reverb.decaySec).toFixed(1)}s · ${Math.round(
          v('wet', effects.reverb.wet) * 100,
        )}%`;
      default:
        return '';
    }
  };

  /** EQ 段级写入：走 store 的 setEqBand（精准写单段，不用整份 bands 拼数组） */
  const changeEqBand = (index: number, patch: Partial<EqBand>) => {
    useStore.getState().setEqBand(index, patch);
  };

  const resetEqBands = () => {
    useStore.getState().setEqBands(structuredClone(DEFAULT_EFFECTS.eq.bands));
  };

  return (
    <section aria-label="混音台" className="flex min-h-0 flex-1 flex-col">
      {/* ═══ 单行顶栏：标题 + 信号流 + 工具 ═══ */}
      <PageBar
        title="混音台"
        status={
          <>
            <Led tone={busBypassed ? 'danger' : 'ok'} on breathe={!busBypassed} />
            <span className="font-mono text-small text-label-muted">
              {busBypassed ? '已旁路' : '主链运行中'}
            </span>
          </>
        }
      >
        {/* 信号流带：紧凑胶囊节点，点击该行展开/折叠（旧实现是滚动定位 + 闪烁） */}
        <div className="hidden items-center gap-1 lg:flex">
          <span className="font-mono text-micro tracking-[0.14em] text-label-faint">IN</span>
          {EFFECT_UNITS.map((u, i) => {
            const on = effects[u.id].enabled;
            return (
              <span key={u.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleRow(u.id)}
                  title={`${u.label}（点击展开/折叠）`}
                  className={`flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-tiny font-semibold tracking-wide transition-colors ${
                    on
                      ? 'bg-flame-600/[0.18] text-flame-300'
                      : 'bg-ink-800 text-label-muted hover:text-label-lo'
                  }`}
                >
                  <Led tone={on ? 'accent' : 'ok'} on={on} />
                  {u.flowLabel}
                </button>
                {i < EFFECT_UNITS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={`h-px w-3 ${on ? 'bg-flame-600/50' : 'bg-ink-700'}`}
                  />
                )}
              </span>
            );
          })}
          <span className="font-mono text-micro tracking-[0.14em] text-label-faint">OUT</span>
        </div>

        <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-line lg:block" />

        <button
          type="button"
          onClick={toggleBusBypass}
          aria-pressed={!busBypassed}
          className={`flex h-ctl-sm items-center gap-1.5 rounded-sm px-2.5 text-small font-medium transition-colors ${
            busBypassed
              ? 'bg-warning/15 text-warning'
              : 'bg-ink-800 text-label-lo hover:bg-ink-700 hover:text-label-hi'
          }`}
        >
          {busBypassed ? '恢复总线' : '总线旁路'}
        </button>

        <button
          type="button"
          onClick={resetAllEffects}
          title="全部参数回到出厂默认"
          className="flex h-ctl-sm items-center gap-1.5 rounded-sm bg-ink-800 px-2.5 text-small font-medium text-label-lo transition-colors hover:bg-ink-700 hover:text-label-hi"
        >
          <IconUndo size={13} />
          重置
        </button>

        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="flex h-ctl-sm items-center gap-1.5 rounded-sm bg-flame-400 px-2.5 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300"
        >
          <IconDownload size={13} />
          导出
        </button>
      </PageBar>

      {/* ═══ 效果器架 ═══ */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        {/* 主输出增益 —— 独立一行，不属于任何一级 */}
        <div className="mb-2 flex items-center gap-3 rounded-md bg-ink-900 px-3 py-2 shadow-[inset_0_1px_0_rgb(var(--hl))]">
          <span className="shrink-0 text-small text-label-muted">主输出</span>
          <MasterGainSlider
            value={pending['master.masterGainDb'] ?? effects.masterGainDb}
            onChange={(v) => {
              const key = 'master.masterGainDb';
              setPendingValue(key, v);
              scheduleWrite(key, DEFAULT_FX_DEBOUNCE_MS, () =>
                useStore.getState().setMasterGainDb(v),
              );
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          {EFFECT_UNITS.map((unit) => {
            const enabled = effects[unit.id].enabled;
            const open = openRows.has(unit.id);
            return (
              <article
                key={unit.id}
                className={`overflow-hidden rounded-md bg-ink-900 shadow-[inset_0_1px_0_rgb(var(--hl))] transition-colors ${
                  open ? 'shadow-[inset_0_1px_0_rgb(var(--hl)),0_0_0_1px_rgb(var(--flame-600)/0.45)]' : ''
                }`}
              >
                {/* ── 闭合行 44px ── */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggleRow(unit.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleRow(unit.id);
                    }
                  }}
                  className="flex h-11 cursor-pointer select-none items-center gap-2.5 px-3 transition-colors hover:bg-ink-800"
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-label-faint"
                    title="拖拽排序（待实现）"
                  >
                    <IconGrip size={13} />
                  </span>

                  <Led tone={enabled ? 'accent' : 'ok'} on={enabled} breathe={enabled} />

                  <span className="flex min-w-0 items-baseline gap-2">
                    <h3 className="shrink-0 text-body font-semibold tracking-[-0.01em] text-label-hi">
                      {unit.label}
                    </h3>
                    {unit.en && (
                      <span className="truncate font-mono text-micro uppercase tracking-[0.12em] text-label-muted">
                        {unit.en}
                      </span>
                    )}
                  </span>

                  <span className="min-w-2 flex-1" />

                  {/* 迷你读数 —— 折叠状态下也能读出当前状态 */}
                  <span className="shrink-0 rounded-sm bg-ink-950 px-2 py-0.5 font-mono text-tiny tabular-nums text-label-lo">
                    {readout(unit)}
                  </span>

                  {/* 旁路开关：独立点击区，不触发展开 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${unit.label} 旁路开关`}
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().setEffect(unit.id, { enabled: !enabled });
                    }}
                    className={`relative h-[21px] w-9 shrink-0 rounded-full transition-colors ${
                      enabled ? 'bg-flame-400' : 'bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]'
                    }`}
                  >
                    <span
                      className={`absolute top-[2px] h-[17px] w-[17px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-pop ${
                        enabled ? 'translate-x-[19px]' : 'translate-x-[2px]'
                      }`}
                    />
                  </button>

                  <IconChevronDown
                    size={15}
                    className={`shrink-0 text-label-muted transition-transform duration-200 ${
                      open ? 'rotate-180' : ''
                    }`}
                  />
                </div>

                {/* ── 展开体：grid-template-rows 0fr→1fr（高度连续，邻排不跳）── */}
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-out"
                  style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden">
                    {/*
                      EQ 走**专属面板**（左可交互曲线 + 右按段旋钮），
                      其余单元走通用的「左可视化 + 右参数滑杆/旋钮」。
                      之所以分开：EQ 的参数是嵌套的（5 段 × 4 字段），
                      通用 params 表表达不了；而它的曲线本身又是最核心的操作面，
                      需要比通用可视化更大的空间。
                    */}
                    {unit.id === 'eq' ? (
                      <div className="border-t border-line p-3">
                        <EqRackPanel
                          bands={effects.eq.bands}
                          selected={eqBand}
                          enabled={enabled}
                          onSelect={setEqBand}
                          onBandChange={changeEqBand}
                          onReset={resetEqBands}
                        />
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 border-t border-line p-3 lg:flex-row lg:items-stretch">
                        {/* 可视化（左） */}
                        <div
                          className={`flex min-w-0 flex-1 transition-opacity duration-300 ${
                            enabled ? '' : 'opacity-40'
                          }`}
                        >
                          {unit.id === 'compressor' && (
                            <>
                              <CompressorViz
                                thresholdDb={val('compressor', 'thresholdDb', effects.compressor.thresholdDb)}
                                ratio={val('compressor', 'ratio', effects.compressor.ratio)}
                                enabled={enabled}
                              />
                              <GainReductionMeter
                                thresholdDb={val('compressor', 'thresholdDb', effects.compressor.thresholdDb)}
                                ratio={val('compressor', 'ratio', effects.compressor.ratio)}
                                active={enabled}
                              />
                            </>
                          )}
                          {unit.id === 'chorus' && (
                            <ChorusViz
                              rateHz={val('chorus', 'rateHz', effects.chorus.rateHz)}
                              depth={val('chorus', 'depth', effects.chorus.depth)}
                              delayTimeMs={val('chorus', 'delayTimeMs', effects.chorus.delayTimeMs)}
                              spreadDegrees={val('chorus', 'spreadDegrees', effects.chorus.spreadDegrees)}
                              enabled={enabled}
                            />
                          )}
                          {unit.id === 'reverb' && (
                            <ReverbViz
                              decaySec={val('reverb', 'decaySec', effects.reverb.decaySec)}
                              preDelaySec={val('reverb', 'preDelaySec', effects.reverb.preDelaySec)}
                              wet={val('reverb', 'wet', effects.reverb.wet)}
                              enabled={enabled}
                            />
                          )}
                        </div>

                        {/* 参数（右）—— 宽屏固定 3 列网格（不换行、不孤行），窄屏自动折行 */}
                        <div
                          className={`grid grid-cols-3 content-start gap-x-1 gap-y-2 transition-opacity duration-300 lg:w-[196px] lg:flex-none ${
                            enabled ? '' : 'opacity-40'
                          }`}
                        >
                          {unit.params.map((spec) => (
                            <div
                              key={spec.key}
                              onDoubleClick={() => resetParam(unit, spec)}
                              title={`${spec.label}（双击复位 ${spec.def}）${spec.hint ? ` · ${spec.hint}` : ''}`}
                            >
                              <Knob
                                label={spec.label}
                                value={displayValue(unit, spec)}
                                min={spec.min}
                                max={spec.max}
                                step={spec.step}
                                unit={spec.unit}
                                disabled={!enabled}
                                size={46}
                                onChange={(nv) => changeParam(unit, spec, nv)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {unit.id === 'compressor' && (
                      <p className="border-t border-line px-3 py-1.5 font-mono text-micro text-label-faint">
                        GR 为按阈值/比率推导的估算指示（引擎未暴露实时读数）
                      </p>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <p className="mt-4 text-small leading-relaxed text-label-muted">
          全部参数经 store 写入后由引擎幂等 apply 到实时主链单例。
          <span className="mx-1.5 text-label-faint">·</span>
          折叠状态下右侧读数即可反映当前设置，无需逐排展开。
          <span className="mx-1.5 text-label-faint">·</span>
          旋钮纵向拖动调值，双击复位。
        </p>
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   主输出增益滑条 —— 横向，比旋钮更适合「一条总线」的语义
   ═══════════════════════════════════════════════════════════════════════ */

const GAIN_MIN = -40;
const GAIN_MAX = 6;

function MasterGainSlider({
  value,
  onChange,
}: {
  value: number;
  onChange(v: number): void;
}) {
  const pct = ((value - GAIN_MIN) / (GAIN_MAX - GAIN_MIN)) * 100;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="relative flex h-5 min-w-0 flex-1 items-center">
        {/* 槽底 */}
        <div className="pointer-events-none absolute inset-x-0 h-[3px] rounded-full bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]" />
        {/* 已划过填充 */}
        <div
          className="pointer-events-none absolute left-0 h-[3px] rounded-full bg-flame-400"
          style={{ width: `${pct}%` }}
        />
        {/*
          轨道与拇指全部由相邻 div + .range-h 类绘制（见 index.css）。
          input 只负责命中与无障碍语义，故不给它任何外观类 ——
          之前用 Tailwind 任意 variant 写 ::-webkit-slider-thumb 不生效，
          表现为拇指完全不可见。
        */}
        <input
          type="range"
          min={GAIN_MIN}
          max={GAIN_MAX}
          step={0.5}
          value={value}
          aria-label="主输出增益"
          onChange={(e) => onChange(Number(e.target.value))}
          className="range-h relative z-10 h-5 w-full"
        />
      </div>
      <span className="w-[52px] shrink-0 text-right font-mono text-small tabular-nums text-flame-300">
        {value > 0 ? '+' : ''}
        {value.toFixed(1)} dB
      </span>
    </div>
  );
}
