/**
 * MIDI 导入确认弹窗 —— 「导入前先说清楚这首歌长什么样」。
 *
 * ══ 为什么需要这一步（2026-09-25）══
 *
 * 旧流程是一步到底：选文件 → 直接落进工程 → 一句 toast「已导入 N 个音符」。
 * 用户看不到、也无法阻止下面这些事：
 *   · 文件里有 3 条轨，音符是从哪几条合并来的；
 *   · 音域超出了当前键盘，工程音域被**自动改大**；
 *   · 有 48 个音落在黑键上，而「半音键」开关是关着的
 *     —— 这批音在键盘上**没有可点的位置**（用户只能听，弹不出来）；
 *   · 有若干个音被静默丢掉（太短 / 超出键域）；
 *   · 超过 2000 个音符的部分被截断。
 *
 * 这些都不是错误，但都是**用户有权知道、并且有权改变**的事。
 * 所以导入拆成两段：解析 → 这个弹窗 → 确认落盘。
 *
 * ══ 实时预览 ══
 *
 * 勾选轨道的变化会**实时重算摘要**（重跑一遍纯函数 `midiToTakeEvents`）——
 * 不另写一套统计逻辑，弹窗里显示的数字与实际落盘的结果必然一致。
 */
import { useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import type { ParsedMidiFile } from '../../engine/midi-import';
import { midiToTakeEvents } from '../../model/midi-import';
import {
  KEY_DOMAIN_MAX_COUNT,
  midiNoteName,
} from '../../model/pitch-map';
import { formatTime } from '../../utils/format';

export interface MidiImportModalProps {
  parsed: ParsedMidiFile;
  /** 当前音域格数（= 键集长度） */
  keyCount: number;
  /** 键域起点音高 */
  baseMidi: number;
  /** 「半音键」当前是否显示 */
  semitoneEnabled: boolean;
  onCancel(): void;
  onConfirm(trackIndices: number[]): void;
}

export default function MidiImportModal({
  parsed,
  keyCount,
  baseMidi,
  semitoneEnabled,
  onCancel,
  onConfirm,
}: MidiImportModalProps) {
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(parsed.defaultTrackIndices),
  );

  /* 勾选集合 → 有序下标数组；集合只用于 UI 的 O(1) 判断 */
  const pickedIndices = useMemo(() => [...picked].sort((a, b) => a - b), [picked]);

  /* 摘要与实际落盘走**同一个函数**，弹窗里的数字不可能与结果不一致 */
  const { summary } = useMemo(
    () => midiToTakeEvents(parsed.midi, { keyCount, baseMidi, trackIndices: pickedIndices }),
    [parsed.midi, keyCount, baseMidi, pickedIndices],
  );

  const willExtend = summary.neededLanes > keyCount;
  const needSemitone = summary.blackKeyEvents > 0;
  const willEnableSemitone = needSemitone && !semitoneEnabled;
  const dropped = summary.tooShort + summary.belowRange + summary.aboveRange + summary.truncated;
  const hasRange = summary.keptEvents > 0;
  /** 举例用的音名（取歌里最高的那个音） */
  const exNote = hasRange ? midiNoteName(summary.maxMidi) : 'G4';

  const toggle = (index: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title="导入 MIDI"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="h-ctl-sm rounded-sm border border-ink-600 bg-ink-800 px-3 text-small text-label-lo transition-colors hover:border-flame-500/40 hover:text-label-hi"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!hasRange}
            onClick={() => onConfirm(pickedIndices)}
            className="h-ctl-sm rounded-sm bg-flame-400 px-3 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-label-faint"
          >
            {hasRange ? `导入 ${summary.keptEvents} 个音` : '没有可用音符'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="truncate text-small text-label-muted" title={parsed.takeName}>
          {parsed.takeName}
        </p>

        {/* ── 这首歌 ── */}
        <Section title="这首歌">
          <Stat label="音符" value={`${summary.keptEvents} 个`} />
          <Stat label="时长" value={formatTime(summary.durationSec)} />
          <Stat label="速度" value={`${Math.round(summary.bpm)} BPM`} />
          <Stat
            label="音域"
            value={
              hasRange
                ? `${midiNoteName(summary.minMidi)}–${midiNoteName(summary.maxMidi)}（${summary.maxMidi - summary.minMidi + 1} 个半音）`
                : '—'
            }
          />
          <Stat
            label="半音音符"
            value={
              needSemitone
                ? `${summary.blackKeyEvents} 个（${Math.round(
                    (summary.blackKeyEvents / Math.max(1, summary.keptEvents)) * 100,
                  )}%）`
                : '0 个'
            }
            tone={needSemitone ? 'warn' : undefined}
          />
        </Section>

        {/* ── 音域条：这首歌落在键域的哪一段 ── */}
        {hasRange && (
          <div className="space-y-1">
            <div className="relative h-3 w-full overflow-hidden rounded-[3px] bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
              {/* 现有键盘 */}
              <div
                className="absolute inset-y-0 left-0 bg-ink-700"
                style={{ width: `${(keyCount / KEY_DOMAIN_MAX_COUNT) * 100}%` }}
                title={`当前键盘：${keyCount} 个半音格`}
              />
              {/* 扩到能装下之后 */}
              {willExtend && (
                <div
                  className="absolute inset-y-0 bg-flame-600/30"
                  style={{
                    left: `${(keyCount / KEY_DOMAIN_MAX_COUNT) * 100}%`,
                    width: `${((summary.neededLanes - keyCount) / KEY_DOMAIN_MAX_COUNT) * 100}%`,
                  }}
                  title={`将自动扩到 ${summary.neededLanes} 个半音格`}
                />
              )}
              {/* 歌曲实际音域 */}
              <div
                className="absolute inset-y-[3px] rounded-[2px] bg-flame-400"
                style={{
                  left: `${(Math.max(0, summary.minMidi - baseMidi) / KEY_DOMAIN_MAX_COUNT) * 100}%`,
                  width: `${((summary.maxMidi - summary.minMidi + 1) / KEY_DOMAIN_MAX_COUNT) * 100}%`,
                }}
                title={`歌曲音域 ${midiNoteName(summary.minMidi)}–${midiNoteName(summary.maxMidi)}`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-label-faint">
              <Legend className="bg-ink-700" text={`当前键盘 ${keyCount} 格`} />
              {willExtend && (
                <Legend
                  className="bg-flame-600/50"
                  text={`导入后自动扩到 ${summary.neededLanes} 格`}
                />
              )}
              <Legend
                className="bg-flame-400"
                text={`歌曲音域 ${midiNoteName(summary.minMidi)}–${midiNoteName(summary.maxMidi)}`}
              />
              <span className="ml-auto font-mono tabular-nums">
                {midiNoteName(baseMidi)} – {midiNoteName(baseMidi + KEY_DOMAIN_MAX_COUNT - 1)}
              </span>
            </div>
          </div>
        )}

        {/* ── 会自动做的两件事 ── */}
        {(willExtend || willEnableSemitone) && (
          <Section title="导入时会自动调整">
            {willExtend && (
              <Stat
                label="键盘音域"
                value={`${keyCount} → ${summary.neededLanes} 个半音格`}
                tone="warn"
              />
            )}
            {willEnableSemitone && (
              <Stat
                label="半音键"
                value={`收起 → 显示（${summary.blackKeyEvents} 个音要落在黑键上）`}
                tone="warn"
              />
            )}
          </Section>
        )}

        {/* ── 轨道 ── */}
        <Section title={`轨道（已选 ${pickedIndices.length} / ${parsed.tracks.length}）`}>
          <div className="w-full space-y-0.5">
            {parsed.tracks.map((t) => {
              const empty = t.usable === 0;
              const on = picked.has(t.index);
              return (
                <label
                  key={t.index}
                  title={
                    empty
                      ? t.noteCount === 0
                        ? '这条轨没有音符'
                        : `这条轨的 ${t.noteCount} 个音符都短于阈值`
                      : undefined
                  }
                  className={`flex items-center gap-2 rounded-sm px-1.5 py-1 text-small transition-colors ${
                    empty ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-ink-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="accent-flame-500"
                    checked={on}
                    disabled={empty}
                    onChange={() => toggle(t.index)}
                  />
                  <span className="min-w-0 flex-1 truncate text-label-hi">{t.name}</span>
                  <span className="shrink-0 text-tiny text-label-faint">{t.instrument}</span>
                  <span className="shrink-0 font-mono text-tiny tabular-nums text-label-lo">
                    {t.usable} 音
                  </span>
                  <span className="w-[86px] shrink-0 text-right font-mono text-tiny tabular-nums text-label-faint">
                    {t.minMidi !== null && t.maxMidi !== null
                      ? `${midiNoteName(t.minMidi)}–${midiNoteName(t.maxMidi)}`
                      : '—'}
                  </span>
                </label>
              );
            })}
          </div>
        </Section>

        {/* ── 会丢掉的 ── */}
        {dropped > 0 && (
          <Section title={`会有 ${dropped} 个音进不来`}>
            {summary.tooShort > 0 && (
              <Stat label="太短" value={`${summary.tooShort} 个（短于 0.05 秒的碎音）`} />
            )}
            {summary.belowRange > 0 && (
              <Stat
                label="太低"
                value={`${summary.belowRange} 个（低于 ${midiNoteName(baseMidi)}，键盘够不着）`}
                tone="warn"
              />
            )}
            {summary.aboveRange > 0 && (
              <Stat
                label="太高"
                value={`${summary.aboveRange} 个（高于 ${midiNoteName(baseMidi + KEY_DOMAIN_MAX_COUNT - 1)}，已是音域上限）`}
                tone="warn"
              />
            )}
            {summary.truncated > 0 && (
              <Stat label="超出上限" value={`${summary.truncated} 个（单次最多 2000 个音）`} tone="warn" />
            )}
          </Section>
        )}

        <p className="text-micro leading-relaxed text-label-faint">
          {`音名与实际发声严格一致：一个 ${exNote} 的音，就落在标签写着 ${exNote} 的键上。`}
        </p>
      </div>
    </Modal>
  );
}

/** 图例：色块 + 说明（音域条下方，让三种颜色各自有名字） */
function Legend({ className, text }: { className: string; text: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" className={`h-2 w-2 rounded-[1px] ${className}`} />
      {text}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-sm bg-ink-950/60 px-2.5 py-2 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
      <p className="mb-1.5 text-micro uppercase tracking-widest text-label-faint">{title}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn';
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-tiny text-label-muted">{label}</span>
      <span
        className={`font-mono text-tiny tabular-nums ${
          tone === 'warn' ? 'text-warning' : 'text-label-hi'
        }`}
      >
        {value}
      </span>
    </span>
  );
}
