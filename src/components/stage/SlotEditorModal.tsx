/**
 * 槽位编辑弹层（自 StagePage L717-851 抽出，className 逐字节一致）：
 *
 *  - picking=true  → 素材箱挑选列表；
 *  - picking=false → 当前槽位详情（试听 / 替换 / 清空）。
 *
 * 纯 props 驱动：Esc 关闭 + 点击蒙层关闭由父级 useEffect 处理。
 */
import type { Key, Sample, SampleId } from '../../model/types';
import { EmptyState } from '../ui/EmptyState';

/** 由素材 id 稳定散列出色相（0..359），芯片着色同源 */
function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function formatDuration(sec: number): string {
  return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

export interface EditorTarget {
  keyIndex: number;
  slotIndex: number;
  picking: boolean;
}

export interface SlotEditorModalProps {
  editor: EditorTarget;
  editorKey: Key;
  samples: Sample[];
  onClose(): void;
  onPick(sampleId: SampleId): void;
  onAudition(sampleId: SampleId): void;
  onSwitchToPicking(): void;
}

export default function SlotEditorModal({
  editor,
  editorKey,
  samples,
  onClose,
  onPick,
  onAudition,
  onSwitchToPicking,
}: SlotEditorModalProps) {
  const ref = editorKey.sequence[editor.slotIndex];
  const sample = ref ? samples.find((x) => x.id === ref.sampleId) : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="槽位编辑"
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-h-[70dvh] w-full overflow-y-auto rounded-t-2xl border border-ink-600 bg-ink-900 p-4 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            键「{editorKey.label}」 ·{' '}
            {editor.picking
              ? editor.slotIndex >= editorKey.sequence.length
                ? `装入第 ${editor.slotIndex + 1} 格`
                : `替换第 ${editor.slotIndex + 1} 格`
              : `第 ${editor.slotIndex + 1} 格`}
          </h3>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-ink-600 text-sm text-slate-400 transition hover:border-flame-500/40 hover:text-flame-300"
          >
            ✕
          </button>
        </div>

        {editor.picking ? (
          samples.length === 0 ? (
            <EmptyState
              className="my-2"
              title="素材箱还是空的"
              description="先去「素材箱」上传切片，或到「切割」页切出素材，再回来装配。"
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {samples.map((s) => {
                const hue = hashHue(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onPick(s.id)}
                      className="flex w-full items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-800 px-3 py-2 text-left transition hover:border-flame-500/40"
                    >
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `hsl(${hue} 60% 55%)` }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-slate-200">{s.name}</span>
                        <span className="block text-[10px] text-slate-500">
                          {formatDuration(s.durationSec)} ·{' '}
                          {s.detectedPitchHz ? `${Math.round(s.detectedPitchHz)} Hz` : '未检出音高'}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] text-flame-300">装入 ›</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : !ref ? (
          <div className="py-4 text-center">
            <p className="text-xs text-slate-500">这一格还空着。</p>
            <button
              type="button"
              onClick={onSwitchToPicking}
              className="mt-3 rounded-full bg-flame-500 px-4 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-flame-400"
            >
              从素材箱装入
            </button>
          </div>
        ) : (
          <>
            <div
              className="mb-3 rounded-xl border px-3 py-2.5"
              style={{
                backgroundColor: `hsl(${hashHue(ref.sampleId)} 42% 16%)`,
                borderColor: `hsl(${hashHue(ref.sampleId)} 45% 30%)`,
              }}
            >
              <p
                className="truncate text-sm font-medium"
                style={{ color: `hsl(${hashHue(ref.sampleId)} 75% 78%)` }}
              >
                {sample?.name ?? '未知素材'}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {sample ? formatDuration(sample.durationSec) : '—'} ·{' '}
                {sample?.detectedPitchHz
                  ? `检测音高 ${Math.round(sample.detectedPitchHz)} Hz`
                  : '未检出音高'}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => onAudition(ref.sampleId)}
                className="rounded-xl border border-ink-600 bg-ink-800 py-2 text-xs text-slate-200 transition hover:border-flame-500/40 hover:text-flame-300"
              >
                ♪ 试听
              </button>
              <button
                type="button"
                onClick={onSwitchToPicking}
                className="rounded-xl border border-ink-600 bg-ink-800 py-2 text-xs text-slate-200 transition hover:border-flame-500/40 hover:text-flame-300"
              >
                ⇄ 替换
              </button>
              <button
                type="button"
                onClick={() => onPick(ref.sampleId)}
                className="rounded-xl border border-red-900/60 bg-red-950/30 py-2 text-xs text-red-300 transition hover:border-red-700 hover:text-red-200"
              >
                ✕ 清空
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
