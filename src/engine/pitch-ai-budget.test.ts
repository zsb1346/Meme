/**
 * AI 检测的「预算算术」回归 —— 纯算术，不碰 wasm / tfjs / worker。
 *
 * ══ 这条测试守的是什么 ══
 *
 * AI 音高检测曾经**永远显示「未检出音高」**，原因不是算法，是两处常量不一致：
 * `pitch-worker.ts` 喂 4 秒音频（basic-pitch 窗口 2 秒 → **3 批**），
 * 而 `pitch-async.ts` 只给 15000ms。真浏览器里跑生产 worker 实测：
 *
 *   4s @48000（素材真实路径）→ **15076ms** > 15000ms → 每次必超时。
 *
 * 单批成本是模型固定的（~4~5 秒），所以「跑几批」就是唯一的自由度。
 * 下面用纯算术把它钉住：**AI_SECONDS 必须只跑 1 批**，
 * 且超时预算要有足够倍数余量。
 *
 * 想改大 `AI_SECONDS` 的人会先在这里看到为什么不行。
 */
import { describe, expect, it } from 'vitest';
import {
  AI_HOP_SAMPLES,
  AI_MS_PER_BATCH_MEASURED,
  AI_NOTES_RELAXED,
  AI_NOTES_STRICT,
  AI_SECONDS,
  AI_WINDOW_SAMPLES,
  AI_WINDOW_TRIES,
  PITCH_ACK_WATCHDOG_MS,
  PITCH_CROSSCHECK_REJECT_CENTS,
  PITCH_TIMEOUT_MS,
  aiBatchCount,
  centsBetween,
  shouldRejectAiPitch,
} from './pitch-ai-budget';

describe('AI 检测预算', () => {
  it('模型窗口/步长与 basic-pitch 的常量一致', () => {
    // AUDIO_N_SAMPLES = 22050*2 - 256；OVERLAP = 30 * 256
    expect(AI_WINDOW_SAMPLES).toBe(43844);
    expect(AI_HOP_SAMPLES).toBe(36164);
  });

  it('批数公式与实测对齐（1s→1 批、2s→2 批、4s→3 批）', () => {
    // 这三组来自 headless Chrome 跑生产 worker 的实测批数
    expect(aiBatchCount(1)).toBe(1);
    expect(aiBatchCount(2)).toBe(2);
    expect(aiBatchCount(4)).toBe(3);
  });

  it('AI_SECONDS 只跑 1 批 —— 这是「AI 不超时」的全部依据', () => {
    expect(aiBatchCount(AI_SECONDS)).toBe(1);
  });

  it('超时预算 ≥ 单批成本的 10 倍（给慢机器留余量）', () => {
    const oneBatch = AI_MS_PER_BATCH_MEASURED * aiBatchCount(AI_SECONDS);
    expect(PITCH_TIMEOUT_MS.ai).toBeGreaterThanOrEqual(oneBatch * 10);
  });

  it('旧的 4 秒输入在今天这套预算下已经不成立（留作历史刻度）', () => {
    const oldCost = AI_MS_PER_BATCH_MEASURED * aiBatchCount(4);
    // 4 秒 = 3 批 ≈ 15000ms，正是当年那个 15000ms 预算翻车的地方
    expect(oldCost).toBe(15000);
    expect(AI_SECONDS).toBeLessThan(4);
  });

  it('YIN 的预算远短于 AI —— 两者量级差三个数量级，不能共用一个值', () => {
    expect(PITCH_TIMEOUT_MS.yin).toBeLessThanOrEqual(5000);
    expect(PITCH_TIMEOUT_MS.ai).toBeGreaterThan(PITCH_TIMEOUT_MS.yin * 10);
  });

  it('ack 看门狗比任何单次检测预算都宽松 —— 它只防 worker 死掉', () => {
    expect(PITCH_ACK_WATCHDOG_MS).toBeGreaterThanOrEqual(PITCH_TIMEOUT_MS.ai / 2);
  });

  it('最坏耗时（窗口重试 × 单批）必须留在 AI 预算里', () => {
    // 弃权素材要走满 AI_WINDOW_TRIES 轮才退 YIN —— 这条不等式是「加大重试次数」
    // 的唯一闸门：改大 AI_WINDOW_TRIES 而忘了同步预算，测试先挂。
    const worst = AI_WINDOW_TRIES * AI_MS_PER_BATCH_MEASURED * aiBatchCount(AI_SECONDS);
    expect(worst).toBeLessThanOrEqual(PITCH_TIMEOUT_MS.ai);
    // 而且要留出至少 3 倍余量给慢机器（真机实测单批可达 5653ms > 5000ms）
    expect(PITCH_TIMEOUT_MS.ai / worst).toBeGreaterThanOrEqual(3);
  });

  it('至少 2 次候选窗口才值得「换窗口重试」这件事存在', () => {
    expect(AI_WINDOW_TRIES).toBeGreaterThanOrEqual(2);
  });
});

describe('AI 音符提取的两档阈值', () => {
  it('严格档就是 basic-pitch 的库默认值', () => {
    expect(AI_NOTES_STRICT).toEqual({
      onsetThreshold: 0.25,
      frameThreshold: 0.25,
      minNoteFrames: 5,
    });
  });

  it('兜底档必须严格更宽 —— 否则它召回不了任何东西，只是白跑一遍', () => {
    expect(AI_NOTES_RELAXED.onsetThreshold).toBeLessThan(AI_NOTES_STRICT.onsetThreshold);
    expect(AI_NOTES_RELAXED.frameThreshold).toBeLessThan(AI_NOTES_STRICT.frameThreshold);
    expect(AI_NOTES_RELAXED.minNoteFrames).toBeLessThanOrEqual(
      AI_NOTES_STRICT.minNoteFrames,
    );
  });

  it('兜底档不低过实测的安全下界 0.2', () => {
    // 实测（probe-ai-threshold.html，41 个真素材）：
    //   0.2 档 → 召回 5/6 弃权，新增灾难 0 个
    //   0.15/0.15/5 → 啊.mp3 切出 +1797¢ 幻觉
    //   0.1  → 4 个新增灾难（哈.005 哈.006 慢哈 高绿）
    // 想继续往下调的人，先去跑了那两个探针再改这里。
    expect(AI_NOTES_RELAXED.onsetThreshold).toBeGreaterThanOrEqual(0.2);
    expect(AI_NOTES_RELAXED.frameThreshold).toBeGreaterThanOrEqual(0.2);
  });
});

describe('AI × YIN 交叉校验（只拦「认错音」这类灾难）', () => {
  it('两个真实测到的灾难案例都要被拦下', () => {
    // 豆.mp3：AI 认成了高一个八度的谐波（比值 1.94 —— 不是正好 2 倍）
    expect(shouldRejectAiPitch(698.5, 360.0)).toBe(true);
    // 米.002.mp3：AI 给了一个人声切片不可能有的低音
    expect(shouldRejectAiPitch(73.4, 382.7)).toBe(true);
  });

  it('正常分歧（真素材实测中位 26 音分，最大 68 音分）一律放行', () => {
    // 实测里最大的三个「非灾难」分歧：西.mp3 -68¢、哈.007.mp3 +66¢、米.001.mp3 -57¢
    expect(shouldRejectAiPitch(349.2, 363.3)).toBe(false); // -68¢
    expect(shouldRejectAiPitch(523.3, 503.7)).toBe(false); // +66¢
    expect(shouldRejectAiPitch(349.2, 361.0)).toBe(false); // -57¢
  });

  it('阈值 300 音分落在实测的两侧边界之间，且两侧都有余量', () => {
    expect(PITCH_CROSSCHECK_REJECT_CENTS).toBe(300);
    // 上侧：良性分歧最大 68¢ → 余量 4 倍以上
    expect(PITCH_CROSSCHECK_REJECT_CENTS / 68).toBeGreaterThan(4);
    // 下侧：灾难分歧最小 1148¢ → 余量 3 倍以上
    expect(1148 / PITCH_CROSSCHECK_REJECT_CENTS).toBeGreaterThan(3);
  });

  it('刚好 300 音分不拦，过了才拦（边界不越界）', () => {
    const justUnder = 440 * 2 ** (299 / 1200);
    const justOver = 440 * 2 ** (301 / 1200);
    expect(shouldRejectAiPitch(justUnder, 440)).toBe(false);
    expect(shouldRejectAiPitch(justOver, 440)).toBe(true);
  });

  it('任一方缺值就不否决 —— 没得比的时候不凭空怀疑 AI', () => {
    expect(shouldRejectAiPitch(null, 440)).toBe(false);
    expect(shouldRejectAiPitch(440, null)).toBe(false);
    expect(shouldRejectAiPitch(null, null)).toBe(false);
  });

  it('降低方向（AI 比 YIN 低）同样要拦', () => {
    expect(shouldRejectAiPitch(220, 440)).toBe(true);
  });

  it('centsBetween 对非法输入返回 0，不会把 NaN 传染成「该否决」', () => {
    expect(centsBetween(440, 440)).toBe(0);
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 6);
    expect(centsBetween(0, 440)).toBe(0);
    expect(centsBetween(NaN, 440)).toBe(0);
  });
});
