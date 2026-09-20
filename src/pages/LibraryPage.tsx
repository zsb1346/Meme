import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SampleChip from '../components/audio/SampleChip';
import { toast } from '../components/ui/toast';
import { useStore } from '../model/store';
import { searchByName } from '../utils/sample-search';
import { defaultUploadName } from '../utils/format';
import { PageBar } from '../components/ui/PageBar';
import {
  IconUpload,
  IconSearch,
  IconClose,
  IconLibrary,
  IconCheck,
  IconAlert,
} from '../components/ui/Icon';

/**
 * LibraryPage 素材箱 —— 全部音频素材的入口。
 *
 * 布局（设计系统 §5.1）：
 *   - 单行顶栏 44px：标题 + 计数 + 搜索框 + 上传按钮（不再有独立大标题区）。
 *   - 内容铺满宽度，不居中、不留白（`auto-fill` 网格自己控制列数）。
 *   - **大号拖放区只在素材箱为空时出现**；一旦有素材，把空间全部还给网格，
 *     拖入能力改为整页可用（拖入时显示一层极简虚线脉冲边框）。
 *
 * 旧实现的问题：整页 `max-w-5xl` 居中 + 大标题 + 独立拖放块 + 独立搜索行，
 * 三行 chrome 吃掉 300px 垂直空间，而素材网格反而被压到很窄。
 */

interface UploadItem {
  key: string;
  name: string;
  status: 'pending' | 'ok' | 'error';
  message?: string;
}

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm)$/i;

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXT_RE.test(file.name);
}

export default function LibraryPage() {
  const samples = useStore((s) => s.project.samples);
  const addSampleFromFile = useStore((s) => s.addSampleFromFile);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const cleanupTimersRef = useRef<number[]>([]);

  const [query, setQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  useEffect(
    () => () => {
      cleanupTimersRef.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | File[] | null) => {
      const files = Array.from(fileList ?? []).filter(isAudioFile);
      if (files.length === 0) {
        toast({
          text: '未识别到音频文件（支持 mp3 / wav / ogg / m4a / flac）',
          kind: 'error',
        });
        return;
      }

      const batchKey = Date.now();
      const items: UploadItem[] = files.map((f, i) => ({
        key: `${batchKey}-${i}`,
        name: f.name,
        status: 'pending',
      }));
      setUploads((prev) => [...prev, ...items]);

      // 名字池随批内进度增长：同一批里若有两个同名文件，第二个会自动补序号，
      // 而不是产生两条同名素材（旧实现直接 stripExt，必然重名）。
      const taken = new Set(useStore.getState().project.samples.map((s) => s.name));

      for (let i = 0; i < files.length; i++) {
        const finalName = defaultUploadName(files[i].name, taken);
        taken.add(finalName);
        const res = await addSampleFromFile(files[i], finalName);
        setUploads((prev) =>
          prev.map((u) =>
            u.key === items[i].key
              ? {
                  ...u,
                  // 回显实际入库名（可能带序号），而不是原始文件名
                  name: finalName,
                  status: res.ok ? 'ok' : 'error',
                  message: res.ok ? undefined : res.error,
                }
              : u,
          ),
        );
        if (res.ok) {
          // 成功条目 4s 后自动淡出队列
          const timer = window.setTimeout(() => {
            setUploads((prev) => prev.filter((u) => u.key !== items[i].key));
          }, 4000);
          cleanupTimersRef.current.push(timer);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addSampleFromFile],
  );

  // 搜索为空 → 按创建时间倒序；有查询 → 按相关度排序（searchByName 内部完成）
  const visibleSamples = useMemo(() => {
    const q = query.trim();
    if (!q) {
      return samples.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
    }
    return searchByName(samples, q);
  }, [samples, query]);

  const pendingCount = uploads.filter((u) => u.status === 'pending').length;
  const isEmpty = samples.length === 0 && uploads.length === 0;

  return (
    <section
      aria-label="素材箱"
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <PageBar
        title="素材箱"
        meta={
          samples.length > 0
            ? `${samples.length} 个素材 · 双击波形切片`
            : '上传音频切片，或从整曲中拉取片段入库'
        }
        status={
          pendingCount > 0 ? (
            <>
              <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-flame-400" />
              <span className="font-mono text-small text-flame-300">
                解码中 {pendingCount}
              </span>
            </>
          ) : undefined
        }
      >
        {/* 搜索：图标在框内，宽 260px，随焦点变强调边框 */}
        <label className="group flex h-ctl-md w-[240px] items-center gap-1.5 rounded-sm bg-ink-950 px-2 shadow-[inset_0_0_0_1px_rgb(var(--line))] transition-shadow focus-within:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]">
          <IconSearch size={14} className="shrink-0 text-label-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称 / 拼音 / 首字母"
            aria-label="搜索素材"
            className="min-w-0 flex-1 bg-transparent text-small text-label-hi outline-none placeholder:text-label-faint"
          />
          {query !== '' && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
              className="shrink-0 text-label-faint transition-colors hover:text-label-lo"
            >
              <IconClose size={13} />
            </button>
          )}
        </label>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-ctl-md items-center gap-1.5 rounded-sm bg-flame-400 px-2.5 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300"
        >
          <IconUpload size={14} />
          上传
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          className="sr-only"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </PageBar>

      {/* 入库进度条 —— 只在有待处理项时占位 */}
      {uploads.length > 0 && (
        <ul
          role="status"
          className="flex shrink-0 flex-col gap-px border-b border-line bg-ink-900 px-3 py-1.5"
        >
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-2 text-small">
              {u.status === 'pending' ? (
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-flame-600/40 border-t-flame-400"
                />
              ) : u.status === 'ok' ? (
                <IconCheck size={13} className="shrink-0 text-success" />
              ) : (
                <IconAlert size={13} className="shrink-0 text-danger" />
              )}
              <span className="min-w-0 truncate text-label-lo">{u.name}</span>
              <span
                className={`ml-auto shrink-0 font-mono text-tiny ${
                  u.status === 'error' ? 'text-danger' : 'text-label-faint'
                }`}
              >
                {u.status === 'pending' ? '解码中…' : (u.message ?? '已入库')}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        {isEmpty ? (
          /* 空态：大号拖放区 + 手绘感插画（唯一使用它的时机） */
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mx-auto flex max-w-2xl flex-col items-center gap-3 rounded-md border-2 border-dashed border-line-hot px-8 py-14 text-center transition-colors hover:border-flame-500/60 hover:bg-flame-600/[0.06]"
          >
            <IconLibrary size={40} className="text-label-faint" />
            <span className="text-body font-semibold text-label-lo">
              把音频文件拖到这里
            </span>
            <span className="text-small leading-relaxed text-label-muted">
              或点击选择文件 · 支持 mp3 / wav / ogg / m4a / flac · 可多选
              <br />
              入库后双击任意波形即可打开切片编辑器
            </span>
          </button>
        ) : visibleSamples.length === 0 ? (
          <p className="py-16 text-center text-body text-label-muted">
            没有匹配「{query}」的素材
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-2.5">
            {visibleSamples.map((s) => (
              <SampleChip key={s.id} sampleId={s.id} />
            ))}
          </div>
        )}
      </div>

      {/* 整页拖入覆盖层：极简虚线脉冲，不用遮罩色块 */}
      {dragOver && <div className="stage-drop-overlay">松开以导入音频</div>}
    </section>
  );
}
