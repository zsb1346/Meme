/**
 * SampleEditorModal —— 素材箱「双击波形」弹出的切片编辑器。
 *
 * ══ 视觉分层（本次重做） ══
 *
 * 波形由**本组件自绘**（细竖条阵，与全站波形语言一致），而不是沿用
 * wavesurfer 的默认外观。原因：
 *   1. wavesurfer 画的是连续折线，与全站的「细竖条」语言冲突；
 *   2. 它的配色只能通过 create() 选项给定，无法跟随设计令牌动态变化；
 *   3. 选区高亮、播放进度、峰值刻度需要统一到一套令牌上。
 *
 * 分工：
 *   - wavesurfer  → 音频解码/播放/seek + RegionsPlugin 的选区拖拽；
 *     其自绘内容被一层覆盖 canvas 遮住（它仍是选区元素的宿主，故必须保留）。
 *   - 覆盖 canvas → 全部可见内容：波形、选区高亮、选区内的播放进度。
 *
 * 交互（对齐用户定稿，未改动）：
 *   - 空格 = 播放/暂停；有选区则只播选区，否则播整段。
 *   - 按住 Shift + 左键拖拽 = 拉出选区，松手后是否自动试听由「自动试听」控制。
 *   - 点击波形 = 跳转播放头。
 *   - 滚轮 = 缩放波形（锚定指针），Shift+滚轮 = 水平平移。
 *   - 底部「将选中区域导入素材箱」= WASM 解码缓存 → 采样精确抽取 → WAV 编码入库。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/toast';
import { useStore } from '../../model/store';
import {
  cacheBuffer,
  decodeAudioBlobShared,
  getCachedBuffer,
} from '../../engine/sample-player';
import { encodeRegionWavAsync } from '../../engine/wav-encoder';
import { formatTime, defaultSliceName } from '../../utils/format';
import { getTokens } from '../../styles/getTokens';
import {
  IconAlert,
  IconCheck,
  IconPause,
  IconPlay,
  IconStop,
  IconVolume,
  IconVolumeOff,
} from '../ui/Icon';

// 滚轮缩放常量（与 KeyMachine 滚动视口控制器一致的灵敏度）
const WHEEL_ZOOM_FACTOR = 0.0022;
const MAX_ZOOM_RATIO = 120;
const MAX_PX_PER_SEC = 2500;

/** 波形条宽（恒定 2px；间距 1px，见 redraw 的 stride） */
const BAR_W = 2;

export interface SampleEditorModalProps {
  sampleId: string;
  onClose(): void;
}

interface Selection {
  start: number;
  end: number;
}

export default function SampleEditorModal({
  sampleId,
  onClose,
}: SampleEditorModalProps) {
  const sample = useStore((s) =>
    s.project.samples.find((x) => x.id === sampleId),
  );
  /** 全部素材名：用于给切片起一个不冲突的默认名 */
  const existingNames = useStore((s) => s.project.samples.map((x) => x.name));
  /**
   * 素材名快照（ref）。
   * wavesurfer 的 effect 只依赖 [sampleId, sampleName]，不能把 existingNames
   * 加进依赖 —— 否则任何一次素材增删都会重建 wavesurfer、打断正在进行的选区。
   * 用 ref 读取「当下」的名字池即可。
   */
  const existingNamesRef = useRef(existingNames);
  existingNamesRef.current = existingNames;
  const addSampleFromFile = useStore((s) => s.addSampleFromFile);
  const sampleName = sample?.name ?? '素材';
  /** 切片名输入框：打开即聚焦全选，便于直接覆写 */
  const nameInputRef = useRef<HTMLInputElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  /** 覆盖 canvas：承载全部可见内容 */
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  /** 已解码的 AudioBuffer（自绘波形的数据源） */
  const bufferRef = useRef<AudioBuffer | null>(null);

  /** Shift 当前是否按住（region-created 里据此决定保留/丢弃选区） */
  const shiftHeldRef = useRef(false);
  /** 当前唯一选区的 region id（本编辑器只保留一个选区） */
  const regionIdRef = useRef<string | null>(null);
  /** 拖拽建区后是否自动试听（region-created 回调读它，避免闭包过期） */
  const autoPlayRef = useRef(false);
  /** 波形是否已 ready（滚轮缩放回调读它，避免闭包过期） */
  const readyRef = useRef(false);
  /** 当前 zoom(minPxPerSec) 值；0 = 适配容器宽度（wavesurfer fillParent） */
  const zoomPxRef = useRef(0);
  /** 选区 state 的 ref 镜像（重绘回调读它，避免闭包过期） */
  const selRef = useRef<Selection | null>(null);
  /** 当前是否在播选区（框外全灰、进度只在选区内推进） */
  const selPlayRef = useRef(false);
  /** 播放头位置（秒）；-1 表示不画 */
  const playheadRef = useRef(-1);
  /** 重绘调度 */
  const dirtyRef = useRef(true);

  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [name, setName] = useState('');
  /** 相对「适配宽度」的缩放百分比（100 = 整段恰好占满容器） */
  const [zoomPct, setZoomPct] = useState(100);

  useEffect(() => {
    autoPlayRef.current = autoPlay;
  }, [autoPlay]);

  useEffect(() => {
    selRef.current = sel;
    dirtyRef.current = true;
  }, [sel]);

  const importingRef = useRef(false);
  const [importing, setImporting] = useState(false);

  /* ═══════════════════════════════════════════════════════════════
     自绘波形 —— 细竖条阵 + 选区高亮 + 选区内进度
     ═══════════════════════════════════════════════════════════════ */

  const redraw = useCallback(() => {
    const cv = overlayRef.current;
    const ws = wsRef.current;
    const buf = bufferRef.current;
    if (!cv || !ws) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cv.clientWidth || 600;
    const cssH = cv.clientHeight || 160;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.max(1, Math.round(cssW * dpr));
      cv.height = Math.max(1, Math.round(cssH * dpr));
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const t = getTokens();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 视口映射：wavesurfer 的 scroll 与 zoom 是唯一事实来源
    const total = ws.getDuration() || 1;
    const width = ws.getWidth() || cssW;
    const scroll = ws.getScroll();
    const pxPerSec = width / total;
    const xOfSec = (sec: number) => sec * pxPerSec - scroll;

    const midY = cssH / 2;
    const maxH = cssH - 14;

    // ── 中线 ──
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(0, midY, cssW, 1);

    if (!buf) {
      ctx.fillStyle = t.textFaint;
      ctx.font = '11px var(--mono)';
      ctx.textAlign = 'center';
      ctx.fillText('解码中…', cssW / 2, midY + 4);
      return;
    }

    // ── 波形（细竖条阵）──
    // 条宽恒定 2px、间距 1px（stride 3px）；子像素位置不做取整，
    // 由 canvas 的抗锯齿处理，避免逐条取整后出现宽窄不一的接缝。
    const stride = BAR_W + 1;
    const chCount = buf.numberOfChannels;
    const d0 = buf.getChannelData(0);
    const d1 = chCount > 1 ? buf.getChannelData(1) : null;
    const s = selRef.current;
    const ph = playheadRef.current;
    const playingSel = selPlayRef.current && s != null;

    for (let x = 0; x < cssW; x += stride) {
      const sec = (x + scroll) / pxPerSec;
      if (sec < 0 || sec > total) continue;
      const idx = Math.floor((sec / total) * d0.length);
      // 每根条取一个窗口内的峰值，避免高缩放下漏掉瞬态
      const win = Math.max(1, Math.floor(d0.length / total / pxPerSec));
      let peak = 0;
      const end = Math.min(idx + win, d0.length);
      for (let i = idx; i < end; i++) {
        const v = Math.abs(d0[i] || 0);
        const v2 = d1 ? Math.abs(d1[i] || 0) : v;
        const m = v > v2 ? v : v2;
        if (m > peak) peak = m;
      }
      const h = Math.max(1.5, peak * maxH);

      // 着色优先级：选区内已播放 → 选区内未播放 → 选区外
      // 旧实现靠改 wavesurfer 的 progressColor 实现「框外全灰」，这里直接按
      // 选区与播放头位置计算，逻辑更直白也不再有状态残留问题。
      let color: string;
      if (s) {
        const inSel = sec >= s.start && sec <= s.end;
        if (!inSel) {
          color = 'rgba(255,255,255,0.13)'; // 框外：全灰
        } else if (playingSel && ph >= 0 && sec <= ph) {
          color = t.flame300; // 选区内已播放：亮端
        } else {
          color = t.flame500; // 选区内未播放：主色
        }
      } else {
        color = ph >= 0 && sec <= ph ? t.flame300 : withAlphaLocal(t.flame500, 0.66);
      }

      ctx.fillStyle = color;
      ctx.fillRect(x, midY - h / 2, BAR_W, h);
    }

    // ── 选区边界把手 ──
    if (s) {
      const x0 = xOfSec(s.start);
      const x1 = xOfSec(s.end);
      ctx.fillStyle = t.flame400;
      ctx.fillRect(x0 - 0.5, 4, 1.5, cssH - 8);
      ctx.fillRect(x1 - 1, 4, 1.5, cssH - 8);
      // 顶部选区条：让「选了多长」在缩得很小时也看得见
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), 2);
    }

    // ── 播放头 ──
    if (ph >= 0) {
      const x = xOfSec(ph);
      if (x >= 0 && x <= cssW) {
        ctx.fillStyle = t.flame300;
        ctx.fillRect(x - 0.75, 0, 1.5, cssH);
      }
    }
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     rAF 重绘循环 —— 仅播放中或标脏时绘制
     ═══════════════════════════════════════════════════════════════ */

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (dirtyRef.current || wsRef.current?.isPlaying()) {
        redraw();
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [redraw]);

  /** 容器尺寸变化 → 标脏 */
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      dirtyRef.current = true;
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     wavesurfer 生命周期
     ═══════════════════════════════════════════════════════════════ */

  useEffect(() => {
    const container = containerRef.current;
    const blob = useStore.getState().blobs[sampleId];
    if (!container) return;
    if (!blob) {
      toast('素材音频缺失，无法打开编辑器');
      return;
    }

    const ws = WaveSurfer.create({
      container,
      height: 160,
      // 全部自绘内容设为全透明 —— 覆盖 canvas 负责可见部分。
      // 保留元素而非删除：wavesurfer 需要它来测量宽度、承载 regions 元素。
      waveColor: 'rgba(0,0,0,0)',
      progressColor: 'rgba(0,0,0,0)',
      cursorColor: 'rgba(0,0,0,0)',
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      dragToSeek: false, // 与 enableDragSelection 冲突，点击 seek 由 renderer 自带 click handler 处理
      autoScroll: false,
    });
    wsRef.current = ws;

    const regions = ws.registerPlugin(RegionsPlugin.create());
    regionsRef.current = regions;

    // 拖拽建区始终绑定；是否保留由 region-created 读 shiftHeldRef 门控。
    // 选区本体不可见（透明），视觉全部由覆盖 canvas 绘制 ——
    // 这样选区样式与全站令牌一致，且不受 wavesurfer 内部样式影响。
    const disableDrag = regions.enableDragSelection({
      color: 'rgba(0,0,0,0)',
      drag: true,
      resize: true,
      minLength: 0.05,
    });

    const unsubs: Array<() => void> = [
      regions.on('region-created', (r: Region) => {
        // 非 Shift 拖拽 = 普通点击跳转（renderer click handler），丢弃临时区
        if (!shiftHeldRef.current) {
          r.remove();
          return;
        }
        regionIdRef.current = r.id;
        for (const other of regions.getRegions()) {
          if (other.id !== r.id) other.remove();
        }
        selRef.current = { start: r.start, end: r.end };
        setSel({ start: r.start, end: r.end });
        dirtyRef.current = true;
        if (autoPlayRef.current) {
          selPlayRef.current = true;
          void ws.play(r.start, r.end);
        }
      }),
      regions.on('region-updated', (r: Region) => {
        if (r.id === regionIdRef.current) {
          selRef.current = { start: r.start, end: r.end };
          setSel({ start: r.start, end: r.end });
          dirtyRef.current = true;
        }
      }),
      regions.on('region-removed', (r: Region) => {
        if (r.id === regionIdRef.current) {
          regionIdRef.current = null;
          selRef.current = null;
          setSel(null);
          selPlayRef.current = false;
          dirtyRef.current = true;
        }
      }),
      ws.on('ready', (dur: number) => {
        readyRef.current = true;
        setReady(true);
        setDuration(dur);
        // 默认名按现有素材去重，避免连续切同一段时出现一串同名素材
        setName(defaultSliceName(sampleName, existingNamesRef.current));
        dirtyRef.current = true;
      }),
      ws.on('timeupdate', (time: number) => {
        playheadRef.current = time;
        setCurrentTime(time);
        dirtyRef.current = true;
      }),
      ws.on('play', () => {
        setPlaying(true);
        dirtyRef.current = true;
      }),
      ws.on('pause', () => {
        setPlaying(false);
        selPlayRef.current = false;
        dirtyRef.current = true;
      }),
      ws.on('finish', () => {
        setPlaying(false);
        selPlayRef.current = false;
        dirtyRef.current = true;
      }),
      ws.on('scroll', () => {
        dirtyRef.current = true;
      }),
      ws.on('zoom', () => {
        dirtyRef.current = true;
      }),
      ws.on('error', (err: Error) => {
        toast(`音频加载失败：${err?.message ?? String(err)}`);
      }),
    ];

    void ws
      .loadBlob(blob)
      .then(() => {
        // 自绘数据源：优先引擎缓存（symphonia 原生采样率，与播放链路一致），
        // 否则用 wavesurfer 解码结果兜底。
        const cached = getCachedBuffer(sampleId);
        if (cached) {
          bufferRef.current = cached;
        } else {
          const decoded = ws.getDecodedData();
          if (decoded) {
            bufferRef.current = decoded;
            cacheBuffer(sampleId, decoded);
          }
        }
        dirtyRef.current = true;
      })
      .catch((err: unknown) => {
        toast(`音频加载失败：${String(err)}`);
      });

    /* ── 滚轮缩放：指针为锚 ── */
    const onWheel = (e: WheelEvent) => {
      const w = wsRef.current;
      if (!w || !readyRef.current) return;
      e.preventDefault();
      const dur = w.getDuration();
      const viewW = w.getWidth() || container.clientWidth;
      if (!dur || dur <= 0 || viewW <= 0) return;
      const fit = viewW / dur;
      const cur = Math.max(zoomPxRef.current, fit);

      if (e.shiftKey) {
        w.setScroll(Math.max(0, w.getScroll() + e.deltaY + e.deltaX));
        return;
      }
      if (e.deltaX) {
        w.setScroll(Math.max(0, w.getScroll() + e.deltaX));
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(viewW, e.clientX - rect.left));
      const anchorTime = (w.getScroll() + x) / cur;
      const maxPx = Math.max(fit, Math.min(fit * MAX_ZOOM_RATIO, MAX_PX_PER_SEC));
      const next = Math.max(fit, Math.min(maxPx, cur * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR)));

      if (next <= fit * 1.005) {
        zoomPxRef.current = 0;
        w.zoom(0);
      } else {
        zoomPxRef.current = next;
        w.zoom(next);
      }
      const actual = Math.max(zoomPxRef.current, fit);
      w.setScroll(Math.max(0, anchorTime * actual - x));
      setZoomPct(Math.round((actual / fit) * 100));
      dirtyRef.current = true;
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      readyRef.current = false;
      bufferRef.current = null;
      container.removeEventListener('wheel', onWheel);
      unsubs.forEach((u) => u());
      disableDrag();
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
  }, [sampleId, sampleName]);

  const currentRegion = useCallback(
    (): Region | undefined =>
      regionsRef.current?.getRegions().find((r) => r.id === regionIdRef.current),
    [],
  );

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (ws.isPlaying()) {
      ws.pause();
      return;
    }
    const s = selRef.current;
    if (s && currentRegion()) {
      // 选区播放：进度只在选区内推进（由覆盖 canvas 按 selPlay + playhead 绘制）
      selPlayRef.current = true;
      const now = ws.getCurrentTime();
      const resume = now >= s.start && now < s.end - 0.03 ? now : s.start;
      dirtyRef.current = true;
      void ws.play(resume, s.end);
      return;
    }
    selPlayRef.current = false;
    void ws.play();
  }, [ready, currentRegion]);

  const handleStop = useCallback(() => {
    wsRef.current?.stop();
    selPlayRef.current = false;
    playheadRef.current = -1;
    dirtyRef.current = true;
  }, []);

  /* ── 键盘：空格播放/暂停，Shift 控制选区模式 ── */
  useEffect(() => {
    const isTyping = (el: EventTarget | null): boolean => {
      const n = el as HTMLElement | null;
      return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = true;
        setShiftHeld(true);
        return;
      }
      if (e.code === 'Space' || e.key === ' ') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        togglePlay();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = false;
        setShiftHeld(false);
      }
    };
    const onBlur = () => {
      shiftHeldRef.current = false;
      setShiftHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [togglePlay]);

  // -------------------------------------------------------------------------
  // 名称输入：打开即聚焦并全选
  // -------------------------------------------------------------------------
  // 目的：切完片段后最常见的一步就是改名。全选状态下直接打字即可覆写，
  // 不必先手动清空 —— 少一次「三击选中」的操作。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     导入选区到素材箱
     ═══════════════════════════════════════════════════════════════ */

  const handleImport = useCallback(async () => {
    if (importingRef.current) return;
    if (!sel) {
      toast('请先按住 Shift 在波形上拖拽选择一段区域');
      return;
    }
    // 切片源优先用引擎缓存（symphonia 原生采样率，与入库/播放链路一致）；
    // wavesurfer 的 getDecodedData 走 WebAudio 会重采样到设备采样率，仅兜底。
    let full = getCachedBuffer(sampleId);
    if (!full) {
      const blob = useStore.getState().blobs[sampleId];
      if (blob) {
        try {
          const decoded = await decodeAudioBlobShared(sampleId, blob);
          cacheBuffer(sampleId, decoded.buffer);
          full = decoded.buffer;
        } catch {
          /* 解码失败则回退 wavesurfer */
        }
      }
    }
    full ??= wsRef.current?.getDecodedData() ?? null;
    if (!full) {
      toast('音频尚未解码完成，请稍候');
      return;
    }

    importingRef.current = true;
    setImporting(true);
    // 让「解码入库中…」先上屏，再做耗时编码
    await new Promise((r) => setTimeout(r, 0));

    try {
      const blob = await encodeRegionWavAsync(full, sel.start, sel.end);
      const finalName = name.trim() || defaultSliceName(sampleName, existingNames);
      const res = await addSampleFromFile(blob, finalName);
      if (res.ok) toast({ text: `已入库：${finalName}`, kind: 'success' });
      else toast({ text: res.error ?? '入库失败', kind: 'error' });
    } catch (err) {
      toast({ text: `切片编码失败：${String(err)}`, kind: 'error' });
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [sel, name, sampleName, sampleId, addSampleFromFile]);

  const clearSelection = useCallback(() => {
    currentRegion()?.remove();
  }, [currentRegion]);

  const selDur = sel ? sel.end - sel.start : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`编辑 · ${sampleName}`}
      size="xl"
      centered
      footer={
        <div className="flex w-full items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-small text-label-muted">切片名</span>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 输入框里回车 = 直接导入（省一次鼠标移动）
                if (e.key === 'Enter' && sel && !importing) {
                  e.preventDefault();
                  void handleImport();
                }
              }}
              aria-label="切片名称"
              placeholder={sampleName}
              className="h-ctl-md min-w-0 flex-1 rounded-sm bg-ink-950 px-2 text-small text-label-hi outline-none shadow-[inset_0_0_0_1px_rgb(var(--line))] transition-shadow focus:shadow-[inset_0_0_0_1px_rgb(var(--flame-500)/0.7)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!sel || importing}
            title={!sel ? '先在波形上按住 Shift 拖出一段选区' : '导入到素材箱（回车）'}
            className="flex h-ctl-md shrink-0 items-center gap-2 rounded-sm bg-flame-400 px-3 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-label-faint"
          >
            {importing ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-ink-950/30 border-t-ink-950"
                />
                编码中…
              </>
            ) : (
              '导入素材箱'
            )}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-2.5">
        {/* ═══ 波形 ═══
            层序（关键，顺序颠倒会让 Shift 拖拽建区失效）：
              1. 自绘 canvas —— 在下层，`pointer-events:none`，负责全部可见内容；
              2. wavesurfer 容器 —— 在上层，**透明但吃指针事件**，
                 承载 regions 元素与宽度测量，是 Shift 拖拽建区的唯一命中面。

            注意：canvas 绝不能在 wavesurfer 之上。若在之上，即使加
            pointer-events:none 也会让 regions 的拖拽命中区被遮挡判定错位；
            若不加，则彻底挡住建区。故固定为「canvas 在下」。 */}
        <div className="relative overflow-hidden rounded-md bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
          <canvas
            ref={overlayRef}
            className="pointer-events-none absolute inset-0 block h-full w-full"
            aria-hidden="true"
          />
          <div
            ref={containerRef}
            className="relative h-[160px] w-full touch-none select-none"
            style={{ cursor: shiftHeld ? 'crosshair' : 'text' }}
            aria-label="波形与选区"
          />
          {ready && zoomPct !== 100 && (
            <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-sm bg-ink-900/90 px-1.5 py-0.5 font-mono text-micro tabular-nums text-flame-300">
              {zoomPct}%
            </span>
          )}
          {!ready && (
            <span className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-small text-label-muted">
              解码中…
            </span>
          )}
          {shiftHeld && (
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-sm bg-flame-600/25 px-1.5 py-0.5 text-micro text-flame-200">
              Shift · 拖拽选区
            </span>
          )}
        </div>

        {/* ═══ 传输条 ═══ */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!ready}
            className="flex h-ctl-md items-center gap-1.5 rounded-sm bg-flame-400 px-3 text-small font-semibold text-ink-950 transition-colors hover:bg-flame-300 disabled:opacity-40"
          >
            {playing ? <IconPause size={12} /> : <IconPlay size={12} />}
            {playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={!ready}
            title="停止并回到起点"
            className="icon-btn"
            aria-label="停止"
          >
            <IconStop size={12} />
          </button>

          <button
            type="button"
            onClick={() => setAutoPlay((a) => !a)}
            disabled={!ready}
            aria-pressed={autoPlay}
            title="拖拽出选区后自动试听"
            className={`flex h-ctl-md items-center gap-1.5 rounded-sm px-2.5 text-small font-medium transition-colors disabled:opacity-40 ${
              autoPlay
                ? 'bg-flame-600/20 text-flame-300'
                : 'text-label-lo hover:bg-ink-800 hover:text-label-hi'
            }`}
          >
            {autoPlay ? <IconVolume size={13} /> : <IconVolumeOff size={13} />}
            自动试听
          </button>

          <span className="min-w-2 flex-1" />

          <span className="font-mono text-small tabular-nums text-label-lo">
            {formatTime(currentTime)}
            <span className="text-label-faint"> / {formatTime(duration)}</span>
          </span>
        </div>

        {/* ═══ 选区信息 / 操作提示（二选一，不并存） ═══ */}
        {sel ? (
          <div className="flex flex-wrap items-center gap-2 rounded-sm bg-ink-900 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            <IconCheck size={13} className="shrink-0 text-flame-300" />
            <span className="text-small text-label-muted">选区</span>
            <span className="font-mono text-small tabular-nums text-flame-300">
              {formatTime(sel.start)} – {formatTime(sel.end)}
            </span>
            <span className="font-mono text-tiny tabular-nums text-label-faint">
              {selDur.toFixed(2)}s
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto text-small text-label-muted transition-colors hover:text-danger"
            >
              清除
            </button>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm bg-ink-900 px-2.5 py-1.5 text-tiny text-label-muted shadow-[inset_0_0_0_1px_rgb(var(--line))]">
            <IconAlert size={12} className="shrink-0 text-label-faint" />
            <span>
              <b className="font-medium text-label-lo">Shift + 拖拽</b> 选区
            </span>
            <span className="text-label-faint">·</span>
            <span>点击波形跳转</span>
            <span className="text-label-faint">·</span>
            <span>空格 播放/暂停</span>
            <span className="text-label-faint">·</span>
            <span>滚轮缩放（Shift 平移）</span>
          </p>
        )}
      </div>
    </Modal>
  );
}

/** 局部 alpha 化（避免为一行引入整个 withAlpha 依赖链） */
function withAlphaLocal(hex: string, alpha: number): string {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}
