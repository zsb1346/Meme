/**
 * 波表库 / 带限波形 / 噪声缓冲 —— 全部**程序生成**，不引入任何二进制资源。
 *
 * 移植自 `原型/效果器/VFX声音设计/VFX.html`（`WT_DEFS`、`classicWave`、
 * `buildAdditiveWave`、`getGranTexture`、白/粉/棕噪声缓冲）。
 *
 * ══ 为什么不用浏览器自带的 `osc.type` ══
 *
 * 原型的注释写得很清楚：直接写 `sawtooth` 拿不到**脉宽**、拿不到**初始相位**，
 * 谐波档位还被实现写死。改成自己算谐波再交给 `createPeriodicWave` 之后：
 *   · 浏览器仍会按播放频率**自动带限**（不会混叠），但
 *   · 我们拿回了脉宽（PWM 音色）与初始相位（Unison 各声部错开起音，
 *     消掉同相叠加的起音爆点）。
 *
 * ══ 缓存的三条规矩 ══
 *
 * ① `PeriodicWave` **属于某个 ctx**（`createPeriodicWave` 是 ctx 的方法），
 *    所以任何缓存都必须按 ctx 失效。用户的音频上下文被换掉时
 *    （`ensureEngine` 里就有这条路）旧对象不能复用 —— 这里每张表/每个波形都
 *    记住自己的 ctx，发现不是同一个就重建。
 * ② 缓存的 key 必须**包含随量化变化的量**（脉宽档、相位档、帧号），
 *    否则「拧脉宽旋钮纹丝不动」。
 * ③ 波表帧是**惰性**算的：5 类 × 4 表 × 16 帧 = 320 帧，全量预计算要几十毫秒，
 *    而一次会话里多半只用到其中一两张。
 */

import type { WtCat, GranTex } from './patch';

/** 每张波表的谐波条数（原型 WT_N） */
export const WT_N = 24;
/** 每张波表的帧数（原型 WT_FRAMES） */
export const WT_FRAMES = 16;

/** 一帧波表的谐波振幅（real 恒为 0：原型只用正弦分量） */
export interface WtFrame {
  real: Float32Array;
  imag: Float32Array;
  /** 逐 ctx 的 PeriodicWave 缓存（按相位档）；换 ctx 时整组丢弃 */
  _ctx?: BaseAudioContext;
  _waves?: Array<PeriodicWave | undefined>;
}

// ---------------------------------------------------------------------------
// 谐波振幅发生器
// ---------------------------------------------------------------------------

const sawAmps = (N = WT_N): number[] =>
  Array.from({ length: N + 1 }, (_, n) => (n === 0 ? 0 : 1 / n));
const squareAmps = (N = WT_N): number[] =>
  Array.from({ length: N + 1 }, (_, n) => (n % 2 === 1 ? 1 / n : 0));
const triAmps = (N = WT_N): number[] =>
  Array.from({ length: N + 1 }, (_, n) =>
    n % 2 === 1 ? (((n - 1) / 2) % 2 === 0 ? 1 : -1) / (n * n) : 0,
  );
const sineAmps = (N = WT_N): number[] => {
  const a = new Array<number>(N + 1).fill(0);
  a[1] = 1;
  return a;
};
const pulseAmps = (w: number, N = WT_N): number[] =>
  Array.from({ length: N + 1 }, (_, n) =>
    n === 0 ? 0 : (2 / (n * Math.PI)) * Math.sin(n * Math.PI * w),
  );

const lerpAmps = (a: number[], b: number[], t: number): number[] =>
  a.map((v, n) => v + ((b[n] || 0) - v) * t);
/** 频谱倾斜：`t = 0` 原样（全亮），`t = 1` 每高一个八度掉约 13 dB（很暗） */
const tiltAmps = (a: number[], t: number): number[] =>
  a.map((v, n) => (n === 0 ? 0 : v * Math.pow(n, -(1 - t) * 0.9)));
const bumpAmps = (a: number[], center: number, width: number, gain: number): number[] =>
  a.map((v, n) => v + gain * Math.exp(-((n - center) ** 2) / (2 * width * width)));
/** 确定性伪随机（同一个 n / t 永远给同一个值）—— 波表必须可复现，不能用 Math.random */
const hashAmp = (n: number, t: number): number =>
  Math.abs(((Math.sin(n * 12.9898 + t * 78.233) * 43758.5453) % 1) + 1) % 1;

/** 波表定义：5 大类 × 4 张表，每张表是一个 `t → 谐波振幅` 的生成函数 */
export const WT_DEFS: Record<WtCat, { name: string; tables: Array<{ name: string; gen(t: number): number[] }> }> = {
  analog: {
    name: '模拟',
    tables: [
      { name: '锯齿→方波', gen: (t) => lerpAmps(sawAmps(), squareAmps(), t) },
      { name: '脉冲扫描', gen: (t) => pulseAmps(0.5 - 0.4 * t) },
      {
        name: '经典主音',
        gen: (t) => {
          const a = sawAmps();
          a[1] *= 1.4;
          a[2] *= 1.2;
          return tiltAmps(a, t);
        },
      },
      { name: '三角→锯齿', gen: (t) => lerpAmps(triAmps(), sawAmps(), t) },
    ],
  },
  digital: {
    name: '数码',
    tables: [
      {
        name: 'FM 钟',
        gen: (t) =>
          sawAmps().map((_, n) =>
            n === 0 ? 0 : Math.abs(Math.sin(n * (0.6 + 3 * t))) * Math.pow(n, -0.9),
          ),
      },
      { name: '8bit 锯齿', gen: () => sawAmps().map((v) => Math.round(v * 5) / 5) },
      { name: '游戏脉冲', gen: (t) => lerpAmps(pulseAmps(0.25), squareAmps(), t) },
      {
        name: '数码簇',
        gen: (t) =>
          sawAmps().map((_v, n) =>
            n === 0 ? 0 : 0.3 / n + Math.exp(-((n - (3 + 10 * t)) ** 2) / 8),
          ),
      },
    ],
  },
  bass: {
    name: '贝斯',
    tables: [
      {
        name: 'Reese 厚重',
        gen: (t) => {
          const a = sawAmps();
          a[1] *= 1.7;
          a[2] *= 1.3;
          return tiltAmps(a, t * 0.6);
        },
      },
      { name: '酸性 Acid', gen: (t) => bumpAmps(sawAmps(), 3 + Math.round(8 * t), 1.6, 1.8) },
      {
        name: '低吼 Growl',
        gen: (t) =>
          sawAmps().map((_v, n) =>
            n === 0 ? 0 : (n % 2 ? 1.5 : 0.5) / n + (t * 0.35 * hashAmp(n, 3.7)) / n,
          ),
      },
      { name: 'Sub→锯齿', gen: (t) => lerpAmps(sineAmps(), sawAmps(), t) },
    ],
  },
  pad: {
    name: '铺底',
    tables: [
      { name: '温暖', gen: (t) => sawAmps().map((_, n) => (n === 0 ? 0 : Math.pow(n, -1.5 + t * 0.6))) },
      {
        name: '空气',
        gen: (t) => {
          const a = sineAmps();
          a[3] = 0.3 + 0.3 * t;
          a[5] = 0.25 * t;
          a[7] = 0.2 * t;
          a[9] = 0.15 * t;
          return a;
        },
      },
      {
        name: '合唱人声',
        gen: (t) =>
          bumpAmps(
            bumpAmps(
              sawAmps().map((v, n) => (n === 0 ? 0 : v / n)),
              4 + 2 * t,
              1.2,
              0.9,
            ),
            8,
            1.8,
            0.6 * t,
          ),
      },
      {
        name: '太空',
        gen: (t) => {
          const a = new Array<number>(WT_N + 1).fill(0);
          [1, 2, 3, 5, 7, 11, 13, 17].forEach((p, i) => {
            if (p <= WT_N) {
              a[p] = Math.pow(0.72, i) * (0.4 + 0.6 * (i / 7) * t + 0.4 * (1 - t) * (1 - i / 7));
            }
          });
          return a;
        },
      },
    ],
  },
  fx: {
    name: '特效',
    tables: [
      {
        name: '激光',
        gen: (t) =>
          sawAmps().map((_v, n) => (n === 0 ? 0 : Math.exp(-((n - (14 - 12 * t)) ** 2) / 6) + 0.5 / n)),
      },
      { name: '异星', gen: (t) => sawAmps().map((_, n) => (n === 0 ? 0 : hashAmp(n, t) * Math.pow(n, -0.6))) },
      {
        name: '机器',
        gen: (t) => {
          const a = squareAmps();
          for (let n = 9; n <= 14; n++) a[n] += 0.3 * t;
          return a;
        },
      },
      {
        name: '噪声云',
        gen: (t) => sawAmps().map((_, n) => (n === 0 ? 0 : (0.4 + hashAmp(n, t * 2)) * Math.pow(n, -0.5))),
      },
    ],
  },
};

/** 波表缓存：`cat/idx` → 16 帧（惰性生成，生成后常驻） */
const wtCache = new Map<string, WtFrame[]>();

/** 某张波表的 16 帧（首次调用时才计算） */
export function getWavetable(cat: WtCat, idx: number): WtFrame[] {
  const def = WT_DEFS[cat];
  const i = Number.isFinite(idx) ? Math.min(def.tables.length - 1, Math.max(0, Math.round(idx))) : 0;
  const key = `${cat}/${i}`;
  const hit = wtCache.get(key);
  if (hit) return hit;
  const gen = def.tables[i].gen;
  const frames: WtFrame[] = [];
  for (let f = 0; f < WT_FRAMES; f++) {
    const amps = gen(f / (WT_FRAMES - 1));
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps.length);
    for (let n = 0; n < amps.length; n++) imag[n] = amps[n];
    frames.push({ real, imag });
  }
  wtCache.set(key, frames);
  return frames;
}

/** 波表/类别的中文名（面板用；`wtTable` 的读数要把表名显示出来才认得出） */
export function wtTableName(cat: WtCat, idx: number): string {
  const def = WT_DEFS[cat];
  const i = Math.min(def.tables.length - 1, Math.max(0, Math.round(idx)));
  return def.tables[i].name;
}

// ---------------------------------------------------------------------------
// 经典引擎：带限波形（可选脉宽、可选初始相位）
// ---------------------------------------------------------------------------

/** 谐波条数（`PeriodicWave` 会按播放频率自动带限，可以给足） */
export const CLASSIC_HARM = 64;
/** 脉宽量化档数（决定缓存规模与 PWM 扫动的颗粒感） */
export const PW_BUCKETS = 24;
/** 初始相位档数，Unison 每声部随机取一档 */
export const PHASE_BUCKETS = 8;

/**
 * 脉宽量化档。
 *
 * ⛔ 量化是**必须**的：波形重建要遍历 64 条谐波，若每一帧的 `oscPW` 都重建，
 * 拖一次旋钮就是上千次 `createPeriodicWave`。跨档才重建，同档直接返回。
 */
export function pwBucket(pw: number): number {
  const v = Number.isFinite(pw) ? pw : 0.5;
  return Math.min(PW_BUCKETS - 1, Math.max(1, Math.round(v * PW_BUCKETS)));
}

/** 单声部时相位不可闻，固定 0 以省缓存 */
export function pickPhaseIdx(voices: number): number {
  return voices > 1 ? Math.floor(Math.random() * PHASE_BUCKETS) : 0;
}

function classicAmps(type: string, pw: number): Float32Array {
  const N = CLASSIC_HARM;
  const a = new Float32Array(N + 1);
  if (type === 'sine') {
    a[1] = 1;
    return a;
  }
  if (type === 'square') {
    for (let n = 1; n <= N; n += 2) a[n] = 1 / n;
    return a;
  }
  if (type === 'triangle') {
    for (let n = 1; n <= N; n += 2) a[n] = (((n - 1) / 2) % 2 === 0 ? 1 : -1) / (n * n);
    return a;
  }
  if (type === 'pulse') {
    const w = Math.min(0.98, Math.max(0.02, pw));
    for (let n = 1; n <= N; n++) a[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * w);
    return a;
  }
  for (let n = 1; n <= N; n++) a[n] = 1 / n; // sawtooth
  return a;
}

/**
 * 带限波形的缓存。
 *
 * ⛔ key 里必须同时有 **ctx 身份**、类型、脉宽档、相位档 —— 少任何一个都会
 * 变成「换了 ctx 之后 PeriodicWave 不认」或「拧脉宽没反应」。
 */
let classicCacheCtx: BaseAudioContext | null = null;
const classicCache = new Map<string, PeriodicWave>();

/**
 * 取（必要时创建）一个带限波形。
 *
 * 谐波 n 上的整体相移 φ 表现为 y 分量的 nφ 旋转 —— 这是 Unison 各声部
 * 「错开起音」的数学依据，也是原来两算子相加会爆点的解药。
 */
export function classicWave(
  ctx: BaseAudioContext,
  type: string,
  pw: number,
  phaseIdx: number,
): PeriodicWave {
  if (classicCacheCtx !== ctx) {
    classicCache.clear();
    classicCacheCtx = ctx;
  }
  const pb = type === 'pulse' ? pwBucket(pw) : 0;
  const ph = phaseIdx || 0;
  const key = `${type}|${pb}|${ph}`;
  const hit = classicCache.get(key);
  if (hit) return hit;
  const amps = classicAmps(type, type === 'pulse' ? pb / PW_BUCKETS : 0.5);
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps.length);
  const phi = (ph / PHASE_BUCKETS) * Math.PI * 2;
  for (let n = 1; n < amps.length; n++) {
    const a = amps[n];
    if (!a) continue;
    imag[n] = a * Math.cos(n * phi);
    real[n] = -a * Math.sin(n * phi);
  }
  const w = ctx.createPeriodicWave(real, imag);
  classicCache.set(key, w);
  return w;
}

/** 加法引擎的波形：谐波表 + 频谱倾斜（`tilt` 0 = 全亮，1 = 很暗） */
export function buildAdditiveWave(
  ctx: BaseAudioContext,
  harm: readonly number[],
  tilt: number,
): PeriodicWave {
  const n = Math.min(harm.length, 32);
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  const k = Math.min(1, Math.max(0, tilt)) * 2.2;
  for (let i = 1; i <= n; i++) imag[i] = (harm[i - 1] ?? 0) * Math.pow(i, -k);
  return ctx.createPeriodicWave(real, imag);
}

/** 波表某一帧的 PeriodicWave（按相位档缓存，理由同 `classicWave`） */
export function wtFrameWave(ctx: BaseAudioContext, frame: WtFrame, phaseIdx: number): PeriodicWave {
  if (frame._ctx !== ctx) {
    frame._ctx = ctx;
    frame._waves = [];
  }
  const ph = phaseIdx || 0;
  const cached = frame._waves?.[ph];
  if (cached) return cached;
  let w: PeriodicWave;
  if (ph === 0) {
    w = ctx.createPeriodicWave(frame.real, frame.imag);
  } else {
    const n = frame.real.length;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const phi = (ph / PHASE_BUCKETS) * Math.PI * 2;
    for (let i = 1; i < n; i++) {
      const a = frame.imag[i];
      if (!a) continue;
      imag[i] = a * Math.cos(i * phi);
      real[i] = -a * Math.sin(i * phi);
    }
    w = ctx.createPeriodicWave(real, imag);
  }
  if (frame._waves) frame._waves[ph] = w;
  return w;
}

// ---------------------------------------------------------------------------
// 噪声缓冲（白 / 粉 / 棕）
// ---------------------------------------------------------------------------

export interface NoiseBuffers {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

/**
 * 白 / 粉 / 棕噪声。
 *
 * ⚠️ 长度 8 秒（原型原本 2 秒）：短缓冲循环播放时**能听出周期性重复**
 * （2 秒 → 0.5 Hz 的「呼吸」），8 秒把重复感推到几乎不可闻。代价是
 * 每块 8s × 4B ≈ 1.4 MB（单声道），三块约 4 MB —— 一次性、且只在引擎建立时。
 */
export function makeNoiseBuffers(ctx: BaseAudioContext): NoiseBuffers {
  const len = Math.floor(ctx.sampleRate * 8);
  const mk = () => ctx.createBuffer(1, len, ctx.sampleRate);
  const wbuf = mk();
  const pbuf = mk();
  const bbuf = mk();
  const w = wbuf.getChannelData(0);
  const pk = pbuf.getChannelData(0);
  const br = bbuf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let brown = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    w[i] = white;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    pk[i] = (b0 + b1 + b2 + white * 0.1848) * 0.25;
    brown = (brown + 0.02 * white) / 1.02;
    br[i] = brown * 3.2;
  }
  return { white: wbuf, pink: pbuf, brown: bbuf };
}

// ---------------------------------------------------------------------------
// 粒子纹理（2.4 秒的合成素材，粒子引擎的「原料」）
// ---------------------------------------------------------------------------

/** 粒子纹理缓存（按 ctx 失效；单条要一百多毫秒，必须缓存） */
let granCacheCtx: BaseAudioContext | null = null;
const granCache = new Map<GranTex, AudioBuffer>();

/**
 * 粒子引擎的纹理缓冲（锯齿群 / 钟 / 人声 / 空气）。
 *
 * ⚠️ 单条生成要一百多毫秒（逐样点叠加谐波），所以：
 *   · 必须缓存（同一条纹理只算一次）；
 *   · 引擎建立后**预热**（`SynthEngine` 构造里排一次），否则第一次按粒化音
 *     会卡在起音上 —— 用户听到的是「按下去过一会儿才响」。
 */
export function getGranTexture(ctx: BaseAudioContext, kind: GranTex): AudioBuffer {
  if (granCacheCtx !== ctx) {
    granCache.clear();
    granCacheCtx = ctx;
  }
  const hit = granCache.get(kind);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  if (kind === 'saw') {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) {
        s += Math.sin(2 * Math.PI * 110 * h * t) / h + (0.5 * Math.sin(2 * Math.PI * 110.7 * h * t)) / h;
      }
      d[i] = s * 0.18;
    }
  } else if (kind === 'bell') {
    const partials = [1, 2.76, 5.4, 8.93];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let s = 0;
      partials.forEach((r, k) => {
        s += (Math.sin(2 * Math.PI * 220 * r * t) * Math.exp(-t * (1.2 + k))) / (k + 1);
      });
      d[i] = s * 0.5;
    }
  } else if (kind === 'vox') {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5 * t);
      let s = 0;
      [1, 2, 3, 4, 5].forEach((h) => {
        const formant =
          Math.exp(-((h * 220 - 700) ** 2) / (2 * 250 * 250)) +
          Math.exp(-((h * 220 - 1200) ** 2) / (2 * 300 * 250));
        s += Math.sin(2 * Math.PI * 220 * h * vib * t) * (0.25 / h + formant * 0.4);
      });
      d[i] = s * 0.45;
    }
  } else {
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const white = Math.random() * 2 - 1;
      const cut = 0.02 + 0.06 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.35 * t));
      lp += cut * (white - lp);
      d[i] = lp * 2.2;
    }
  }
  granCache.set(kind, buf);
  return buf;
}
