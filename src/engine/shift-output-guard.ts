/**
 * 第三方变调引擎的**出口验收** —— 「这段输出还能听吗」的绝对判据。
 *
 * ── 为什么必须有它（而不是靠引擎自己「返回合法音频」）──
 *
 * `playSample` 的降级链（PSOLA → SOLA → 原声）是**靠异常推进**的：内核
 * 「返回了合法音频但没做事」会让它误判成功（`isPsolaSilentNoop` 就是为
 * wasm 那一侧补的这个判断）。第三方路径原先一个判据都没有 —— 只要库
 * 不抛异常，它的输出就被原样播出去，**哪怕那是一整段零**。
 *
 * 而实测确实存在会产出「合法但坏」输出的档位（`probe-silence-lag.mjs`，
 * 龙.001 / 立体声 / 0.72s，与 App 的调用方式一致）：
 *
 *   引擎              ratio   长度比   电平dB    峰值
 *   shift-sample      1/32    1.000    **−46.3**  0.008   ← 整段听不见
 *   ST-声码器          8       **0.704**  +16.3    **31.96** ← 爆表 32 倍
 *   ST-声码器          16      **0.352**  +14.3    23.11
 *   shift-wsola       1/32    1.000    −15.0     0.126
 *
 * 注意这些**不是「比我们的差」**，而是「东西是坏的」：一个 −46dB 的输出、
 * 一个 32 倍满刻度的输出、一个只剩三成长度的输出，无论听感偏好如何都不该播。
 * 所以它符合本项目那条最重要的规矩 —— **指标只用来「排除」，不用来「选优」**：
 * 这里只挡「明显坏了」，任何一处「哪个更好听」的取舍都不在这里做。
 *
 * ── 判据为什么是这三个 ──
 *
 * `@audio/shift-*` 与 SoundTouchJS 声明的契约都是「输出时长 == 输入时长、
 * 同样的内容、只把音高搬走」。所以违约只有三种形态：
 *   1. **长度塌缩** —— 内容被截掉一大段（`len < 0.5×` 才算，宽到不会误伤
 *      正常的窗边界效应；实测 19 个引擎在 ±24 半音内长度比**全是 1.000**）；
 *   2. **电平塌陷** —— 输出比源低 40dB 以上，等于没声音（正常人耳可辨的
 *      引擎偏差都在 ±8dB 以内，`ola` 最差 −6dB）；
 *   3. **电平爆表** —— 比源高 12dB 以上。没有哪个变调器「设计上」会加 12dB 增益；
 *      实测正常档位最大 +8dB（paulstretch 在极短素材上），而 ratio≥8 的
 *      `ST-声码器` 是 +16dB / 峰值 32 倍 —— 那是数值发散，不是效果。
 * 外加一条**非有限值**：一个 NaN 就能让整段静音，而所有相对指标在 NaN 上都会失灵。
 *
 * ── 拒了之后怎么办 ──
 *
 * 抛异常。`playSample` 的 catch 会把它退到 wasm PSOLA —— 那个内核在这些
 * 极端档位上实测是稳的（ratio=32 仍 1.000×/−0.2dB）。**绝不静默播坏音频**：
 * 用户宁可听到「我们自己的引擎」，也不要听到一段静音或爆音。
 */

/** 长度低于输入的这个比例 → 判为内容被截断（实测正常引擎恒 1.000） */
const MIN_LEN_RATIO = 0.5;
/** 比源低这么多 dB → 判为「听不见」 */
const MIN_LEVEL_DB = -40;
/** 比源高这么多 dB → 判为数值发散（正常引擎实测上限 +8dB） */
const MAX_LEVEL_DB = 12;

export interface ShiftOutputStats {
  /** 输出长度 / 输入长度（契约应当 ≈ 1） */
  lenRatio: number;
  /** 输出 RMS 相对输入的电平（dB） */
  levelDb: number;
  /** 输出峰值绝对值 */
  peak: number;
  /** 非有限（NaN/Inf）样点个数 */
  nonFinite: number;
}

export type ShiftOutputVerdict =
  | { ok: true; stats: ShiftOutputStats }
  | { ok: false; reason: string; stats: ShiftOutputStats };

function statsOf(src: Float32Array, out: Float32Array): ShiftOutputStats {
  let srcSq = 0;
  for (let i = 0; i < src.length; i++) srcSq += src[i] * src[i];
  let outSq = 0;
  let peak = 0;
  let nonFinite = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (!Number.isFinite(v)) {
      nonFinite++;
      continue;
    }
    outSq += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const srcRms = Math.sqrt(srcSq / Math.max(1, src.length));
  const outRms = Math.sqrt(outSq / Math.max(1, out.length));
  return {
    lenRatio: out.length / Math.max(1, src.length),
    // 输入本身静音时电平没有意义 → 记为 0dB，交由长度/非有限值那两条去判
    levelDb:
      srcRms <= 1e-9 ? 0 : 20 * Math.log10(Math.max(1e-12, outRms) / srcRms),
    peak,
    nonFinite,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * 验收一段第三方引擎的输出。`src` / `out` 都取**通道 0**（逐通道内容一致，
 * 取一条即可；多通道之间的差异由 `transformByExternal` 自己统一长度）。
 */
export function checkShiftOutput(
  src: Float32Array,
  out: Float32Array,
): ShiftOutputVerdict {
  const stats = statsOf(src, out);

  if (stats.nonFinite > 0) {
    return {
      ok: false,
      reason: `输出含 ${stats.nonFinite} 个非有限值（NaN/Inf）—— 播出去就是一段静音`,
      stats,
    };
  }
  if (stats.lenRatio < MIN_LEN_RATIO) {
    return {
      ok: false,
      reason:
        `输出长度只有输入的 ${pct(stats.lenRatio)}（< ${pct(MIN_LEN_RATIO)}）—— 内容被截断，` +
        `听感是「响一下就没」`,
      stats,
    };
  }
  if (stats.levelDb < MIN_LEVEL_DB) {
    return {
      ok: false,
      reason: `输出比源低 ${(-stats.levelDb).toFixed(1)}dB（阈值 ${-MIN_LEVEL_DB}dB）—— 等于没声音`,
      stats,
    };
  }
  if (stats.levelDb > MAX_LEVEL_DB) {
    return {
      ok: false,
      reason:
        `输出比源高 ${stats.levelDb.toFixed(1)}dB、峰值 ${stats.peak.toFixed(2)}（阈值 +${MAX_LEVEL_DB}dB）` +
        `—— 数值发散，不是效果`,
      stats,
    };
  }
  return { ok: true, stats };
}
