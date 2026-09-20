/**
 * 演奏模式视图（纯 props 驱动：状态与引擎全部由父级 useKeyMachineController 持有）。
 *
 * 空间策略（用户诉求：讨厌莫名其妙占空间的东西）：
 *   - 工具行压到单行 26px 控件：键数 / 声部 / 绑定 / 归位 / Take 选择器全部并列，
 *     不再分两行，不再用「胶囊 + 发光」的重装饰。
 *   - 键区改为**铺满可用宽度**（旧实现 max-width:900px 让大屏两侧大片空荡），
 *     但保留 7 列八度网格与行内轻微弧线这两个签名手法。
 *   - 操作提示从独立段落降级为键区右下角的一行弱化文案。
 *
 * 含：键数选择 7/14/21/自定义(1–28 逐键步进)、声部切换、Take 选择器、
 * 按键绑定模式、全部游标归位、KeyLayout 七列八度网格 + MemeKey。
 */

import type { ReactNode } from 'react';
import type { Key, SampleId, Take, TakeId } from '../../model/types';
import KeyLayout from '../keys/KeyLayout';
import MemeKey, { type MemeKeyPressResult } from '../keys/MemeKey';
import { Seg, Led } from '../ui/PageBar';
import { IconKeyboard, IconMinus, IconPlus, IconUndo, IconVolume } from '../ui/Icon';

/** 键数分段选择器选项（八度制预设 + 自定义逐键步进） */
export type CountOption = '7' | '14' | '21' | 'custom';

export interface PlayModeViewProps {
  keys: Key[];
  keyCount: number;
  countOption: CountOption;
  onCountOption: (option: CountOption) => void;
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
  return (
    <>
      {/* ---- 工具行：单行 26px，全部并列 ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-small text-label-muted">键数</span>
        <Seg
          label="键数"
          size="sm"
          value={countOption}
          onChange={(v) => {
            onCountOption(v);
            if (v !== 'custom') onApplyKeyCount(Number(v));
          }}
          options={[
            { value: '7', label: '7' },
            { value: '14', label: '14' },
            { value: '21', label: '21' },
            { value: 'custom', label: '自定' },
          ]}
        />
        {countOption === 'custom' && (
          <span className="flex items-center gap-0.5 rounded-sm bg-ink-950 px-1 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            <IconBtn
              label="减少一个键"
              onClick={() => onApplyKeyCount(Math.max(1, keyCount - 1))}
              disabled={keyCount <= 1}
            >
              <IconMinus size={13} />
            </IconBtn>
            <span className="w-7 text-center font-mono text-small tabular-nums text-label-hi">
              {keyCount}
            </span>
            <IconBtn
              label="增加一个键"
              onClick={() => onApplyKeyCount(Math.min(28, keyCount + 1))}
              disabled={keyCount >= 28}
            >
              <IconPlus size={13} />
            </IconBtn>
          </span>
        )}

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
        renderKey={(i) => {
          const k = keys[i];
          if (!k) return null;
          const isBindingTarget = bindingTarget === i;
          const boundKey = bindings[i];
          return (
            <MemeKey
              keyIndex={i}
              label={k.label}
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

      {/* 提示：弱化到一行，不再独占段落 */}
      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-tiny text-label-faint">
        <IconVolume size={12} />
        每排七个键 = 一个八度
        <span className="text-label-faint/60">·</span>
        连按循环播放
        <span className="text-label-faint/60">·</span>
        多指同按没问题
      </p>
    </>
  );
}
