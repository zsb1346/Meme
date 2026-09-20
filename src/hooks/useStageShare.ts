/**
 * 演奏台分享：导入/导出 + 确认流。
 * 拖拽只挂在 StagePage 的 <section> 上，不做全局监听。
 * 导入后：整体替换演奏台，并落一个空 Take（旧录音不保留）。
 */
import { useCallback, useRef, useState } from 'react';
import {
  buildPack,
  readPack,
  materialize,
  type LoadedPack,
} from '../model/instrument-pack';
import { useStore } from '../model/store';
import { seedTakeFromKeys } from '../model/take-stage';
import { downloadBlob } from '../model/transfer';
import { toast } from '../components/ui/toast';

export function useStageShare() {
  const [pending, setPending] = useState<LoadedPack | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const depthRef = useRef(0);

  const exportStage = useCallback(async () => {
    const { project, blobs } = useStore.getState();
    try {
      // buildPack 的 missing 是「缺失素材数量」（number），不是数组 —— 不可取 .length
      const { blob, missing } = await buildPack(project, blobs);
      const name = project.name.trim() || 'stage';
      downloadBlob(blob, `${slug(name)}.zip`);
      if (missing > 0) {
        toast({
          text: `已导出 · ${missing} 个样本缺失被跳过`,
          kind: 'error',
        });
      } else {
        toast({ text: '已导出', kind: 'success' });
      }
    } catch (e) {
      toast({ text: String(e instanceof Error ? e.message : e), kind: 'error' });
    }
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try {
      setPending(await readPack(file));
    } catch (e) {
      toast({ text: String(e instanceof Error ? e.message : e), kind: 'error' });
    }
  }, []);

  const pickFile = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void loadFile(f);
    };
    input.click();
  }, [loadFile]);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(() => {
    if (!pending) return;
    const st = useStore.getState();
    st.replaceStage(materialize(pending));
    // 导入包的音色装配在键序列里，Take 化舞台需从序列播种，否则导入后无声
    st.resetTakes(seedTakeFromKeys(useStore.getState().project, '演奏 1'));
    toast({ text: `已载入：${pending.manifest.projectName ?? pending.project.name}`, kind: 'success' });
    setPending(null);
  }, [pending]);

  /** 挂到 StagePage 的 <section> 上 */
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      depthRef.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      depthRef.current -= 1;
      if (depthRef.current <= 0) {
        depthRef.current = 0;
        setDragOver(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      depthRef.current = 0;
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void loadFile(f);
    },
  };

  return { exportStage, pickFile, pending, confirm, cancel, dragOver, dragProps };
}

function slug(s: string) {
  return s.trim().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'stage';
}
