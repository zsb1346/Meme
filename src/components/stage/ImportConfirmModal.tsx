/**
 * 导入确认弹窗——拖入 .zip 后弹出，展示包信息供用户二次确认。
 * 样式与 ExportDialog 同族（glass-raised 面板）。
 */
import { Modal } from '../ui/Modal';
import type { LoadedPack } from '../../model/instrument-pack';

interface Props {
  pack: LoadedPack;
  onConfirm(): void;
  onCancel(): void;
}

export default function ImportConfirmModal({ pack, onConfirm, onCancel }: Props) {
  const { project } = pack;
  const sampleCount = project.samples.length;
  const keyCount = project.keys.length;

  return (
    <Modal
      open
      onClose={onCancel}
      title="导入乐器包"
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-ink-600 bg-ink-800 px-4 py-1.5 text-xs text-slate-300 transition hover:border-flame-500/40 hover:text-slate-100 active:scale-[0.97]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-flame-500 px-5 py-1.5 text-xs font-semibold text-ink-950 shadow-[0_0_16px_rgb(var(--flame-500)_/_0.4)] transition active:scale-[0.97]"
          >
            确认载入
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-widest text-slate-500">工程</span>
          <span className="font-medium text-slate-100">{project.name || '未命名'}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-widest text-slate-500">素材</span>
          <span>{sampleCount} 个</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-widest text-slate-500">键位</span>
          <span>{keyCount} 个</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          载入后当前演奏台将被替换，旧录音不保留。
        </p>
      </div>
    </Modal>
  );
}
