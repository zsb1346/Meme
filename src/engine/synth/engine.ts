/**
 * SynthEngine —— 合成声部的**唯一发声实现**。
 *
 * 图结构与调音算法移植自 `原型/效果器/VFX.html`（用户自己调出来的「清音合成器 Pro」），
 * 这里做了四件「移植之外」的事，全部是为了**稳健**：
 *
 * ══ ① 与 Tone 的边界只有一处 ══
 *
 * 本模块只用**原生 WebAudio** 节点，不 import Tone。理由：链路里有
 * `WaveShaper.oversample`、`ChannelSplitter/Merger` 手写立体声矩阵、
 * `Convolver` 这些原生 API 才好表达的东西；混用两套对象模型是 bug 温床。
 * 唯一的交汇点是最后一句 `analyser.connect(ctx.destination)` —— 而这里收到的
 * `ctx` 就是 `core.getAudioContext()`（同一块硬件、同一个时钟），
 * 所以「同一上下文里两套节点」成立，不需要 Tone 侧的适配层。
 *
 * 参数类型是 `BaseAudioContext` 而不是 `AudioContext`：这样**测试与探针可以塞一个
 * `OfflineAudioContext` 进来离线渲染**，把「到底出没出声、峰值多少」变成可断言的
 * 数字（见 `scripts/probe-synth.html`）。离线渲染时自动不开清扫定时器（见下文③）。
 *
 * ══ ② 所有参数输入都过同一道闸 ══
 *
 * `setPatch` / `applyParam` 收到的东西一律先走 `sanitizeSynthPatch`。
 * 这不是「防御性编程」而是**已知事故的修复**：本项目曾因存档里出现 `undefined`
 * 而让 `AudioParam.setTargetAtTime` 抛 `TypeError`，抛点在渲染期 → React 卸载
 * 整棵树 → 用户看到整片黑屏。64 个数字参数里任何一个非有限值都能复现它，
 * 所以闸门放在**引擎入口**，而不是指望每个调用方自觉。
 *
 * ══ ③ 声音的结束时刻由「绝对时刻」决定，不由定时器决定 ══
 *
 * 起音/释放自动化全部用 `setValueAtTime(when)` + `ramp(when + Δ)` 预排在 ctx 时钟上
 * —— **定时器只负责事后回收节点**，它的抖动不影响声音。回收用一个 250ms 的清扫
 * 定时器统一做，而不是每个音符一个 `setTimeout`：一个定时器不可能泄漏，N 个就可能。
 * 离线渲染不开清扫（不然会在渲染中途把振荡器 `stop()` 掉，把音尾剪断）。
 *
 * ══ ④ 声部有硬上限，抢占最旧 ══
 *
 * 上限 32（VFX 原为 16）。同时响 30 个音的 take 少见，但真出现时引擎必须自己稳住，
 * 不能让节点爆炸卡住主线程。
 *
 * ══ ⑤ 「释放」和「拆节点」是两件事，中间不能断链 ══
 *
 * `voices`（在响，谁该被热更新）与 `dying`（已释放，谁该被拆）是两个集合，
 * **任何释放都必须经 `retire()` 把声部移交进 `dying`**。
 * 曾经的 bug 是「释放时从 `voices` 里删掉就算完」，而清扫器只遍历 `voices`
 * —— 松过手的声部就成了不可达的孤儿，永远拆不掉：节点越积越多，
 * 几十次按键之后音频线程顶不住 → **卡顿 → 没声**。详见 `dying` 字段的注释。
 *
 * ══ ⑥ 「静音」要靠排程，不能靠 disconnect ══
 *
 * AudioParam 的实际值 = 内置值 **+** 连入信号之和，所以「把包络拉到 1e-4」
 * 不等于静音；而滤波器又在包络**之前**，包络根本管不住它的自激。
 * 两路调制因此各自走一个**声部私有、可排程**的深度级：
 * `lfoAmpDepth` → `amp.gain`、`lfoFilterDepth` → `filter.frequency`，
 * 释放时一条 `setValueAtTime(0, at)` 就能精确归零。
 * 之所以不能用 `disconnect()`：它只有「立刻」一个时刻，而 `release()` 经常是在
 * 排一个**未来**才发生的自动释放（`noteOn` 里就排了一次）—— 在那儿断开会把仍在
 * 响的音的颤音当场摘掉。详见这两个字段的注释。
 */

import { midiToHz } from '../pitch';
import {
  DEFAULT_SYNTH_PATCH,
  FM_ALGOS,
  MAX_UNISON,
  sanitizeSynthParamValue,
  sanitizeSynthPatch,
  type GranTex,
  type ModDst,
  type ModSrc,
  type SynthPatch,
} from './patch';
import {
  buildAdditiveWave,
  classicWave,
  getGranTexture,
  getWavetable,
  makeNoiseBuffers,
  pickPhaseIdx,
  pwBucket,
  wtFrameWave,
  type NoiseBuffers,
} from './wavetables';

/** 声部通道：常规试听声 / 录制跟弹参考声（两条独立增益，互不静音） */
export type SynthChannel = 'voice' | 'feedback';

/** 指数斜坡不能到 0（会抛 / 会静音），全链路统一用这个下限 */
const MIN_GAIN = 1e-4;
/** 同时发声上限（超出时抢占最旧的声部） */
const MAX_VOICES = 32;
/** 低于此电平的振荡器不建节点（省 CPU，也是「音色里关掉某个振荡器」的实现） */
const OSC_LEVEL_EPS = 0.0015;
/** 声部回收清扫周期 */
const REAPER_INTERVAL_MS = 250;
/** 释放结束后再多留一点再拆节点，避免把尾音切掉 */
const DISPOSE_PAD_SEC = 0.12;
/** 混响脉冲响应重建的防抖（拖「空间」旋钮时不能每帧重建 IR） */
const IR_DEBOUNCE_MS = 180;
/** 通道总线基准增益（沿用 VFX 的 0.9） */
const CHANNEL_GAIN = 0.9;
/** 快速释放时长（抢占 / 全部停止）—— 短到听不出来，长到不会「咔」 */
const FAST_RELEASE_SEC = 0.012;
/** 调制矩阵的控制速率（原型是音频线程 60Hz；这里用主线程单一定时器，见 `tickMod`） */
const MOD_TICK_MS = 16;
/** 粒子引擎的前瞻窗口：主线程被重建面板/切引擎卡住半秒也不会掉 grain */
const GRAN_LOOKAHEAD_SEC = 0.5;
/** 一次补发最多造多少个 grain（长卡顿后一次性补出上千个会把主线程彻底打死） */
const GRAN_BURST_LIMIT = 256;
/** FM 调制指数上限（超过这个数只是在加噪声） */
const MAX_FM_INDEX = 32;
/** FM 调制指数 → 赫兹的换算因子：`增益(Hz) = 指数 × 算子频率` */
const FM_INDEX_MAX = 8;

function rand(a: number, b?: number): number {
  return b === undefined ? Math.random() * a : a + Math.random() * (b - a);
}

/**
 * 调制矩阵的「源 → 数值」解析式。
 *
 * 与音频域 LFO 同波形同速率 —— 矩阵是控制速率的，但听感上必须与 LFO 同步，
 * 否则「LFO1 直接进滤波器」和「LFO1 经矩阵进滤波器」会听到两个不同的抖动。
 */
export function lfoValue(wave: string, phase: number): number {
  const x = phase - Math.floor(phase);
  switch (wave) {
    case 'triangle':
      return 4 * Math.abs(x - 0.5) - 1;
    case 'square':
      return x < 0.5 ? 1 : -1;
    case 'sawtooth':
      return 1 - 2 * x;
    default:
      return Math.sin(x * Math.PI * 2);
  }
}

/** 每个调制目标的一格「满量程」——决定同一个 `amt` 在不同目标上手感一致 */
const MOD_SCALE: Record<string, number> = {
  pitch: 1200,
  cutoff: 8000,
  reso: 16,
  amp: 0.6,
  pan: 1,
  fm: 4, // fm 以「调制指数」为单位
  wtpos: 1,
  pw: 0.45,
  drive: 1,
  reverb: 1,
  delay: 1,
  bit: 12,
};

/**
 * 「全局目标」= 只能改整条效果链、没法按声部改的那些。
 *
 * ⛔ 这个集合与 `SynthVoice.applyMod` 里那条 `continue` 必须一字不差 ——
 * 两边不一致的后果是：某个目标被**当成本地目标**静默吃掉（旋钮转了没反应），
 * 或者被**两边同时写**（两个引擎级的曲线重建互相打架）。
 */
const GLOBAL_MOD_DSTS = new Set<string>(['drive', 'reverb', 'delay', 'bit']);

/**
 * 滤波前驱动曲线。
 *
 * `amount < 0.001` 时返回**真直通**（一条直线）—— 不是「接近直通」：
 * 0 位置的曲线若带一点弯曲，用户会以为「前级驱动旋钮在 0 的时候音色也被染了」。
 *
 * ⚠️ 取样点数走共用的 `CURVE_LEN`（奇数），理由见 `CURVE_LEN` 的注释：
 * 偶数长度会让「输入 0」落在两点之间，插值出一个常量 = **直流偏置**。
 *
 * ⚠️ 返回类型刻意**不手写**（`Float32Array<ArrayBufferLike>` 与
 * `WaveShaperNode.curve` 要求的 `Float32Array<ArrayBuffer>` 不兼容，
 * 一个注解就把本来能通过的赋值变成编译错误），缓存表的类型也用
 * `ReturnType<typeof build>` 反向取，避免手写泛型。
 */
function buildFilterDriveCurve(amount: number) {
  const n = CURVE_LEN;
  const curve = new Float32Array(n);
  const v = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  if (v < 0.001) {
    for (let i = 0; i < n; i++) curve[i] = (i * 2) / CURVE_DEN - 1;
  } else {
    const drive = 1 + v * 7;
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / CURVE_DEN - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
  }
  return curve;
}

const driveCurveCache = new Map<number, ReturnType<typeof buildFilterDriveCurve>>();

export function makeFilterDriveCurve(amount: number) {
  const a = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const bucket = Math.round(a * 100);
  const hit = driveCurveCache.get(bucket);
  if (hit) return hit;
  const curve = buildFilterDriveCurve(bucket / 100);
  driveCurveCache.set(bucket, curve);
  return curve;
}

/**
 * 两级双二阶串联的滤波器组。
 *
 * 12 dB/oct 只走第一级，24 dB/oct 串上第二级（原型「阶梯滤波」的斜率）。
 * 对外的 `.frequency` / `.Q` 是**转发代理**，会同时写两级的 AudioParam ——
 * 于是包络、LFO、调制矩阵那些调用点一行都不用改，也不必担心两级参数不同步。
 * 需要真实 AudioParam 做音频连线时用 `connectFreq` / 两级各自的 `frequency`。
 *
 * ⚠️ `setSlope` 会**断线重连**：这是唯一一处运行期的图结构改动，切换瞬间
 * 滤波器的状态（内部延迟）会清零，听感上是一声极轻的「噗」。原型也这样，
 * 且切斜率本来就是「换个音色」，可以接受；但**不要在 60Hz 的调制循环里调它**。
 */
export interface FilterBank {
  readonly stages: [BiquadFilterNode, BiquadFilterNode];
  readonly frequency: RampParam;
  readonly Q: RampParam;
  type: BiquadFilterType;
  twoStage(): boolean;
  setSlope(slope: number): void;
  connectFreq(node: AudioNode): void;
  disconnectFreq(node: AudioNode): void;
  disconnect(): void;
}

function buildFilterBank(ctx: BaseAudioContext, dest: AudioNode): FilterBank {
  const stages: [BiquadFilterNode, BiquadFilterNode] = [
    ctx.createBiquadFilter(),
    ctx.createBiquadFilter(),
  ];
  const proxy = (key: 'frequency' | 'Q'): RampParam => {
    const p: RampParam = {
      get value() {
        return stages[0][key].value;
      },
      set value(v: number) {
        for (const s of stages) s[key].value = v;
      },
      setValueAtTime(v: number, t: number) {
        for (const s of stages) s[key].setValueAtTime(v, t);
        return p;
      },
      linearRampToValueAtTime(v: number, t: number) {
        for (const s of stages) s[key].linearRampToValueAtTime(v, t);
        return p;
      },
      exponentialRampToValueAtTime(v: number, t: number) {
        for (const s of stages) s[key].exponentialRampToValueAtTime(v, t);
        return p;
      },
      setTargetAtTime(v: number, t: number, c: number) {
        for (const s of stages) s[key].setTargetAtTime(v, t, c);
        return p;
      },
      cancelScheduledValues(t: number) {
        for (const s of stages) s[key].cancelScheduledValues(t);
        return p;
      },
      cancelAndHoldAtTime(t: number) {
        for (const s of stages) s[key].cancelAndHoldAtTime(t);
        return p;
      },
    };
    return p;
  };
  let two = false;
  const bank: FilterBank = {
    stages,
    frequency: proxy('frequency'),
    Q: proxy('Q'),
    get type() {
      return stages[0].type;
    },
    set type(v: BiquadFilterType) {
      for (const s of stages) s.type = v;
    },
    twoStage: () => two,
    setSlope(slope: number) {
      const next = slope >= 24;
      if (next === two) return;
      two = next;
      quietly(() => stages[0].disconnect());
      if (two) {
        stages[0].connect(stages[1]);
        stages[1].connect(dest);
      } else {
        quietly(() => stages[1].disconnect());
        stages[0].connect(dest);
      }
    },
    connectFreq(node: AudioNode) {
      for (const s of stages) node.connect(s.frequency);
    },
    disconnectFreq(node: AudioNode) {
      for (const s of stages) quietly(() => node.disconnect(s.frequency));
    },
    disconnect() {
      for (const s of stages) quietly(() => s.disconnect());
    },
  };
  stages[0].connect(dest);
  return bank;
}

/** 单引用的 AudioParam */
/** 单引用的 AudioParam */
/** 单引用的 AudioParam */
/**
 * 能「按住当前值再排自动化」的参数。
 *
 * 刻意用一个**结构类型**而不是 `AudioParam`：两级滤波组的 `.frequency` / `.Q`
 * 是转发代理（同时写两级），它不是 `AudioParam` 的实例，但有完全一样的方法。
 * 若把 `holdParam` 的形参钉成 `AudioParam`，调用点就得写类型断言 ——
 * 而断言恰好会掩盖「代理少实现了某个方法」这种真问题。
 */
export interface HoldableParam {
  value: number;
  cancelScheduledValues(startTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  cancelAndHoldAtTime?(cancelTime: number): unknown;
}

/** 还能排斜坡 / 目标值的参数 */
export interface RampParam extends HoldableParam {
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 单步失败不牵连其余 —— 一个断不开的连接不该拖垮整页。
 * （`disconnect` 对「本来就没连过」的目的地会抛 `NotFoundError`，而调用点
 * 往往是幂等的清理路径，所以这里一律吞掉。）
 */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    /* 已断开 / 已停止的节点：忽略 */
  }
}

/**
 * 把参数「按住」在当前值再排新的自动化。
 *
 * `cancelAndHoldAtTime` 是正解（保留已进行的斜坡），旧 Safari 没有这个方法，
 * 故退回「读当前值 + 取消 + 钉住」。
 */
function holdParam(param: HoldableParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time);
  } else {
    const v = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(v, time);
  }
}

/**
 * 波形整形曲线的取样点数 —— **必须是奇数**。
 *
 * ⛔ 曾经用 2048（偶数），于是 `x = (i*2)/n - 1` 在整个数组里**取不到 0**：
 * 最接近的两个点是 `-1/1024` 与 `+1/1024`。而 `WaveShaperNode` 把输入 0 映射到
 * 索引 `(0+1)/2*(n-1) = 1023.5` —— **正好落在这两点之间**，于是插值出一个
 * 约 `-5e-4` 的**常量**。正弦过零、乃至「所有音量都为 0」的静音 patch，
 * 出来都带一个 −60 dBFS 的**直流偏置**（实测 rms ≈ peak ≈ 7.9e-4，就是直流的指纹）。
 *
 * 直流本身听不见，但它会一路喂给延迟/混响的反馈路径，而且让
 * 「静音 = 绝对零」这条判据失效 —— 而项目规矩是「有没有出声必须用**绝对量**」，
 * 基线不干净，绝对量就没有意义。
 *
 * 取奇数之后 `x=0` 恰好落在 `i=(n-1)/2` 上，且任意输入 0 都精确命中该点 →
 * 奇对称的整形函数（tanh / 硬限幅 / 折叠）输出恒为 0，**天然无直流**。
 * 附带把整条曲线的插值误差减半。
 */
const CURVE_LEN = 2049;
/** 曲线的自变量步长分母（`CURVE_LEN - 1`，保证首点 = −1、末点 = +1） */
const CURVE_DEN = CURVE_LEN - 1;

/**
 * 失真曲线（三种削波形态）。
 *
 * 导出**只为测试**（`curve.test.ts` 用量化到「WaveShaper 在输入 0 处取到什么」
 * 的方式钉死「无直流」这条性质）—— 业务代码请走 `buildFx`。
 */
export function makeDistCurve(amount: number, type: string) {
  const n = CURVE_LEN;
  const curve = new Float32Array(n);
  if (amount < 0.005) {
    for (let i = 0; i < n; i++) curve[i] = (i * 2) / CURVE_DEN - 1;
    return curve;
  }
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / CURVE_DEN - 1;
    if (type === 'hard') {
      const k = 1 + amount * 8;
      curve[i] = clamp(x * k, -0.92, 0.92);
    } else if (type === 'fold') {
      let y = x * (1 + amount * 4);
      while (Math.abs(y) > 1) y = 2 * Math.sign(y) - y;
      curve[i] = y;
    } else {
      const k = amount * 40;
      curve[i] = Math.tanh(x * (1 + k * 0.08));
    }
  }
  return curve;
}

/**
 * 位深量化曲线。
 *
 * ⚠️ 刻意**不写返回类型注解**：TS 5.7 起 TypedArray 带上缓冲区泛型，
 * 手写 `: Float32Array` 会推成 `Float32Array<ArrayBufferLike>`，
 * 而 `WaveShaperNode.curve` 要的是 `Float32Array<ArrayBuffer>` ——
 * 一个类型注解就把本来能通过的赋值变成编译错误。让推断决定最稳。
 */
/** 位深量化曲线。导出只为测试，理由见 `makeDistCurve`。 */
export function makeBitCurve(bits: number) {
  const n = CURVE_LEN;
  const curve = new Float32Array(n);
  const levels = Math.pow(2, Math.max(2, bits)) / 2;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / CURVE_DEN - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

/** 生成混响脉冲响应（噪声 × 指数衰减） */
function makeIR(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** 效果链节点集（整体构建后赋值，避免一堆确定断言的 `!`） */
interface FxChain {
  shaper: WaveShaperNode;
  chorusLfo: OscillatorNode;
  chorusDry: GainNode;
  chorusWet: GainNode;
  delayNode: DelayNode;
  delayFb: GainNode;
  delayWet: GainNode;
  delayHP: BiquadFilterNode;
  delayLP: BiquadFilterNode;
  delayPan: StereoPannerNode;
  reverbWet: GainNode;
  reverbPre: DelayNode;
  convolver: ConvolverNode;
  reverbDamp: BiquadFilterNode;
  bitShaper: WaveShaperNode;
  widthLL: GainNode;
  widthLR: GainNode;
  widthRL: GainNode;
  widthRR: GainNode;
  masterPan: StereoPannerNode;
  masterFilter: BiquadFilterNode;
  /** 链头 / 链尾：总线接 input，主控接 output */
  input: GainNode;
  output: BiquadFilterNode;
}

/** 组装效果链 —— 顺序与 VFX 完全一致（这是音色的一部分，不要重排） */
function buildFx(ctx: BaseAudioContext, patch: SynthPatch): FxChain {
  const maxF = ctx.sampleRate * 0.45;

  const distIn = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistCurve(patch.drive, patch.driveType);
  shaper.oversample = '4x';
  const distOut = ctx.createGain();
  distIn.connect(shaper).connect(distOut);

  const chorusIn = ctx.createGain();
  const chorusOut = ctx.createGain();
  const chorusDry = ctx.createGain();
  const chorusWet = ctx.createGain();
  chorusDry.gain.value = 1;
  chorusWet.gain.value = 0;
  const chorusDelay = ctx.createDelay(0.1);
  chorusDelay.delayTime.value = 0.02;
  const chorusLfo = ctx.createOscillator();
  chorusLfo.frequency.value = patch.chorusRate;
  const chorusLfoGain = ctx.createGain();
  chorusLfoGain.gain.value = 0.004;
  chorusLfo.connect(chorusLfoGain).connect(chorusDelay.delayTime);
  chorusLfo.start();
  chorusIn.connect(chorusDry).connect(chorusOut);
  chorusIn.connect(chorusDelay).connect(chorusWet).connect(chorusOut);

  const delayIn = ctx.createGain();
  const delayOut = ctx.createGain();
  const delayDry = ctx.createGain();
  const delayWet = ctx.createGain();
  delayDry.gain.value = 1;
  delayWet.gain.value = 0;
  const delayNode = ctx.createDelay(2);
  delayNode.delayTime.value = patch.delayTime;
  const delayFb = ctx.createGain();
  delayFb.gain.value = Math.min(0.92, patch.delayFb);
  const delayHP = ctx.createBiquadFilter();
  delayHP.type = 'highpass';
  delayHP.frequency.value = clamp(patch.delayHP, 10, maxF);
  const delayLP = ctx.createBiquadFilter();
  delayLP.type = 'lowpass';
  delayLP.frequency.value = clamp(patch.delayLP, 10, maxF);
  const delayPan = ctx.createStereoPanner();
  delayPan.pan.value = patch.delayPan;
  delayIn.connect(delayDry).connect(delayOut);
  delayIn.connect(delayNode);
  delayNode.connect(delayHP).connect(delayLP);
  delayLP.connect(delayFb).connect(delayNode);
  delayLP.connect(delayPan).connect(delayWet).connect(delayOut);

  const reverbIn = ctx.createGain();
  const reverbOut = ctx.createGain();
  const reverbDry = ctx.createGain();
  const reverbWet = ctx.createGain();
  reverbDry.gain.value = 1;
  reverbWet.gain.value = 0;
  const reverbPre = ctx.createDelay(0.5);
  reverbPre.delayTime.value = patch.reverbPre;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeIR(ctx, patch.reverbSize, 3);
  const reverbDamp = ctx.createBiquadFilter();
  reverbDamp.type = 'lowpass';
  reverbDamp.frequency.value = clamp(patch.reverbDamp, 10, maxF);
  reverbIn.connect(reverbDry).connect(reverbOut);
  reverbIn
    .connect(reverbPre)
    .connect(convolver)
    .connect(reverbDamp)
    .connect(reverbWet)
    .connect(reverbOut);

  const bitIn = ctx.createGain();
  const bitShaper = ctx.createWaveShaper();
  bitShaper.curve = makeBitCurve(patch.bitDepth);
  const bitOut = ctx.createGain();
  bitIn.connect(bitShaper).connect(bitOut);

  const widthIn = ctx.createGain();
  const widthOut = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const widthLL = ctx.createGain();
  const widthLR = ctx.createGain();
  const widthRL = ctx.createGain();
  const widthRR = ctx.createGain();
  const a = (1 + patch.stereoWidth) / 2;
  const b = (1 - patch.stereoWidth) / 2;
  widthLL.gain.value = a;
  widthLR.gain.value = b;
  widthRL.gain.value = b;
  widthRR.gain.value = a;
  widthIn.connect(split);
  split.connect(widthLL, 0);
  split.connect(widthLR, 0);
  split.connect(widthRL, 1);
  split.connect(widthRR, 1);
  widthLL.connect(merge, 0, 0);
  widthRL.connect(merge, 0, 0);
  widthLR.connect(merge, 0, 1);
  widthRR.connect(merge, 0, 1);
  merge.connect(widthOut);

  const masterPan = ctx.createStereoPanner();
  masterPan.pan.value = patch.masterPan;
  const masterFilter = ctx.createBiquadFilter();
  masterFilter.type = patch.masterFilterType;
  masterFilter.frequency.value = clamp(patch.masterFilterCutoff, 10, maxF);
  masterFilter.Q.value = patch.masterFilterReso;

  distOut.connect(chorusIn);
  chorusOut.connect(delayIn);
  delayOut.connect(reverbIn);
  reverbOut.connect(bitIn);
  bitOut.connect(widthIn);
  widthOut.connect(masterPan);
  masterPan.connect(masterFilter);

  return {
    shaper,
    chorusLfo,
    chorusDry,
    chorusWet,
    delayNode,
    delayFb,
    delayWet,
    delayHP,
    delayLP,
    delayPan,
    reverbWet,
    reverbPre,
    convolver,
    reverbDamp,
    bitShaper,
    widthLL,
    widthLR,
    widthRL,
    widthRR,
    masterPan,
    masterFilter,
    input: distIn,
    output: masterFilter,
  };
}

/** Voice 需要从引擎读到的全部东西（显式接口 = 不会顺手摸到别处） */
interface VoiceHost {
  ctx: BaseAudioContext;
  patch: SynthPatch;
  noiseBufs: NoiseBuffers;
  granBuf(kind: GranTex): AudioBuffer;
  lfoPitch: GainNode;
  lfoFilter: GainNode;
  lfoAmp: GainNode;
  lfo2Pitch: GainNode;
  lfo2Filter: GainNode;
  lfo2Amp: GainNode;
  lastNoteFreq: number;
  busFor(channel: SynthChannel): GainNode;
}

/**
 * 一条振荡器。
 *
 * `freq` 是**已经算好八度/比率之后**的目标频率：`trigger` 之后所有自动化
 * 都基于它，而参数热更新（`osc2Oct` 之类）会重算它。
 */
interface OscUnit {
  osc: OscillatorNode;
  panner: StereoPannerNode;
  /** Unison 内的位置 −1…+1（音量/失谐/立体声的分布依据） */
  spread: number;
  phaseIdx: number;
  waveType: string;
  freq: number;
}

/** 一组 Unison 振荡器（共享一个音量级与声像级） */
interface OscEntry {
  gain: GainNode;
  panner: StereoPannerNode;
  oscs: OscUnit[];
  /** 经典引擎：0/1/2 → 响应 `oscN*` 参数；−1 → 不响应任何单个振荡器的参数 */
  slot: number;
  /** 频率基数（Hz，未含八度）——`oscNOct` 热更新时用它重算 */
  baseFreq: number;
  /** 八度倍率 */
  octMul: number;
  /** detune 的「基准」在 patch 里的键（经典引擎 = `oscNDetune`，其余 = `osc1Detune`） */
  detuneKey: keyof SynthPatch;
  useBaseDetune: boolean;
}

/** 波表引擎的一条：两个振荡器交叉淡化，才拿得到帧间的连续过渡 */
interface WtPair {
  oA: OscillatorNode;
  oB: OscillatorNode;
  gA: GainNode;
  gB: GainNode;
  panner: StereoPannerNode;
  spread: number;
  phase: number;
}

interface WtEntry {
  gain: GainNode;
  panner: StereoPannerNode;
  pairs: WtPair[];
  frames: ReturnType<typeof getWavetable>;
}

/** FM 的调制算子（2/3/4 号） */
interface FmOp {
  osc: OscillatorNode;
  /** 调制输出（增益 = 调制指数 × 算子频率） */
  mod: GainNode;
  /** 直接发声输出（只有被算法选为载波的算子才开） */
  aud: GainNode;
  panner: StereoPannerNode;
  ratio: number;
}

/** 弦鸣（Karplus-Strong）的延迟反馈环 */
interface StringUnit {
  burst: AudioBufferSourceNode;
  burstG: GainNode;
  delay: DelayNode;
  damp: BiquadFilterNode;
  fb: GainNode;
  out: GainNode;
}

/** 粒子调度器状态 */
interface GranUnit {
  out: GainNode;
  buf: AudioBuffer;
  tex: GranTex;
  nextTime: number;
  alive: boolean;
}

/**
 * 单个声部。
 *
 * 保留的是 VFX 的**调音数学**（滤波器键跟随、包络形状、FM/RM 接法、
 * Unison 的分布、Karplus-Strong 的反馈环）—— 那就是音色本身。
 * 改掉的是三处：
 *   · 调度改成「一切按传入的绝对时刻排程」（构造期**不** start 任何源）；
 *   · 删掉 VFX 里那 6 个「增益恒为 1、纯做二传」的声部级 LFO 节点
 *     （引擎 LFO 增益直接接声部参数，32 声部时省下近 200 个节点）；
 *   · 把 VFX 那句「release 里 `setTimeout(dispose)`」换成交给引擎的清扫器
 *     （一个定时器管全部声部；N 个 `setTimeout` 才可能泄漏）。
 */
class SynthVoice {
  private readonly eng: VoiceHost;
  private readonly midi: number;
  private readonly velocity: number;
  private readonly freq: number;
  /** 单音模式下滑音的起点频率；null = 不需要滑音 */
  private readonly glideFrom: number | null;
  private readonly mixer: GainNode;
  /** 两级双二阶滤波组（12/24 dB 斜率由 `filterSlope` 决定） */
  private readonly filter: FilterBank;
  /** 滤波前饱和：24dB 阶梯那点「脏」味来自这里，曲线为直线时等于直通 */
  private readonly filterDrive: WaveShaperNode;
  private readonly amp: GainNode;
  /**
   * 调制矩阵「音量」目标的落点。
   *
   * ⛔ 为什么不直接写 `amp.gain`：包络也在写同一个 AudioParam，两者会互相
   * 取消（包络的斜坡被矩阵的 `setTargetAtTime` 冲掉，起音就没了）。
   * 多一级之后，矩阵写它、包络写 `amp`，互不打架。
   */
  private readonly vcaMod: GainNode;
  private readonly panner: StereoPannerNode;
  /**
   * 幅度调制深度 —— **每个声部私有**的一级增益。
   *
   * ⛔ 为什么不让 `lfoAmp` 直连 `amp.gain`，而要多这一级：
   *
   * AudioParam 的实际值是「内置值 **+** 所有连入信号之和」。所以释放斜坡把
   * 内置值拉到 `MIN_GAIN`（1e-4）**并不等于静音** —— 只要 LFO 还接着，增益就
   * 一直在 `MIN_GAIN ± lfoAmpAmt` 之间摆动。预设表里有 13 款 `lfoAmpAmt` 非零
   * （最大 0.22 ≈ −13 dB），实测离线渲染 0.2s 释放后、`[2.0s,4.0s]` 窗口的
   * rms 仍有 **0.05 量级** —— 用户听到的就是「松手了还在响」。
   *
   * ⛔ 也**不能**改成「release 时 disconnect 掉 LFO」：
   * `disconnect()` **无法排程到未来时刻**，而 `release()` 有一半的调用来自
   * `noteOn` 里那句「排一个 `durationSec` 之后才发生的自动释放」—— 在那里断开，
   * 等于**每次按音都把颤音当场摘掉**（所有带 `lfoAmpAmt` 的预设立刻失去颤音）。
   * 这个坑真发生过：第一版修复就是这么写的，被 `voice-lifecycle.test.ts`
   * 里「release 前后调制源计数」那条断言当场抓住。
   *
   * 正解是把「调制」独立成一级增益：`lfoAmp/lfo2Amp → lfoAmpDepth → amp.gain`。
   * 释放时只需 `lfoAmpDepth.gain.setValueAtTime(0, at)` ——
   * **可排程、时刻精确**，深度归零之后包络斜坡就真的通向静音了。
   * 深度为 1 时与「LFO 直连 `amp.gain`」在信号上完全等价（纯二传），音色不变。
   */
  private readonly lfoAmpDepth: GainNode;
  /**
   * 滤波调制深度 —— 同样每个声部私有。
   *
   * ⛔ 释放后**必须**归零，理由和 `lfoAmpDepth` 不同但同样致命：
   * 滤波器在链路里位于包络**之前**（`mixer → filterDrive → filter → amp`），
   * 所以包络归零只能把滤波器输出**乘小**，不能阻止滤波器**继续产生**输出。
   * 高 Q 滤波器在被扫频时会自激振铃：实测「酸性 · 303 贝斯」
   * （`filterReso: 18`、锯齿 LFO `lfoFilterAmt: 400`、`ampRelease: 0.14`）
   * 在释放早已结束的 `[2s, 4s]` 窗口里，输出仍有 rms 2.1e-3 ——
   * 反推滤波器自身电平约 **20**（远超 1.0），只是被 `1e-4` 的包络压下来而已。
   */
  private readonly lfoFilterDepth: GainNode;
  /** 音高调制的专用信号源（音频速率；后台标签页也照常工作） */
  private readonly pitchModSrc: ConstantSourceNode;
  private readonly rmGain: GainNode;

  /** 全部 Unison 振荡器组（经典 / 加法 / FM 载波 / 次低音 / 弦鸣都不用） */
  private readonly entries: OscEntry[] = [];
  /** 波表引擎（只有一个，单独持有以便热换帧） */
  private wtEntry: WtEntry | null = null;
  private readonly wtEntries: WtEntry[] = [];
  private readonly addEntries: OscEntry[] = [];
  private fmOps: Array<FmOp | null> | null = null;
  private fmCarrier: OscEntry | null = null;
  /** FM 的次低音（正弦，低频一个八度），单独持有以便热更新音量 */
  private fmSubEntry: OscEntry | null = null;
  private fmGain: GainNode | null = null;
  private rmMod: GainNode | null = null;
  /** 白噪声叠加支路（所有引擎通用） */
  private noise: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** 噪声引擎的主噪声源 */
  private noiseSrc: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private string: StringUnit | null = null;
  private gran: GranUnit | null = null;

  /**
   * 「在 trigger(at) 时要 start 的源」。构造期一个源都不 start ——
   * 这是「排一个未来时刻的自动释放」能成立的前提：若构造期就 start，
   * 声部在 `at` 之前就已经出声了。
   */
  private readonly starts: Array<{ osc: OscillatorNode; freq: number; glide: boolean }> = [];
  /**
   * `trigger(at)` 负责 start 的「只能 start/stop、没有 detune」的源
   * （白噪声叠加支路 / 噪声引擎主源）。
   *
   * ⛔ `push` 进这个清单**就等于**声明「它由 `trigger` 起振」；谁自己 start 的，
   * 谁就别往这里塞 —— 见 `extraStarts` 的血案。
   */
  private readonly triggerStarts: AudioScheduledSourceNode[] = [];
  /**
   * 「只登记回收、`trigger` 不碰」的源。目前三类，**都是自己在别处 start 的**：
   *   · 粒子 grain —— `scheduleGrains` 里 `start(t, off, size)`，自己排 stop；
   *   · 噪声换色时换上的新源 —— `updateParam('noiseColor')` 里 `start()`；
   *   · 弦鸣起振脉冲 —— `trigger` 的弦鸣分支 `start(at)` + 0.06s 后排 stop。
   *
   * ⛔ 这个清单**不会被 `trigger` 遍历**（它只遍历 `triggerStarts`）。
   *
   * 为什么要把这两者分开：过去它们共用同一个 `extraStarts`，于是弦鸣的
   * `burst` 既被 `extraStarts` 循环 start、又被弦鸣分支 start —— 真机上抛
   * `InvalidStateError: cannot call start more than once`，**整条声部一个音
   * 都发不出来**（异常从 `trigger` 里逃出去，`noteOn` 后半段的 release 排程
   * 与注册全被跳过）。而假 AudioContext 的 `start()` 是幂等的，所以
   * `voice-lifecycle.test.ts` 当时 29 条全绿也照不出来 —— 这个洞是
   * `scripts/probe-synth.mjs` 把七个引擎**逐个离线渲染**之后才现形的。
   * 教训：一个清单背两种语义，等于给自己埋一个只在真机上炸的雷。
   */
  private readonly extraStarts: AudioScheduledSourceNode[] = [];
  /** 回收清单（见 `dispose`） */
  private readonly allOscs: OscillatorNode[] = [];
  private readonly allPanners: StereoPannerNode[] = [];
  private readonly allGains: GainNode[] = [];

  /** 滤波器基准截止（键跟随后的值）；随 patch 热更新 */
  private baseCutoff: number;
  /** 矩阵里 `rand` 源的取值：每个声部一个固定随机数 */
  private readonly randVal: number;
  /** 矩阵算出来的音高调制量（音分） */
  private pitchMod = 0;
  /** 矩阵算出来的脉宽调制量 */
  private pwMod = 0;
  /** 上一次把脉冲波重建到哪一档脉宽 */
  private pwBucketCache = -1;
  /** 上一次把加法波重建到哪一档频谱倾斜 */
  private addTiltBucket = -1;
  /** 频谱包络（tickSpectral）算出来的倾斜；undefined = 未启用 */
  private addSpectralTilt: number | undefined;
  /** FM 引擎：矩阵灌进来的额外调制指数 */
  private fmExtra = 0;
  /** 起音时刻（绝对 ctx 秒）——`envValue` 算包络要用 */
  private startTime = 0;
  /** 释放时刻；null = 还按着 */
  private relTime: number | null = null;
  /** 释放那一刻的包络值（音尾从这里往下走） */
  private relLevel = 0;
  private dead = false;
  private disposed = false;
  /** 早于此时刻不回收（绝对 ctx 秒）；由 release 写入 */
  disposeAtSec = Number.POSITIVE_INFINITY;

  private get ctx(): BaseAudioContext {
    return this.eng.ctx;
  }

  constructor(eng: VoiceHost, midi: number, velocity: number, channel: SynthChannel) {
    this.eng = eng;
    this.midi = midi;
    this.velocity = velocity;
    const ctx = eng.ctx;
    const p = eng.patch;

    this.freq = midiToHz(midi);
    this.randVal = rand(-1, 1);
    this.glideFrom =
      p.monoMode === 1 && p.glideTime > 0 && eng.lastNoteFreq > 0 ? eng.lastNoteFreq : null;

    this.mixer = ctx.createGain();
    this.amp = ctx.createGain();
    this.filterDrive = ctx.createWaveShaper();
    this.filterDrive.curve = makeFilterDriveCurve(p.filterDrive);
    this.filterDrive.oversample = '4x';
    this.vcaMod = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.rmGain = ctx.createGain();
    this.lfoAmpDepth = ctx.createGain();
    this.lfoFilterDepth = ctx.createGain();
    this.pitchModSrc = ctx.createConstantSource();
    this.allGains.push(
      this.mixer,
      this.amp,
      this.vcaMod,
      this.rmGain,
      this.lfoAmpDepth,
      this.lfoFilterDepth,
    );

    // 滤波器组：组内已自行接到 amp（`dest`）
    this.filter = buildFilterBank(ctx, this.amp);
    this.filter.setSlope(p.filterSlope);

    this.amp.gain.value = MIN_GAIN;
    this.vcaMod.gain.value = 1;
    this.filter.type = p.filterType;
    this.filter.Q.value = p.filterReso;

    const keyMul = Math.pow(2, ((midi - 60) / 12) * p.filterKey);
    this.baseCutoff = clamp(p.filterCutoff * keyMul, 20, ctx.sampleRate * 0.45);
    this.filter.frequency.value = this.baseCutoff;

    this.rmGain.gain.value = 1;
    this.rmGain.connect(this.mixer);
    this.pitchModSrc.offset.value = 0;

    /*
      调制接线。多个声部接同一 AudioParam = 求和，这是正确的；
      但**深度级必须是声部私有的**，否则释放时没法单独把这一路归零。
    */
    eng.lfoAmp.connect(this.lfoAmpDepth);
    eng.lfo2Amp.connect(this.lfoAmpDepth);
    this.lfoAmpDepth.gain.value = 1;
    this.lfoAmpDepth.connect(this.amp.gain);

    eng.lfoFilter.connect(this.lfoFilterDepth);
    eng.lfo2Filter.connect(this.lfoFilterDepth);
    this.lfoFilterDepth.gain.value = 1;
    this.filter.connectFreq(this.lfoFilterDepth);

    const et = p.engineType;
    if (et === 'wavetable') this.buildWavetable();
    else if (et === 'fm') this.buildFM();
    else if (et === 'additive') this.buildAdditive();
    else if (et === 'string') this.buildString();
    else if (et === 'granular') this.buildGranular();
    else if (et === 'noise') this.buildNoise();
    else this.buildClassic();

    this.mixer.connect(this.filterDrive);
    this.filterDrive.connect(this.filter.stages[0]);
    this.amp.connect(this.vcaMod);
    this.vcaMod.connect(this.panner);
    this.panner.connect(eng.busFor(channel));
  }
  /** 起音：全部自动化按 `when` 这个绝对时刻排程 */
  trigger(when: number): void {
    const ctx = this.eng.ctx;
    const p = this.eng.patch;
    const at = Math.max(when, ctx.currentTime);
    const maxF = ctx.sampleRate * 0.45;
    this.startTime = at;

    /*
      ① 频率自动化 + 起振。
      ⚠️ 顺序与原型一致：**先滑音，后音高包络**。音高包络用的是
      `setValueAtTime(起点) + 指数斜坡`，会整体覆盖滑音的那两条 —— 两者同时开时
      音高包络赢。这是原型的既定行为（不是这次移植引入的），保持一致。
    */
    for (const s of this.starts) {
      if (s.glide && this.glideFrom !== null) {
        s.osc.frequency.setValueAtTime(clamp(this.glideFrom, 0.5, 22000), at);
        s.osc.frequency.exponentialRampToValueAtTime(
          Math.max(1, s.freq),
          at + Math.max(0.001, p.glideTime),
        );
      } else {
        s.osc.frequency.setValueAtTime(s.freq, at);
      }
      this.applyPitchEnv(s.osc.frequency, s.freq, at);
      s.osc.start(at);
    }
    for (const src of this.triggerStarts) src.start(at);
    this.pitchModSrc.start(at);

    const velScale = 1 - p.velSens + p.velSens * this.velocity;
    const peak = Math.max(MIN_GAIN, velScale * 0.34);
    const attack = Math.max(0.001, p.ampAttack);
    const decay = Math.max(0.002, p.ampDecay);
    const g = this.amp.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(MIN_GAIN, at);
    /*
     * ⛔ 起音必须是**线性**斜坡，不能跟衰减/释放一样用指数。
     *
     * 指数斜坡从 `MIN_GAIN` 升到峰值，意味着前 x% 的时间只走掉极小的振幅：
     * 增益(t) = MIN_GAIN · (peak/MIN_GAIN)^(t/attack)。取 peak≈0.26、MIN_GAIN=1e-4
     * （比值 2600），则 `ampAttack = 2s` 的音色在 t = 0.9s（面板试听时长）处
     * 增益只有 2600^0.45 × 1e-4 ≈ **5.7e-3** —— 比峰值低 45 dB，等于没声。
     * 离线渲染实测：整段 rms ≈ 0，且把 ampAttack 改成 0.001 后立刻出声。
     * 受害的是**整个慢起音家族**（Pad / Riser 共 5 款预设），它们恰恰是最需要
     * 「慢慢涨起来」的音色 —— 用户点上它们只会以为「这个音色坏了」。
     *
     * 线性起音是减法合成器的常规做法；decay / release 仍用指数（那是自然的衰减形态）。
     * 起音时长本身很短（多数预设 ≤ 0.02s）时两者在听感上没有区别，所以这个改动
     * 只影响「本来就该被听见」的慢起音音色。
     */
    g.linearRampToValueAtTime(peak, at + attack);
    g.exponentialRampToValueAtTime(
      Math.max(MIN_GAIN, peak * p.ampSustain),
      at + attack + decay,
    );

    const f = this.filter.frequency;
    const peakF = clamp(this.baseCutoff + p.filterEnv, 20, maxF);
    const susF = clamp(this.baseCutoff + (peakF - this.baseCutoff) * p.fSustain, 20, maxF);
    const fAttack = Math.max(0.001, p.fAttack);
    const fDecay = Math.max(0.002, p.fDecay);
    f.cancelScheduledValues(at);
    f.setValueAtTime(Math.max(20, this.baseCutoff), at);
    f.exponentialRampToValueAtTime(Math.max(20, peakF), at + fAttack);
    f.exponentialRampToValueAtTime(susF, at + fAttack + fDecay);

    // 弦鸣：起振脉冲（一段白噪声喂进延迟线）也按绝对时刻排
    if (this.string) {
      const st = this.string;
      st.burstG.gain.setValueAtTime(0.9, at);
      st.burstG.gain.linearRampToValueAtTime(0, at + Math.min((1 / this.freq) * 1.2, 0.05));
      st.burst.start(at);
      st.burst.stop(at + 0.06);
    }

    // 粒子：调度指针从 `at` 起跑（原型用 `currentTime + 0.02`，这里同理）
    if (this.gran) {
      this.gran.nextTime = at + 0.02;
      this.pumpGrains(at);
    }
  }

  // -------------------------------------------------------------------------
  // 各引擎的图构造
  // -------------------------------------------------------------------------

  /**
   * 建一组 Unison 振荡器（经典 / 加法 / FM 载波 / 次低音共用）。
   *
   * 两条与原型一致、且**必须**保留的细节：
   *   · 音量除以 `√n` 而不是 `n`：除以 n 会让「加声部数」听起来像「变小声」，
   *     除以 √n 才是「变厚」；相位随机错开则消掉同相叠加的起音爆点。
   *   · 每条振荡器额外加 `±2` 音分的随机失谐：纯等分失谐会听出「梳状滤波」
   *     扫过，加一点抖动才像真实的齐奏。
   */
  private makeOscEntry(
    type: string,
    freq: number,
    level: number,
    pan: number,
    detuneCents: number,
    slot = -1,
    detuneKey: keyof SynthPatch = 'osc1Detune',
    octMul = 1,
  ): OscEntry {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const n = clamp(Math.round(p.unison), 1, MAX_UNISON);
    const entry: OscEntry = {
      gain: ctx.createGain(),
      panner: ctx.createStereoPanner(),
      oscs: [],
      slot,
      baseFreq: freq,
      octMul,
      detuneKey,
      useBaseDetune: slot >= 0,
    };
    entry.gain.gain.value = level / Math.sqrt(n);
    entry.panner.pan.value = pan;
    this.allGains.push(entry.gain);

    for (let u = 0; u < n; u++) {
      const osc = ctx.createOscillator();
      const phaseIdx = pickPhaseIdx(n);
      osc.setPeriodicWave(classicWave(ctx, type, p.oscPW, phaseIdx));
      const spread = n > 1 ? (u / (n - 1)) * 2 - 1 : 0;
      osc.detune.value = detuneCents + spread * p.unisonDetune + (n > 1 ? rand(-2, 2) : 0);
      osc.frequency.value = freq;
      const pn = ctx.createStereoPanner();
      pn.pan.value = clamp(spread * p.unisonSpread, -1, 1);
      osc.connect(pn).connect(entry.gain);
      pn.connect(entry.panner);
      this.wirePitchMod(osc);
      this.allPanners.push(pn);
      this.starts.push({ osc, freq, glide: true });
      entry.oscs.push({ osc, panner: pn, spread, phaseIdx, waveType: type, freq });
    }
    this.entries.push(entry);
    return entry;
  }

  /** 音高调制三路（两个 LFO + 矩阵）接上某个振荡器 */
  private wirePitchMod(osc: OscillatorNode): void {
    this.eng.lfoPitch.connect(osc.detune);
    this.eng.lfo2Pitch.connect(osc.detune);
    this.pitchModSrc.connect(osc.detune);
    this.allOscs.push(osc);
  }

  private detachPitchMod(osc: OscillatorNode): void {
    quietly(() => this.eng.lfoPitch.disconnect(osc.detune));
    quietly(() => this.eng.lfo2Pitch.disconnect(osc.detune));
    quietly(() => this.pitchModSrc.disconnect(osc.detune));
  }

  /**
   * 音高包络：起音时把频率整体推高/压低 `pitchEnvAmt` 个半音，再指数式滑回。
   *
   * 波形（打击乐 / 贝斯 / 激光）的那个「啵」就来自这里。
   * `|amt| < 0.05` 直接返回 —— 此时用户听不出差别，但省掉两条自动化。
   */
  private applyPitchEnv(param: RampParam, finalFreq: number, at: number): void {
    const p = this.eng.patch;
    if (Math.abs(p.pitchEnvAmt) < 0.05) return;
    const startF = clamp(finalFreq * Math.pow(2, p.pitchEnvAmt / 12), 1, 22000);
    param.setValueAtTime(startF, at);
    param.exponentialRampToValueAtTime(
      Math.max(1, finalFreq),
      at + Math.max(0.005, p.pitchEnvDecay),
    );
  }

  /**
   * 脉宽（只对「脉冲」波生效）。
   *
   * ⛔ 必须按**量化档**判变化：重建一次 `PeriodicWave` 要遍历 64 条谐波，
   * 而调制矩阵 / PWM 扫动是 60Hz 在调的 —— 不量化就是每秒 60 次重建。
   */
  private updatePulseWidth(v: number): void {
    const b = pwBucket(v);
    if (b === this.pwBucketCache) return;
    this.pwBucketCache = b;
    for (const e of this.entries) {
      for (const o of e.oscs) {
        if (o.waveType !== 'pulse') continue;
        o.osc.setPeriodicWave(classicWave(this.ctx, 'pulse', v, o.phaseIdx));
      }
    }
  }

  /** 由参数 + Unison 分布重算所有振荡器失谐（`unisonDetune` / `oscNDetune` 热更新） */
  private refreshDetune(t: number, immediate = false): void {
    const p = this.eng.patch;
    const set = (param: RampParam, v: number) => {
      if (immediate) param.setValueAtTime(v, t);
      else param.setTargetAtTime(v, t, 0.015);
    };
    for (const e of this.entries) {
      const base = e.useBaseDetune ? (p[e.detuneKey] as number) : p.osc1Detune;
      for (const o of e.oscs) set(o.osc.detune, base + o.spread * p.unisonDetune);
    }
    if (this.wtEntry) {
      for (const pr of this.wtEntry.pairs) {
        const dv = p.osc1Detune + pr.spread * p.unisonDetune;
        set(pr.oA.detune, dv);
        set(pr.oB.detune, dv);
      }
    }
  }

  /**
   * 包络的**解析式求值**（调制矩阵的 `env` / `fenv` 源要用）。
   *
   * ⚠️ 这是「按时间算」而不是「读 AudioParam」：AudioParam 的值在渲染线程上，
   * 主线程读到的 `value` 是**最后一个自动化事件的终点值**，不是当前值。
   * 用它当调制源会得到一个台阶函数。
   */
  private envValue(attack: number, decay: number, sustain: number, release: number, t: number): number {
    const a = Math.max(0.001, attack);
    const d = Math.max(0.002, decay);
    const r = Math.max(0.005, release);
    if (this.relTime === null) {
      const e = t - this.startTime;
      if (e <= 0) return 0;
      if (e < a) return e / a;
      if (e < a + d) return 1 - ((1 - sustain) * (e - a)) / d;
      return sustain;
    }
    const rel = t - this.relTime;
    if (rel >= r) return 0;
    return this.relLevel * (1 - rel / r);
  }

  /** 调制矩阵的「源 → −1…+1」 */
  sourceValue(src: ModSrc, t: number): number {
    const p = this.eng.patch;
    switch (src) {
      case 'lfo1':
        return lfoValue(p.lfoWave, t * p.lfoRate);
      case 'lfo2':
        return lfoValue(p.lfo2Wave, t * p.lfo2Rate);
      case 'env':
        return this.envValue(p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease, t) * 2 - 1;
      case 'fenv':
        return this.envValue(p.fAttack, p.fDecay, p.fSustain, p.fRelease, t) * 2 - 1;
      case 'vel':
        return this.velocity * 2 - 1;
      case 'key':
        return clamp((this.midi - 60) / 24, -1, 1);
      case 'rand':
        return this.randVal;
      case 'm1':
        return p.macroComplex * 2 - 1;
      case 'm2':
        return p.macroBright * 2 - 1;
      case 'm3':
        return p.macroThick * 2 - 1;
      case 'm4':
        return p.macroSpace * 2 - 1;
      default:
        return 0;
    }
  }

  // -------------------------------------------------------------------------
  // 各引擎：图构造
  // -------------------------------------------------------------------------

  /** 经典：三个振荡器 + 可选 FM / RM / 白噪声 */
  private buildClassic(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const defs: Array<
      [keyof SynthPatch, keyof SynthPatch, keyof SynthPatch, keyof SynthPatch, keyof SynthPatch]
    > = [
      ['osc1Wave', 'osc1Oct', 'osc1Detune', 'osc1Level', 'osc1Pan'],
      ['osc2Wave', 'osc2Oct', 'osc2Detune', 'osc2Level', 'osc2Pan'],
      ['osc3Wave', 'osc3Oct', 'osc3Detune', 'osc3Level', 'osc3Pan'],
    ];
    const made: Array<OscEntry | null> = defs.map(([w, o, d, l, pan], i) => {
      const level = p[l] as number;
      if (level <= OSC_LEVEL_EPS) return null;
      const octMul = Math.pow(2, p[o] as number);
      return this.makeOscEntry(
        p[w] as string,
        this.freq * octMul,
        level,
        p[pan] as number,
        p[d] as number,
        i,
        d,
        octMul,
      );
    });

    // 振荡器 1 走环形调制支路（rmGain）再入混音器；2/3 直入
    if (made[0]) made[0].panner.connect(this.rmGain);
    if (made[1]) made[1].panner.connect(this.mixer);
    if (made[2]) made[2].panner.connect(this.mixer);

    // FM：OSC2 → OSC1。调制量按 OSC2 的声部数均分，Unison 时总调制量不变
    if (made[0] && made[1] && p.fmDepth > 0) {
      const fmGain = ctx.createGain();
      fmGain.gain.value = (p.fmDepth * 800) / made[1].oscs.length;
      for (const m of made[1].oscs) m.osc.connect(fmGain);
      for (const c of made[0].oscs) fmGain.connect(c.osc.frequency);
      this.fmGain = fmGain;
      this.allGains.push(fmGain);
    }

    if (made[0] && made[1] && p.rmDepth > 0) {
      this.rmGain.gain.value = 1 - p.rmDepth;
      const rmMod = ctx.createGain();
      rmMod.gain.value = p.rmDepth / made[1].oscs.length;
      for (const m of made[1].oscs) m.osc.connect(rmMod);
      rmMod.connect(this.rmGain.gain);
      this.rmMod = rmMod;
      this.allGains.push(rmMod);
    }

    this.addNoiseSrc();
  }

  /** 波表：两个振荡器交叉淡化，才拿得到帧间的连续过渡 */
  private buildWavetable(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const entry: WtEntry = {
      gain: ctx.createGain(),
      panner: ctx.createStereoPanner(),
      pairs: [],
      frames: getWavetable(p.wtCat, p.wtTable),
    };
    this.allGains.push(entry.gain);
    const n = clamp(Math.round(p.unison), 1, MAX_UNISON);
    entry.gain.gain.value = p.osc1Level / Math.sqrt(n);
    entry.panner.pan.value = p.osc1Pan;

    for (let u = 0; u < n; u++) {
      const spread = n > 1 ? (u / (n - 1)) * 2 - 1 : 0;
      const phase = pickPhaseIdx(n);
      const mkOsc = (): OscillatorNode => {
        const o = ctx.createOscillator();
        o.detune.value = p.osc1Detune + spread * p.unisonDetune + (n > 1 ? rand(-2, 2) : 0);
        o.frequency.value = this.freq;
        this.wirePitchMod(o);
        this.starts.push({ osc: o, freq: this.freq, glide: false });
        return o;
      };
      const oA = mkOsc();
      const oB = mkOsc();
      const gA = ctx.createGain();
      const gB = ctx.createGain();
      const pn = ctx.createStereoPanner();
      pn.pan.value = clamp(spread * p.unisonSpread, -1, 1);
      oA.connect(gA).connect(pn);
      oB.connect(gB).connect(pn);
      pn.connect(entry.gain);
      this.allGains.push(gA, gB);
      this.allPanners.push(pn);
      entry.pairs.push({ oA, oB, gA, gB, panner: pn, spread, phase });
    }
    entry.gain.connect(entry.panner);
    entry.panner.connect(this.mixer);
    this.wtEntry = entry;
    this.wtEntries.push(entry);
    this.setWtPos(p.wtPos, true);
    this.addNoiseSrc();
  }

  /**
   * 波表帧位置。
   *
   * 用 `cos/sin` 而不是线性权重：`cos²+sin²=1`，于是**交叉淡化期间总能量恒定** ——
   * 线性权重会在中点掉 3dB（听感上是「扫到中间变小一声」）。
   */
  private setWtPos(pos: number, immediate = false): void {
    const entry = this.wtEntry;
    if (!entry) return;
    const t = this.ctx.currentTime;
    const F = entry.frames.length - 1;
    const f = clamp(pos, 0, 1) * F;
    const i0 = Math.min(F - 1, Math.floor(f));
    const frac = f - i0;
    const wA = Math.cos((frac * Math.PI) / 2);
    const wB = Math.sin((frac * Math.PI) / 2);
    for (const pr of entry.pairs) {
      pr.oA.setPeriodicWave(wtFrameWave(this.ctx, entry.frames[i0], pr.phase));
      pr.oB.setPeriodicWave(wtFrameWave(this.ctx, entry.frames[i0 + 1], pr.phase));
      if (immediate) {
        pr.gA.gain.value = wA;
        pr.gB.gain.value = wB;
      } else {
        pr.gA.gain.setTargetAtTime(wA, t, 0.03);
        pr.gB.gain.setTargetAtTime(wB, t, 0.03);
      }
    }
  }

  private fmRatioOf(i: number): number {
    const p = this.eng.patch;
    return i === 2 ? p.fmRatio : i === 3 ? p.fmRatio3 : p.fmRatio4;
  }

  /** FM：4 算子，算子 1 是主载波（走 Unison），2/3/4 的连线由算法矩阵决定 */
  private buildFM(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const carrier = this.makeOscEntry('sine', this.freq, p.fmCar, 0, 0);
    carrier.panner.connect(this.mixer);
    this.fmCarrier = carrier;

    this.fmOps = [null];
    for (let i = 2; i <= 4; i++) {
      const ratio = this.fmRatioOf(i);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.freq * ratio;
      this.wirePitchMod(osc);
      this.starts.push({ osc, freq: this.freq * ratio, glide: false });
      const mod = ctx.createGain();
      mod.gain.value = 0;
      const aud = ctx.createGain();
      aud.gain.value = 0;
      const panner = ctx.createStereoPanner();
      osc.connect(mod);
      osc.connect(aud);
      aud.connect(panner);
      panner.connect(this.mixer);
      this.allGains.push(mod, aud);
      this.allPanners.push(panner);
      this.fmOps[i] = { osc, mod, aud, panner, ratio };
    }
    this.routeFm(ctx.currentTime, undefined, true);
    if (p.fmSub > OSC_LEVEL_EPS) {
      const sub = this.makeOscEntry('sine', this.freq / 2, p.fmSub, 0, 0);
      sub.panner.connect(this.mixer);
      this.fmSubEntry = sub;
    }
    this.addNoiseSrc();
  }

  /**
   * 按算法重排算子连线（算法可以在按住音时实时切换）。
   *
   * ⛔ `op.mod.disconnect()` 之前必须**先断开所有出边**再重连 ——
   * 否则新算法里没被用到的算子会留着上一条「调制某人频率」的线，
   * 表现为「换算法之后有个不该响的算子一直在调制」。
   */
  private routeFm(t: number, algoIdx?: number, immediate = false): void {
    const ops = this.fmOps;
    const carrier = this.fmCarrier;
    if (!ops || !carrier) return;
    const p = this.eng.patch;
    const raw = algoIdx === undefined ? p.fmAlgo : algoIdx;
    const algo = FM_ALGOS[clamp(Math.round(raw), 0, FM_ALGOS.length - 1)];
    const set = (param: RampParam, v: number, tc: number) => {
      if (immediate) param.setValueAtTime(v, t);
      else param.setTargetAtTime(v, t, tc);
    };

    for (let i = 2; i <= 4; i++) {
      const op = ops[i];
      if (!op) continue;
      quietly(() => op.mod.disconnect());
      op.ratio = this.fmRatioOf(i);
      set(op.osc.frequency, this.freq * op.ratio, 0.02);
      const isOut = algo.out.indexOf(i) >= 0;
      // 额外载波略微分到两侧（否则两个载波叠在正中间会糊）
      set(op.panner.pan, isOut ? (i - 3) * 0.3 : 0, 0.02);
      set(op.aud.gain, isOut ? p.fmCar * 0.8 : 0, 0.03);
    }
    for (const [a, b] of algo.edges) {
      const src = ops[a];
      if (!src) continue;
      if (b === 1) for (const o of carrier.oscs) src.mod.connect(o.osc.frequency);
      else if (ops[b]) src.mod.connect(ops[b]!.osc.frequency);
    }
    this.updateFmGains(t, this.fmExtra, immediate);
  }

  /**
   * 调制指数 → 赫兹：`增益(Hz) = 指数 × 算子频率`。
   *
   * 乘上算子频率是关键 —— 不乘的话「同一个 depth 在低音上调制很凶、
   * 高音上几乎没反应」，手感不一致。
   */
  private updateFmGains(t: number, extra: number, immediate = false): void {
    const ops = this.fmOps;
    if (!ops) return;
    const p = this.eng.patch;
    for (let i = 2; i <= 4; i++) {
      const op = ops[i];
      if (!op) continue;
      const d = i === 2 ? p.fmDepth : i === 3 ? p.fmDepth3 : p.fmDepth4;
      const idx = clamp(d + extra, 0, MAX_FM_INDEX);
      const v = idx * FM_INDEX_MAX * this.freq * op.ratio;
      if (immediate) op.mod.gain.setValueAtTime(v, t);
      else op.mod.gain.setTargetAtTime(v, t, 0.02);
    }
  }

  /** 加法：Unison 正弦组 + 32 条谐波波形 */
  private buildAdditive(): void {
    const p = this.eng.patch;
    const entry = this.makeOscEntry(
      'sine',
      this.freq,
      p.osc1Level,
      p.osc1Pan,
      p.osc1Detune,
    );
    entry.panner.connect(this.mixer);
    this.addEntries.push(entry);
    this.addTiltBucket = -1;
    this.updateAdditiveWave(true);
    this.addNoiseSrc();
  }

  /** 谐波包络的「亮度」基准：手动倾斜 + 亮度宏 */
  private additiveTilt(): number {
    const p = this.eng.patch;
    return clamp(p.addTilt + (p.macroBright || 0) * 0.4, 0, 1);
  }

  /**
   * 重建加法波形。
   *
   * 倾斜量化为 24 档 —— 只有跨档才真的重建 `PeriodicWave`，否则 60Hz 的
   * 频谱包络会疯狂重算 32 条谐波的波形，把主线程拖死（原型踩过这个坑）。
   */
  private updateAdditiveWave(force: boolean): void {
    if (!this.addEntries.length) return;
    const tilt = this.addSpectralTilt === undefined ? this.additiveTilt() : this.addSpectralTilt;
    const b = Math.round(tilt * 24);
    if (!force && b === this.addTiltBucket) return;
    this.addTiltBucket = b;
    const p = this.eng.patch;
    const wave = buildAdditiveWave(this.ctx, p.addHarm, b / 24);
    for (const e of this.addEntries) for (const o of e.oscs) o.osc.setPeriodicWave(wave);
  }

  /**
   * 频谱包络：音符衰减时**高次泛音先掉下去**（钟、钢琴、拨弦的共同特征）。
   *
   * 松键后额外再叠加一次释放时间，让余韵真的「变暗」。
   * 由引擎的控制速率循环驱动（与调制矩阵同一套节拍）。
   */
  private tickSpectral(t: number): void {
    if (!this.addEntries.length) return;
    const p = this.eng.patch;
    if (p.addEnvAmt < 0.002) {
      if (this.addSpectralTilt !== undefined) {
        this.addSpectralTilt = undefined;
        this.updateAdditiveWave(true);
      }
      return;
    }
    const age =
      Math.max(0, t - this.startTime) +
      (this.relTime === null ? 0 : Math.max(0, t - this.relTime));
    const fall = Math.exp(-age / Math.max(0.02, p.addEnvDecay));
    this.addSpectralTilt = clamp(this.additiveTilt() + p.addEnvAmt * (1 - fall), 0, 1);
    this.updateAdditiveWave(false);
  }

  /** 弦鸣（Karplus-Strong）：一段噪声灌进带阻尼的延迟反馈环 */
  private buildString(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const burst = ctx.createBufferSource();
    burst.buffer = this.eng.noiseBufs.white;
    const burstG = ctx.createGain();
    burstG.gain.value = 0;
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = Math.min(0.1, 1 / this.freq);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = p.strDamp;
    const fb = ctx.createGain();
    fb.gain.value = clamp(p.strDecay, 0.9, 0.9995);
    const out = ctx.createGain();
    out.gain.value = p.strLevel * 0.8;

    burst.connect(burstG).connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    delay.connect(out).connect(this.mixer);
    this.allGains.push(burstG, fb, out);
    this.extraStarts.push(burst);
    this.string = { burst, burstG, delay, damp, fb, out };
  }

  /** 粒子：本身不发声，靠调度器按 `granDensity` 不断往混音器里丢短样本 */
  private buildGranular(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.mixer);
    this.allGains.push(out);
    this.gran = { out, buf: this.eng.granBuf(p.granTex), tex: p.granTex, nextTime: 0, alive: true };
  }

  private pumpGrains(fromSec: number): void {
    const g = this.gran;
    if (!g || !g.alive) return;
    const p = this.eng.patch;
    if (p.granTex !== g.tex) {
      g.tex = p.granTex;
      g.buf = this.eng.granBuf(p.granTex);
    }
    this.scheduleGrains(g.buf, fromSec);
  }

  /**
   * 补发粒子。
   *
   * ⚠️ 两处「防打死」的护栏（原型踩过）：
   *   ① 长卡顿（重建面板 / 切引擎 / 标签页休眠恢复）会把调度指针远远甩在后面，
   *      一次性补出成千上万个 grain 会把主线程彻底打死 → 先跳到近处；
   *   ② 单次补发上限 `GRAN_BURST_LIMIT`。
   */
  private scheduleGrains(buf: AudioBuffer, fromSec: number): void {
    const g = this.gran;
    if (!g) return;
    const ctx = this.ctx;
    const p = this.eng.patch;
    const horizon = Math.max(ctx.currentTime, fromSec) + GRAN_LOOKAHEAD_SEC;
    const dur = buf.duration;
    if (horizon - g.nextTime > 2) g.nextTime = horizon - 0.5;
    if (g.nextTime < fromSec) g.nextTime = fromSec;
    const per = 1 / clamp(p.granDensity, 1, 60);
    const size = clamp(p.granSize, 0.015, 0.4);
    const amp = p.granLevel * clamp(0.55 / Math.sqrt(p.granDensity * size * 0.5), 0.15, 1.2);
    let n = 0;
    while (g.nextTime < horizon && n++ < GRAN_BURST_LIMIT) {
      const t = g.nextTime;
      g.nextTime += per;
      const off = clamp(
        (p.granPos + rand(-0.5, 0.5) * p.granRand * 0.6) * dur,
        0,
        Math.max(0, dur - size),
      );
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value =
        Math.pow(2, (p.granPitch + rand(-0.15, 0.15) * p.granRand) / 12) * (this.freq / 220);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(1, t + size * 0.5);
      env.gain.linearRampToValueAtTime(0, t + size);
      const pn = ctx.createStereoPanner();
      pn.pan.value = rand(-1, 1) * p.granRand;
      const g2 = ctx.createGain();
      g2.gain.value = amp;
      src.connect(env).connect(g2).connect(pn).connect(g.out);
      // grain 是**一次性**的：`stop` 排在尾端，节点靠清扫器回收（见 dispose 注释）
      src.start(t, off, size + 0.02);
      src.stop(t + size + 0.04);
      this.allGains.push(env, g2);
      this.allPanners.push(pn);
      this.extraStarts.push(src);
    }
  }

  /** 噪声引擎：白 / 粉 / 棕三选一，整段循环 */
  private buildNoise(): void {
    const ctx = this.ctx;
    const p = this.eng.patch;
    const src = ctx.createBufferSource();
    src.buffer = this.eng.noiseBufs[p.noiseColor];
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = p.noiseEngLevel;
    src.connect(g).connect(this.mixer);
    this.allGains.push(g);
    this.triggerStarts.push(src);
    this.noiseSrc = { src, gain: g };
  }

  /** 经典 / 波表 / FM / 加法引擎共用的「白噪声叠加」支路 */
  private addNoiseSrc(): void {
    const p = this.eng.patch;
    if (p.noiseLevel <= OSC_LEVEL_EPS) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.eng.noiseBufs.white;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = p.noiseLevel * 0.5;
    src.connect(g).connect(this.mixer);
    this.allGains.push(g);
    this.triggerStarts.push(src);
    this.noise = { src, gain: g };
  }

  // -------------------------------------------------------------------------
  // 调制矩阵（控制速率）
  // -------------------------------------------------------------------------

  /**
   * 把矩阵算出来的量写进这个声部。
   *
   * ⛔ 每条写入都带**阈值**（0.5 音分 / 0.01 脉宽 / 0.0005 调制指数）：
   * 这是 60Hz 的循环，没有阈值就是每秒 60 次无谓的自动化写入，
   * 在 32 个声部上足以让音频线程出现毛刺。
   */
  applyMod(slots: Array<{ src: ModSrc; dst: ModDst; amt: number }>, t: number): void {
    const p = this.eng.patch;
    let pitch = 0;
    let cutoff = 0;
    let reso = 0;
    let amp = 0;
    let pan = 0;
    let fm = 0;
    let wt = 0;
    let pw = 0;
    for (const s of slots) {
      if (GLOBAL_MOD_DSTS.has(s.dst)) continue;
      const v = this.sourceValue(s.src, t) * s.amt * (MOD_SCALE[s.dst] || 1);
      switch (s.dst) {
        case 'pitch':
          pitch += v;
          break;
        case 'cutoff':
          cutoff += v;
          break;
        case 'reso':
          reso += v;
          break;
        case 'amp':
          amp += v;
          break;
        case 'pan':
          pan += v;
          break;
        case 'fm':
          fm += v;
          break;
        case 'wtpos':
          wt += v;
          break;
        case 'pw':
          pw += v;
          break;
        default:
          break;
      }
    }
    const maxF = this.ctx.sampleRate * 0.45;

    if (Math.abs(pitch - this.pitchMod) > 0.5) {
      this.pitchMod = pitch;
      this.pitchModSrc.offset.setTargetAtTime(pitch, t, 0.02);
    }
    if (Math.abs(pw - this.pwMod) > 0.01) {
      this.pwMod = pw;
      this.updatePulseWidth(clamp(p.oscPW + pw, 0.02, 0.98));
    }
    const km = Math.pow(2, ((this.midi - 60) / 12) * p.filterKey);
    this.filter.frequency.setTargetAtTime(clamp(p.filterCutoff * km + cutoff, 20, maxF), t, 0.015);
    this.filter.Q.setTargetAtTime(clamp(p.filterReso + reso, 0.1, 30), t, 0.02);
    this.vcaMod.gain.setTargetAtTime(clamp(1 + amp, 0, 2.2), t, 0.02);
    this.panner.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.02);
    if (this.fmGain) {
      this.fmGain.gain.setTargetAtTime(clamp(p.fmDepth * 800 + fm, 0, 4000), t, 0.02);
    }
    if (this.fmOps && Math.abs(fm - this.fmExtra) > 0.0005) {
      this.fmExtra = fm;
      this.updateFmGains(t, fm);
    }
    if (this.wtEntry && wt !== 0) {
      let pos = (p.wtPos + wt) % 1;
      if (pos < 0) pos += 1;
      this.setWtPos(pos);
    }
  }

  /** 矩阵全部关掉时把声部恢复成「只有 patch 本身」的状态 */
  resetMod(t: number): void {
    const p = this.eng.patch;
    const maxF = this.ctx.sampleRate * 0.45;
    this.pitchMod = 0;
    this.pitchModSrc.offset.setTargetAtTime(0, t, 0.02);
    this.pwMod = 0;
    this.updatePulseWidth(p.oscPW);
    const km = Math.pow(2, ((this.midi - 60) / 12) * p.filterKey);
    this.filter.frequency.setTargetAtTime(clamp(p.filterCutoff * km, 20, maxF), t, 0.02);
    this.filter.Q.setTargetAtTime(p.filterReso, t, 0.02);
    this.vcaMod.gain.setTargetAtTime(1, t, 0.02);
    this.panner.pan.setTargetAtTime(0, t, 0.02);
    if (this.fmGain) this.fmGain.gain.setTargetAtTime(p.fmDepth * 800, t, 0.02);
    if (this.fmOps) {
      this.fmExtra = 0;
      this.updateFmGains(t, 0);
    }
    if (this.wtEntry) this.setWtPos(p.wtPos);
  }

  /**
   * 控制速率的每个节拍。
   *
   * ⛔ **死的声部一律不 tick**。它们在 `voices` 里还留着（等 `disposeAtSec` 到点
   * 才被清扫），但 `noteOn` 排的自动释放已经在跑 —— 这时候再往
   * `filter.frequency` / `vcaMod.gain` 上写 `setTargetAtTime`，
   * 会把释放的斜坡**当场冲掉**，音尾就永远收不干净。
   */
  tick(t: number): void {
    if (this.dead) return;
    if (this.gran && this.gran.alive) this.pumpGrains(t);
    if (this.addEntries.length) this.tickSpectral(t);
  }

  /** 这个声部还需要控制速率的节拍吗（引擎据此决定要不要开着定时器） */
  get needsTick(): boolean {
    if (this.dead) return false;
    if (this.gran && this.gran.alive) return true;
    if (this.addEntries.length && this.eng.patch.addEnvAmt >= 0.002) return true;
    return false;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * 摘掉两路调制的源（只在拆节点时调用）。
   *
   * ⚠️ 释放路径**不靠这个**来静音 —— 释放靠的是把两个深度级排程到 0。
   * 这里只负责在拆节点前把线断干净，避免 LFO 一直连着一个已经没人引用的增益。
   */
  private detachModulation(): void {
    quietly(() => this.eng.lfoAmp.disconnect(this.lfoAmpDepth));
    quietly(() => this.eng.lfo2Amp.disconnect(this.lfoAmpDepth));
    quietly(() => this.lfoAmpDepth.disconnect());
    quietly(() => this.eng.lfoFilter.disconnect(this.lfoFilterDepth));
    quietly(() => this.eng.lfo2Filter.disconnect(this.lfoFilterDepth));
    quietly(() => this.lfoFilterDepth.disconnect());
  }

  /**
   * 释放。`when` 是绝对时刻，`fast` = 抢占/全部停止用的极短释放。
   * 写 `disposeAtSec` 交给清扫器 —— 回收时机由这里主张，不由定时器猜。
   *
   * 两条语义要同时成立：
   *   ① **幂等**：重复 release 不该把已经开始的斜坡搅乱；
   *   ② **可提速**：已被自动释放（长尾）的声部，若随后被 `fast` 抢占，
   *      必须允许把释放缩短重排。否则同音重按时，旧声部会拖着自己那
   *      2~4 秒的长尾继续响，听起来像「按下去没反应、还在响上一个音」。
   */
  release(when: number, fast = false): void {
    const ctx = this.eng.ctx;
    const p = this.eng.patch;
    const at = Math.max(when, ctx.currentTime);
    const rel = fast ? FAST_RELEASE_SEC : Math.max(0.01, p.ampRelease);
    const frel = fast ? FAST_RELEASE_SEC : Math.max(0.01, p.fRelease);
    const disposeAt = at + Math.max(rel, frel) + DISPOSE_PAD_SEC;

    if (this.dead && !(fast && disposeAt < this.disposeAtSec)) return;

    /*
      音尾要**从此刻的包络值往下走**，不能一律从峰值开始 ——
      短促的音（已经衰减到 sustain*0.2 了）松手时若从峰值开始斜坡，
      会听到「松手的瞬间音量反而弹起来一下」。
      `envValue` 用的是解析式（AudioParam 的 `.value` 在主线程读到的是
      「最后一个自动化事件的终点值」，不是当前值）。
    */
    if (!this.dead) {
      this.relLevel = clamp(
        this.envValue(p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease, at),
        0,
        1,
      );
      this.relTime = at;
    }
    this.dead = true;

    /*
      ⛔ 两路调制深度都必须在 `at` 排程归零 —— 这是「释放真的通向静音」的唯一保证。
      不能换成 disconnect（它无法排程到未来时刻，会把仍在响的音的调制当场摘掉），
      理由详见 `lfoAmpDepth` / `lfoFilterDepth` 字段注释。
      这是一条常数排程：两个 param 的内置值恒为 1、也没有别人给它排过东西，
      所以直接 setValueAtTime 即可，不需要 holdParam。
    */
    this.lfoAmpDepth.gain.setValueAtTime(0, at);
    this.lfoFilterDepth.gain.setValueAtTime(0, at);

    holdParam(this.amp.gain, at);
    this.amp.gain.exponentialRampToValueAtTime(MIN_GAIN, at + rel);
    /*
      ⛔ 释放必须**以精确的 0 收尾**，不能停在 MIN_GAIN（1e-4 ≈ −80 dB）。

      指数斜坡到不了 0，所以这里补一条 `setValueAtTime(0)`。为什么非要不可：
      滤波器在包络**之前**（`mixer → filterDrive → filter → amp`），而振荡器要到拆节点
      时才会停 —— 也就是说释放之后，滤波器仍在被满幅信号**持续喂着**，它的输出靠包络的
      1e-4 去乘。高 Q 共振会把这个 1e-4 抬回来：实测「低音 · 神经质」
      （`filterReso: 14`）与「低吼 Bass · 工业」（`filterReso: 10`）在释放结束后
      的残留 rms 恰好是 2.09e-4 / 2.04e-4 —— **正好卡在可闻下限上**。
      收尾到 0 之后残留变成精确的绝对零。

      （从 1e-4 跳到 0 不会「咔」：那已经比任何可闻电平低 80 dB。）
    */
    this.amp.gain.setValueAtTime(0, at + rel);

    holdParam(this.filter.frequency, at);
    this.filter.frequency.exponentialRampToValueAtTime(
      Math.max(20, this.baseCutoff),
      at + frel,
    );

    // 粒子：置 alive=false 后不再新建 grain；已经排进程的由各自包络收尾
    if (this.gran) this.gran.alive = false;
    // 弦鸣：把反馈环关掉，否则延迟线会一直自己喂自己
    if (this.string) this.string.fb.gain.setTargetAtTime(0, at, fast ? 0.005 : 0.05);

    this.disposeAtSec = disposeAt;
  }

  /**
   * 参数热更新（拖动旋钮时对正在响的声部也生效）。
   *
   * ⚠️ 三个「只对新音符生效」的参数：`engineType`（换引擎 = 换整张图）、
   * `unison` / `unisonSpread` / `unisonDetune` 里的声部数、`pitchEnvAmt` /
   * `pitchEnvDecay`（起音时一次性排的自动化）。面板上必须把这些写成
   * 「下一次按音生效」，否则用户拧了没反应会觉得旋钮坏了。
   */
  updateParam(name: string, value: number | string, t: number): void {
    const p = this.eng.patch;
    const maxF = this.ctx.sampleRate * 0.45;
    const v = value as number;
    switch (name) {
      case 'filterType':
        this.filter.type = value as BiquadFilterType;
        return;
      case 'filterSlope':
        this.filter.setSlope(v);
        return;
      case 'filterDrive':
        this.filterDrive.curve = makeFilterDriveCurve(v);
        return;
      case 'filterReso':
        this.filter.Q.setTargetAtTime(v, t, 0.02);
        return;
      case 'filterCutoff': {
        const km = Math.pow(2, ((this.midi - 60) / 12) * p.filterKey);
        this.baseCutoff = clamp(v * km, 20, maxF);
        this.filter.frequency.setTargetAtTime(this.baseCutoff, t, 0.03);
        return;
      }
      case 'filterKey': {
        const km = Math.pow(2, ((this.midi - 60) / 12) * p.filterKey);
        this.baseCutoff = clamp(p.filterCutoff * km, 20, maxF);
        this.filter.frequency.setTargetAtTime(this.baseCutoff, t, 0.03);
        return;
      }
      case 'oscPW':
        this.updatePulseWidth(v);
        return;
      case 'fmDepth':
      case 'fmDepth3':
      case 'fmDepth4':
        if (this.fmGain) this.fmGain.gain.setTargetAtTime(p.fmDepth * 800, t, 0.02);
        this.updateFmGains(t, this.fmExtra);
        return;
      case 'fmAlgo':
        if (this.fmOps) this.routeFm(t, v);
        return;
      case 'fmRatio':
      case 'fmRatio3':
      case 'fmRatio4':
        if (this.fmOps) this.routeFm(t);
        return;
      case 'fmCar':
        if (this.fmCarrier) {
          this.fmCarrier.gain.gain.setTargetAtTime(
            v / Math.sqrt(Math.max(1, this.fmCarrier.oscs.length)),
            t,
            0.02,
          );
        }
        if (this.fmOps) this.routeFm(t);
        return;
      case 'fmSub':
        if (this.fmSubEntry) {
          this.fmSubEntry.gain.gain.setTargetAtTime(
            v / Math.sqrt(Math.max(1, this.fmSubEntry.oscs.length)),
            t,
            0.02,
          );
        }
        return;
      case 'rmDepth':
        if (this.rmGain && this.rmMod) {
          this.rmGain.gain.setTargetAtTime(1 - v, t, 0.02);
          this.rmMod.gain.setTargetAtTime(v, t, 0.02);
        }
        return;
      case 'wtPos':
        if (this.wtEntry) this.setWtPos(v);
        return;
      case 'wtCat':
      case 'wtTable':
        if (this.wtEntry) {
          this.wtEntry.frames = getWavetable(p.wtCat, p.wtTable);
          this.setWtPos(p.wtPos, true);
        }
        return;
      case 'addHarm':
      case 'addTilt':
      case 'macroBright':
        this.updateAdditiveWave(true);
        return;
      case 'addEnvAmt':
        this.tickSpectral(t);
        return;
      case 'unisonDetune':
      case 'osc1Detune':
      case 'osc2Detune':
      case 'osc3Detune':
        this.refreshDetune(t);
        return;
      case 'osc1Pan':
        if (this.wtEntry) this.wtEntry.panner.pan.setTargetAtTime(v, t, 0.02);
        return;
      case 'osc1Level':
        if (this.wtEntry) {
          this.wtEntry.gain.gain.setTargetAtTime(
            v / Math.sqrt(Math.max(1, this.wtEntry.pairs.length)),
            t,
            0.02,
          );
        }
        return;
      case 'strDamp':
        if (this.string) this.string.damp.frequency.setTargetAtTime(v, t, 0.02);
        return;
      case 'strDecay':
        if (this.string) this.string.fb.gain.setTargetAtTime(clamp(v, 0.9, 0.9995), t, 0.02);
        return;
      case 'strLevel':
        if (this.string) this.string.out.gain.setTargetAtTime(v * 0.8, t, 0.02);
        return;
      case 'granLevel':
        return; // 调度器实时读 patch
      case 'noiseColor': {
        if (!this.noiseSrc) return;
        const { src, gain } = this.noiseSrc;
        const next = this.ctx.createBufferSource();
        next.buffer = this.eng.noiseBufs[p.noiseColor];
        next.loop = true;
        next.connect(gain);
        next.start();
        quietly(() => src.stop());
        quietly(() => src.disconnect());
        this.noiseSrc.src = next;
        this.extraStarts.push(next);
        return;
      }
      case 'noiseEngLevel':
        if (this.noiseSrc) this.noiseSrc.gain.gain.setTargetAtTime(v, t, 0.02);
        return;
      case 'noiseLevel':
        if (this.noise) this.noise.gain.gain.setTargetAtTime(v * 0.5, t, 0.02);
        return;
      default:
        break;
    }

    // 振荡器参数（经典引擎）：按 slot 落到对应那一组
    const m = /^osc([123])(Level|Detune|Wave|Oct|Pan)$/.exec(name);
    if (m) {
      const idx = Number(m[1]) - 1;
      const entry = this.entries.find((e) => e.slot === idx);
      if (!entry) return;
      const kind = m[2];
      const n = Math.max(1, entry.oscs.length);
      if (kind === 'Level') entry.gain.gain.setTargetAtTime(v / Math.sqrt(n), t, 0.02);
      else if (kind === 'Pan') entry.panner.pan.setTargetAtTime(v, t, 0.02);
      else if (kind === 'Wave') {
        for (const o of entry.oscs) {
          o.waveType = String(value);
          o.osc.setPeriodicWave(classicWave(this.ctx, o.waveType, p.oscPW, o.phaseIdx));
        }
      } else if (kind === 'Oct') {
        entry.octMul = Math.pow(2, v);
        for (const o of entry.oscs) {
          o.freq = this.freq * entry.octMul;
          o.osc.frequency.setTargetAtTime(o.freq, t, 0.02);
        }
      } else if (kind === 'Detune') {
        for (const o of entry.oscs) {
          o.osc.detune.setTargetAtTime(v + o.spread * p.unisonDetune, t, 0.02);
        }
      }
      return;
    }
  }

  /**
   * 拆节点。幂等；单步失败不牵连其余（一个断不开的连接不该拖垮整页）。
   *
   * 回收范围由四个清单兜住：
   *   · `allOscs` —— 每条振荡器都要先摘掉三路音高调制再停；
   *   · `triggerStarts` / `extraStarts` —— 噪声源、弦鸣脉冲、粒子源，只 stop
   *     （两个清单的分工见各自声明处的注释）；
   *   · `allPanners` / `allGains` —— 中间节点，只 disconnect。
   * 四个清单之外还有几处**显式建、显式拆**的节点（滤波两级、滤波驱动、
   * 声像、各 entry 自己的 gain/panner、FM 的 mod/aud、弦鸣的五个节点），
   * 它们在下面逐个收尾 —— 漏掉任何一个都是「越用越卡」的那类 bug。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const osc of this.allOscs) {
      this.detachPitchMod(osc);
      quietly(() => osc.stop());
      quietly(() => osc.disconnect());
    }
    for (const src of [...this.triggerStarts, ...this.extraStarts]) {
      quietly(() => src.stop());
      quietly(() => src.disconnect());
    }
    for (const pn of this.allPanners) quietly(() => pn.disconnect());
    for (const g of this.allGains) quietly(() => g.disconnect());
    for (const e of this.entries) {
      quietly(() => e.gain.disconnect());
      quietly(() => e.panner.disconnect());
    }
    if (this.wtEntry) {
      for (const pr of this.wtEntry.pairs) {
        quietly(() => pr.gA.disconnect());
        quietly(() => pr.gB.disconnect());
        quietly(() => pr.panner.disconnect());
      }
    }
    if (this.fmOps) {
      for (let i = 2; i <= 4; i++) {
        const op = this.fmOps[i];
        if (!op) continue;
        quietly(() => op.mod.disconnect());
        quietly(() => op.aud.disconnect());
        quietly(() => op.panner.disconnect());
      }
    }
    if (this.string) {
      const st = this.string;
      for (const n of [st.burstG, st.delay, st.damp, st.fb, st.out]) {
        quietly(() => n.disconnect());
      }
    }
    if (this.gran) {
      const g = this.gran;
      quietly(() => g.out.disconnect());
    }
    if (this.noiseSrc) {
      const ns = this.noiseSrc;
      quietly(() => ns.gain.disconnect());
    }
    if (this.noise) {
      const nz = this.noise;
      quietly(() => nz.gain.disconnect());
    }
    if (this.fmGain) {
      const fm = this.fmGain;
      quietly(() => fm.disconnect());
    }
    if (this.rmMod) {
      const rm = this.rmMod;
      quietly(() => rm.disconnect());
    }
    this.detachModulation();
    quietly(() => {
      this.pitchModSrc.stop();
      this.pitchModSrc.disconnect();
    });
    this.filter.disconnect();
    quietly(() => this.filterDrive.disconnect());
    quietly(() => this.panner.disconnect());
  }
}

/** 单个音符的调度参数 */
export interface SynthNoteOptions {
  /** 绝对 ctx 起音时刻（秒）；缺省 = 立刻 */
  whenCtxSec?: number;
  /** 发声时长（秒），到点自动释放；缺省 0.5 */
  durationSec?: number;
  /** 归一力度 0..1，缺省 0.85 */
  velocity?: number;
  /** 通道：常规试听声 / 录制跟弹参考声 */
  channel?: SynthChannel;
}

export class SynthEngine {
  readonly ctx: BaseAudioContext;
  /** ⚠️ 引擎内部状态：Voice 要读它。外部请走 `setPatch` / `applyParam`。 */
  patch: SynthPatch;
  /** 白 / 粉 / 棕三类噪声（8 秒，理由见 `makeNoiseBuffers`） */
  noiseBufs: NoiseBuffers;
  lfoPitch: GainNode;
  lfoFilter: GainNode;
  lfoAmp: GainNode;
  lfo2Pitch: GainNode;
  lfo2Filter: GainNode;
  lfo2Amp: GainNode;
  lastNoteFreq = 0;

  private readonly fx: FxChain;
  private readonly lfo: OscillatorNode;
  private readonly lfo2: OscillatorNode;
  private readonly masterGain: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  private readonly voiceBus: GainNode;
  private readonly feedbackBus: GainNode;
  /** 正在发声的声部（含已排自身自动释放、但还没到回收点的） */
  private readonly voices = new Map<number, SynthVoice>();
  /**
   * 已释放、等 `disposeAtSec` 到点的声部。
   *
   * ⛔ 这个集合必须存在。曾经的做法是「`release()` 的同时顺手把声部从
   * `voices` 里摘掉」，而清扫器 `sweepVoices` 只遍历 `voices` —— 于是
   * **凡是被显式 `noteOff` 的声部从此不可达，永远拆不掉**。
   * 后果恰好就是用户报的两个症状：
   *
   *   · **一直发声**：声部没被拆掉，`amp.gain` 上的幅度 LFO 还连着，
   *     增益停在 `±lfoAmpAmt` 之间（预设里最大 0.22，约 −13 dB）永不衰减；
   *   · **卡顿 → 没声**：每个声部约 20 个节点（3 振荡器 + 增益 + 声像 +
   *     滤波 + 包络 + FM/RM + 噪声…），按几十次键就漏掉上千个节点，
   *     全部仍在音频线程上跑，最后顶不住就成片掉音。
   *
   * 不变式：**进入 `dying` 的声部一定会被 `dispose()`**
   * （由清扫器或引擎 `dispose()` 兜底）。
   */
  private readonly dying = new Set<SynthVoice>();
  /** 累计创建 / 累计拆解 —— 探针与单测靠这两个数断言「建了多少就拆了多少」 */
  private createdVoices = 0;
  private disposedVoices = 0;
  private readonly realtime: boolean;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private irTimer: ReturnType<typeof setTimeout> | null = null;
  /** 粒子纹理的预热定时器（一次性，构造后 800ms） */
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private irSeconds: number;
  /**
   * 控制速率的单一定时器（调制矩阵 + 粒子补发 + 加法频谱包络）。
   *
   * ⛔ 为什么是**一个**定时器而不是「每个声部一个」：
   * 一个定时器不可能泄漏，N 个就可能 —— 这是本项目已经栽过一次的坑
   * （见 `dying` 的注释）。所以这里与清扫器同一个思路：单表统管，
   * 空闲时自动停表。
   */
  private modTimer: ReturnType<typeof setInterval> | null = null;
  /** 矩阵是否处于「正在起作用」的状态（用于关掉时把声部恢复原状） */
  private modEngaged = false;
  /** 上一次矩阵灌进「全局目标」的过载量（避免每拍都重建失真曲线） */
  private lastModDrive = 0;
  private disposed = false;

  /**
   * @param ctx 目标上下文。传 `OfflineAudioContext` 即进入离线渲染模式：
   *            仍会正常排程，但**不开清扫定时器**（否则会在渲染中途拆掉振荡器）。
   */
  constructor(ctx: BaseAudioContext, patch?: unknown) {
    this.ctx = ctx;
    this.patch =
      patch === undefined ? { ...DEFAULT_SYNTH_PATCH } : sanitizeSynthPatch(patch);
    this.irSeconds = this.patch.reverbSize;
    // 显式判定而不是靠调用方声明：传错上下文不会有「看起来正常但不响」的中间态
    this.realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;

    this.fx = buildFx(ctx, this.patch);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.patch.volume;

    // 安全限幅：面板允许把过载/共振拧到很凶，没有这一级就会数字削顶
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = CHANNEL_GAIN;
    this.feedbackBus = ctx.createGain();
    this.feedbackBus.gain.value = CHANNEL_GAIN;
    this.voiceBus.connect(this.fx.input);
    this.feedbackBus.connect(this.fx.input);

    this.fx.output.connect(this.masterGain);
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.analyser);
    // 唯一与 Tone 交汇的一句：与主效果链物理隔离的独立干路
    this.analyser.connect(ctx.destination);

    this.noiseBufs = makeNoiseBuffers(ctx);
    // 粒子纹理单条要一百多毫秒：预热，别让第一次按粒化音卡在起音上。
    // ⚠️ 用 `setTimeout` 只为「别卡住构造」；这是**一次性预热**，不是回收路径。
    if (this.realtime) {
      const kinds: GranTex[] = ['saw', 'bell', 'vox', 'air'];
      this.warmupTimer = setTimeout(() => {
        this.warmupTimer = null;
        for (const k of kinds) {
          try {
            getGranTexture(ctx, k);
          } catch {
            /* 预热失败无所谓：真正用到时还会再算一次 */
          }
        }
      }, 800);
    }

    const l1 = this.makeLfo(this.patch.lfoWave, this.patch.lfoRate, [
      this.patch.lfoPitchAmt,
      this.patch.lfoFilterAmt,
      this.patch.lfoAmpAmt,
    ]);
    this.lfo = l1.osc;
    this.lfoPitch = l1.pitch;
    this.lfoFilter = l1.filter;
    this.lfoAmp = l1.amp;

    const l2 = this.makeLfo(this.patch.lfo2Wave, this.patch.lfo2Rate, [
      this.patch.lfo2PitchAmt,
      this.patch.lfo2FilterAmt,
      this.patch.lfo2AmpAmt,
    ]);
    this.lfo2 = l2.osc;
    this.lfo2Pitch = l2.pitch;
    this.lfo2Filter = l2.filter;
    this.lfo2Amp = l2.amp;
  }

  /** 粒子纹理查询（Voice 用） */
  granBuf(kind: GranTex): AudioBuffer {
    return getGranTexture(this.ctx, kind);
  }

  private makeLfo(
    wave: OscillatorType,
    rate: number,
    amts: [number, number, number],
  ): { osc: OscillatorNode; pitch: GainNode; filter: GainNode; amp: GainNode } {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = rate;
    const pitch = ctx.createGain();
    const filter = ctx.createGain();
    const amp = ctx.createGain();
    pitch.gain.value = amts[0];
    filter.gain.value = amts[1];
    amp.gain.value = amts[2];
    osc.connect(pitch);
    osc.connect(filter);
    osc.connect(amp);
    osc.start();
    return { osc, pitch, filter, amp };
  }

  busFor(channel: SynthChannel): GainNode {
    return channel === 'feedback' ? this.feedbackBus : this.voiceBus;
  }

  /** 面板频谱/示波器读数用 */
  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  getPatch(): SynthPatch {
    return this.patch;
  }

  /** 在响的声部数（面板读数 / 探针断言用）。不含已释放、等回收的那批。 */
  get activeVoices(): number {
    return this.voices.size;
  }

  /**
   * 声部账目 —— 探针与单测的断言口。
   *
   * 关键不变式：**`created` 迟早等于 `disposed`**。
   * 曾经这里能观察到 `created=60 / disposed=0`（每次松手都漏一个声部），
   * 而界面上完全看不出来 —— 只有按够多次数之后才「卡顿 → 没声」。
   * 那种「不会报错、只是慢慢变差」的 bug，只能靠一个能读出账目的口子抓住。
   */
  get voiceStats(): { live: number; dying: number; created: number; disposed: number } {
    return {
      live: this.voices.size,
      dying: this.dying.size,
      created: this.createdVoices,
      disposed: this.disposedVoices,
    };
  }

  /** 通道静音（录制跟弹参考声有自己的开关，不能连坐试听声） */
  setChannelMuted(channel: SynthChannel, muted: boolean): void {
    if (this.disposed) return;
    const bus = this.busFor(channel);
    bus.gain.setTargetAtTime(muted ? 0 : CHANNEL_GAIN, this.ctx.currentTime, 0.03);
  }

  // -------------------------------------------------------------------------
  // 调制矩阵（控制速率）
  //
  // 原型把这一层跑在 AudioWorklet 的音频线程上（60Hz 发拍），为的是
  // 「后台标签页的定时器被节流到 1 秒一次，切页后声音还在响、调制却卡住了」。
  // 我们没有引入 worklet，改用**主线程的单个 16ms 定时器**：
  //   · 好处是零新增构建产物、离线渲染里也能跑（离线时不开定时器，探针手动 tick）；
  //   · 代价是后台标签页里调制会跟着变慢 —— 而这里调制的是**试听音色**，
  //     用户切走页面时本来也听不到，所以这个代价可以接受。
  // ⛔ 绝不为每个声部各开一个定时器（N 个定时器才可能泄漏，见 `dying` 的注释）。
  // -------------------------------------------------------------------------

  /** 生效中的矩阵槽（源/目标都不是 none，且量不为 0） */
  private activeSlots(): Array<{ src: ModSrc; dst: ModDst; amt: number }> {
    const p = this.patch;
    const out: Array<{ src: ModSrc; dst: ModDst; amt: number }> = [];
    for (const i of [1, 2, 3, 4] as const) {
      const src = p[`mod${i}Src` as keyof SynthPatch] as ModSrc;
      const dst = p[`mod${i}Dst` as keyof SynthPatch] as ModDst;
      const amt = p[`mod${i}Amt` as keyof SynthPatch] as number;
      if (src === 'none' || dst === 'none' || Math.abs(amt) < 0.002) continue;
      out.push({ src, dst, amt });
    }
    return out;
  }

  /** 没有声部时也能取值的源（LFO / 宏 / 常数）—— 全局目标用它 */
  private globalSourceValue(src: ModSrc, t: number): number {
    const p = this.patch;
    switch (src) {
      case 'lfo1':
        return lfoValue(p.lfoWave, t * p.lfoRate);
      case 'lfo2':
        return lfoValue(p.lfo2Wave, t * p.lfo2Rate);
      case 'm1':
        return p.macroComplex * 2 - 1;
      case 'm2':
        return p.macroBright * 2 - 1;
      case 'm3':
        return p.macroThick * 2 - 1;
      case 'm4':
        return p.macroSpace * 2 - 1;
      default:
        return 0;
    }
  }

  /**
   * 全局目标（只能改整条效果链的那些）。
   *
   * ⚠️ 过载走「和上次差 > 0.01 才重建」的短路：`makeDistCurve` 是 2049 个点的
   * 循环，60Hz 无脑重建就是一条白烧的 CPU 跑满。
   */
  private applyGlobalMod(
    slots: Array<{ src: ModSrc; dst: ModDst; amt: number }>,
    t: number,
    ref: SynthVoice | null,
  ): void {
    const p = this.patch;
    const fx = this.fx;
    let drive = 0;
    let reverb = 0;
    let delay = 0;
    let bit = 0;
    for (const s of slots) {
      if (!GLOBAL_MOD_DSTS.has(s.dst)) continue;
      const raw = ref ? ref.sourceValue(s.src, t) : this.globalSourceValue(s.src, t);
      const v = raw * s.amt * (MOD_SCALE[s.dst] || 1);
      if (s.dst === 'drive') drive += v;
      else if (s.dst === 'reverb') reverb += v;
      else if (s.dst === 'delay') delay += v;
      else bit += v;
    }
    if (drive && Math.abs(drive - this.lastModDrive) > 0.01) {
      this.lastModDrive = drive;
      fx.shaper.curve = makeDistCurve(clamp(p.drive + drive, 0, 1), p.driveType);
    }
    if (reverb) fx.reverbWet.gain.setTargetAtTime(clamp(p.reverbMix + reverb, 0, 1), t, 0.03);
    if (delay) fx.delayWet.gain.setTargetAtTime(clamp(p.delayMix + delay, 0, 1), t, 0.03);
    if (bit) fx.bitShaper.curve = makeBitCurve(clamp(Math.round(p.bitDepth + bit), 2, 16));
  }

  private restoreGlobalMod(t: number): void {
    const p = this.patch;
    const fx = this.fx;
    this.lastModDrive = 0;
    fx.shaper.curve = makeDistCurve(p.drive, p.driveType);
    fx.reverbWet.gain.setTargetAtTime(p.reverbMix, t, 0.03);
    fx.delayWet.gain.setTargetAtTime(p.delayMix, t, 0.03);
    fx.bitShaper.curve = makeBitCurve(p.bitDepth);
  }

  private anyVoiceNeedsTick(): boolean {
    for (const v of this.voices.values()) if (v.needsTick) return true;
    return false;
  }

  private ensureModTick(): void {
    // 离线渲染不开：渲染期间 currentTime 会推进，定时器补发的粒子会插到错误的时刻
    if (!this.realtime || this.disposed || this.modTimer !== null) return;
    if (this.activeSlots().length === 0 && !this.anyVoiceNeedsTick()) return;
    this.modTimer = setInterval(() => this.tickMod(), MOD_TICK_MS);
  }

  private stopModTick(): void {
    if (this.modTimer === null) return;
    clearInterval(this.modTimer);
    this.modTimer = null;
  }

  /**
   * 控制速率的每个节拍：矩阵 + 粒子补发 + 加法频谱包络。
   *
   * 空闲时**自己停表** —— 这个函数是唯一的停表判据，别处不要偷偷 clear。
   * @internal 探针与单测手动驱动（离线渲染没有定时器）
   */
  tickMod(): void {
    if (this.disposed) {
      this.stopModTick();
      return;
    }
    const slots = this.activeSlots();
    const t = this.ctx.currentTime;
    let needed = slots.length > 0;
    if (slots.length) {
      this.modEngaged = true;
      let ref: SynthVoice | null = null;
      for (const v of this.voices.values()) {
        if (v.isDead) continue;
        if (ref === null) ref = v;
        v.applyMod(slots, t);
      }
      this.applyGlobalMod(slots, t, ref);
    } else if (this.modEngaged) {
      for (const v of this.voices.values()) if (!v.isDead) v.resetMod(t);
      this.restoreGlobalMod(t);
      this.modEngaged = false;
    }
    for (const v of this.voices.values()) {
      if (!v.needsTick) continue;
      v.tick(t);
      needed = true;
    }
    if (!needed) this.stopModTick();
  }

  /**
   * 矩阵配置变了（源/目标/量值）。
   *
   * 两条分支都必要：
   *   · 有生效槽 → 确保节拍在跑（否则「拖了量值但一个声部都没有」时全局目标不会被推）；
   *   · 槽全空了 → **立刻跑一次** `tickMod`，把声部与全局目标恢复原状。
   *     不立刻跑的话，最后一个槽被关掉时会**永远**停在调制后的状态 ——
   *     听感上就是「把调制量拧回 0，音色却还是被调过的样子」。
   */
  private onModConfigChanged(): void {
    if (this.activeSlots().length) this.ensureModTick();
    else this.tickMod();
  }

  // -------------------------------------------------------------------------
  // Patch 写入
  // -------------------------------------------------------------------------

  /** 整体套用（预设 / 存档 hydrate）。全部参数一次写全。 */
  setPatch(patch: unknown): void {
    if (this.disposed) return;
    const next = sanitizeSynthPatch(patch);
    this.patch = next;
    for (const key of Object.keys(next) as Array<keyof SynthPatch>) {
      this.writeParam(key, next[key], true);
    }
    // 混响空间变化要重建 IR：批量套用不走防抖（否则立刻试听还是旧空间）
    if (next.reverbSize !== this.irSeconds) this.rebuildIR(next.reverbSize);
    // 换整份 patch 时矩阵可能从「没启用」变成「启用」（或反过来），节拍要跟着调整
    this.onModConfigChanged();
    this.ensureModTick();
  }

  /** 单参数写入（面板拖动）。非法值在这里被夹取/回落，不会漏进 AudioParam。 */
  applyParam(name: keyof SynthPatch, raw: unknown): void {
    if (this.disposed) return;
    const v = sanitizeSynthParamValue(name, raw, this.patch);
    if (this.patch[name] === v) return;
    this.patch = { ...this.patch, [name]: v } as SynthPatch;
    this.writeParam(name, v, false);
  }

  /**
   * 把值真正写进节点。
   * `bulk = true`（预设/存档）时混响空间立即重建；`false`（拖动）时防抖。
   */
  private writeParam(
    name: keyof SynthPatch,
    value: SynthPatch[keyof SynthPatch],
    bulk: boolean,
  ): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const fx = this.fx;
    const maxF = ctx.sampleRate * 0.45;

    switch (name) {
      case 'drive':
        fx.shaper.curve = makeDistCurve(value as number, this.patch.driveType);
        break;
      case 'driveType':
        fx.shaper.curve = makeDistCurve(this.patch.drive, value as string);
        break;
      case 'chorusMix': {
        const v = value as number;
        fx.chorusWet.gain.setTargetAtTime(v * 0.75, t, 0.02);
        fx.chorusDry.gain.setTargetAtTime(1 - v * 0.35, t, 0.02);
        break;
      }
      case 'chorusRate':
        fx.chorusLfo.frequency.setTargetAtTime(value as number, t, 0.05);
        break;
      case 'delayTime':
        fx.delayNode.delayTime.setTargetAtTime(value as number, t, 0.06);
        break;
      case 'delayFb':
        // 夹到 0.92 以下：≥1 的正反馈在没有清零输入时会自激成持续啸叫
        fx.delayFb.gain.setTargetAtTime(Math.min(0.92, value as number), t, 0.02);
        break;
      case 'delayMix':
        fx.delayWet.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'delayPan':
        fx.delayPan.pan.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'delayHP':
        fx.delayHP.frequency.setTargetAtTime(clamp(value as number, 10, maxF), t, 0.02);
        break;
      case 'delayLP':
        fx.delayLP.frequency.setTargetAtTime(clamp(value as number, 10, maxF), t, 0.02);
        break;
      case 'reverbMix':
        fx.reverbWet.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'reverbPre':
        fx.reverbPre.delayTime.setTargetAtTime(value as number, t, 0.05);
        break;
      case 'reverbDamp':
        fx.reverbDamp.frequency.setTargetAtTime(clamp(value as number, 10, maxF), t, 0.05);
        break;
      case 'reverbSize':
        this.scheduleIR(value as number, bulk);
        break;
      case 'bitDepth':
        fx.bitShaper.curve = makeBitCurve(value as number);
        break;
      case 'stereoWidth': {
        const v = value as number;
        const a = (1 + v) / 2;
        const b = (1 - v) / 2;
        fx.widthLL.gain.setTargetAtTime(a, t, 0.02);
        fx.widthLR.gain.setTargetAtTime(b, t, 0.02);
        fx.widthRL.gain.setTargetAtTime(b, t, 0.02);
        fx.widthRR.gain.setTargetAtTime(a, t, 0.02);
        break;
      }
      case 'masterPan':
        fx.masterPan.pan.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'masterFilterType':
        fx.masterFilter.type = value as BiquadFilterType;
        break;
      case 'masterFilterCutoff':
        fx.masterFilter.frequency.setTargetAtTime(clamp(value as number, 10, maxF), t, 0.02);
        break;
      case 'masterFilterReso':
        fx.masterFilter.Q.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'volume':
        this.masterGain.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfoRate':
        this.lfo.frequency.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfoWave':
        this.lfo.type = value as OscillatorType;
        break;
      case 'lfoPitchAmt':
        this.lfoPitch.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfoFilterAmt':
        this.lfoFilter.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfoAmpAmt':
        this.lfoAmp.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfo2Rate':
        this.lfo2.frequency.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfo2Wave':
        this.lfo2.type = value as OscillatorType;
        break;
      case 'lfo2PitchAmt':
        this.lfo2Pitch.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfo2FilterAmt':
        this.lfo2Filter.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      case 'lfo2AmpAmt':
        this.lfo2Amp.gain.setTargetAtTime(value as number, t, 0.02);
        break;
      default:
        // 声部级参数（振荡器 / 包络 / 演奏）由下面统一下发给在响的声部
        break;
    }

    for (const voice of this.voices.values()) {
      voice.updateParam(name, value as number | string, t);
    }

    /*
      矩阵配置或矩阵源变了 → 可能要让节拍起/停。
      ⛔ 必须在声部循环**之后**：`activeSlots` 读的是 `this.patch`，而
      `applyParam` 在调用本函数前已经把它更新过了，所以这里读到的就是新值。
    */
    if (String(name).startsWith('mod')) this.onModConfigChanged();
    if (name === 'addEnvAmt' || name === 'addHarm') this.ensureModTick();
  }

  private scheduleIR(seconds: number, bulk: boolean): void {
    if (bulk) {
      if (this.irTimer !== null) {
        clearTimeout(this.irTimer);
        this.irTimer = null;
      }
      this.rebuildIR(seconds);
      return;
    }
    // 拖动中：防抖，避免每个 pointermove 都生成几百 KB 的脉冲响应
    if (this.irTimer !== null) clearTimeout(this.irTimer);
    this.irTimer = setTimeout(() => {
      this.irTimer = null;
      this.rebuildIR(seconds);
    }, IR_DEBOUNCE_MS);
  }

  private rebuildIR(seconds: number): void {
    if (this.disposed) return;
    this.irSeconds = seconds;
    try {
      this.fx.convolver.buffer = makeIR(this.ctx, seconds, 3);
    } catch {
      /* 极端长度下分配失败：保留旧 IR，不要因此中断整个音色编辑 */
    }
  }

  // -------------------------------------------------------------------------
  // 发声
  // -------------------------------------------------------------------------

  /**
   * 响一个音（按 MIDI 音号）。
   *
   * 时刻语义：`whenCtxSec` 是**绝对 ctx 秒**，会与 `currentTime` 取大 ——
   * 迟到的排程不会「补响一串」，而是并到当下。
   */
  noteOn(midi: number, opts: SynthNoteOptions = {}): void {
    if (this.disposed) return;
    if (!Number.isFinite(midi)) return;
    const note = clamp(Math.round(midi), 0, 127);
    const ctx = this.ctx;
    const when = Number.isFinite(opts.whenCtxSec)
      ? Math.max(opts.whenCtxSec as number, ctx.currentTime)
      : ctx.currentTime;
    const durationSec = Number.isFinite(opts.durationSec)
      ? Math.max(0.01, opts.durationSec as number)
      : 0.5;
    const velocity = Number.isFinite(opts.velocity)
      ? clamp(opts.velocity as number, 0, 1)
      : 0.85;
    const channel: SynthChannel = opts.channel === 'feedback' ? 'feedback' : 'voice';

    if (this.patch.monoMode === 1) {
      for (const [key, v] of this.voices) {
        this.voices.delete(key);
        this.retire(v, when, true);
      }
    } else {
      const same = this.voices.get(note);
      if (same) {
        this.voices.delete(note);
        this.retire(same, when, true);
      }
    }

    if (this.voices.size >= MAX_VOICES) {
      const oldest = this.voices.keys().next();
      if (!oldest.done) {
        const victim = this.voices.get(oldest.value);
        this.voices.delete(oldest.value);
        if (victim) this.retire(victim, when, true);
      }
    }

    const voice = new SynthVoice(this, note, velocity, channel);
    this.createdVoices++;
    voice.trigger(when);
    voice.release(when + durationSec, false);
    this.voices.set(note, voice);
    this.lastNoteFreq = midiToHz(note);
    this.ensureReaper();
    // 粒子 / 加法频谱包络要按控制速率补发（矩阵生效时也走同一个节拍）
    this.ensureModTick();
  }

  /**
   * 把声部从「在响」移交到「等回收」。
   *
   * ⛔ 全靠这个函数，别处**不要**再直接 `release()` —— 那样会绕过 `dying`，
   * 声部就又变成不可达的孤儿了。这是本次修复的核心不变式。
   */
  private retire(voice: SynthVoice, when: number, fast: boolean): void {
    voice.release(when, fast);
    this.dying.add(voice);
    this.ensureReaper();
  }

  /** 真正拆掉一个声部（唯一的计数点，保证 created / disposed 配对） */
  private killVoice(voice: SynthVoice): void {
    this.disposedVoices++;
    voice.dispose();
  }

  /** 手动释放某个音（UI 抬起键） */
  noteOff(midi: number, fast = false, whenCtxSec?: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(midi)) return;
    const note = clamp(Math.round(midi), 0, 127);
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    const when = Number.isFinite(whenCtxSec)
      ? Math.max(whenCtxSec as number, this.ctx.currentTime)
      : this.ctx.currentTime;
    // ⛔ 必须先 retire（进 dying）再谈别的 —— 只 delete 不 retire 就是那个老 bug
    this.retire(voice, when, fast);
  }

  /** 全部停止（快速释放，不留尾音） */
  releaseAll(whenCtxSec?: number): void {
    if (this.disposed) return;
    const when = Number.isFinite(whenCtxSec)
      ? Math.max(whenCtxSec as number, this.ctx.currentTime)
      : this.ctx.currentTime;
    for (const voice of this.voices.values()) this.retire(voice, when, true);
    this.voices.clear();
  }

  /**
   * 清扫到点的声部。一个定时器干完全部回收，绝不为每个音符挂一个 timer。
   *
   * `nowSec` 只为测试/探针开放：定时器在 `OfflineAudioContext` 下刻意不开
   * （见 `ensureReaper`），没有这个入口就没法在离线渲染里断言回收真的发生过。
   * @internal
   */
  sweepVoices(nowSec?: number): void {
    if (this.disposed) {
      this.stopReaper();
      this.stopModTick();
      return;
    }
    const now = Number.isFinite(nowSec) ? (nowSec as number) : this.ctx.currentTime;
    for (const [key, voice] of this.voices) {
      if (voice.disposeAtSec <= now) {
        this.voices.delete(key);
        this.killVoice(voice);
      }
    }
    for (const voice of this.dying) {
      if (voice.disposeAtSec <= now) {
        this.dying.delete(voice);
        this.killVoice(voice);
      }
    }
    // 两侧都空了才能停表 —— 只看 voices 会让 dying 里的声部没人收
    if (this.voices.size === 0 && this.dying.size === 0) {
      this.stopReaper();
      // 调制节拍同理：没有声部、也没有生效的槽，就没有人需要它了
      if (this.activeSlots().length === 0) this.stopModTick();
    }
  }

  private ensureReaper(): void {
    // 离线渲染刻意不开：渲染期间 currentTime 会推进，清扫会在中途 stop() 掉振荡器
    if (!this.realtime || this.reaper !== null || this.disposed) return;
    this.reaper = setInterval(() => this.sweepVoices(), REAPER_INTERVAL_MS);
  }

  private stopReaper(): void {
    if (this.reaper === null) return;
    clearInterval(this.reaper);
    this.reaper = null;
  }

  /**
   * 卸载 / 单测清理：停掉定时器并拆掉整张图。
   * 生产路径不调用（单例常驻，反复建图会有爆音）。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopReaper();
    this.stopModTick();
    if (this.irTimer !== null) {
      clearTimeout(this.irTimer);
      this.irTimer = null;
    }
    if (this.warmupTimer !== null) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    for (const voice of this.voices.values()) this.killVoice(voice);
    for (const voice of this.dying) this.killVoice(voice);
    this.voices.clear();
    this.dying.clear();
    const quiet = quietly;
    quiet(() => this.lfo.stop());
    quiet(() => this.lfo2.stop());
    quiet(() => this.fx.chorusLfo.stop());
    quiet(() => this.analyser.disconnect());
  }
}
