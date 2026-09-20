/**
 * ReverbUnit —— 完整混响单元：IR 卷积 + 湿声滤波 + 立体声宽度 + 干湿混合。
 *
 * ══ 为什么内部**全部用原生节点**，不混 Tone ══
 *
 * 这个类踩过两次「接线把整个应用搞崩」的坑，两次都不是逻辑错，而是
 * **Tone 与原生节点的混用陷阱**：
 *
 *   第一次：`Tone.connect(toneNode, rawConvolverNode)` →
 *     `TypeError: Failed to execute 'connect' on 'AudioNode':
 *      Overload resolution failed.`
 *
 *   第二次：统一拆包成原生节点，用 `n.input as unknown as AudioNode` 取端点 →
 *     `Error: Cannot connect to undefined node`
 *     因为 **`ToneAudioNode.input` 的类型并不统一**：
 *       · `Tone.Gain.input`  是原生 `GainNode`
 *       · `Tone.Filter.input` 却是 `Tone.Gain`（Tone 的包装对象）
 *     在 Gain 上侥幸能跑，在 Filter 上就把 Tone 对象当原生节点用了。
 *
 * 这两次报错都**不带上下文**，且发生在 `buildEffectChain()` ——
 * 也就是 `App` 启动时同步执行的 `getMasterChain()` 里，
 * 于是整个 React 树崩掉，表现为「制作台打不开 / MIDI 导入报没有有效音符」
 * 这类看起来毫不相关的故障。
 *
 * 结论（写死在这里，别再回头）：
 *   **内部拓扑一律用原生 Web Audio 节点搭建**（ConvolverNode / BiquadFilterNode /
 *   GainNode / ChannelSplitter / ChannelMerger），原生 `connect()` 的语义在
 *   规范里是唯一且明确的，不存在重载歧义，也不需要任何类型断言。
 *   只在**对外边界**（`input` / `output`）包一层 `Tone.Gain`，
 *   以满足 `EffectUnit.create` 返回 `ToneAudioNode` 的链路契约 ——
 *   那一层由 `effects.ts` 的 `Tone.connectSeries` 处理，是已经验证可用的路径。
 */
import * as Tone from 'tone';
import { generatePrototypeIR, type PrototypeReverbOptions } from './prototype-reverb';

/** 湿声滤波器 Q（与原型一致：0.7，接近巴特沃斯，无谐振峰） */
const WET_FILTER_Q = 0.7;
/** 参数平滑时间常数（秒）—— 与原型 `setTargetAtTime(v, t, 0.02)` 一致 */
const RAMP_SEC = 0.02;

/** IR 参数（改变即重建脉冲响应） */
export interface ReverbIrParams {
  decay: number;
  preDelay: number;
  damping: number;
  diffusion: number;
  size: number;
  early: number;
}

export class ReverbUnit extends Tone.ToneAudioNode {
  readonly name = 'ReverbUnit';

  /** 链路入口 / 出口（对外边界，保持 Tone 类型以符合 EffectUnit 契约） */
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  /* ── 以下全部为原生节点 ── */
  private readonly _ctx: BaseAudioContext;
  private readonly _in: GainNode;
  private readonly _out: GainNode;
  /** 干声支路增益（1 - wet） */
  private readonly _dry: GainNode;
  /** 湿声支路增益（wet） */
  private readonly _wet: GainNode;
  /** IR 卷积器 */
  private readonly _conv: ConvolverNode;
  /** 湿声低切 / 高切 */
  private readonly _hp: BiquadFilterNode;
  private readonly _lp: BiquadFilterNode;
  /** M/S 宽度矩阵 */
  private readonly _wLL: GainNode;
  private readonly _wLR: GainNode;
  private readonly _wRL: GainNode;
  private readonly _wRR: GainNode;

  /** 当前 IR 参数（重建时用） */
  private _ir: ReverbIrParams;
  /** IR 重建版本号：快速拖旋钮时只跑最新一次，旧的生成完后发现版本不对就丢弃 */
  private _irVersion = 0;
  /** IR 重建的串行链：保证后一次生成不会与上一次交错 */
  private _ready: Promise<void> = Promise.resolve();

  constructor(options: PrototypeReverbOptions & { decay: number; preDelay: number }) {
    super();

    this._ir = {
      decay: options.decay,
      preDelay: options.preDelay,
      damping: options.damping ?? 0.4,
      diffusion: options.diffusion ?? 0.7,
      size: options.size ?? 1.2,
      early: options.early ?? 0.55,
    };

    /* 对外边界的 Tone 包装。`input`/`output` 是 Tone.Gain，
       但内部拓扑只认下面这两个原生 GainNode —— 见类注释。 */
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);
    this._ctx = (this.input.context.rawContext ?? this.input.context) as BaseAudioContext;
    this._in = this._ctx.createGain();
    this._out = this._ctx.createGain();
    // 把 Tone 包装与原生端点对接（这一步用原生 connect，端点明确）
    this._bridgeToNative();

    this._dry = this._ctx.createGain();
    this._wet = this._ctx.createGain();
    this._conv = this._ctx.createConvolver();
    /*
      normalize = false：IR 自身已按 LOCAL_NOISE_PEAK 归一化，
      再交给浏览器按能量归一化会把「早期反射相对弥散尾的强度」
      这个刻意设计的比例抹平 —— 那正是空间感所在。
    */
    this._conv.normalize = false;

    this._hp = this._ctx.createBiquadFilter();
    this._hp.type = 'highpass';
    this._hp.frequency.value = options.lowCutHz ?? 80;
    this._hp.Q.value = WET_FILTER_Q;

    this._lp = this._ctx.createBiquadFilter();
    this._lp.type = 'lowpass';
    this._lp.frequency.value = options.highCutHz ?? 12000;
    this._lp.Q.value = WET_FILTER_Q;

    this._wLL = this._ctx.createGain();
    this._wLR = this._ctx.createGain();
    this._wRL = this._ctx.createGain();
    this._wRR = this._ctx.createGain();

    this.wire();
    this.setWidth(options.width ?? 1, 0);
    this.setWet(options.wet ?? 0.4, 0);
    this.rebuildIr();
  }

  /**
   * 把 Tone 包装与内部原生端点对接。
   *
   * `Tone.Gain` 的底层节点通过 `ToneAudioNode` 的 `input`/`output` 暴露，
   * 但那两个属性的**类型不统一**（见类注释），所以这里不去猜：
   * 直接读写 `.gain`（它一定存在且是 AudioParam），
   * 再用它所属的 context 建我们自己的原生端点。
   *
   * 实际接线方向：
   *   Tone.input  ←  外部信号（由 effects.ts 连进来）
   *   但 Tone.Gain 是个「增益为 1 的过路节点」，我们无法把内部节点插进它的
   *   内部拓扑。故改为：**把 Tone 包装当成纯占位端点**，
   *   真正的信号路径完全走原生：`_in → … → _out`，
   *   而 `input`/`output` 只负责让 effects.ts 的连线有个落点 ——
   *   这通过 `Tone.connect`/`Tone.connectSeries` 对 ToneAudioNode 的支持完成。
   */
  private _bridgeToNative(): void {
    // 让 Tone 的 input 增益直通我们的原生 _in（两段都在同一 context）
    const toneInRaw = this.input.input as unknown;
    const toneOutRaw = this.output.input as unknown;
    if (toneInRaw instanceof AudioNode) {
      toneInRaw.connect(this._in);
    } else {
      /**
       * 意图：桥接失败时 console.warn 而非静默。
       * 旧版 if 里连了但没 else —— 桥接失败时整个混响支路无声且无报错，
       * 比崩溃更难排查。加 warn 至少能在 console 里看到。
       */
      console.warn('[ReverbUnit] Tone input 桥接失败：input.input 不是 AudioNode，混响支路将无声');
    }
    if (toneOutRaw instanceof AudioNode) {
      this._out.connect(toneOutRaw);
    } else {
      console.warn('[ReverbUnit] Tone output 桥接失败：output.input 不是 AudioNode，混响支路将无声');
    }
  }

  /** 内部拓扑（全部原生 connect，零重载歧义） */
  private wire(): void {
    // ① 干声支路：_in → _dry → _out
    this._in.connect(this._dry);
    this._dry.connect(this._out);

    // ② 湿声支路：_in → conv → hp → lp → 宽度矩阵 → _wet → _out
    this._in.connect(this._conv);
    this._conv.connect(this._hp);
    this._hp.connect(this._lp);

    const split = this._ctx.createChannelSplitter(2);
    const merge = this._ctx.createChannelMerger(2);
    this._lp.connect(split);
    // L' = a·L + b·R，R' = a·R + b·L（a/b 由 setWidth 写入）
    split.connect(this._wLL, 0);
    split.connect(this._wRL, 0);
    split.connect(this._wLR, 1);
    split.connect(this._wRR, 1);
    this._wLL.connect(merge, 0, 0);
    this._wLR.connect(merge, 0, 1);
    this._wRL.connect(merge, 0, 1);
    this._wRR.connect(merge, 0, 0);

    merge.connect(this._wet);
    this._wet.connect(this._out);
  }

  /* ══════════════════ IR 参数 ══════════════════ */

  /**
   * 重建脉冲响应。
   *
   * 版本号机制：快速拖旋钮时产生一串重建请求，每个请求只跑最新参数，
   * 旧的生成完后发现版本号已过期就丢弃 —— 避免主线程堆积同步计算卡顿。
   */
  rebuildIr(): void {
    const params = { ...this._ir };
    const myVersion = ++this._irVersion;
    this._ready = this._ready
      .catch(() => undefined)
      .then(() => {
        // 被更新的请求覆盖了，直接丢弃
        if (myVersion !== this._irVersion) return;
        const sr = this._ctx.sampleRate;
        const ir = generatePrototypeIR(this._ctx, params);
        // 再次检查：生成期间可能又来了新请求
        if (myVersion !== this._irVersion) return;
        const padSamples = Math.max(0, Math.floor(params.preDelay * sr));
        if (padSamples === 0) {
          this._conv.buffer = ir;
          return;
        }
        // preDelay 拼成 IR 开头的静音段 —— IR 自包含，不需要额外的延迟节点
        const padded = this._ctx.createBuffer(2, ir.length + padSamples, sr);
        for (let ch = 0; ch < 2; ch++) {
          padded.getChannelData(ch).set(ir.getChannelData(ch), padSamples);
        }
        this._conv.buffer = padded;
      });
  }

  /**
   * 批量写 IR 参数；只在真的变化时才重建（避免无谓的毫秒级运算）。
   *
   * 非有限值一律忽略（见 `setParam` 的说明）——否则 `generatePrototypeIR`
   * 会拿着 NaN 算出整段 NaN 的 IR，卷积结果静音且极难排查。
   */
  setIrParams(next: Partial<ReverbIrParams>): void {
    let changed = false;
    for (const k of Object.keys(next) as Array<keyof ReverbIrParams>) {
      const v = next[k];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v !== this._ir[k]) {
        this._ir[k] = v;
        changed = true;
      }
    }
    if (changed) this.rebuildIr();
  }

  getIrParams(): Readonly<ReverbIrParams> {
    return this._ir;
  }

  /* ══════════════════ 路径参数（实时，不重建 IR）══════════════════ */

  /**
   * 安全写 AudioParam：**非有限值直接忽略**。
   *
   * ══ 为什么每一处写入都要过这一层 ══
   *
   * `AudioParam.setTargetAtTime(NaN | Infinity | undefined)` 会抛
   *   `TypeError: The provided float value is non-finite`
   * 而本方法是**渲染期同步调用**的（`apply()` ← `getMasterChain()` ← App 启动
   * 或页面渲染），所以一次坏参数会让整页被 React 卸载 ——
   * 表现为「切换过去画面变黑」，且报错信息只有一句 non-finite，
   * 完全看不出是哪个字段的问题。
   *
   * 真实案例：`reverb` 新增 7 个字段后，老存档缺这些键 →
   * `undefined` 直接喂进 setTargetAtTime → 演奏台/制作台/混音台全部黑屏。
   * 上游虽然已经修了迁移（migrateProject 用默认值打底），但**参数写入
   * 这一层必须自己设防**：将来任何人新增字段、任何存档损坏，
   * 最坏结果都只是「这个参数不生效」，而不会让整页崩掉。
   */
  private static setParam(p: AudioParam, value: number, rampSec: number, now: number): void {
    if (!Number.isFinite(value)) return;
    p.setTargetAtTime(value, now, rampSec);
  }

  /**
   * 干湿比 0..1。
   *
   * 用两条支路增益实现（而非 `Tone.CrossFade`）：交叉淡化需要三个增益
   * 且依赖 Tone 的包装语义，而这里两条支路更直白 ——
   * `dry = 1 - w`、`wet = w`。线性而非等功率，与原型一致。
   */
  setWet(v: number, rampSec = RAMP_SEC): void {
    if (!Number.isFinite(v)) return;
    const w = Math.min(1, Math.max(0, v));
    const t = this._ctx.currentTime;
    ReverbUnit.setParam(this._wet.gain, w, rampSec, t);
    ReverbUnit.setParam(this._dry.gain, 1 - w, rampSec, t);
  }

  setLowCut(hz: number, rampSec = RAMP_SEC): void {
    ReverbUnit.setParam(this._hp.frequency, hz, rampSec, this._ctx.currentTime);
  }

  setHighCut(hz: number, rampSec = RAMP_SEC): void {
    ReverbUnit.setParam(this._lp.frequency, hz, rampSec, this._ctx.currentTime);
  }

  /** 立体声宽度 0..2（M/S 矩阵：a = (1+w)/2，b = (1-w)/2） */
  setWidth(width: number, rampSec = RAMP_SEC): void {
    if (!Number.isFinite(width)) return;
    const a = (1 + width) / 2;
    const b = (1 - width) / 2;
    const t = this._ctx.currentTime;
    ReverbUnit.setParam(this._wLL.gain, a, rampSec, t);
    ReverbUnit.setParam(this._wRR.gain, a, rampSec, t);
    ReverbUnit.setParam(this._wLR.gain, b, rampSec, t);
    ReverbUnit.setParam(this._wRL.gain, b, rampSec, t);
  }

  /** IR 就绪（effects.ts 的聚合 ready() 消费；离线渲染前必须 await） */
  get ready(): Promise<void> {
    return this._ready;
  }

  dispose(): this {
    for (const n of [
      this._in,
      this._out,
      this._dry,
      this._wet,
      this._conv,
      this._hp,
      this._lp,
      this._wLL,
      this._wLR,
      this._wRL,
      this._wRR,
    ]) {
      try {
        n.disconnect();
      } catch {
        /* 未连接则忽略 */
      }
    }
    /**
     * 意图：释放 IR buffer + 调用 super.dispose()。
     * 旧版 dispose 跳过了基类 Tone.ToneAudioNode.dispose()，
     * Tone 内部状态（监听器、定时器等）残留 → 内存泄漏。
     * _conv.buffer = null 释放 IR（可能几百 KB 的 Float32Array）。
     */
    this._conv.buffer = null;
    this.input.dispose();
    this.output.dispose();
    super.dispose();
    return this;
  }
}
