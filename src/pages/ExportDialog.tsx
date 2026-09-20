import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportFormat } from '../engine/exporter';
import { exportTake } from '../engine/exporter';
import { getCachedBuffer } from '../engine/sample-player';
import { getMasterChain } from '../engine/effects';
import { resolveFilledSample, useStore } from '../model/store';
import { prewarmProjectBuffers } from '../model/buffer-cache-service';
import {
  createTakePlayback,
  useTakePlaybackState,
  type TakePlaybackController,
} from '../hooks/useTakePlayback';
import { downloadBlob } from '../model/transfer';
import { flushSave } from '../model/persistence';
import { formatTime } from '../utils/format';
import { tailSecFor } from '../engine/export-constants';

/**
 * ExportDialog —— 导出对话框（计划 §4.4：OfflineAudioContext 渲染 → wav/mp3）。
 *
 * 流程与安全护栏：
 * 1. 打开时预热素材解码缓存（预览与导出共用，README §3 缓存预热约定）；
 * 2. 预览 = TakePlayer 实时播放走主效果链（getMasterChain().input），
 *    播放头进度用 AudioContext 时钟计算（禁 Date.now）；
 * 3. 导出前 flushSave() 落盘 → exportTake()（内部切换 Tone 全局上下文到
 *    OfflineAudioContext）。渲染期间【硬禁用】预览与格式切换，
 *    且不允许关闭对话框 —— 保证离线渲染串行化、不与实时发声并发
 *    （README §8 / §10.4）；
 * 4. 成功后 downloadBlob 触发浏览器下载；失败错误内联展示（zh-CN）。
 *
 * Props 向后兼容 P1 占位契约 { open, onClose }（MixPage 在用）；
 * StudioPage 入口可传 takeId 预选要导出的 Take。
 */

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
  /** 预选的 Take（StudioPage 入口按钮传入）；缺省选最近一条 */
  takeId?: string;
}

/** previewing 不再是独立 phase —— 播放态由控制器快照驱动 */
type Phase = 'idle' | 'prewarming' | 'rendering' | 'done';

const MP3_KBPS = 192;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// 键序列引用集的缓存预热已收编至 model/buffer-cache-service（原本地 prewarmBuffers）。

export default function ExportDialog({ open, onClose, takeId }: ExportDialogProps) {
  const project = useStore((s) => s.project);

  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('wav');
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [missingCount, setMissingCount] = useState(0);
  const [successInfo, setSuccessInfo] = useState<{
    filename: string;
    bytes: number;
  } | null>(null);

  /** 导出串行化硬闸门：渲染期间拒绝一切实时发声路径 */
  const renderingRef = useRef(false);

  const takes = project.takes;
  const selectedTake =
    takes.find((t) => t.id === selectedTakeId) ?? takes[0] ?? null;

  // ---- 预览（createTakePlayback 统一编排；播放头走 ctx 时钟）----
  const selectedTakeRef = useRef(selectedTake);
  selectedTakeRef.current = selectedTake;
  const [playback] = useState<TakePlaybackController>(() =>
    createTakePlayback({
      getTarget: () => ({
        project: useStore.getState().project,
        take: selectedTakeRef.current,
      }),
      getDestination: () =>
        getMasterChain(useStore.getState().project.effects).input,
    }),
  );
  const previewSnap = useTakePlaybackState(playback);

  // 打开时初始化选择 + 预热缓存；关闭时停播清理
  useEffect(() => {
    if (!open) {
      playback.stop();
      setPhase('idle');
      setErrorMsg(null);
      setSuccessInfo(null);
      return;
    }
    setSelectedTakeId(takeId ?? takes[0]?.id ?? null);
    let cancelled = false;
    setPhase('prewarming');
    prewarmProjectBuffers(project)
      .then((missing) => {
        if (cancelled) return;
        setMissingCount(missing.length);
        setPhase('idle');
      })
      .catch(() => {
        if (!cancelled) setPhase('idle');
      });
    return () => {
      cancelled = true;
    };
    // 仅在开关/预选变化时触发一次预热
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, takeId, playback]);

  const stopPreview = useCallback(() => {
    playback.stop();
  }, [playback]);

  const startPreview = useCallback(() => {
    if (!selectedTake || renderingRef.current || phase === 'prewarming') return;
    setErrorMsg(null);
    setSuccessInfo(null);
    // 控制器内部完成 ensureAudioStarted / 主链现取 / 半音决策
    playback.start(0);
  }, [selectedTake, phase, playback]);

  const doExport = useCallback(async () => {
    if (!selectedTake || renderingRef.current) return;
    // 护栏①：先掐掉一切实时发声（离线渲染会独占 Tone 全局上下文）
    playback.stop();
    renderingRef.current = true;
    setErrorMsg(null);
    setSuccessInfo(null);
    setPhase('rendering');
    try {
      await flushSave(); // README §9：导出前落盘
      const res = await exportTake(
        { project, take: selectedTake, resolveBuffer: (id) => getCachedBuffer(id) },
        format,
      );
      downloadBlob(res.blob, res.filename);
      setSuccessInfo({ filename: res.filename, bytes: res.blob.size });
      setPhase('done');
    } catch (err) {
      setErrorMsg(
        `导出失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setPhase('idle');
    } finally {
      renderingRef.current = false;
    }
  }, [selectedTake, project, format, playback]);

  // Esc 关闭（渲染中禁止）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !renderingRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const busyRendering = phase === 'rendering';
  const prewarming = phase === 'prewarming';
  // 播放态改由控制器快照驱动（ctx 时钟），phase 不再承载预览态
  const previewing = previewSnap.isPlaying;

  // 预览进度：总时长含 0.4s 尾垫（与 TakePlayer 一致）
  const totalPreviewSec = (selectedTake?.durationSec ?? 0) + 0.4;
  const progress =
    totalPreviewSec > 0
      ? Math.min(1, previewSnap.playheadSec / totalPreviewSec)
      : 1;

  const totalEstSec = (selectedTake?.durationSec ?? 0) + tailSecFor(project.effects);
  const estBytes =
    format === 'wav'
      ? totalEstSec * 44100 * 2 * 2 // 44.1kHz · 双声道 · PCM16
      : (totalEstSec * MP3_KBPS * 1000) / 8;

  const hasSound = selectedTake
    ? selectedTake.events.some((ev) => resolveFilledSample(project, ev) !== null)
    : false;

  const requestClose = () => {
    if (busyRendering) return; // 渲染期间禁止关闭（上下文切换保护）
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="导出音频"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-100">导出音频</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              离线渲染所选 Take（含总线效果链），保证导出 = 预览。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            disabled={busyRendering}
            onClick={requestClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl text-slate-400 transition hover:bg-ink-800 hover:text-slate-200 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Take 选择 */}
        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs font-medium text-slate-400">
            选择 Take
          </span>
          <select
            value={selectedTake?.id ?? ''}
            disabled={busyRendering || takes.length === 0}
            onChange={(e) => {
              stopPreview();
              setSelectedTakeId(e.target.value);
              setSuccessInfo(null);
            }}
            className="h-11 w-full rounded-lg border border-ink-600 bg-ink-800 px-3 text-sm text-slate-100 outline-none transition focus:border-flame-500 disabled:opacity-50 [&>option]:bg-ink-900"
          >
            {takes.length === 0 && <option value="">（暂无录制）</option>}
            {takes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.events.length} 音 · {formatTime(t.durationSec)}
              </option>
            ))}
          </select>
        </label>

        {/* 格式切换 */}
        <div className="mt-4">
          <span className="mb-1.5 block text-xs font-medium text-slate-400">
            格式
          </span>
          <div className="flex rounded-lg border border-ink-600 bg-ink-800 p-1">
            {(['wav', 'mp3'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format === f}
                disabled={busyRendering}
                onClick={() => setFormat(f)}
                className={`h-11 flex-1 rounded-md text-sm font-semibold transition ${
                  format === f
                    ? 'bg-flame-500 text-ink-950'
                    : 'text-slate-300 hover:bg-ink-700'
                } disabled:opacity-50`}
              >
                {f === 'wav' ? 'WAV 无损' : 'MP3 小体积'}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {format === 'wav'
              ? 'PCM16 无压缩，音质最佳、文件较大。'
              : `${MP3_KBPS}kbps 编码，首次导出需加载编码器，稍等片刻属正常。`}
          </p>
        </div>

        {/* 信息行 */}
        <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-ink-700 bg-ink-800/60 p-2.5">
            <dt className="text-slate-500">时长</dt>
            <dd className="mt-0.5 font-semibold text-slate-200">
              {formatTime(totalEstSec)}（含尾音）
            </dd>
          </div>
          <div className="rounded-lg border border-ink-700 bg-ink-800/60 p-2.5">
            <dt className="text-slate-500">预计大小</dt>
            <dd className="mt-0.5 font-semibold text-slate-200">
              ≈ {fmtBytes(estBytes)}
            </dd>
          </div>
          <div className="rounded-lg border border-ink-700 bg-ink-800/60 p-2.5">
            <dt className="text-slate-500">事件数</dt>
            <dd className="mt-0.5 font-semibold text-slate-200">
              {selectedTake?.events.length ?? 0}
            </dd>
          </div>
        </dl>

        {/* 内联提示区 */}
        {prewarming && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-800/60 px-3 py-2 text-xs text-slate-400">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-500/40 border-t-flame-400" />
            正在预热素材解码缓存…
          </p>
        )}
        {missingCount > 0 && !prewarming && (
          <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
            有 {missingCount} 个素材缺失音频数据（可能已被删除或导入不完整），
            对应按键将静音。
          </p>
        )}
        {selectedTake && !hasSound && (
          <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
            该 Take 涉及的键位尚未装配任何素材，导出会是静音文件。
            请先到「录制棚」完成填词装配。
          </p>
        )}
        {busyRendering && (
          <p className="mt-3 rounded-lg border border-ink-600 bg-ink-800/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
            渲染期间已暂停预览并锁定本对话框（离线渲染独占音频上下文，请稍候）。
          </p>
        )}
        {errorMsg && (
          <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
            {errorMsg}
          </p>
        )}
        {successInfo && (
          <p className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-300">
            已开始下载「{successInfo.filename}」（{fmtBytes(successInfo.bytes)}）。
          </p>
        )}

        {/* 预览行 */}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={previewing ? stopPreview : startPreview}
            disabled={
              busyRendering ||
              prewarming ||
              !selectedTake ||
              selectedTake.events.length === 0
            }
            className={`flex h-11 min-w-[96px] items-center justify-center gap-2 rounded-lg text-sm font-bold transition active:scale-[0.98] disabled:opacity-40 ${
              previewing
                ? 'border border-ink-600 bg-ink-800 text-slate-200 hover:bg-ink-700'
                : 'bg-flame-500 text-ink-950 hover:bg-flame-400'
            }`}
          >
            {previewing ? '■ 停止' : '▶ 预览'}
          </button>
          <div className="min-w-0 flex-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-flame-500 transition-[width] duration-100"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-500">
              <span>{formatTime(progress * ((selectedTake?.durationSec ?? 0) + 0.4))}</span>
              <span>{formatTime(selectedTake?.durationSec ?? 0)}</span>
            </p>
          </div>
        </div>

        {/* 导出按钮 */}
        <button
          type="button"
          onClick={doExport}
          disabled={
            busyRendering ||
            prewarming ||
            !selectedTake ||
            selectedTake.events.length === 0 ||
            !hasSound
          }
          className="mt-4 flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-gradient-to-b from-flame-400 to-flame-600 text-sm font-bold text-ink-950 shadow-lg shadow-flame-600/20 transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
        >
          {busyRendering && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />
          )}
          {busyRendering
            ? '正在渲染并编码…'
            : phase === 'done' && successInfo
              ? '✓ 已导出，可再次导出'
              : `导出 ${format.toUpperCase()}`}
        </button>
      </div>
    </div>
  );
}
