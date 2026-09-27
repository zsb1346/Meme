/**
 * 波形预览的纯几何：把「一串谐波振幅」画成一条 SVG 折线。
 *
 * 面板上要有两处用到它 —— 波表浏览器的 16 帧缩略图、以及 32 谐波编辑器的
 * 「看一眼这条频谱长什么样」。两处都只是「算点」，所以放在没有 React 的模块里，
 * `wave-preview.test.ts` 能直接断言：
 *   · 空数组 / 全零 → 一条平直的中线（不是 NaN 路径 → 整块画不出来）；
 *   · 越界的振幅（理论上被 `fitHarm` 夹过，但预览不该依赖上游）→ 不越出画框；
 *   · 采样点数与 `samples` 一致（少一个点就是折线缺一段，视觉上是「波形断了」）。
 */

/** 把路径里的数字保留 2 位小数：SVG 里多出来的精度只是体积，看不出来 */
const r2 = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * 谐波振幅 → 一个周期内的波形折线路径。
 *
 * `amps[n]` 是第 n 次谐波的振幅（`amps[0]` 是直流，一律忽略 ——
 * 直流成分画在预览里只会把整条波形抬起来，读不出音色）。
 * 用**正弦**分量重建，与 `wavetables.ts` 里 `imag` 的约定一致。
 */
export function frameWavePath(
  amps: ArrayLike<number>,
  w: number,
  h: number,
  samples = 48,
): string {
  const n = Math.max(2, Math.round(samples));
  const mid = h / 2;

  // ① 先算出一个周期内的原始波形
  const raw = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const phase = (s / (n - 1)) * Math.PI * 2;
    let acc = 0;
    for (let k = 1; k < amps.length; k++) {
      const a = amps[k];
      if (!Number.isFinite(a) || a === 0) continue;
      acc += a * Math.sin(k * phase);
    }
    raw[s] = acc;
  }

  // ② 再按**合成本身的峰值**归一化 —— 不是按单条谐波的最大振幅。
  //    多条谐波会在某些相位上叠加，用单条振幅做基准会让曲线冲出画框
  //    （实测 `[0, 1e6, -1e6]` 会画出 y = −0.15：越了一点点，看不出来但确实是错的）。
  let peak = 0;
  for (let s = 0; s < n; s++) {
    const a = Math.abs(raw[s]);
    if (a > peak) peak = a;
  }
  // 留 8% 余量：贴边的波形在缩略图里看着像被裁过
  const norm = peak > 1e-12 ? (mid * 0.92) / peak : 0;

  const parts: string[] = [];
  for (let s = 0; s < n; s++) {
    const x = (s / (n - 1)) * w;
    parts.push(`${s === 0 ? 'M' : 'L'}${r2(x)} ${r2(mid - raw[s] * norm)}`);
  }
  return parts.join(' ');
}

/**
 * 32 谐波编辑器的柱高 → 百分比。
 *
 * 留 2% 的底：全零的柱子完全不见时，用户会以为那一格坏了 / 点不上。
 */
export function harmBarPercent(v: number): number {
  if (!Number.isFinite(v)) return 2;
  return Math.max(2, Math.min(1, Math.max(0, v)) * 100);
}

/** 画一条中心基准线（预览图里的 0 轴） */
export function midLinePath(w: number, h: number): string {
  const y = r2(h / 2);
  return `M0 ${y} H${r2(w)}`;
}
