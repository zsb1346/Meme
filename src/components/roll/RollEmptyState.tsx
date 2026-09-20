import { useRef } from 'react';

export interface RollEmptyStateProps {
  onImportMidi(file: File): void;
  onGoRecord(): void;
  importing: boolean;
}

export function RollEmptyState({
  onImportMidi,
  onGoRecord,
  importing,
}: RollEmptyStateProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="text-center">
        <p className="text-sm text-slate-300">钢琴卷帘还空着</p>
        <p className="mt-1 text-xs text-slate-500">
          导入一段 MIDI 骨架，或现场录制演奏
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={importing}
          onClick={() => inputRef.current?.click()}
          className="flex min-h-[48px] items-center gap-2 rounded-xl border border-flame-500/60 bg-flame-500/15 px-6 text-sm font-medium text-flame-300 transition hover:bg-flame-500/25 active:scale-[0.98] disabled:opacity-50"
        >
          {importing ? '解析中…' : '导入 MIDI'}
        </button>
        <button
          type="button"
          onClick={onGoRecord}
          className="flex min-h-[48px] items-center gap-2 rounded-xl border border-ink-600 bg-ink-800 px-6 text-sm text-slate-300 transition hover:border-flame-500/40 hover:text-flame-200 active:scale-[0.98]"
        >
          录制演奏
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportMidi(f);
          e.target.value = ''; // 允许重复选同一文件
        }}
      />
    </div>
  );
}
