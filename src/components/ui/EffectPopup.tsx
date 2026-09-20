/**
 * EffectPopup —— VST 风格效果器弹层（钢琴卷帘 / 填词区点击音符音高区域时唤起）。
 *
 * 深色玻璃弹层内按注册表序渲染四级效果模块（EQ / Compressor / Chorus /
 * Reverb）：每级一张 Panel 卡 + LED + PowerToggle 旁路开关；EQ 级含
 * EqCurve 频响可视化与分频点只读徽章，压缩级含增益衰减 LevelMeter。
 *
 * 参数写入走共享漏斗 hooks/useFxParamFunnel（与 MixPage 同一实现）：拖动中
 * 先更新本地 pending 镜像（视觉即时），store 落库按规格声明的 debounceMs
 * （缺省 60ms）防抖合并；关闭/卸载时 flush 在途写入。
 */
import { useCallback, useEffect, useState } from 'react';
import { useStore, DEFAULT_EFFECTS } from '../../model/store';
import {
  useFxParamFunnel,
  writeFxParam,
  DEFAULT_FX_DEBOUNCE_MS,
} from '../../hooks/useFxParamFunnel';
import { EFFECT_UNITS } from '../../engine/effect-units/registry';
import type { StageId } from '../../engine/effect-units/types';
import { Panel } from './Panel';
import { PowerToggle } from './PowerToggle';
import { Knob } from './Knob';
import { LevelMeter } from './LevelMeter';
import {
  EQ_TYPE_LABEL,
  eqBandColor,
  eqTypeHasGain,
} from '../../engine/effect-units/eq';
import { formatHz } from '../../utils/format';

export interface EffectPopupProps {
  open: boolean;
  onClose(): void;
}

// ---------------------------------------------------------------------------
// 写入漏斗已收编至 hooks/useFxParamFunnel（与 MixPage 共用单例实现）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 注册表现已覆盖全部可调参数（EQ 补分频点、Compressor 补启动/释放、
// Chorus 补速率/立体声、Reverb 补预延迟），故这里不再需要补充参数表。
// ---------------------------------------------------------------------------

/** 各级旋钮网格布局（compressor 单独走 flex 行容纳电平表） */
const KNOB_GRID: Record<StageId, string> = {
  eq: 'grid grid-cols-3 gap-x-2 gap-y-3',
  compressor: '',
  chorus: 'grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-5',
  reverb: 'grid grid-cols-3 gap-x-2 gap-y-3',
};

/** LED 指示灯：开机绿光 / 待机灰（与 MixPage 本地实现同款） */
function Led({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 shrink-0 rounded-full transition-all duration-300 ${
        on
          ? 'bg-flame-400 shadow-[0_0_8px_2px_rgb(var(--flame-400)_/_0.55)]'
          : 'bg-slate-600 shadow-inner'
      }`}
    />
  );
}

/**
 * 增益衰减估算：以慢速摆动的模拟节目电平驱动阈值/比率公式
 * GR = max(0, level − threshold) × (1 − 1/ratio)。
 * 纯可视化指示（引擎未暴露实时 GR），随阈值/比率旋钮正确联动。
 */
function useEstimatedGainReduction(thresholdDb: number, ratio: number): number {
  const [grDb, setGrDb] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const timer = window.setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const programDb = -12 + 6 * Math.sin(t * 2.2) + 1.5 * Math.sin(t * 5.7);
      const over = programDb - thresholdDb;
      setGrDb(over > 0 ? over * (1 - 1 / Math.max(ratio, 1)) : 0);
    }, 80);
    return () => window.clearInterval(timer);
  }, [thresholdDb, ratio]);
  return grDb;
}

// ---------------------------------------------------------------------------
// 弹层
// ---------------------------------------------------------------------------

export function EffectPopup({ open, onClose }: EffectPopupProps) {
  const effects = useStore((s) => s.project.effects);
  // 共享漏斗：pending 镜像 + 防抖落库 + 卸载自动 flush（原本地实现收编）
  const {
    pending,
    setPendingValue,
    scheduleWrite,
    cancelAllPending,
    flushPendingWrites,
  } = useFxParamFunnel();

  /**
   * 弹层侧修复：尊重单元规格声明的 debounceMs（如 reverb.decaySec=400ms），
   * 不再一律压到 60ms —— 拖动长窗口参数时不再触发保存风暴。
   */
  const changeParam = useCallback(
    (id: StageId, key: string, value: number, debounceMs?: number) => {
      const fullKey = `${id}.${key}`;
      setPendingValue(fullKey, value);
      scheduleWrite(fullKey, debounceMs ?? DEFAULT_FX_DEBOUNCE_MS, () =>
        writeFxParam(id, key, value),
      );
    },
    [setPendingValue, scheduleWrite],
  );

  const handleClose = useCallback(() => {
    flushPendingWrites();
    onClose();
  }, [flushPendingWrites, onClose]);

  // Escape 关闭 + 打开期间锁定 body 滚动（与 ui/Modal 行为一致）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, handleClose]);

  /** 显示值：拖动镜像优先，否则读 store */
  const val = (id: StageId, key: string, fallback: number): number =>
    pending[`${id}.${key}`] ?? fallback;

  const resetAll = () => {
    cancelAllPending();
    const d = structuredClone(DEFAULT_EFFECTS);
    const s = useStore.getState();
    EFFECT_UNITS.forEach((u) => s.setEffect(u.id, d[u.id]));
  };

  // 压缩级增益衰减估算的输入（pending 镜像优先）
  const thresholdDb = val('compressor', 'thresholdDb', effects.compressor.thresholdDb);
  const ratio = val('compressor', 'ratio', effects.compressor.ratio);
  const grDb = useEstimatedGainReduction(thresholdDb, ratio);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="效果器"
    >
      {/* 遮罩：模糊 + 点击关闭 */}
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" onClick={handleClose} />

      {/* 深色玻璃面板 */}
      <div className="relative z-10 max-h-[88dvh] w-full overflow-y-auto rounded-t-2xl border border-ink-600 bg-ink-900/95 shadow-2xl backdrop-blur-md sm:max-w-xl sm:rounded-2xl">
        {/* 顶部氛围光 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(60%_120%_at_50%_0%,rgb(var(--flame-500)_/_0.10),transparent)]"
        />

        <div className="relative p-4">
          {/* —— 头部 —— */}
          <header className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-flame-500/80">
                Note FX · Rack
              </p>
              <h2 className="mt-0.5 text-base font-bold tracking-wide text-slate-100">效果器</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                主总线四级效果链，改动实时生效并自动保存。
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={handleClose}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-ink-600 text-sm text-slate-400 transition hover:border-accent/40 hover:text-flame-300"
            >
              ✕
            </button>
          </header>

          {/* —— 四张模块卡（按注册表序）—— */}
          <div className="space-y-3">
            {EFFECT_UNITS.map((unit) => {
              const enabled = effects[unit.id].enabled;
              // 注册表已覆盖全部参数；EXTRA_PARAMS 已退役，直接消费 unit.params
              const specs = unit.params;
              const knobEls = specs.map((spec) => (
                <Knob
                  key={spec.key}
                  label={spec.label}
                  value={val(unit.id, spec.key, unit.readValue(effects[unit.id], spec.key))}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  unit={spec.unit}
                  disabled={!enabled}
                  onChange={(v) =>
                    changeParam(
                      unit.id,
                      spec.key,
                      v,
                      'debounceMs' in spec ? spec.debounceMs : undefined,
                    )
                  }
                />
              ));

              return (
                <Panel
                  key={unit.id}
                  className="border-ink-700 bg-gradient-to-b from-ink-800/90 to-ink-900 shadow-lg"
                >
                  {/* 机架顶部导光条 */}
                  <div
                    aria-hidden="true"
                    className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${
                      enabled ? 'via-flame-500/50' : 'via-ink-600'
                    }`}
                  />

                  {/* 卡头：LED + 名称 + 电源拨杆（负边距全出血，与 MixPage 同版式） */}
                  <header className="-mx-4 -mt-4 mb-3 flex items-center justify-between gap-2 overflow-hidden border-b border-ink-700/70 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Led on={enabled} />
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-slate-100">
                          {unit.label}
                        </h3>
                        <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                          {unit.en}
                        </p>
                      </div>
                    </div>
                    <PowerToggle
                      on={enabled}
                      onChange={(on) => useStore.getState().setEffect(unit.id, { enabled: on })}
                      label={`${unit.label}电源（旁路开关）`}
                    />
                  </header>

                  <div
                    className={`transition-opacity duration-300 ${
                      enabled ? '' : 'pointer-events-none opacity-35'
                    }`}
                  >
                    {unit.id === 'eq' && (
                      /*
                        EQ 的参数是**嵌套**的（5 段 × 4 字段），扁平的
                        `AnyParamSpec[]` 表达不了 —— 故这里不复用通用旋钮网格，
                        改为「各段增益的紧凑总览」。完整的按段编辑（频率/增益/Q/
                        类型/开关 + 可拖拽曲线）在混音台的专属面板里。
                      */
                      <div className="flex flex-col gap-1">
                        {effects.eq.bands.map((b, i) => {
                          const g = val('eq', `bands.${i}.gainDb`, b.gainDb);
                          const hasGain = eqTypeHasGain(b.type);
                          return (
                            <div
                              key={i}
                              className={`flex items-center gap-2 rounded-sm px-1.5 py-1 font-mono text-[10px] tabular-nums ${
                                b.enabled ? '' : 'opacity-40'
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: eqBandColor(i) }}
                              />
                              <span className="w-3 shrink-0 text-slate-500">{i + 1}</span>
                              <span className="w-10 shrink-0 text-slate-400">
                                {EQ_TYPE_LABEL[b.type]}
                              </span>
                              <span className="w-14 shrink-0 text-slate-400">
                                {formatHz(b.frequencyHz)}
                              </span>
                              <span className="w-14 shrink-0 text-right text-flame-300">
                                {hasGain
                                  ? `${g > 0 ? '+' : ''}${g.toFixed(1)}dB`
                                  : '—'}
                              </span>
                              {/* 行内竖条：让「哪一段抬/砍了多少」一眼可读 */}
                              <span className="flex h-2.5 min-w-0 flex-1 items-center">
                                <span className="relative h-[3px] w-full rounded-full bg-ink-950">
                                  <span
                                    className="absolute top-0 h-[3px] rounded-full"
                                    style={{
                                      background: eqBandColor(i),
                                      left: g >= 0 ? '50%' : `${50 - (Math.abs(g) / 24) * 50}%`,
                                      width: `${(Math.abs(g) / 24) * 50}%`,
                                      opacity: hasGain ? 1 : 0.25,
                                    }}
                                  />
                                </span>
                              </span>
                            </div>
                          );
                        })}
                        <p className="mt-1 text-[10px] leading-snug text-slate-500">
                          完整参数在混音台的「均衡器」行里编辑（曲线可直接拖节点）。
                        </p>
                      </div>
                    )}

                    {unit.id === 'compressor' && (
                      <>
                        <div className="flex items-end gap-3">
                          <div className="grid flex-1 grid-cols-2 gap-x-2 gap-y-3">{knobEls}</div>
                          <LevelMeter value={grDb} max={24} label="增益衰减" />
                        </div>
                        <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                          ※ 衰减为按阈值/比率估算的可视化指示
                        </p>
                      </>
                    )}

                    {(unit.id === 'chorus' || unit.id === 'reverb') && (
                      <div className={KNOB_GRID[unit.id]}>{knobEls}</div>
                    )}
                  </div>
                </Panel>
              );
            })}
          </div>

          {/* —— 底部操作条 —— */}
          <footer className="mt-4 flex justify-end gap-2 border-t border-ink-700/70 pt-3">
            <button
              type="button"
              onClick={resetAll}
              className="flex min-h-[44px] items-center rounded-lg border border-ink-600 bg-ink-800 px-4 text-sm text-slate-300 transition hover:bg-ink-700 hover:text-slate-100 active:scale-[0.98]"
            >
              重置
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="flex min-h-[44px] items-center rounded-lg border border-accent/50 bg-accent/15 px-4 text-sm font-medium text-flame-300 transition hover:bg-accent/25 active:scale-[0.98]"
            >
              关闭
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}