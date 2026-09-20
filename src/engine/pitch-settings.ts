/**
 * 音高检测参数（持久化到 localStorage）。
 * 检测组改 → 清缓存重算；显示组改 → 只重渲染。
 */

export type Detector = 'yin' | 'ai';

export interface PitchSettings {
  // 检测组（改 → 清缓存重算）
  detector: Detector;
  threshold: number;
  minHz: number;
  maxHz: number;
  // 显示组（改 → 只重渲染）
  a4Hz: number;
  showSolfege: boolean;
  showCents: boolean;
}

export const DEFAULTS: PitchSettings = {
  detector: 'yin',
  threshold: 0.12,
  minHz: 65,
  maxHz: 1200,
  a4Hz: 440,
  showSolfege: true,
  showCents: true,
};

const STORAGE_KEY = 'meme-studio:pitch-settings';

/** 判断当前 settings 是否等同默认（决定要不要跳过 store 缓存） */
export function isDefaultDetect(s: PitchSettings): boolean {
  return (
    s.detector === DEFAULTS.detector &&
    s.threshold === DEFAULTS.threshold &&
    s.minHz === DEFAULTS.minHz &&
    s.maxHz === DEFAULTS.maxHz
  );
}

/** PitchSettings → YinOptions（只传检测组） */
export function settingsToYinOpts(s: PitchSettings) {
  return { threshold: s.threshold, minHz: s.minHz, maxHz: s.maxHz };
}

/** 判断 YIN opts 是否等同默认（纯 opts 对象，不带 detector） */
export function isDefaultYinOpts(opts: { threshold?: number; minHz?: number; maxHz?: number }): boolean {
  return (
    (opts.threshold ?? DEFAULTS.threshold) === DEFAULTS.threshold &&
    (opts.minHz ?? DEFAULTS.minHz) === DEFAULTS.minHz &&
    (opts.maxHz ?? DEFAULTS.maxHz) === DEFAULTS.maxHz
  );
}

export function loadPitchSettings(): PitchSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    /**
     * 意图：逐字段校验类型，坏值用默认值。
     * 旧版 `{ ...DEFAULTS, ...parsed }` 不校验类型 ——
     * 如果 localStorage 里 threshold 被存成字符串 "0.5"，
     * 后续 `s.threshold === 0.12` 比较永远 false，参数永远不对。
     * 逐字段 typeof + Number.isFinite 保证每个字段类型正确。
     * 注：本文件全项目零调用，先防御性写好，接上调用时直接可用。
     */
    return {
      detector: typeof parsed.detector === 'string' && (parsed.detector === 'yin' || parsed.detector === 'ai')
        ? parsed.detector : DEFAULTS.detector,
      threshold: typeof parsed.threshold === 'number' && Number.isFinite(parsed.threshold)
        ? parsed.threshold : DEFAULTS.threshold,
      minHz: typeof parsed.minHz === 'number' && Number.isFinite(parsed.minHz)
        ? parsed.minHz : DEFAULTS.minHz,
      maxHz: typeof parsed.maxHz === 'number' && Number.isFinite(parsed.maxHz)
        ? parsed.maxHz : DEFAULTS.maxHz,
      a4Hz: typeof parsed.a4Hz === 'number' && Number.isFinite(parsed.a4Hz)
        ? parsed.a4Hz : DEFAULTS.a4Hz,
      showSolfege: typeof parsed.showSolfege === 'boolean'
        ? parsed.showSolfege : DEFAULTS.showSolfege,
      showCents: typeof parsed.showCents === 'boolean'
        ? parsed.showCents : DEFAULTS.showCents,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 200ms 节流写入 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function savePitchSettings(s: PitchSettings): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // 隐私模式 / 配额满 → 静默忽略
    }
    saveTimer = null;
  }, 200);
}
