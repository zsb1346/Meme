/**
 * 演奏模式视图（纯 props 驱动：状态与引擎全部由父级 useKeyMachineController 持有）。
 *
 * 空间策略（用户诉求：讨厌莫名其妙占空间的东西）：
 *   - 工具行压到单行 26px 控件：音域 / 半音键 / 声部 / 绑定 / 归位 / Take 选择器全部并列；
 *   - 键区**铺满可用宽度**，保留 7 列八度网格与行内弧线这两个签名手法；
 *   - 操作提示从独立段落降级为键区右下角的一行弱化文案。
 *
 * ══ 半音键开关的语义（2026-09-25 与用户第二次定稿）══
 *
 * 半音键**默认就在后台铺好了**（键集恒为从 C3 起的连续半音序列），
 * 这个开关只决定它们**显不显示**：
 *   · 关 → 键盘只摆白键（一个八度 7 个键）；
 *   · 开 → 黑键全部出现（一个八度 12 个键）。
 * 音域、键高、Take 里的音符一个都不动 —— 拨开关不会跑音。
 *
 * 所以「音域档位」的数字会随开关变化（7/14/21 ↔ 12/24/36），
 * 但**音域本身不变**：选「2 个八度」永远是 C3–B4，打开半音只是把它切得更细。
 */

import type { ReactNode } from 'react';
import type { Key, SampleId, Take, TakeId } from '../../model/types';
import {
  KEY_BASE_MIDI,
  isBlackMidi,
  keyRangePresets,
  midiNoteName,
  nextVisiblePitch,
  presetOctavesOfSpan,
  spanOfPresetOctaves,
  visibleKeyCount,
  visibleKeysInSpan,
} from '../../model/pitch-map';
import KeyLayout from '../keys/KeyLayout';
import MemeKey, { type MemeKeyPressResult } from '../keys/MemeKey';
import { Seg, Led } from '../ui/PageBar';
import { IconKeyboard, IconMinus, IconPlus, IconUndo, IconVolume } from '../ui/Icon';

/**
 * 音域分段选择器的选项：档位 = **八度数**（`'1'|'2'|'3'`），或「自定」（逐格步进）。
 *
 * ⚠️ 档位值**不是键数**，是八度数 —— 它是唯一一个**与半音键开关无关**的量。
 * 同一个 `'2'` 永远是 24 个半音格（C3–B4）；开关只决定这段音域在键盘上
 * 露出 14 个键（只摆白键）还是 24 个键。详见 `pitch-map.ts` 的 `KeyRangePreset`。
 */
export type CountOption = '1' | '2' | '3' | 'custom';

/**
 * 音域格数 → 选择器选项（「这段音域命中第几档预设」）。
 *
 * ⚠️ 判定**只看格数**、与开关无关 —— 这也是「拨开关时档位不会乱跳」的原因。
 * 旧的键数口径必须带模式判定（14 键在自然音下是「2 个八度」、在半音下什么都不是），
 * 那种「同一个数字在两种模式下含义不同」的设计正是上一版一切混乱的源头。
 */
export function countOptionOfSpan(span: number): CountOption {
  const octaves = presetOctavesOfSpan(span);
  return octaves === 1 || octaves === 2 || octaves === 3
    ? (String(octaves) as CountOption)
    : 'custom';
}

export interface PlayModeViewProps {
  keys: Key[];
  /** 音域**格数**（连续半音序列的长度），不是可见键数 */
  keyCount: number;
  /**
   * 半音键开关（显示/收起黑键）。**纯视图状态**：
   * 它只决定黑键摆不摆、以及「＋/−」要不要跳过黑键。
   *
   * ⛔ 它**不**决定键位矩阵的几何 —— 那是 `Key.pitchMidi` 的事。
   *    把几何交回给开关，就会出现「关掉开关后已存在的黑键被当白键、
   *    挤掉别的键的位置」（2026-09-25 用户实报，已修）。
   */
  semitoneEnabled: boolean;
  /** 各键音高（与下标同序）—— 钢琴布局的分组依据 */
  keyPitches?: number[];
  countOption: CountOption;
  onCountOption: (option: CountOption) => void;
  /** 「＋/−」步进器：改音域格数（不动已有键的音高；关闭半音键时自动跳过黑键） */
  onApplyKeyCount: (n: number) => void;
  onResetAll: () => void;
  prewarmReady: boolean;
  hasAnySound: boolean;
  cursors: number[];
  nameById: Map<SampleId, string>;
  onPress: ((keyIndex: number) => MemeKeyPressResult | null) | undefined;
  /* 声部 */
  voiceMode: 'audio' | 'synth';
  onVoiceModeChange: (mode: 'audio' | 'synth') => void;
  /** 半音键开关（省略则不渲染该控件） */
  onSemitoneChange?: (on: boolean) => void;
  /* Take 选择器 */
  takes: Take[];
  selectedTakeId: TakeId | null;
  onTakeChange: (id: TakeId | null) => void;
  /* 按键绑定 */
  bindingMode: boolean;
  onBindingModeChange: (on: boolean) => void;
  bindingTarget: number | null;
  onBindingTargetChange: (keyIndex: number | null) => void;
  bindings: Record<number, string>;
  /** 外部闪灯信号（键盘绑定触发时由父级传入） */
  lastFlash: { keyIndex: number; slotIndex: number; triggered: boolean } | null;
  /** 外部按压信号（键盘绑定触发时由父级传入） */
  lastPress: { keyIndex: number; pressed: boolean } | null;
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-[22px] w-[22px] place-items-center rounded-sm text-label-lo transition-colors hover:bg-ink-700 hover:text-label-hi disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export default function PlayModeView({
  keys,
  keyCount,
  semitoneEnabled,
  keyPitches,
  countOption,
  onCountOption,
  onApplyKeyCount,
  onResetAll,
  prewarmReady,
  hasAnySound,
  cursors,
  nameById,
  onPress,
  voiceMode,
  onVoiceModeChange,
  onSemitoneChange,
  takes,
  selectedTakeId,
  onTakeChange,
  bindingMode,
  onBindingModeChange,
  bindingTarget,
  onBindingTargetChange,
  bindings,
  lastFlash,
  lastPress,
}: PlayModeViewProps) {
  /** 键域起点音高（新工程恒为 C3；迁移过的老工程可能略有不同） */
  const baseMidi = keyPitches?.[0] ?? KEY_BASE_MIDI;
  /** 键盘上**实际能看到的**键数（关闭半音键 = 只数白键） */
  const visibleCount = visibleKeyCount(keyPitches ?? [], semitoneEnabled);
  /**
   * 还能不能再扩一格 = 「音域顶端之后还有可见的音」。
   *
   * ⚠️ 关闭半音键时必须问 `nextVisiblePitch`（它会跳过黑键），不能用
   * 「格数 < 61」当条件 —— 否则「＋」会把音域扩到一个**看不见的**黑键上，
   * 用户连点几次键盘毫无变化。
   */
  const topPitchMidi = keyPitches && keyPitches.length > 0 ? keyPitches[keyPitches.length - 1] : null;
  const nextPitch = nextVisiblePitch(topPitchMidi, semitoneEnabled);
  const canAddKey = nextPitch !== null;
  /** 键盘里是否真的有半音键（决定提示文案，与开关无关） */
  const hasBlackKey = (keyPitches ?? []).some((p) => isBlackMidi(p));
  return (
    <>
      {/* ---- 工具行：单行 26px，全部并列 ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-small text-label-muted">音域</span>
        <Seg
          label="音域"
          size="sm"
          value={countOption}
          onChange={(v) => {
            onCountOption(v);
            if (v === 'custom') return;
            /*
              档位存的是**八度数** → 换算成音域**格数**（12 × 八度）。
              这一步与半音键开关**无关** —— 所以拨开关不会让音域跳动，
              这也是旧版「音域漂移」bug 结构性消失的原因。
            */
            const n = spanOfPresetOctaves(Number(v));
            if (n !== null) onApplyKeyCount(n);
          }}
          options={[
            ...keyRangePresets().map((p) => ({
              value: String(p.octaves) as CountOption,
              /* 标签写**当前可见的键数**：关掉半音键就是 7/14/21，打开就是 12/24/36 */
              label: `${visibleKeysInSpan(p.span, semitoneEnabled)} 键`,
              title:
                `${p.octaves} 个八度 · ${midiNoteName(baseMidi)}–${midiNoteName(baseMidi + p.span - 1)}` +
                `（半音键${semitoneEnabled ? '开' : '关'}：${visibleKeysInSpan(p.span, semitoneEnabled)} / ${p.span} 键）`,
            })),
            {
              value: 'custom' as CountOption,
              label: '自定',
              title: '自定音域：用 ＋/− 逐格调整（半音键收起时会自动跳过一个八度里的黑键）',
            },
          ]}
        />
        {countOption === 'custom' && (
          <span className="flex items-center gap-0.5 rounded-sm bg-ink-950 px-1 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            <IconBtn
              label="缩小音域"
              onClick={() => onApplyKeyCount(keyCount - 1)}
              disabled={keyCount <= 1}
            >
              <IconMinus size={13} />
            </IconBtn>
            <span
              className="w-7 text-center font-mono text-small tabular-nums text-label-hi"
              title={
                `音域 ${midiNoteName(baseMidi)}–${midiNoteName(baseMidi + keyCount - 1)}` +
                `（${visibleCount} 个键可用）`
              }
            >
              {visibleCount}
            </span>
            <IconBtn
              label={
                canAddKey
                  ? `扩大音域（下一个是 ${midiNoteName(nextPitch!)}）`
                  : `已到最高音 ${midiNoteName(topPitchMidi ?? KEY_BASE_MIDI)}，不能再扩`
              }
              onClick={() => onApplyKeyCount(keyCount + 1)}
              disabled={!canAddKey}
            >
              <IconPlus size={13} />
            </IconBtn>
          </span>
        )}

        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

        {/*
          半音键开关：**纯视图开关** —— 黑键本来就在后台铺好了，
          这里只决定摆不摆它们。键集、音域、音符一律不动（关掉再打开不跑音）。
        */}
        <button
          type="button"
          onClick={() => onSemitoneChange?.(!semitoneEnabled)}
          aria-pressed={semitoneEnabled}
          title={
            semitoneEnabled
              ? '半音键已显示（每八度 12 键）。关掉只是把黑键收起来，音域与已装的素材都不变'
              : '半音键已收起（每八度 7 个白键）。打开即出现全部黑键 —— 它们一直就在，不需要手动添加'
          }
          className={`flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-small font-medium transition-colors ${
            semitoneEnabled
              ? 'bg-flame-600/25 text-flame-200'
              : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
          }`}
        >
          半音键
        </button>

        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

        <span className="text-small text-label-muted">声部</span>
        <Seg
          label="声部"
          size="sm"
          value={voiceMode}
          onChange={onVoiceModeChange}
          options={[
            { value: 'audio', label: '采样' },
            { value: 'synth', label: '电子音' },
          ]}
        />

        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />

        <button
          type="button"
          onClick={() => onBindingModeChange(!bindingMode)}
          aria-pressed={bindingMode}
          className={`flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-small font-medium transition-colors ${
            bindingMode
              ? 'bg-success/20 text-success'
              : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
          }`}
        >
          <IconKeyboard size={13} />
          {bindingMode ? '绑定中…' : '按键绑定'}
        </button>

        <button
          type="button"
          onClick={onResetAll}
          title="把所有键的游标拨回第 1 格"
          className="flex h-[26px] items-center gap-1.5 rounded-sm px-2 text-small font-medium text-label-lo transition-colors hover:bg-ink-800 hover:text-label-hi"
        >
          <IconUndo size={13} />
          游标归位
        </button>

        <span className="min-w-2 flex-1" />

        {/* Take 选择器：与工具同排，不再独占一行 */}
        {takes.length > 0 && (
          <label className="flex items-center gap-1.5">
            <span className="text-small text-label-muted">Take</span>
            <select
              value={selectedTakeId ?? ''}
              onChange={(e) => onTakeChange(e.target.value || null)}
              aria-label="演奏 Take"
              className="h-[26px] max-w-[220px] rounded-sm bg-ink-950 px-1.5 text-small text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)] [&>option]:bg-ink-900"
            >
              {takes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.events.length} 音）
                </option>
              ))}
            </select>
          </label>
        )}

        {hasAnySound && (
          <span className="flex items-center gap-1.5">
            <Led tone={prewarmReady ? 'ok' : 'accent'} on breathe={!prewarmReady} />
            <span
              className={`font-mono text-tiny ${
                prewarmReady ? 'text-label-muted' : 'text-flame-300'
              }`}
            >
              {prewarmReady ? '就绪' : '预热'}
            </span>
          </span>
        )}
      </div>

      {/* ---- 按键绑定提示 ---- */}
      {bindingMode && (
        <p className="mb-2 text-center text-small text-success">
          {bindingTarget !== null
            ? `请按键盘键绑定「${keys[bindingTarget]?.label ?? ''}」，Esc 取消`
            : '点击一个音符按钮开始绑定，Esc 退出'}
        </p>
      )}

      {/* ---- 键盘区域（铺满宽度） ---- */}
      <KeyLayout
        keyCount={keyCount}
        keyPitches={keyPitches}
        /* 半音键收起时**不摆黑键**（键还在数据里，只是不给按） */
        hideBlackKeys={!semitoneEnabled}
        renderKey={(i) => {
          const k = keys[i];
          if (!k) return null;
          const isBindingTarget = bindingTarget === i;
          const boundKey = bindings[i];
          return (
            <MemeKey
              keyIndex={i}
              label={k.label}
              /* 黑键由**音高**决定，与半音开关无关：一个键是黑键就永远摆黑键位置 */
              black={isBlackMidi(keyPitches?.[i] ?? 0)}
              slotNames={k.sequence.map((r) => r.sampleId ? (nameById.get(r.sampleId) ?? '未知素材') : '未装配')}
              cursor={cursors[i] ?? 0}
              interactive={bindingMode || onPress !== undefined}
              onPress={
                bindingMode
                  ? () => {
                      onBindingTargetChange(i);
                      return null;
                    }
                  : onPress
                    ? () => onPress(i)
                    : undefined
              }
              extraBadge={bindingMode ? (boundKey ?? (isBindingTarget ? '…' : '')) : undefined}
              externalFlash={
                lastFlash?.keyIndex === i
                  ? { slotIndex: lastFlash.slotIndex, triggered: lastFlash.triggered }
                  : null
              }
              externalPress={lastPress?.keyIndex === i ? lastPress.pressed : undefined}
            />
          );
        }}
      />

      {/* 提示：弱化到一行，不再独占段落。
          第一段必须描述**键盘此刻实际长什么样**（半音键开着才有深色键），
          不能照着「有没有黑键这个东西」写 —— 收起黑键后说「深色键 = 半音键」
          会让用户满屏找一个根本不存在的深色键。 */}
      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-tiny text-label-faint">
        <IconVolume size={12} />
        {semitoneEnabled && hasBlackKey
          ? '深色键 = 半音键'
          : '每排七个白键 = 一个八度（半音键已收起）'}
        <span className="text-label-faint/60">·</span>
        连按循环播放
        <span className="text-label-faint/60">·</span>
        多指同按没问题
      </p>
    </>
  );
}
