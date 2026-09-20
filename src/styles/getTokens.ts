/**
 * 设计令牌读取器。
 *
 * canvas（波形、频谱、电平表、卷帘绘制等）无法引用 CSS 变量，故把
 * src/styles/tokens.css 的 RGB 三元组在运行时换算成十六进制字符串，
 * 供引擎/绘制层与 CSS 保持同一色值来源。
 *
 * 方案 · Apple Neutral：灰阶为零色偏中性灰，强调色为 Apple systemBlue。
 *
 * 结果进程内缓存；主题变更时调用 invalidateTokenCache() 后下次读取即刷新。
 */

/** 全站设计令牌（十六进制颜色字符串） */
export interface ThemeTokens {
  /* —— 面阶梯（四级 + 凹槽）—— */
  ink950: string;
  ink900: string;
  ink800: string;
  ink700: string;
  ink600: string;
  /** 卷帘白键行底色（黑键行直接用 ink950）—— canvas 专用，见 tokens.css */
  laneKey: string;
  /* —— 强调色阶梯（Apple systemBlue；唯一交互色）—— */
  flame200: string;
  flame300: string;
  flame400: string;
  flame500: string;
  flame600: string;
  flame700: string;
  /** 辅色（频谱 / 混响可视化的第二数据通道，非第二强调色） */
  violet400: string;
  violet500: string;
  /* —— 功能色（状态语义，固定不随主题漂移）—— */
  success: string;
  warning: string;
  danger: string;
  /* —— 文本阶梯 —— */
  /** 主文本（Apple label） */
  textHi: string;
  /** 次级文本（secondaryLabel） */
  textLo: string;
  /** 弱化文本（tertiaryLabel） */
  textMuted: string;
  /** 极弱文本（quaternaryLabel）：网格、刻度、占位 */
  textFaint: string;
}

/**
 * 兜底值 = tokens.css 的原始定义。仅在非 DOM 环境
 * （SSR / 单测无 document）或变量缺失时使用，保证返回值永远可用。
 */
const FALLBACK_TOKENS: ThemeTokens = {
  ink950: '#000000',
  ink900: '#1C1C1E',
  ink800: '#2C2C2E',
  ink700: '#3A3A3C',
  ink600: '#48484A',
  laneKey: '#242427',
  flame200: '#8FC0FF',
  flame300: '#7AB4FF',
  flame400: '#409CFF',
  flame500: '#2E8AEC',
  flame600: '#1F6FD0',
  flame700: '#154F98',
  violet400: '#5E5CE6',
  violet500: '#4B49C7',
  success: '#30D158',
  warning: '#FFD60A',
  danger: '#FF453A',
  textHi: '#F2F2F7',
  textLo: '#AEAEB2',
  textMuted: '#8E8E93',
  textFaint: '#636366',
};

/** 令牌键 → tokens.css 自定义属性名 */
const TOKEN_VARS: ReadonlyArray<readonly [keyof ThemeTokens, string]> = [
  ['ink950', '--ink-950'],
  ['ink900', '--ink-900'],
  ['ink800', '--ink-800'],
  ['ink700', '--ink-700'],
  ['ink600', '--ink-600'],
  ['laneKey', '--lane-key'],
  ['flame200', '--flame-200'],
  ['flame300', '--flame-300'],
  ['flame400', '--flame-400'],
  ['flame500', '--flame-500'],
  ['flame600', '--flame-600'],
  ['flame700', '--flame-700'],
  ['violet400', '--violet-400'],
  ['violet500', '--violet-500'],
  ['success', '--success'],
  ['warning', '--warning'],
  ['danger', '--danger'],
  ['textHi', '--text-hi'],
  ['textLo', '--text-lo'],
  ['textMuted', '--text-muted'],
  ['textFaint', '--text-faint'],
];

let cache: ThemeTokens | null = null;

/** "10 13 18" → "#0a0d12"；格式非法返回 null */
function tripletToHex(triplet: string): string | null {
  const parts = triplet.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const channels: number[] = [];
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n)) return null;
    channels.push(Math.max(0, Math.min(255, Math.round(n))));
  }
  return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 读取当前主题令牌（带缓存）。优先取 :root 计算样式中的三元组，
 * 失败时逐项回退到 FALLBACK_TOKENS。
 */
export function getTokens(): ThemeTokens {
  if (cache) return cache;
  const tokens: ThemeTokens = { ...FALLBACK_TOKENS };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const rootStyle = window.getComputedStyle(document.documentElement);
    for (const [key, cssVar] of TOKEN_VARS) {
      const hex = tripletToHex(rootStyle.getPropertyValue(cssVar));
      if (hex !== null) tokens[key] = hex;
    }
  }
  cache = tokens;
  return tokens;
}

/** 清空令牌缓存（主题切换 / 测试重置后调用） */
export function invalidateTokenCache(): void {
  cache = null;
}

/**
 * "#409CFF" + alpha → "rgba(64,156,255,0.55)"，供 canvas 绘制半透明变体。
 * 传入非法 hex 时原样返回（不吞色，便于排查）。
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
