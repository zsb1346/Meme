/**
 * AI 检测的**候选窗口**选取 —— 与 `pitch-worker.ts` 分出来单独成文件，
 * 是为了让「最响的一秒」这段逻辑能被单测和真浏览器探针直接 import，
 * 而不用去 import 那个带 `self.onmessage` 副作用的 worker 模块。
 */

/**
 * 从 `x` 里挑出至多 `count` 段长度为 `seconds` 的候选窗口，按能量从高到低。
 *
 * ══ 为什么不能只取前缀 ══
 *
 * 素材开头可能是静音或淡入（导入的长音频尤其如此），前 1 秒全是静音时模型
 * 必然给不出任何音符 → 又变成「未检出」。「最响的一秒」是对「音高信息在哪」
 * 更稳的代理量。
 *
 * ══ 为什么返回一串而不是一段 ══
 *
 * 最响的一秒**不一定是有人声的一秒**：鬼畜素材里爆音、鼓点、音效都比人声响。
 * 实测 41 个真素材，AI 在这一秒上弃权（给不出任何音符）的有 4 个
 * （`scripts/probe-ai/probe-ai-sweep.html`）。弃权时换一个候选窗口再问一次，
 * 是这条链路上最便宜的召回手段 —— 而且**只有失败者才付这个成本**。
 *
 * 窗口之间强制错开半窗以上：重叠太多的两段音频喂给同一个确定性模型，
 * 结果只会一样，重试等于白花几秒。
 *
 * 步长 0.1 秒、内层再 4 抽样，成本可忽略。
 */
export function candidateWindows(
  x: Float32Array,
  sampleRate: number,
  seconds: number,
  count: number,
): Float32Array[] {
  const win = Math.floor(sampleRate * seconds);
  // 比一个窗口还短：只有它自己，没有「换个位置」这回事
  if (win <= 0 || x.length <= win) return [x];

  const hop = Math.max(1, Math.floor(sampleRate * 0.1));
  const scored: { start: number; energy: number }[] = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    let e = 0;
    for (let i = start; i < start + win; i += 4) e += x[i] * x[i];
    scored.push({ start, energy: e });
  }
  scored.sort((a, b) => b.energy - a.energy);

  const picked: number[] = [];
  for (const s of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p - s.start) < win / 2)) continue;
    picked.push(s.start);
  }
  // 注意保持**能量降序**（不按时间重排）：第一个候选必须是全局最响的那一秒，
  // 否则「第一次尝试就成功」这个最常见路径会变慢。能量相同时 `sort` 是稳定
  // （ES2019 起规范要求），落在时间较早的位置。
  return picked.map((s) => x.subarray(s, s + win));
}
