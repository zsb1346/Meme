/**
 * 全站 SVG 图标集。
 *
 * 为什么必须有这个文件：旧实现把导航 SVG 内联在 App.tsx、把 20+ 个其他图标
 * 写成 emoji（麦克风 / 谱号 / 喇叭 / 文件夹 / 钢琴 / 静音 / 铅笔 / 垃圾桶 / 齿轮 / 归位 / 播放 / 停止 共 12 种）。emoji 的问题：
 *   1. 每个平台的渲染都不同，无法控制线宽与对齐；
 *   2. 与 1.6px 的 SVG 图标混排时基线、视觉重量全对不上；
 *   3. 是「廉价感」与「占空间」的重要来源。
 *
 * 结构：`PATHS` 是可序列化的图标数据表（name → SVG 子元素数组），
 * `createIcon` 是工厂，把每个条目变成一个受控的 React 组件。
 * 这样既避免了为 40 个图标各写一个组件，也不需要在图标组件间透传 children。
 *
 * 统一规范：viewBox 0 0 24 24 · fill=none · stroke=currentColor ·
 * strokeWidth 1.6（导航/工具）或 1.8（方向/播放）· linecap/linejoin round。
 * 尺寸由调用方决定（推荐 className="h-4 w-4"，或传 size 数字）。
 */
import type { ReactNode, SVGProps } from 'react';

/* ═══════════════════════════════════════════════════════════════
   图标数据表
   ═══════════════════════════════════════════════════════════════ */

/** 单个图标定义：children 为 SVG 子元素；可选覆写线宽与填充模式 */
interface IconDef {
  d: ReactNode;
  /** 线宽，默认 1.6 */
  w?: number;
  /** true = 实心图标（播放/停止/握把等），此时忽略 stroke */
  solid?: boolean;
}

const PATHS = {
  /* ── 导航（4 个主页面）── */
  /** 素材箱：四宫格 */
  library: {
    d: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="3" width="8" height="8" rx="2" />
        <rect x="3" y="13" width="8" height="8" rx="2" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
      </>
    ),
  },
  /** 演奏台：力度条阵（四根高低柱） */
  stage: { d: <path d="M4 18V9M9 18V4M14 18v-6M19 18V7" /> },
  /** 制作台：八分音符 + 双符头 */
  studio: {
    d: (
      <>
        <path d="M9 18V5l11-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="17" cy="16" r="3" />
      </>
    ),
  },
  /** 混音台：三条推子轨道 + 旋钮 */
  mix: {
    d: (
      <>
        <path d="M6 4v6m0 4v6M12 4v2m0 4v10M18 4v8m0 4v4" />
        <circle cx="6" cy="13" r="2" />
        <circle cx="12" cy="8" r="2" />
        <circle cx="18" cy="14" r="2" />
      </>
    ),
  },
  /** 品牌标：棱镜（六边形 + 内折线），呼应「折射 / 调音」 */
  brand: {
    d: (
      <>
        <path d="M12 2.6l8.4 5v8.8L12 21.4 3.6 16.4V7.6z" />
        <path d="M12 8.2v7.6M8.9 10L12 8.2l3.1 1.8" />
      </>
    ),
  },

  /* ── 传输控制 ── */
  play: { w: 1.8, solid: true, d: <path d="M8 5l11 7-11 7z" /> },
  stop: { w: 1.8, solid: true, d: <rect x="7" y="7" width="10" height="10" rx="2" /> },
  pause: {
    w: 1.8,
    solid: true,
    d: (
      <>
        <rect x="7" y="5" width="3.5" height="14" rx="1.5" />
        <rect x="13.5" y="5" width="3.5" height="14" rx="1.5" />
      </>
    ),
  },
  /** 录制：同心圆（外环描边 + 实心内点） */
  record: {
    d: (
      <>
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      </>
    ),
  },

  /* ── 文件 / 数据 ── */
  upload: { d: <path d="M12 16V4M7.5 8.5L12 4l4.5 4.5M5 20h14" /> },
  download: { d: <path d="M12 4v12M7.5 11.5L12 16l4.5-4.5M5 20h14" /> },
  importMidi: {
    d: (
      <>
        <path d="M9 17V5l11-2v12" />
        <circle cx="6" cy="17" r="3" />
        <path d="M20 11v6M17.5 14.5L20 17l2.5-2.5" />
      </>
    ),
  },
  package: {
    d: (
      <>
        <path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
        <path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" />
      </>
    ),
  },

  /* ── 编辑 / 操作 ── */
  rename: {
    d: (
      <>
        <path d="M4 20l4-1 9.5-9.5a2.1 2.1 0 0 0-3-3L5 16z" />
        <path d="M14 6.5l3 3" />
      </>
    ),
  },
  trash: { d: <path d="M4 7h16M9 7V5h6v2M6 7v12h12V7" /> },
  plus: { w: 1.7, d: <path d="M12 5v14M5 12h14" /> },
  minus: { w: 1.7, d: <path d="M5 12h14" /> },
  close: { w: 1.7, d: <path d="M6 6l12 12M18 6L6 18" /> },
  check: { w: 1.8, d: <path d="M5 12.5l4.5 4.5L19 7" /> },
  undo: { d: <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4 4v4h4" /> },
  redo: { d: <path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5M20 4v4h-4" /> },
  copy: {
    d: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </>
    ),
  },
  paste: {
    d: (
      <>
        <path d="M9 4h6v3H9z" />
        <path d="M15 5.5h2A2 2 0 0 1 19 7.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h2" />
      </>
    ),
  },
  search: {
    d: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4 4" />
      </>
    ),
  },
  settings: {
    d: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5" />
      </>
    ),
  },
  info: {
    d: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5M12 8.2v.6" />
      </>
    ),
  },
  alert: { d: <path d="M12 3.5L21 19H3zM12 10v4M12 16.6v.6" /> },
  /** 电源（段/单元启用开关）：断口圆环 + 竖线 */
  power: {
    w: 1.7,
    d: (
      <>
        <path d="M12 3.5v8" />
        <path d="M7.2 6.6a7 7 0 1 0 9.6 0" />
      </>
    ),
  },

  /* ── 卷帘 / 时间轴 ── */
  /** 横向缩小（时间轴压紧） */
  zoomOut: { w: 1.7, d: <path d="M6 12h12" /> },
  /** 横向放大（时间轴展开） */
  zoomIn: { w: 1.7, d: <path d="M12 6v12M6 12h12" /> },
  /** 纵向铺满：左右箭头对 + 中线 */
  fit: { d: <path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" /> },
  /** 吸附：磁铁 */
  snap: {
    d: (
      <>
        <path d="M7 4v7a5 5 0 0 0 10 0V4h-3v7a2 2 0 0 1-4 0V4z" />
        <path d="M7 4h3M14 4h3" />
      </>
    ),
  },
  pencil: { d: <path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16zM15 5l4 4" /> },
  /** 框选：虚线矩形 */
  marquee: {
    d: (
      <>
        <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
        <path d="M11 4h2M11 20h2M4 11v2M20 11v2" />
      </>
    ),
  },

  /* ── 音频 / 效果 ── */
  /** 试听：五条对称衰减柱 */
  waveform: { d: <path d="M4 10v4M7.5 7v10M11 4.5v15M14.5 8v8M18 10.5v3M21 12v.5" /> },
  /** 效果器：三条推子 + 旋钮 */
  effects: {
    d: (
      <>
        <path d="M6 4v5m0 4v7M12 4v10m0 4v2M18 4v3m0 4v9" />
        <circle cx="6" cy="11" r="2" />
        <circle cx="12" cy="16" r="2" />
        <circle cx="18" cy="9" r="2" />
      </>
    ),
  },
  /** 均衡器：频响曲线 + 两个节点 */
  eq: {
    d: (
      <>
        <path d="M3 15c3 0 4-7 7-7s4 6 7 6 4-3 4-3" />
        <circle cx="10" cy="8" r="1.8" />
        <circle cx="17" cy="14" r="1.8" />
      </>
    ),
  },
  volume: {
    d: (
      <>
        <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
        <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
      </>
    ),
  },
  volumeOff: {
    d: (
      <>
        <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
        <path d="M16 10l4 4M20 10l-4 4" />
      </>
    ),
  },

  /* ── 键盘 / 演奏 / 杂项 ── */
  /** 键盘绑定：键盘轮廓 + 键帽点 */
  keyboard: {
    d: (
      <>
        <rect x="2.5" y="6.5" width="19" height="11" rx="2.5" />
        <path d="M7 10v1M11 10v1M15 10v1M7 13.5h10" />
      </>
    ),
  },
  fullscreen: { d: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /> },
  chevronDown: { w: 1.8, d: <path d="M5 8l5 5 5-5" /> },
  chevronRight: { w: 1.8, d: <path d="M9 5l5 5-5 5" /> },
  /** 握把：两点列（拖拽排序用） */
  grip: {
    solid: true,
    d: (
      <>
        <circle cx="9" cy="6" r="1.4" />
        <circle cx="15" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" />
        <circle cx="15" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" />
        <circle cx="15" cy="18" r="1.4" />
      </>
    ),
  },

  /* ── 合规入口（AGPL-3.0 §13 要求网络用户能拿到源码）── */
  /** 源码：尖括号代码符号 */
  source: {
    d: (
      <>
        <path d="M9 8L5 12l4 4" />
        <path d="M15 8l4 4-4 4" />
        <path d="M13.5 5.5l-3 13" />
      </>
    ),
  },
} satisfies Record<string, IconDef>;

/** 图标名 */
export type IconName = keyof typeof PATHS;

/* ═══════════════════════════════════════════════════════════════
   组件工厂
   ═══════════════════════════════════════════════════════════════ */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** 边长 px；缺省由 className 控制（推荐 className="h-4 w-4"） */
  size?: number;
}

function createIcon(name: IconName) {
  const def = PATHS[name] as IconDef;
  const Icon = ({ size, className, ...rest }: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill={def.solid ? 'currentColor' : 'none'}
      stroke={def.solid ? 'none' : 'currentColor'}
      strokeWidth={def.w ?? 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
      {...(size !== undefined ? { width: size, height: size } : {})}
      {...(className !== undefined ? { className } : {})}
    >
      {def.d}
    </svg>
  );
  Icon.displayName = `Icon.${name}`;
  return Icon;
}

/* ── 具名导出：按语义命名，调用处读起来像自然语言 ── */

export const IconLibrary = createIcon('library');
export const IconStage = createIcon('stage');
export const IconStudio = createIcon('studio');
export const IconMix = createIcon('mix');
export const IconBrand = createIcon('brand');

export const IconPlay = createIcon('play');
export const IconStop = createIcon('stop');
export const IconPause = createIcon('pause');
export const IconRecord = createIcon('record');

export const IconUpload = createIcon('upload');
export const IconDownload = createIcon('download');
export const IconImportMidi = createIcon('importMidi');
export const IconPackage = createIcon('package');

export const IconRename = createIcon('rename');
export const IconTrash = createIcon('trash');
export const IconPlus = createIcon('plus');
export const IconMinus = createIcon('minus');
export const IconClose = createIcon('close');
export const IconCheck = createIcon('check');
export const IconUndo = createIcon('undo');
export const IconRedo = createIcon('redo');
export const IconCopy = createIcon('copy');
export const IconPaste = createIcon('paste');
export const IconSearch = createIcon('search');
export const IconSettings = createIcon('settings');
export const IconInfo = createIcon('info');
export const IconAlert = createIcon('alert');
export const IconPower = createIcon('power');

export const IconZoomOut = createIcon('zoomOut');
export const IconZoomIn = createIcon('zoomIn');
export const IconFit = createIcon('fit');
export const IconSnap = createIcon('snap');
export const IconPencil = createIcon('pencil');
export const IconMarquee = createIcon('marquee');

export const IconWaveform = createIcon('waveform');
export const IconEffects = createIcon('effects');
export const IconEq = createIcon('eq');
export const IconVolume = createIcon('volume');
export const IconVolumeOff = createIcon('volumeOff');

export const IconKeyboard = createIcon('keyboard');
export const IconFullscreen = createIcon('fullscreen');
export const IconChevronDown = createIcon('chevronDown');
export const IconChevronRight = createIcon('chevronRight');
export const IconGrip = createIcon('grip');

/* ── 合规入口 ── */
export const IconSource = createIcon('source');
