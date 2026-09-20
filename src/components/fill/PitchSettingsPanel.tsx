import type { Detector, PitchSettings } from '../../engine/pitch-settings';
import { DEFAULTS } from '../../engine/pitch-settings';

/* ═══════════════════════════════════════════════════════════════════════
   参数表（manifest）—— 单一事实来源
   ═══════════════════════════════════════════════════════════════════════

   为什么把 UI 参数提成数据而不是直接写 JSX：
   用户反馈过一次「参数别给我丢了」。写死 JSX 时，漏渲染一个字段编译期
   完全无感 —— 只有人肉比对才发现。提成表之后，「表必须覆盖 PitchSettings
   的每一个键」这一条由**类型系统**强制（见下 `FIELD_KEYS`），
   而「表里的每一项都必须被渲染」由渲染函数的 switch 穷尽检查强制。
   两层加起来，漏字段在编译期就会报错，不需要靠测试或人工审查。 */

const DETECTOR_LABELS: Record<Detector, string> = {
  yin: 'YIN',
  ai: 'AI · Basic Pitch',
};

type FieldKey = keyof PitchSettings;

interface BaseField {
  key: FieldKey;
  /** 参数名 —— 完整写出，不缩写（缩写是「看不出这是什么」的根源） */
  label: string;
  /** 分组小标题 */
  group: '检测器' | '检测参数' | '显示';
}

interface NumberField extends BaseField {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  /** 单位后缀，画在输入框右侧 */
  unit: string;
}

interface RangeField extends BaseField {
  kind: 'range';
  min: number;
  max: number;
  step: number;
  /** 读数小数位 */
  digits: number;
}

interface BoolField extends BaseField {
  kind: 'bool';
}

interface SelectField extends BaseField {
  kind: 'select';
  options: ReadonlyArray<{ value: string; label: string }>;
  /** 每个选项被选中时的说明 */
  hints: Record<string, string>;
}

type Field = NumberField | RangeField | BoolField | SelectField;

const FIELDS = [
  {
    key: 'detector',
    kind: 'select',
    group: '检测器',
    label: '算法',
    options: (['yin', 'ai'] as Detector[]).map((d) => ({
      value: d,
      label: DETECTOR_LABELS[d],
    })),
    hints: {
      yin: '自写 YIN 算法 —— 快（毫秒级），适合单音素材；阈值越小越严格',
      ai: 'Spotify Basic Pitch —— 抗噪更好，每次约 4 秒；极短切片上可能不出结果，此时自动用 YIN 兜底',
    },
  },

  { key: 'threshold', kind: 'range', group: '检测参数', label: '阈值', min: 0.05, max: 0.2, step: 0.01, digits: 2 },

  { key: 'minHz', kind: 'number', group: '检测参数', label: '最低 Hz', min: 30, max: 200, step: 1, unit: 'Hz' },
  { key: 'maxHz', kind: 'number', group: '检测参数', label: '最高 Hz', min: 200, max: 4000, step: 1, unit: 'Hz' },

  { key: 'a4Hz', kind: 'number', group: '显示', label: 'A4 基准', min: 400, max: 480, step: 1, unit: 'Hz' },

  { key: 'showSolfege', kind: 'bool', group: '显示', label: '显示唱名' },
  { key: 'showCents', kind: 'bool', group: '显示', label: '显示音分' },
] as const satisfies ReadonlyArray<Field>;

/**
 * 编译期闸门：`FIELDS` 的 key 必须**穷尽** PitchSettings 的全部字段。
 *
 * 若有人往 PitchSettings 加了字段却忘了在 FIELDS 里登记，
 * 条件类型会退化为 `never`，赋值给 `true` 立即编译失败。
 */
type FieldKeys = (typeof FIELDS)[number]['key'];
type MissingKeys = Exclude<keyof PitchSettings, FieldKeys>;
const _ALL_FIELDS_COVERED: MissingKeys extends never ? true : never = true;
void _ALL_FIELDS_COVERED;

/** 分组顺序（渲染时按此顺序成块） */
const GROUP_ORDER = ['检测器', '检测参数', '显示'] as const;

/** 统一的参数行：`标签(72px) + 控件(flex-1) + 后缀(右对齐)`。
 *  三栏定宽让所有行左中右三列对齐 —— 挤的根源不是行数多，
 *  而是每行控件位置各不相同，眼睛要重新找。 */
function Row({
  label,
  children,
  suffix,
}: {
  label: string;
  children: React.ReactNode;
  suffix?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[72px] shrink-0 text-small text-label-muted">{label}</span>
      {children}
      <span className="w-[38px] shrink-0 text-right font-mono text-micro tabular-nums text-label-muted">
        {suffix}
      </span>
    </div>
  );
}

const NUM_CLS =
  'h-7 min-w-0 flex-1 rounded-sm bg-ink-950 px-2 font-mono text-small tabular-nums text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] transition-shadow focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]';

interface Props {
  value: PitchSettings;
  onChange(v: PitchSettings): void;
}

/**
 * PitchSettingsPanel —— 音高检测参数（装配面板右栏的折叠区内容）。
 *
 * ══ 布局取舍（两次迭代后的结论）══
 *
 * v1（原始）：每项独占一行、标签 `w-16`、裸 checkbox。约 300px 高，宽松但冗长。
 * v2：为压高度把「最低/最高 Hz」挤成一行、标签缩写、说明塞进 tooltip。
 *     **过度压缩** —— 一眼看不出哪个框是最低、哪个是最高。
 * v3（当前）：保留分组小标题与紧凑行高（约 210px，仍比 v1 短三成），
 *     但**每个参数都有完整、独立的标签行**，且渲染由 FIELDS 表驱动。
 *
 * 结论：省空间要省「重复的容器与装饰」，不能省「标签」。
 */
export function PitchSettingsPanel({ value, onChange }: Props) {
  const patch = (partial: Partial<PitchSettings>) =>
    onChange({ ...value, ...partial });

  /** 数字字段的逐项校验：区间 + 与关联字段的先后关系 */
  const commitNumber = (f: NumberField, raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (v < f.min || v > f.max) return;
    // 频率上下限必须保持 min < max，否则检测区间为空
    if (f.key === 'minHz' && v >= value.maxHz) return;
    if (f.key === 'maxHz' && v <= value.minHz) return;
    patch({ [f.key]: v } as Partial<PitchSettings>);
  };

  /** 渲染单个字段 —— switch 对 Field 联合穷尽，漏一种 kind 会编译报错 */
  const renderField = (f: Field): React.ReactNode => {
    switch (f.kind) {
      case 'select':
        return (
          <section key={f.key} className="flex flex-col gap-1.5">
            <h5 className="text-micro text-label-muted">{f.label}</h5>
            {/*
              检测器按钮**纵向排列、各占满宽**。
              横排两个按钮在 232px 的侧栏里每个只有 ~100px，
              长标签会被逐字折行（「YIN — 自写算法」折成三行）—— 比换行更糟。
              竖排后每个按钮 200px+，标签一行放得下。
            */}
            <div className="flex flex-col gap-1">
              {f.options.map((o) => {
                const on = String(value[f.key]) === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patch({ [f.key]: o.value } as unknown as Partial<PitchSettings>)
                    }
                    className={`h-7 rounded-sm px-2 text-left text-small font-medium transition-colors ${
                      on
                        ? 'bg-flame-600/25 text-flame-300 shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.5)]'
                        : 'bg-ink-800 text-label-muted hover:text-label-lo'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {/* 完整说明常驻显示，不藏进 tooltip —— 这是「参数别丢」的一部分 */}
            <p className="text-micro leading-relaxed text-label-faint">
              {f.hints[String(value[f.key])]}
            </p>
          </section>
        );

      case 'range': {
        const cur = value[f.key] as number;
        return (
          <Row key={f.key} label={f.label}>
            <div className="relative flex h-4 min-w-0 flex-1 items-center">
              <div className="pointer-events-none absolute inset-x-0 h-[3px] rounded-full bg-ink-800" />
              <div
                className="pointer-events-none absolute left-0 h-[3px] rounded-full bg-flame-500"
                style={{ width: `${((cur - f.min) / (f.max - f.min)) * 100}%` }}
              />
              <input
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={cur}
                aria-label={f.label}
                onChange={(e) => patch({ [f.key]: Number(e.target.value) } as Partial<PitchSettings>)}
                className="range-h relative z-10 h-4 w-full"
              />
            </div>
            <span className="shrink-0 text-right font-mono text-micro tabular-nums text-label-lo">
              {cur.toFixed(f.digits)}
            </span>
          </Row>
        );
      }

      case 'number':
        return (
          <Row key={f.key} label={f.label} suffix={f.unit}>
            <input
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={value[f.key] as number}
              aria-label={f.label}
              onChange={(e) => commitNumber(f, e.target.value)}
              className={NUM_CLS}
            />
          </Row>
        );

      case 'bool':
        return (
          <label
            key={f.key}
            className="flex cursor-pointer items-center gap-2 text-small text-label-muted transition-colors hover:text-label-lo"
          >
            <input
              type="checkbox"
              checked={value[f.key] as boolean}
              onChange={(e) => patch({ [f.key]: e.target.checked } as Partial<PitchSettings>)}
              className="h-3.5 w-3.5 shrink-0 accent-flame-400"
            />
            {f.label}
          </label>
        );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {GROUP_ORDER.map((g) => {
        const items = FIELDS.filter((f) => f.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} className="flex flex-col gap-2">
            <h4 className="text-micro uppercase tracking-[0.14em] text-label-faint">{g}</h4>
            {items.map(renderField)}
          </section>
        );
      })}

      <button
        type="button"
        onClick={() => onChange({ ...DEFAULTS })}
        className="h-7 shrink-0 rounded-sm text-small text-label-faint transition-colors hover:bg-ink-900 hover:text-label-lo"
      >
        恢复默认
      </button>
    </div>
  );
}
