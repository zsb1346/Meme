/**
 * PrototypeReverb —— 用 `原型/效果器/混响.html` 的 IR 合成算法替换 Tone.Reverb。
 *
 * ══ 为什么要换 ══
 *
 * `Tone.Reverb.generate()` 生成的是「噪声 + 指数衰减」：
 *   OfflineContext 里跑两路 Noise，用一个 GainNode 做
 *   `setValueAtTime(0) → setValueAtTime(1, preDelay) → exponentialApproach(0, decay)`。
 * 也就是**一条平滑的噪声尾巴**，没有早期反射、没有扩散、没有频率相关阻尼。
 * 听感上偏「一片糊」，缺乏空间感与前后层次。
 *
 * 原型的 `generateIR()` 则包含四个物理环节：
 *   1. **早期反射**：左右声道各 7 个抽头（L 4/9/15/23/33/47/63ms，
 *      R 5/11/18/27/37/53/71ms），幅度按 0.68^k 衰减 ——
 *      这组离散反射才让人脑判断出「空间有多大、是什么形状」。
 *   2. **扩散**：若干次单极点低通（k=0.3）把噪声「抹开」，
 *      模拟空气与壁面的多次散射。
 *   3. **频率相关阻尼**：一阶低通，截止频率随 damping 指数下降
 *      （`fc = 18000·e^(-damping·4.5) + 300`）—— 真实空间里高频衰减更快。
 *   4. **双指数包络** `(1-t)^1.4 · e^(-2.2t)`：比单纯指数更接近实测 IR
 *      （先快速下落、再拖一条长尾）。
 *
 * ══ 与 Tone.Reverse 的关系 ══
 *
 * 继承并**只覆写 `generate()`**，其余（decay/preDelay 的 getter·setter、
 * `ready` Promise 语义、`_convolver` 接线、Effect 的 wet 干湿混合）
 * 全部沿用父类 —— 这样 `effect-units/reverb.ts` 的 `ready()`
 * 与 `effects.ts` 的离线渲染聚合逻辑完全不用改。
 *
 * ══ 参数现状 ══
 *
 * `ReverbSettings` 目前只有 `decaySec` / `preDelaySec` / `wet` 三个字段，
 * 所以**阻尼与扩散暂时用默认常数**（音色已经比 Tone.Reverb 好得多）。
 * 等 `ReverbSettings` 扩出 damping / diffusion / size 字段后，
 * 只需在 create 时把它们传进来即可 —— 本类已经预留了 options。
 */

export interface PrototypeReverbOptions {
  decay: number;
  preDelay: number;
  /**
   * 高频阻尼 0..1。
   * 0 → 截止 18.3kHz（几乎不吸高频）；1 → 约 500Hz（闷）。
   */
  damping?: number;
  /** 扩散 0..1：0 只有早期反射，1 完全抹开成弥散场 */
  diffusion?: number;
  /** 房间尺寸系数（缩放早期反射的到达时间） */
  size?: number;
  /** 早期反射强度 0..1 */
  early?: number;
  /** 湿声低切（Hz）—— 实时参数，不触发 IR 重建 */
  lowCutHz?: number;
  /** 湿声高切（Hz）—— 实时参数，不触发 IR 重建 */
  highCutHz?: number;
  /** 立体声宽度 0..2 —— 实时参数，不触发 IR 重建 */
  width?: number;
  wet?: number;
}

/** `damping === 0` 时的阻尼低通截止（Hz）—— 与原型一致 */
const DAMPING_FC_MAX = 18000;
/** 阻尼低通截止的下限（Hz） */
const DAMPING_FC_MIN = 300;
/** 早期反射抽头时间（秒）。左右声道刻意不同 —— 这是立体声空间感的来源 */
const EARLY_TIMES_L = [0.004, 0.009, 0.015, 0.023, 0.033, 0.047, 0.063];
const EARLY_TIMES_R = [0.005, 0.011, 0.018, 0.027, 0.037, 0.053, 0.071];
/** 每个后续早期反射的幅度衰减比 */
const EARLY_DECAY = 0.68;
/** 起始淡入时长（秒）—— 避免 IR 开头那一下产生咔哒 */
const FADE_IN_SEC = 0.001;
/**
 * 早期反射首抽头相对于**同时刻弥散尾**的目标幅度比。
 *
 * ══ 为什么是 4.0 而不是 1.8 ══
 *
 * 一切以「抽头能否从弥散尾里站出来」为准。白噪声的**逐采样峰**约为其
 * 平均绝对值的 2.5 倍；弥散尾定标到 `LOCAL_NOISE_PEAK = 0.5` 后，
 * 首抽头附近的噪声逐采样峰实测就有 0.46~0.50。
 *
 * 比值取 1.8 时算出的首抽头目标幅度只有 0.42 —— **比噪声峰还低**，
 * 七根抽头于是全部淹没（实测抽头峰 0.30~0.46，与噪声不可分）。
 * 后果不只是「听起来糊」：`size` 与 `early` 这两个参数几乎失去可闻效果，
 * 而它们正是本算法相对裸 Tone.Reverb 的全部价值。
 *
 * 取 4.0 后首抽头约 0.93，明确高于噪声峰；后续抽头按 0.68^k 落在
 * 尾音之上，离散回声可辨、层次成形。峰值由 IR_PEAK_CEILING 与软限幅兜住。
 */
const EARLY_TARGET_RATIO = 4.0;
/**
 * 湿声尾音相对干声的目标能量比。
 *
 * ══ 为什么必须按「能量」而不是「峰值」标定 ══
 *
 * 卷积的输出电平由 IR 的**有效能量**决定，不是峰值：
 *   对于白噪声型 IR，`out_rms ≈ in_rms × sqrt(Σ h[i]²)`
 *
 * 早先按「峰值归一到 0.5」的写法，2.5s 尾长的 IR 得到
 *   `sqrt(Σh²) ≈ 9.87` → **放大约 10 倍**，
 * 于是「只开混响」时输出 rms 1.57（干声直通只有 0.25）——
 * 混响糊成一片、还会把后级压缩器一直顶着。
 *
 * 现在按目标能量反推标定量：
 *   `targetRms = 本常量 / sqrt(len)`
 * 由 `out_rms = in_rms × sqrt(Σh²)`、`Σh² ≈ len × rms²` 可得
 *   `out_rms ≈ in_rms × sqrt(len) × rms`
 * 令 `out_rms = 本常量 × in_rms` 即得上式 —— **尾长自动适配**，
 * 不需要为 0.3s 与 10s 各调一个魔数。
 *
 * 0.45 的听感含义：干湿各半时整体电平约 +0.5dB，混响明确可闻但不盖过干声。
 */
const IR_TAIL_TO_INPUT = 0.45;

/** 峰值上限（能量标定后通常远低于此；极端参数组合才触发软限幅） */
const IR_PEAK_CEILING = 1.0;
/** 早期反射区的本地噪声定标值 —— 决定「离散回声 vs 弥散尾」的清晰度 */
const LOCAL_NOISE_PEAK = 0.5;

/**
 * 合成一段立体声冲激响应。
 *
 * ══ 为什么要注入 `rng` ══
 *
 * 这个算法有三处随机：尾音噪声、早期反射的抽样、以及抽头位置的抖动。
 * 用全局 `Math.random` 会让它**不可测** —— 早期反射是稀疏脉冲，
 * 幅度（约 0.05）远小于噪声的逐采样幅度（约 0.2），
 * 于是「脉冲是否落在正确位置」这类断言会被噪声方差随机地掩盖，
 * 写出间歇性失败的测试（比没有测试更糟）。
 *
 * 把随机源作为参数注入后，测试可以传确定性 PRNG，
 * 从而在不改算法行为的前提下得到可复现的结果。
 * 默认仍是 `Math.random`，生产路径不受影响。
 *
 * 注意：这是**一次性生成**，不参与实时音频回调，
 * 故随机噪声不会造成逐帧抖动（参数改动才重新生成，上层还有防抖）。
 */
export function generatePrototypeIR(
  ctx: BaseAudioContext,
  opts: Required<
    Pick<PrototypeReverbOptions, 'decay' | 'damping' | 'diffusion' | 'size' | 'early'>
  >,
  /** 随机源 0..1；注入确定性 PRNG 可让测试可复现 */
  rng: () => number = Math.random,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const duration = Math.max(0.2, Math.min(10, opts.decay));
  const len = Math.max(1, Math.floor(sr * duration));
  const buf = ctx.createBuffer(2, len, sr);
  /** 算法内部统一用「-1..1 的对称随机」 */
  const rnd = () => rng() * 2 - 1;

  /* 阻尼：高频吸收越强，低通截止越低 */
  const fc = DAMPING_FC_MAX * Math.exp(-opts.damping * 4.5) + DAMPING_FC_MIN;
  /** 一阶低通系数（标准 RC 单极点） */
  const alpha = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  /** 扩散模糊次数 */
  const blurPasses = Math.round(opts.diffusion * 3);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const earlyTimes = ch === 0 ? EARLY_TIMES_L : EARLY_TIMES_R;
    /** 左右相反极性 —— 让早期反射在声场里「拉开」，而不是叠在中间 */
    const sideSign = ch === 0 ? 1 : -1;

    /* ① 尾音噪声：双指数包络 */
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = (1 - t) ** 1.4 * Math.exp(-t * 2.2);
      d[i] = rnd() * env;
    }

    /* ② 定标顺序：**先定噪声，再据此算抽头**。
     *
     * ══ 这一步踩过五个坑，最终方案如下 ══
     *
     * 坑一（归一化顺序）：若先加早期反射、再按**全段峰值**归一化，
     *   离散尖峰会成为峰值，整段噪声尾巴被压小 —— 结果是
     *   「加了早期反射反而把混响压低了」，与它该起的作用正好相反。
     *
     * 坑二（幅度太小）：若抽头用「原始 0..1 幅度」直接相加，
     *   幅度只有弥散尾的约 1/10，早期反射被彻底淹没。
     *
     * 坑三（滤波削幅）：扩散是 k=0.3 的单极点低通（时间常数约 39 采样），
     *   会把一两采样宽的脉冲展宽并削掉约三分之二峰值。
     *
     * 坑四（窗口修正重叠，最隐蔽）：改成「滤波后给每个抽头窗口补偿」后，
     *   衰减比被从 0.68 压平到 ≈1.0 —— 补偿窗口（±2.5ms）比抽头间隔
     *   （4~6ms）还宽，相邻窗口互相重叠，中间抽头被重复加成。
     *   **任何窗口化的修正都会踩这个坑，所以最终方案里一个窗口修正都没有。**
     *
     * 坑五（定标顺序错）：抽头幅度若按「理论包络」算，而随后噪声又被
     *   归一化一次，抽头会跟着被缩放 —— 实测比值差了近 2 倍。
     *   必须**先量出噪声峰值、定标噪声，再据此算抽头幅度**。
     *
     * 最终的做法只有三步，且互不干扰：
     *   ① 把噪声按**实测峰值**定标到 LOCAL_NOISE_PEAK；
     *   ② 抽头幅度 = 目标弥散尾电平 × 目标比值 ÷ 实测滤波衰减；
     *   ③ 两者相加后一起过滤波 —— 线性系统对二者同等作用，
     *      所以注入时的比值就是最终听感上的比值，衰减比自然保留。
     */
    {
      /* ① 定标噪声：按实测峰值（跳过抽头尚未注入，此处只有噪声） */
      let noisePeak = 0;
      const scanEnd = Math.min(len, Math.floor(sr * 0.25 * Math.max(1, opts.size)));
      for (let i = 0; i < scanEnd; i++) {
        const v = Math.abs(d[i]);
        if (v > noisePeak) noisePeak = v;
      }
      if (noisePeak > 1e-5) {
        const norm = LOCAL_NOISE_PEAK / noisePeak;
        for (let i = 0; i < len; i++) d[i] *= norm;
      }

      /* ② 抽头幅度：目标弥散尾电平由**抽样实测**得到，不用理论包络 ——
            理论式 `(1-t)^1.4·e^(-2.2t)` 与噪声的随机峰值不是一回事，
            用它会引入固定偏差。这里直接采样首抽头处的噪声幅度。 */
      const firstTapSec = earlyTimes[0] * opts.size;
      const sampleAt = Math.min(len - 1, Math.floor(firstTapSec * sr));
      const diffuseAtFirst = Math.abs(d[sampleAt]) || LOCAL_NOISE_PEAK;
      const targetFirstAmp =
        diffuseAtFirst * EARLY_TARGET_RATIO * Math.max(0, Math.min(1, opts.early));

      /* ③ 实测滤波链对单位脉冲的峰值衰减 a（第 ④⑤ 步与本段完全相同）。
            滤波器是线性的，故 a 与脉冲位置弱相关，同一段抽头共用即可。 */
      let a = 1;
      if (targetFirstAmp > 1e-6) {
        const probe = new Float32Array(len);
        probe[sampleAt] = 1;
        for (let pass = 0; pass < blurPasses; pass++) {
          let prev = 0;
          for (let i = 0; i < len; i++) {
            prev += (probe[i] - prev) * 0.3;
            probe[i] = prev;
          }
        }
        let prev = 0;
        for (let i = 0; i < len; i++) {
          prev += (probe[i] - prev) * alpha;
          probe[i] = prev;
        }
        let peak = 0;
        for (let i = 0; i < len; i++) {
          const v = Math.abs(probe[i]);
          if (v > peak) peak = v;
        }
        a = Math.max(1e-4, peak);
      }
      const tapAmp = targetFirstAmp / a;

      /* ④ 注入：幅度按 EARLY_DECAY^k 衰减 —— 与滤波无关，故比值原样保留 */
      for (let k = 0; k < earlyTimes.length; k++) {
        const time = earlyTimes[k] * opts.size;
        // 抖动 ±0.75ms：避免左右声道完全对称造成的「梳状滤波金属声」
        const jitter = rnd() * 0.5 * sr * 0.0015;
        const idx = Math.floor(time * sr + jitter);
        if (idx >= 0 && idx < len) {
          d[idx] += rnd() * tapAmp * EARLY_DECAY ** k * sideSign;
        }
      }
    }
    /* ⑤ 扩散：多次单极点低通把噪声抹开 */
    for (let pass = 0; pass < blurPasses; pass++) {
      let prev = 0;
      const k = 0.3;
      for (let i = 0; i < len; i++) {
        prev += (d[i] - prev) * k;
        d[i] = prev;
      }
    }

    /* ⑥ 阻尼：单极点低通（频率相关高频衰减） */
    let prev = 0;
    for (let i = 0; i < len; i++) {
      prev += (d[i] - prev) * alpha;
      d[i] = prev;
    }

    /* ⑦ 起始淡入 */
    const fade = Math.min(len, Math.floor(sr * FADE_IN_SEC));
    for (let i = 0; i < fade; i++) d[i] *= i / fade;

    /* ⑧ 能量归一化 —— 决定湿声整体音量，是「混响会不会糊成一片」的关键。
     *
     * 按目标 rms 反推标定量（推导见 IR_TAIL_TO_INPUT 的注释）。
     * 必须放在滤波与软限幅**之前**：滤波会改变能量，先标定再滤波的量算不准。
     * 注意本步在每声道内部独立进行 —— 左右声道能量本就接近，
     * 独立归一化不会破坏立体声差异，只是把两者拉到同一量级。 */
    {
      let sumSq = 0;
      for (let i = 0; i < len; i++) sumSq += d[i] * d[i];
      const curRms = Math.sqrt(sumSq / len);
      const targetRms = IR_TAIL_TO_INPUT / Math.sqrt(len);
      if (curRms > 1e-9) {
        const scale = targetRms / curRms;
        for (let i = 0; i < len; i++) d[i] *= scale;
      }
    }

    /* ⑨ 峰值兜底：极端参数组合仍可能越界。
     * 硬截断会产生刺耳的高频谐波，故用 tanh 平滑压回。 */
    for (let i = 0; i < len; i++) {
      const v = d[i];
      if (v > IR_PEAK_CEILING || v < -IR_PEAK_CEILING) {
        d[i] = Math.tanh(v / IR_PEAK_CEILING) * IR_PEAK_CEILING;
      }
    }
  }
  return buf;
}
