/**
 * EqRackPanel —— 均衡器的专属面板：**左侧可交互可视化 + 右侧按段旋钮**。
 *
 * ══ 布局（用户定稿）══
 *
 *   ┌─ 频响曲线（可拖拽节点）────────────┬─ 段 1 ─ 段 2 ─ 段 3 ─┐
 *   │                                    │  段 4 ─ 段 5 ────    │
 *   └────────────────────────────────────┴──────────────────────┘
 *
 * 为什么段控件竖排成列而不是横铺成一长条：
 *   每段有 频率/增益/Q 三个旋钮 + 类型 + 开关，横铺 5 段需要 ≥900px；
 *   竖排 2~3 列则能在 300px 宽内放下，把省下的宽度让给曲线 ——
 *   曲线越宽，拖拽定位越准（这是均衡器最核心的操作）。
 *
 * 为什么 EQ 不复用通用的 `unit.params` 滑杆：
 *   EQ 的参数是嵌套的（5 段 × 4 字段），扁平 `AnyParamSpec[]` 表达不了。
 *   本面板直接读 store 的 `effects.eq.bands` 并用 `setEqBand` 写入。
 */
import type { EqBand, EqBandType } from '../../model/types';
import { Knob } from './Knob';
import EqCanvas from './EqCanvas';
import { IconPower } from './Icon';
import {
  EQ_TYPE_LABEL,
  EQ_TYPE_ORDER,
  eqBandColor,
  eqTypeHasGain,
} from '../../engine/effect-units/eq';

const TYPE_OPTIONS = EQ_TYPE_ORDER;

export interface EqRackPanelProps {
  bands: EqBand[];
  selected: number;
  enabled: boolean;
  onSelect(index: number): void;
  onBandChange(index: number, patch: Partial<EqBand>): void;
  /** 复位全部段到出厂默认 */
  onReset(): void;
}

export default function EqRackPanel({
  bands,
  selected,
  enabled,
  onSelect,
  onBandChange,
  onReset,
}: EqRackPanelProps) {
  return (
    <div className="flex flex-col gap-2.5 lg:flex-row lg:items-stretch">
      {/* ── 左：可交互频响曲线 ── */}
      <div className={`flex min-w-0 flex-1 ${enabled ? '' : 'opacity-40'}`}>
        <EqCanvas
          bands={bands}
          selected={selected}
          onSelect={onSelect}
          onBandChange={onBandChange}
          height={248}
        />
      </div>

      {/* ── 右：按段旋钮 ──
          宽度算法：卡片内容 = 3 个旋钮(38px) + 2 个间隙(2px) + 内边距(12px) ≈ 130px；
          3 列 + 2 个 gap(8px) = 406px；但旋钮的标签文字会比旋钮本体宽，
          实际需要 448px 才不会被右缘切掉（336px / 420px 都实测溢出过）。 */}
      <div
        className={`flex shrink-0 flex-col gap-2 lg:w-[448px] ${enabled ? '' : 'opacity-40'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-micro uppercase tracking-[0.14em] text-label-faint">
            {bands.length} 段参数
          </span>
          <span className="min-w-2 flex-1" />
          <button
            type="button"
            onClick={onReset}
            className="h-6 rounded-sm px-2 text-micro text-label-faint transition-colors hover:bg-ink-800 hover:text-label-lo"
          >
            复位
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-2 gap-y-2 xl:grid-cols-3">
          {bands.map((b, i) => {
            const isSel = i === selected;
            const color = eqBandColor(i);
            const hasGain = eqTypeHasGain(b.type);
            return (
              <section
                key={i}
                onClick={() => onSelect(i)}
                className={`flex cursor-pointer flex-col gap-1 rounded-sm bg-ink-950 px-1.5 py-1.5 transition-colors ${
                  isSel
                    ? 'shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.55)]'
                    : 'shadow-[inset_0_0_0_1px_rgb(var(--line))] hover:shadow-[inset_0_0_0_1px_rgb(var(--line-hot))]'
                } ${b.enabled ? '' : 'opacity-45'}`}
              >
                {/* 段头：序号徽章 + 开关 */}
                <div className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-sm font-mono text-micro font-bold text-ink-950"
                    style={{ background: color }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-micro text-label-muted">
                    {EQ_TYPE_LABEL[b.type]}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={b.enabled}
                    aria-label={`第 ${i + 1} 段开关`}
                    title={b.enabled ? '停用该段' : '启用该段'}
                    onClick={(e) => {
                      e.stopPropagation();
                      onBandChange(i, { enabled: !b.enabled });
                    }}
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-sm transition-colors ${
                      b.enabled ? 'text-flame-300' : 'text-label-faint hover:text-label-lo'
                    }`}
                  >
                    <IconPower size={11} />
                  </button>
                </div>

                {/* 类型选择：原生 select，键盘可达且无自造下拉的定位问题 */}
                <select
                  value={b.type}
                  aria-label={`第 ${i + 1} 段类型`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const type = e.target.value as EqBandType;
                    // 切到无增益类型时把增益归零，避免留下「看不见但生效」的残留值
                    onBandChange(i, eqTypeHasGain(type) ? { type } : { type, gainDb: 0 });
                  }}
                  className="h-6 w-full rounded-sm bg-ink-900 px-1 text-micro text-label-lo outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)] [&>option]:bg-ink-900"
                >
                  {TYPE_OPTIONS.map((tp) => (
                    <option key={tp} value={tp}>
                      {EQ_TYPE_LABEL[tp]}
                    </option>
                  ))}
                </select>

                {/* 三个旋钮：频率 / 增益 / Q */}
                <div className="flex items-start justify-between gap-0.5">
                  <Knob
                    label="频率"
                    value={b.frequencyHz}
                    min={20}
                    max={20000}
                    step={1}
                    unit="hz"
                    size={38}
                    disabled={!enabled || !b.enabled}
                    onChange={(v) => onBandChange(i, { frequencyHz: Math.round(v) })}
                  />
                  <div title={hasGain ? undefined : `${EQ_TYPE_LABEL[b.type]} 无增益参数`}>
                    <Knob
                      label="增益"
                      value={b.gainDb}
                      min={-24}
                      max={24}
                      step={0.5}
                      unit="db"
                      size={38}
                      disabled={!enabled || !b.enabled || !hasGain}
                      onChange={(v) => onBandChange(i, { gainDb: v })}
                    />
                  </div>
                  <Knob
                    label="Q"
                    value={b.q}
                    min={0.05}
                    max={40}
                    step={0.01}
                    unit="raw"
                    size={38}
                    disabled={!enabled || !b.enabled}
                    onChange={(v) => onBandChange(i, { q: v })}
                  />
                </div>
              </section>
            );
          })}
        </div>

        <p className="font-mono text-micro leading-relaxed text-label-faint">
          曲线可直接拖节点：横向改频率、纵向改增益。滚轮调 Q，右键换类型，双击增益归零。
        </p>
      </div>
    </div>
  );
}
