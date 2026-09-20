/**
 * AI 音高检测的**预算常量** —— worker 与主线程共用的单一事实来源。
 *
 * 单独成文件的理由：这几个数决定「AI 检测到底会不会超时」，散落在
 * `pitch-worker.ts`（输入长度）与 `pitch-async.ts`（超时）两处时，
 * 它们之间的一致性没人守得住 —— 而**正是这两者的不一致让 AI 检测长期不可用**：
 * worker 跑 4 秒输入（3 批 × ~5s = 15s），主线程只给 15000ms。
 *
 * 放这里之后，`pitch-ai-budget.test.ts` 能用纯算术把「批数 × 单批成本 vs 预算」
 * 钉住，想改大输入长度的人会先看到这条测试。
 */

import type { Detector } from './pitch-settings';

/** basic-pitch 模型要求的输入采样率（`AUDIO_SAMPLE_RATE`）。 */
export const AI_TARGET_SR = 22050;

/**
 * 喂给模型的音频长度（秒）。
 *
 * 模型窗口只有 2 秒（`AUDIO_N_SAMPLES = 22050*2 - 256 = 43844`），
 * `prepareData` 用 `tf.signal.frame(..., padEnd=true)` 按 `HOP_SIZE = 36164`
 * 切窗，所以**输入多少秒就直接决定跑几批**（见 [`aiBatchCount`]）。
 *
 * 真浏览器里跑生产 worker 实测（headless Chrome，
 * `scripts/probe-ai/probe-real-worker.html`）：
 *
 * | 输入 | 批数 | 主线程看到 | 结论 |
 * |---|---|---|---|
 * | 4s @22050 | 3 | 13040ms | 险过 |
 * | **4s @48000（素材真实路径）** | 3 | **15076ms** | **超 15000ms** → UI 永远「未检出音高」 |
 * | 1s @48000 | 1 | 4277ms | OK |
 *
 * 真素材是 48kHz，线上走的是第二行 —— 这就是故障本体。
 * 砍到 1 秒只跑 1 批，而**结论不变**：41 个真素材上 1s 与 4s 的音高完全一致
 * （`scripts/probe-ai/_probe-ai-window.mjs`，0 个分歧）。
 */
export const AI_SECONDS = 1;

/** basic-pitch 的窗口与步长（`src/inference.ts` 的常量，单位：样本 @22050）。 */
export const AI_WINDOW_SAMPLES = AI_TARGET_SR * 2 - 256; // 43844
export const AI_HOP_SAMPLES = AI_WINDOW_SAMPLES - 30 * 256; // 36164

/**
 * 跑 `seconds` 秒音频模型会执行几批。
 *
 * 与 `pitch-worker.ts::prepareData` 的实际行为一致（前端还会补半窗的零，
 * 所以分子是 `n + HOP/2`）。实测对齐：1s→1 批、2s→2 批、4s→3 批。
 */
export function aiBatchCount(seconds: number): number {
  const n = AI_TARGET_SR * seconds + Math.floor((AI_WINDOW_SAMPLES - AI_HOP_SAMPLES) / 2);
  return Math.max(1, Math.ceil(n / AI_HOP_SAMPLES));
}

/**
 * 单批推理的实测耗时上界（毫秒）。
 *
 * 来源：headless Chrome 里跑生产 worker，1 秒输入（= 1 批）= 4277ms；
 * Node CPU 后端 1 批 = 3833~3899ms。取 5000 留一点余量，作为**下界标尺**用
 * （见测试里那条「预算至少要有单批的多少倍」）。
 */
export const AI_MS_PER_BATCH_MEASURED = 5000;

/**
 * 一次 AI 请求里最多尝试几个候选窗口（含第一次）。
 *
 * ══ 为什么需要「换窗口重试」══
 *
 * 模型只吃 1 秒（[`AI_SECONDS`]），而那一秒是从素材里挑的**能量最高**的一段。
 * 但最响的一秒不等于有音高的一秒：鬼畜素材里爆音、鼓点、音效都比人声响。
 *
 * ══ 但要诚实：真素材上它几乎不生效 ══
 *
 * 41 个真素材实测（`probe-ai-sweep.html`，逐条打印候选窗口数）：
 * **全部 41 个都只有 1 个候选** —— 这批切片最长 1442ms、中位数约 260ms，
 * 比一个窗口（1 秒）还短的一大把，`candidateWindows` 直接退化成「就它自己」。
 * 所以对**短切片**，真正在救弃权的是 [`AI_NOTES_RELAXED`]（阈值兜底），不是这里。
 *
 * 这里的价值在**导入的长音频**（用户可以从任何地方导入几十秒的素材）：
 * 那些素材才有多个互不重叠的 1 秒可挑，最响的那一秒落在鼓点/静音上时才轮得到它。
 *
 * ══ 为什么是 3 ══
 *
 * 成本只落在**弃权**的素材上：第一个窗口就出结果的素材只跑一轮
 * （见 `pitch-worker.ts::detectAi` 的短路 return）。真素材单轮实测
 * p50 4179ms / max 5653ms，3 轮最坏约 17s，而预算 [`PITCH_TIMEOUT_MS`]`.ai`
 * 是 60000ms —— `pitch-ai-budget.test.ts` 钉住了这条不等式，改大这里会先挂测试。
 *
 * 候选窗口之间错开半个窗以上（`pitch-window.ts::candidateWindows`），
 * 所以 3 轮问的是 3 段不同的音频，不是同一段重复问；比窗口还短的素材
 * 只有 1 个候选，这一档自动退化成不重试。
 */
export const AI_WINDOW_TRIES = 3;

/**
 * basic-pitch 后处理（`outputToNotesPoly`）的三个参数。
 *
 * 模型吐的是三份逐帧概率图（frames / onsets / contours），**音符是从概率图里
 * "切"出来的** —— 阈值太严，概率不够高的音符就被切没了，表现为「弃权」。
 */
export interface NoteExtraction {
  /** onsets 概率图的阈值 */
  onsetThreshold: number;
  /** frames 概率图的阈值 */
  frameThreshold: number;
  /** 最短音符（帧）；basic-pitch 帧率 ≈ 86.13fps，所以 5 帧 ≈ 58ms */
  minNoteFrames: number;
}

/** 现用档 = basic-pitch 库默认值。 */
export const AI_NOTES_STRICT: NoteExtraction = {
  onsetThreshold: 0.25,
  frameThreshold: 0.25,
  minNoteFrames: 5,
};

/**
 * 兜底档：**只在严格档一个音符都切不出来（弃权）时**才启用。
 *
 * ══ 为什么需要它 —— 实测 ══
 *
 * `scripts/probe-ai/probe-ai-threshold.html` 把 41 个真素材的推理**只跑一次**，
 * 然后拿不同的阈值去切同一份概率图（切音符是纯 JS，微秒级），结论：
 *
 * | 现象 | 数量 | 说明 |
 * |---|---|---|
 * | `frames` 为空（模型真的没输出） | **0/41** | 模型从不「不知道」 |
 * | 严格档弃权但概率图有数据 | **6/41** | 全是阈值把音符切掉了 |
 *
 * 也就是说：**弃权不是模型的能力问题，是门的宽度问题。**
 *
 * ══ 为什么是 0.2/0.2/4（不是更宽）══
 *
 * 同一份扫描里逐档看「有没有把本来对的答案改坏」：
 *
 * | 档位 | 召回弃权 | 新增灾难（≥300¢） |
 * |---|---|---|
 * | 0.25/0.25/5（现用） | — | 基线 |
 * | **0.2/0.2/4** | **5/6** | **0** |
 * | 0.15/0.15/5 | 6/6 | **1** —— `啊.mp3` 切出 1244.5Hz（+1797¢ 幻觉） |
 * | 0.15/0.15/3 | 6/6 | 0 |
 * | 0.1/0.1/3 | 6/6 | **4** —— 哈.005 −3012¢、哈.006 +1085¢、慢哈 +1216¢、高绿 −3778¢ |
 *
 * 0.2 档在真素材上**一个也没改坏**（对本来就有结果的素材，这一档根本不会被执行），
 * 却把 6 个弃权里的 5 个救回来，且救回的值与 YIN 都在 61 音分以内
 * （哈.003 −61¢、哈.006 −15¢、啊 −3¢、基.002 +33¢）。剩下 1 个（`基.mp3`）
 * 连 YIN 也判无音高 —— 两边都弃权才是真的没有音高。
 *
 * **不要再往低降**。0.15 这一档已经不稳定（`minNoteFrames=5` 时 `啊.mp3`
 * 会切出高八度以上的幻觉），0.1 明确崩。真要动，先跑那两个探针拿数据说话。
 */
export const AI_NOTES_RELAXED: NoteExtraction = {
  onsetThreshold: 0.2,
  frameThreshold: 0.2,
  minNoteFrames: 4,
};

/**
 * 超时预算：分检测器给。
 *
 * 两者量级差三个数量级，**共用一个值两头都不对** —— 旧的单一 15000ms 对 YIN
 * 太长（worker 真卡住要干等 15 秒）、对 AI 又太短（4 秒输入实测 15076ms，
 * 必然超时）。现在 AI 输入已砍到 1 秒（1 批 ≈ 4.3s），60 秒给慢机器留了
 * 10 倍以上余量；YIN 是纯 JS 毫秒级，5 秒足够发现 worker 死掉。
 */
export const PITCH_TIMEOUT_MS: Record<Detector, number> = {
  yin: 5000,
  ai: 60000,
};

/**
 * worker 回过 ack 之后才开始计的这段预算之外的**看门狗**。
 *
 * ack 之前只在防「worker 整个死了」；AI 推理和模型加载都可能好几秒，
 * 排队等待不该被算进推理预算，否则用户快速切换素材时后一条请求会在
 * 还没轮到执行时就先超时。
 */
export const PITCH_ACK_WATCHDOG_MS = 30000;

/**
 * AI 与 YIN 相差超过这个音分数 → **采用 YIN**。
 *
 * ══ 为什么需要交叉校验 ══
 *
 * 跑 41 个真素材对比（`scripts/probe-ai/_probe-ai-window.mjs`，
 * AI(4s) vs YIN 共 35 个双方都有值）：**中位差仅 26 音分** —— 两个检测器
 * 基本互相印证。超过 50 音分的只有 5 个，其中两个是灾难级：
 *
 * | 素材 | YIN | AI | 差 | 判断 |
 * |---|---|---|---|---|
 * | 豆.mp3 | 360.0 Hz | 698.5 Hz | +1148¢ | AI 认成了**高一个八度**的谐波（比值 1.94）。YIN 的 360Hz 是早先单独验证过的正确值 |
 * | 米.002.mp3 | 382.7 Hz | 73.4 Hz | −2860¢ | AI 给了一个人声切片不可能有的低音（比值 0.19） |
 *
 * 「认错音」是这条链路上**唯一已知的灾难性失效**：`sampleSemitonesAtPitch` 会据此
 * 把素材移调整整一个八度甚至更多，输出直接毁掉 —— 比返回 null（退回手动偏移 = 不动）糟得多。
 *
 * ══ 300 音分是怎么定的（不是凑的）══
 *
 * 实测的两侧边界：
 *  - **良性分歧上界 68 音分**（西.mp3，≈ 0.7 个半音）—— 这类是正常音准差异，
 *    必须放行：自动修音本来就是往最近的目标音上贴，几十音分不改变结论。
 *  - **灾难分歧下界 1148 音分**（≈ 11.5 个半音）—— 这一侧已经不是音准差异，
 *    而是「认为是哪个音」的差异。
 *
 * 300 音分（三个半音）落在两者之间，两侧余量接近对称（4.4 倍 / 3.8 倍）。
 * 一旦超过三个半音，两个检测器就不再是「对同一个音的音准意见不同」，
 * 而是给出了不同的音符 —— 这种分歧没有「取平均」之类的折中办法，
 * 只能按既定规则选一个（这里选 YIN，因为上面两个灾难案例 YIN 都是对的）。
 *
 * **300~1148 音分之间没有实测样本** —— 这一段是外推出来的。将来若在这段里
 * 发现真实素材，应当补进 `_probe-ai-window.mjs` 的对照表再决定阈值。
 * 另外注意「正好一个八度」并不足以描述这个失效：豆.mp3 的实际比值是 1.94
 * （差 48 音分才到整八度），所以按「接近 2 的整数幂」去判别会漏掉它。
 */
export const PITCH_CROSSCHECK_REJECT_CENTS = 300;

/** a 相对 b 的音分差（有符号）。`b` 为 0 或非有限值时返回 0。 */
export function centsBetween(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  return 1200 * Math.log2(a / b);
}

/**
 * AI 的答案是否该被否决（与 YIN 冲突到灾难级）。
 *
 * 任一方没有值就**不否决** —— 没得比的时候不该凭空怀疑 AI：
 * 「AI 弃权」与「YIN 也没值」是另外两条分支，各有各的处理。
 */
export function shouldRejectAiPitch(aiHz: number | null, yinHz: number | null): boolean {
  if (aiHz == null || yinHz == null) return false;
  return Math.abs(centsBetween(aiHz, yinHz)) > PITCH_CROSSCHECK_REJECT_CENTS;
}
