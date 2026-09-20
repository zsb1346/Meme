import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../model/store';
import {
  cacheBuffer,
  decodeAudioBlobShared,
  dropCachedBuffer,
  getCachedBuffer,
  playSample,
  type PlayingSample,
} from '../../engine/sample-player';
import { getMasterChain } from '../../engine/effects';
import { getAudioContext } from '../../engine/core';
import { runUndo, stashForUndo } from '../../model/undo-stash';
import { toast } from '../ui/toast';
import { getTokens, withAlpha } from '../../styles/getTokens';
import SampleEditorModal from './SampleEditorModal';
import { IconPencil, IconPlay, IconStop, IconTrash } from '../ui/Icon';

/**
 * SampleChip 素材卡片。
 *
 * 视觉语言（设计系统 §4.3）：
 *   - 波形用**细竖条阵**绘制（`w=2, rx=1`），不用连续折线。
 *     竖条更「乐器」、更游戏化，也让播放头扫过时的「该列变亮」有了落点。
 *   - 卡片高 96px：上 52px 波形，下 44px 名称 + 时长；hover 时波形整体提亮，
 *     **不位移**（位移在网格里会造成整片抖动）。
 *   - 操作（重命名 / 试听 / 删除）默认隐身，hover 或 focus-within 时淡入 ——
 *     静止时不占用视觉带宽（戒律一：静）。
 *
 * 数据全部来自 store + engine 运行时缓存；缓存未命中时经共享 worker 解码
 * （与导入/预热去重，主线程零解码）并回填缓存后绘制。
 */

export interface SampleChipProps {
  sampleId: string;
  className?: string;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0.0s';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 波形条宽（恒定 2px；间距由可用宽度均分，见 drawPeaks） */
const BAR_W = 2;

/**
 * 把 AudioBuffer 首（混）声道降采样为竖条峰值并绘制。
 *
 * 与旧实现相比的三点改进：
 *   1. 条数与条宽解耦 —— 按容器宽度算条数，条本身恒为 2px；
 *   2. 播放进度不再重画整条波形，而是单独叠一层「已播放高亮」矩形，
 *      大幅降低每帧开销（旧实现每帧重跑全量峰值采样）；
 *   3. 未播放部分与已播放部分用两种透明度区分，不再靠画一条竖线。
 */
function drawPeaks(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  progress: number | null = null,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 180;
  const cssH = canvas.clientHeight || 52;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = getTokens();
  ctx.clearRect(0, 0, cssW, cssH);

  // 条数固定、间距按可用宽度均分 —— 波形恰好铺满卡片，且条宽恒定 2px
  // （旧写法用固定 stride，剩余空间全留在右侧，看起来像画到一半）
  const usable = Math.max(1, cssW - 8);
  const buckets = Math.max(6, Math.floor(usable / (BAR_W + 1)));
  const stride = usable / buckets;
  const chCount = buffer.numberOfChannels;
  const data = buffer.getChannelData(0);
  const data2 = chCount > 1 ? buffer.getChannelData(1) : null;
  const per = Math.max(1, Math.floor(data.length / buckets));
  // 每桶最多采样 48 点 —— 长缓冲也保持恒定开销
  const step = Math.max(1, Math.floor(per / 48));

  const midY = cssH / 2;
  const maxH = cssH - 8;
  const playedX = progress != null ? Math.min(1, Math.max(0, progress)) * cssW : -1;

  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const off = b * per;
    const limit = Math.min(off + per, data.length);
    for (let i = off; i < limit; i += step) {
      const v = Math.abs(data[i] || 0);
      const v2 = data2 ? Math.abs(data2[i] || 0) : v;
      const m = v > v2 ? v : v2;
      if (m > peak) peak = m;
    }
    const x = 4 + b * stride;
    const h = Math.max(2, peak * maxH);
    const played = playedX >= 0 && x <= playedX;
    // 已播放段用亮端色，未播放段用主色 —— 两种令牌，不引入第三色
    ctx.fillStyle = played ? t.flame300 : withAlpha(t.flame500, 0.72);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, midY - h / 2, BAR_W, h, 1);
    } else {
      ctx.rect(x, midY - h / 2, BAR_W, h);
    }
    ctx.fill();
  }
}

export default function SampleChip({ sampleId, className = '' }: SampleChipProps) {
  const sample = useStore((s) => s.project.samples.find((x) => x.id === sampleId));
  const blob = useStore((s) => s.blobs[sampleId]);
  const updateSample = useStore((s) => s.updateSample);
  const removeSample = useStore((s) => s.removeSample);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const playingRef = useRef<PlayingSample | null>(null);
  const playTimerRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number>(0);

  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sample?.name ?? '');
  const [editorOpen, setEditorOpen] = useState(false);

  // 波形缩略：优先运行时缓存；未命中则经共享 worker 解码后回填。
  // 用 rAF 等一帧再画 —— canvas 首帧 clientWidth 可能仍是 0（父级 grid 尚未布局完），
  // 那会导致条数按默认宽度算出来，波形只铺半张卡。
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    void (async () => {
      let buf = getCachedBuffer(sampleId);
      if (!buf && blob) {
        try {
          const decoded = await decodeAudioBlobShared(sampleId, blob);
          buf = decoded.buffer;
          cacheBuffer(sampleId, buf);
        } catch (err) {
          console.warn('[SampleChip] 波形解码失败', err);
          return;
        }
      }
      if (cancelled || !buf) return;
      bufferRef.current = buf;
      raf = window.requestAnimationFrame(() => {
        if (!cancelled && canvasRef.current) drawPeaks(canvasRef.current, buf);
      });
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [sampleId, blob]);

  // 容器尺寸变化后重绘（网格列数随窗口变化）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      if (bufferRef.current) drawPeaks(cv, bufferRef.current, null);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  // 卸载时停声 + 清定时器 + 停播放头动画
  useEffect(
    () => () => {
      playingRef.current?.stop();
      window.clearTimeout(playTimerRef.current);
      window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const stopPlayback = useCallback(() => {
    playingRef.current?.stop();
    playingRef.current = null;
    window.clearTimeout(playTimerRef.current);
    window.cancelAnimationFrame(rafRef.current);
    if (canvasRef.current && bufferRef.current) {
      drawPeaks(canvasRef.current, bufferRef.current, null);
    }
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) {
      stopPlayback();
      return;
    }
    const buf = bufferRef.current ?? getCachedBuffer(sampleId);
    if (!buf) return;
    bufferRef.current = buf;
    const handle = playSample({
      buffer: buf,
      destination: getMasterChain().input,
    });
    playingRef.current = handle;
    setPlaying(true);
    // 播放头：按 ctx 时钟推进，逐帧重绘「已播放高亮」
    const loop = () => {
      const ctx = getAudioContext();
      const p =
        handle.durationSec > 0 ? (ctx.currentTime - handle.when) / handle.durationSec : 1;
      if (canvasRef.current && bufferRef.current) {
        drawPeaks(canvasRef.current, bufferRef.current, Math.min(1, Math.max(0, p)));
      }
      if (p < 1) rafRef.current = window.requestAnimationFrame(loop);
    };
    rafRef.current = window.requestAnimationFrame(loop);
    playTimerRef.current = window.setTimeout(() => {
      playingRef.current = null;
      window.cancelAnimationFrame(rafRef.current);
      if (canvasRef.current && bufferRef.current) {
        drawPeaks(canvasRef.current, bufferRef.current, null);
      }
      setPlaying(false);
    }, Math.ceil(buf.duration * 1000) + 120);
  }, [playing, sampleId, stopPlayback]);

  const startRename = useCallback(() => {
    if (!sample) return;
    setDraft(sample.name);
    setEditing(true);
  }, [sample]);

  const commitRename = useCallback(() => {
    if (!sample) return;
    const trimmed = draft.trim();
    if (trimmed && trimmed !== sample.name) {
      updateSample(sample.id, { name: trimmed });
    }
    setEditing(false);
  }, [draft, sample, updateSample]);

  /** 立即删除 + 6s 可撤销 toast：撤销原子恢复 素材/Blob/键序列引用 */
  const handleDelete = useCallback(() => {
    if (!sample) return;
    const st = useStore.getState();
    const index = st.project.samples.findIndex((x) => x.id === sample.id);
    const blobRef = st.blobs[sample.id];
    const affectedKeys = st.project.keys
      .map((key, i) => ({ index: i, key }))
      .filter(({ key }) => key.sequence.some((r) => r.sampleId === sample.id));
    const warmBuf = bufferRef.current ?? getCachedBuffer(sample.id);
    stopPlayback();
    dropCachedBuffer(sample.id);
    removeSample(sample.id);
    const undoId = stashForUndo({
      label: '删除素材',
      undo: () => {
        useStore
          .getState()
          .restoreSample({ sample, blob: blobRef, index, keys: affectedKeys });
        if (warmBuf) cacheBuffer(sample.id, warmBuf);
      },
    });
    toast({
      text: `已删除「${sample.name}」`,
      action: { label: '撤销', onClick: () => runUndo(undoId) },
    });
  }, [removeSample, sample, stopPlayback]);

  if (!sample) return null;

  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-md bg-ink-800 shadow-[inset_0_1px_0_rgb(var(--hl))] transition-colors hover:bg-ink-700 ${className}`}
    >
      {/* 波形：双击打开切片编辑器；单击试听由下方按钮承担（避免误触） */}
      <button
        type="button"
        onClick={togglePlay}
        onDoubleClick={() => {
          stopPlayback();
          setEditorOpen(true);
        }}
        title="单击试听 · 双击打开切片编辑器"
        aria-label={`${playing ? '停止' : '试听'} ${sample.name}`}
        className="relative block h-[52px] w-full cursor-pointer bg-ink-950"
      >
        <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
        {/* 播放中的小圆点指示（静止时不可见） */}
        {playing && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-breathe rounded-full bg-flame-400" />
        )}
      </button>

      <div className="flex min-h-[42px] items-center gap-1.5 px-2 py-1.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label="素材名称"
            className="h-6 min-w-0 flex-1 rounded-sm bg-ink-950 px-1.5 text-small text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]"
          />
        ) : (
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="truncate text-small font-medium leading-tight text-label-hi">
              {sample.name}
            </span>
            <span className="font-mono text-micro leading-tight text-label-muted">
              {formatDuration(sample.durationSec)}
              {sample.detectedPitchHz != null && (
                <>
                  <span className="mx-1 text-label-faint">·</span>
                  {Math.round(sample.detectedPitchHz)}Hz
                </>
              )}
            </span>
          </span>
        )}

        {/* 操作组：静止时隐身，hover / 焦点进入时淡入 */}
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <ChipButton label="重命名" onClick={startRename}>
            <IconPencil size={13} />
          </ChipButton>
          <ChipButton
            label={playing ? '停止' : '试听'}
            onClick={togglePlay}
            disabled={!bufferRef.current && !getCachedBuffer(sampleId)}
          >
            {playing ? <IconStop size={12} /> : <IconPlay size={12} />}
          </ChipButton>
          <ChipButton label="删除" onClick={handleDelete} tone="danger">
            <IconTrash size={13} />
          </ChipButton>
        </span>
      </div>

      {editorOpen && (
        <SampleEditorModal sampleId={sampleId} onClose={() => setEditorOpen(false)} />
      )}
    </article>
  );
}

/** 卡片内的小图标按钮：26px，无边框（卡片本身已是浮起面） */
function ChipButton({
  label,
  onClick,
  disabled,
  tone = 'normal',
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  tone?: 'normal' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-[26px] w-[26px] place-items-center rounded-sm transition-colors disabled:opacity-30 ${
        tone === 'danger'
          ? 'text-label-muted hover:bg-danger/15 hover:text-danger'
          : 'text-label-muted hover:bg-ink-900 hover:text-flame-300'
      }`}
    >
      {children}
    </button>
  );
}
