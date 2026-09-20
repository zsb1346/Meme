/**
 * 编辑模式矩阵视图（自 StagePage 编辑块抽出，className 逐字节一致）：
 *
 *  - 键 × 槽位横向滚动矩阵：填充格 = 色相芯片（含时长），尾随 ＋ 装入，
 *    行操作 = ▶ 预览 / ＋ 加槽 / − 删末槽 / ↺ 游标归位；
 *  - 纯 props 驱动；所有 store 写入由父级回调完成。
 */
import type { Key, SampleId } from '../../model/types';

/** 由素材 id 稳定散列出色相（0..359），用于芯片着色 —— 同一素材全站同色 */
function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function formatDuration(sec: number): string {
  return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

const CHIP_BASE =
  'flex h-12 w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border px-1 text-[11px] leading-tight transition';

function IconBtn({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-7 w-7 items-center justify-center rounded-lg border text-xs transition',
        disabled
          ? 'cursor-not-allowed border-ink-700 text-slate-600'
          : active
            ? 'border-flame-400 bg-flame-500/20 text-flame-300'
            : 'border-ink-600 bg-ink-800 text-slate-300 hover:border-flame-500/40 hover:text-flame-300',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export interface EditMatrixViewProps {
  keys: Key[];
  nameById: Map<SampleId, string>;
  sampleDurationById: Map<SampleId, number>;
  colCount: number;
  previewingKey: number | null;
  hasAnySound: boolean;
  onSlotClick(keyIndex: number, slotIndex: number): void;
  onAppendClick(keyIndex: number): void;
  onPreviewRow(keyIndex: number): void;
  onRemoveLast(keyIndex: number): void;
  onResetRow(keyIndex: number): void;
}

export default function EditMatrixView({
  keys,
  nameById,
  sampleDurationById,
  colCount,
  previewingKey,
  hasAnySound,
  onSlotClick,
  onAppendClick,
  onPreviewRow,
  onRemoveLast,
  onResetRow,
}: EditMatrixViewProps) {
  return (
    <div className="mt-4 rounded-2xl border border-ink-700 bg-ink-900/70 p-3 md:p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-slate-100">键 × 序列矩阵</h2>
        <p className="text-[11px] text-slate-500">
          点「＋」装入声音 · 点已有格子试听 / 替换 / 清空 · 改动即时保存并同步到演奏
        </p>
      </div>

      {keys.map((key, ki) => {
        const len = key.sequence.length;
        return (
          <div
            key={key.id}
            className="flex items-center gap-2 border-b border-ink-800 py-2 last:border-b-0"
          >
            {/* 行头 */}
            <div className="w-14 shrink-0 md:w-20">
              <div className="truncate text-sm font-semibold text-slate-200">{key.label}</div>
              <div className="text-[10px] tabular-nums text-slate-500">{len} 槽</div>
            </div>

            {/* 槽位横向滚动区 */}
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-0.5">
              {Array.from({ length: colCount }, (_, si) => {
                const ref = key.sequence[si];
                if (ref) {
                  const hue = hashHue(ref.sampleId);
                  const name = nameById.get(ref.sampleId) ?? '未知素材';
                  const dur = sampleDurationById.get(ref.sampleId) ?? 0;
                  return (
                    <button
                      key={si}
                      type="button"
                      title={`${name} · 第 ${si + 1} 格`}
                      onClick={() => onSlotClick(ki, si)}
                      className={`${CHIP_BASE} hover:brightness-125`}
                      style={{
                        backgroundColor: `hsl(${hue} 42% 18%)`,
                        borderColor: `hsl(${hue} 45% 32%)`,
                        color: `hsl(${hue} 75% 78%)`,
                      }}
                    >
                      <span className="text-[9px] opacity-70">{si + 1}</span>
                      <span className="max-w-[72px] truncate">{name}</span>
                      <span className="text-[9px] opacity-60">{formatDuration(dur)}</span>
                    </button>
                  );
                }
                if (si === len) {
                  return (
                    <button
                      key={si}
                      type="button"
                      title={`给「${key.label}」的第 ${si + 1} 格装声音`}
                      onClick={() => onAppendClick(ki)}
                      className={`${CHIP_BASE} border-dashed border-ink-600 bg-ink-800/60 text-slate-400 hover:border-flame-500/50 hover:text-flame-300`}
                    >
                      <span className="text-base leading-none">＋</span>
                    </button>
                  );
                }
                return (
                  <span
                    key={si}
                    aria-hidden="true"
                    className={`${CHIP_BASE} border-transparent text-ink-600`}
                  >
                    ·
                  </span>
                );
              })}
            </div>

            {/* 行操作 */}
            <div className="flex shrink-0 items-center gap-1">
              <IconBtn
                label={previewingKey === ki ? '停止预览' : '按顺序预览整行'}
                onClick={() => onPreviewRow(ki)}
                active={previewingKey === ki}
              >
                {previewingKey === ki ? '■' : '▶'}
              </IconBtn>
              <IconBtn label="在末尾加一个槽位" onClick={() => onAppendClick(ki)}>
                ＋
              </IconBtn>
              <IconBtn label="移除最后一个槽位" onClick={() => onRemoveLast(ki)} disabled={len === 0}>
                −
              </IconBtn>
              <IconBtn label="游标拨回第 1 格" onClick={() => onResetRow(ki)} disabled={len === 0}>
                ↺
              </IconBtn>
            </div>
          </div>
        );
      })}

      {!hasAnySound && (
        <p className="mt-3 rounded-xl border border-dashed border-ink-600 bg-ink-800/40 px-3 py-2.5 text-center text-[11px] leading-relaxed text-slate-500">
          还没有任何键装上声音 —— 点任意行的「＋」，从素材箱挑一段切片装进来。
        </p>
      )}
    </div>
  );
}
