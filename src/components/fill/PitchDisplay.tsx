import { useEffect, useMemo, useState } from 'react';
import {
  getPitchWorkerStatus,
  getSamplePitchHzDetailed,
  invalidatePitchCache,
  subscribePitchStatus,
  type PitchLookup,
  type PitchWorkerStatus,
} from '../../engine/pitch-async';
import {
  loadPitchSettings,
  savePitchSettings,
  settingsToYinOpts,
  type PitchSettings,
} from '../../engine/pitch-settings';
import { useDebounce } from '../../hooks/useDebounce';
import type { SampleId } from '../../model/types';
import { PitchSettingsPanel } from './PitchSettingsPanel';
import { IconChevronDown, IconSettings } from '../ui/Icon';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;
const SOLFEGE   = ['do','re','mi','fa','sol','la','si'] as const;

interface Props {
  sampleId: SampleId | null;
  /** resolveSemitones(candidateId) + delta */
  semitones: number;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; staleHz: number | null }
  | { kind: 'nodetect' }
  | { kind: 'ok'; hz: number; note: string; sol: string; cents: number };

/**
 * PitchDisplay —— 候选素材的音高读数面板。
 *
 * ══ 排版重做（用户反馈：参数一多就挤）══
 *
 * 旧版的问题：
 *   1. 固定 `w-56`（224px）却只放一个大音符名，**中间大片空白**；
 *   2. 音名（text-5xl）、唱名（text-2xl）、Hz、音分各自成行、字重相近，
 *      没有主次，信息密度低而视觉噪音高；
 *   3. 「参数」展开后把整列往下撑长，弹层被迫变高 ——
 *      这是「挤」的直接来源：**参数不该参与主内容的布局流**。
 *
 * 新版策略：
 *   1. 音名是唯一主视觉（`text-[34px]` 等宽粗体），唱名降为同行的小徽章；
 *   2. Hz / 音分 / 采样率改成**标签-值两列紧凑网格**，一屏读完；
 *   3. 参数区**放进独立滚动容器**（`max-h-[220px] overflow-y-auto`），
 *      展开与否都不改变弹层高度；
 *   4. 面板宽度收到 `w-[212px]`（lg 以下铺满），把省下的宽度让给候选列表。
 */
export function PitchDisplay({ sampleId, semitones }: Props) {
  const [base, setBase] = useState<PitchLookup | null>(null);
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PitchSettings>(loadPitchSettings);
  /*
    初值取**当前**状态而不是固定的 `'ready'`：
    worker 可能在组件挂载**之前**就已经死了（用户先在别的面板待了一会儿）。
    只订阅事件的话，这里会从「一切正常」起步 —— 等于谎报。
  */
  const [workerStatus, setWorkerStatus] = useState<PitchWorkerStatus>(getPitchWorkerStatus);

  // 订阅 worker 状态变化（AI 模型加载 / worker 可用性）
  useEffect(() => {
    return subscribePitchStatus(setWorkerStatus);
  }, []);

  /**
   * worker 整个起不来（脚本没加载 / 崩了）。
   *
   * 与「AI 模型加载中」必须分开显示：后者是会自己好的「再等等」，
   * 前者不会 —— 混用的话，worker 死掉时这里会**永远**停在
   * 「首次加载 AI 模型…」，把一个「这里坏了」显示成「再等等」。
   */
  const workerDown = workerStatus === 'unavailable';

  // 检测参数 debounce（300ms）—— 只有这三个变化才触发重算
  const detectParams = useMemo(
    () => ({ t: settings.threshold, n: settings.minHz, m: settings.maxHz }),
    [settings.threshold, settings.minHz, settings.maxHz],
  );
  const debouncedDetect = useDebounce(detectParams, 300);
  const yinOpts = useMemo(
    () => settingsToYinOpts(settings),
    [debouncedDetect.t, debouncedDetect.n, debouncedDetect.m],
  );

  // 持久化 settings（200ms 节流写 localStorage）
  useEffect(() => {
    savePitchSettings(settings);
  }, [settings]);

  // 拉取 base：sampleId / detector / 检测参数变化时重算
  useEffect(() => {
    if (!sampleId) { setBase(null); setPending(false); return; }
    let cancelled = false;
    setPending(true);
    getSamplePitchHzDetailed(sampleId, settings.detector, yinOpts)
      .then((r) => { if (!cancelled) { setBase(r); setPending(false); } })
      .catch(() => { if (!cancelled) { setBase(null); setPending(false); } });
    return () => { cancelled = true; };
  }, [sampleId, settings.detector, yinOpts]);

  // 检测参数变化 → 清缓存
  useEffect(() => {
    if (sampleId) invalidatePitchCache(sampleId, yinOpts);
  }, [debouncedDetect.t, debouncedDetect.n, debouncedDetect.m]);

  const baseHz = base?.hz ?? null;
  /**
   * 请求了 AI 但实际由 YIN 兜底 —— 标题如实标出来。
   * 不标的话，标题写着「AI 音高」而值是 YIN 算的，等于向用户谎报来源。
   */
  const fellBack =
    settings.detector === 'ai' && base?.detector === 'yin' && baseHz != null;

  // 计算显示读数
  const st: State = (() => {
    if (!sampleId) return { kind: 'idle' as const };
    if (pending && baseHz == null) return { kind: 'loading' as const, staleHz: null };
    if (baseHz == null) return { kind: 'nodetect' as const };
    const hz = baseHz * Math.pow(2, semitones / 12);
    if (!Number.isFinite(hz) || hz <= 0) return { kind: 'nodetect' as const };
    const midiF = 69 + 12 * Math.log2(hz / settings.a4Hz);
    const midi = Math.round(midiF);
    const cents = Math.round((midiF - midi) * 100);
    const idx = ((midi % 12) + 12) % 12;
    return {
      kind: 'ok' as const, hz,
      note: `${NOTE_NAMES[idx]}${Math.floor(midi / 12) - 1}`,
      sol: SOLFEGE[idx],
      cents,
    };
  })();

  const inTune = st.kind === 'ok' && Math.abs(st.cents) <= 5;

  return (
    <aside className="flex min-w-0 flex-col self-stretch rounded-md bg-ink-950 shadow-[inset_0_0_0_1px_rgb(var(--line))] lg:w-[232px] lg:shrink-0">
      {/* ── 头部：检测器 + 参数开关 ── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <span className="font-mono text-micro uppercase tracking-[0.14em] text-label-muted">
          {settings.detector === 'ai'
            ? fellBack
              ? 'AI 音高 · YIN 兜底'
              : 'AI 音高'
            : 'YIN 音高'}
        </span>
        <span className="min-w-2 flex-1" />
        {pending && st.kind !== 'loading' && (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-flame-600/40 border-t-flame-400"
          />
        )}
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          title="检测参数"
          className={`grid h-5 w-5 place-items-center rounded-sm transition-colors ${
            settingsOpen ? 'bg-flame-600/25 text-flame-300' : 'text-label-faint hover:text-label-lo'
          }`}
        >
          <IconSettings size={12} />
        </button>
      </div>

      {/* ── 主读数：音名是唯一主视觉 ── */}
      <div className="flex shrink-0 flex-col items-center justify-center px-2.5 py-3">
        {st.kind === 'idle' && (
          <p className="py-2 text-small text-label-faint">无候选</p>
        )}
        {st.kind === 'loading' && (
          <>
            {st.staleHz != null && (
              <span className="font-mono text-lead tabular-nums text-label-muted">
                {st.staleHz.toFixed(1)}
              </span>
            )}
            <p className="text-small text-label-faint">
              {workerDown
                ? '音高检测暂不可用'
                : workerStatus === 'loading_model'
                  ? '首次加载 AI 模型…'
                  : '分析中…'}
            </p>
            {workerDown && (
              <p className="mt-0.5 text-center text-micro leading-relaxed text-label-faint">
                音高 worker 未能启动
              </p>
            )}
          </>
        )}
        {st.kind === 'nodetect' && (
          <p className="py-2 text-center text-small leading-relaxed text-label-faint">
            {workerDown ? (
              <>
                音高检测暂不可用
                <br />
                <span className="text-micro">音高 worker 未能启动（详见控制台）</span>
              </>
            ) : workerStatus === 'loading_model' ? (
              '首次加载 AI 模型…'
            ) : (
              <>
                未检出音高
                <br />
                <span className="text-micro">可在下方参数里放宽范围</span>
              </>
            )}
          </p>
        )}
        {st.kind === 'ok' && (
          <>
            {/* 音名是唯一主视觉（唱名徽章已随全站音名统一下线） */}
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[34px] font-bold leading-none tracking-[-0.02em] text-flame-300">
                {st.note}
              </span>
            </div>
            <span className="mt-1.5 font-mono text-small tabular-nums text-label-lo">
              {st.hz.toFixed(1)} Hz
            </span>
          </>
        )}
      </div>

      {/* ── 读数网格：标签-值两列，一屏读完 ── */}
      {st.kind === 'ok' && (
        <dl className="shrink-0 border-t border-line px-2.5 py-1.5 text-micro">
          {settings.showCents && (
            <div className="flex items-center justify-between py-px">
              <dt className="text-label-faint">音分</dt>
              <dd
                className={`font-mono tabular-nums ${
                  inTune ? 'text-success' : 'text-label-lo'
                }`}
              >
                {st.cents > 0 ? '+' : ''}
                {st.cents}
                {inTune && <span className="ml-1">准</span>}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between py-px">
            <dt className="text-label-faint">移调</dt>
            <dd className="font-mono tabular-nums text-label-lo">
              {semitones > 0 ? '+' : ''}
              {semitones} 半音
            </dd>
          </div>
          <div className="flex items-center justify-between py-px">
            <dt className="text-label-faint">A4 基准</dt>
            <dd className="font-mono tabular-nums text-label-lo">{settings.a4Hz} Hz</dd>
          </div>
        </dl>
      )}

      {/* ── 参数区：独立滚动，展开不改变弹层高度 ──
          为什么加 max-h：左栏候选列表的高度决定了弹层内容区高度，
          参数全展开会比它高 —— 不设上限就会溢出到弹层之外被裁掉。
          给一个独立滚动容器，参数再多也能滚到，且弹层尺寸稳定。 */}
      {settingsOpen && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-2.5 py-2">
          <PitchSettingsPanel value={settings} onChange={setSettings} />
        </div>
      )}

      {/* ── 底部提示：不展开参数时用它占住底部 ── */}
      {!settingsOpen && (
        <p className="mt-auto flex shrink-0 items-center justify-center gap-1 border-t border-line px-2 py-1.5 text-micro text-label-faint">
          <IconChevronDown size={11} className="rotate-180" />
          Shift+↑↓ 实时跟随
        </p>
      )}
    </aside>
  );
}
