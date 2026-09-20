/**
 * `candidateWindows` 的回归 —— 纯函数，不碰 tfjs。
 *
 * 守两件事：
 *  ① **第一个候选必须能量最高**。挑错窗口不会报错，只会让 AI 在爆音段上弃权，
 *     然后白跑两轮重试 —— 症状是「AI 变慢了」，很难反查到窗口选择上去。
 *  ② **候选之间不重叠**。重叠的两段喂给同一个确定性模型，结果只会一样，
 *     重试纯属浪费（这条如果破了，`AI_WINDOW_TRIES=3` 的成本要翻三倍而召回不变）。
 */
import { describe, expect, it } from 'vitest';
import { candidateWindows } from './pitch-window';

const SR = 48000;

/** 造一段 3 秒静音，在 [from, to) 秒区间填上固定振幅的方波。 */
function withLoudRegion(totalSec: number, regions: [number, number, number][]) {
  const x = new Float32Array(Math.round(SR * totalSec));
  for (const [from, to, amp] of regions) {
    for (let i = Math.round(SR * from); i < Math.round(SR * to) && i < x.length; i++) {
      x[i] = i % 2 === 0 ? amp : -amp;
    }
  }
  return x;
}

/** 某段子数组的能量（与实现同一口径：每 4 个抽 1 个）。 */
function energy(a: Float32Array) {
  let e = 0;
  for (let i = 0; i < a.length; i += 4) e += a[i] * a[i];
  return e;
}

describe('candidateWindows', () => {
  it('比窗口还短的素材只有一个候选，就是它自己（退化成不重试）', () => {
    const x = withLoudRegion(0.5, [[0, 0.5, 0.5]]);
    const w = candidateWindows(x, SR, 1, 3);
    expect(w).toHaveLength(1);
    expect(w[0]).toBe(x); // 同一个引用，不拷贝
  });

  it('恰好一个窗口长时也只有一个候选', () => {
    const x = withLoudRegion(1, [[0, 1, 0.5]]);
    expect(candidateWindows(x, SR, 1, 3)).toHaveLength(1);
  });

  it('第一个候选是能量最高的那一段（不是前缀）', () => {
    // 前 1.2 秒静音、中段最响、尾段次响 —— 前缀会落在静音上
    const x = withLoudRegion(3, [
      [1.2, 1.5, 0.9],
      [2.0, 3.0, 0.3],
    ]);
    const w = candidateWindows(x, SR, 1, 3);
    expect(energy(w[0])).toBe(energy(x.subarray(Math.round(SR * 1.2), Math.round(SR * 2.2))));
    // 前 1 秒是静音，绝不能当选
    expect(energy(w[0])).toBeGreaterThan(energy(x.subarray(0, SR)));
  });

  it('候选之间至少错开半个窗口', () => {
    // 用「值 = 下标」的斜坡信号，这样窗口的第一个样本直接就是它的起点
    // （subarray 视图读不到 offset，只能靠内容把位置编码出来）
    const n = Math.round(SR * 4);
    const ramp = new Float32Array(n);
    for (let i = 0; i < n; i++) ramp[i] = i;

    const w = candidateWindows(ramp, SR, 1, 3);
    expect(w).toHaveLength(3);
    const starts = w.map((s) => s[0]);
    const sorted = [...starts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(SR / 2);
    }
    // 斜坡上后面能量更高（值随下标增长），所以第一个候选应当在最右端
    expect(starts[0]).toBe(n - SR);
  });

  it('重叠过滤真的生效：候选取自互不重叠的位置', () => {
    // 两段等长高能区，中间静音 —— 第二个候选应当落在另一段上
    const x = withLoudRegion(3.5, [
      [0.0, 1.0, 0.8],
      [2.5, 3.5, 0.8],
    ]);
    const w = candidateWindows(x, SR, 1, 3);
    expect(w.length).toBeGreaterThanOrEqual(2);
    const tail = energy(w[1]);
    const head = energy(w[0]);
    // 第二段必须也是"有声音"的窗口（不是中间那段静音）
    expect(tail).toBeGreaterThan(head * 0.5);
  });

  it('count 就是上限', () => {
    const x = withLoudRegion(10, [[0, 10, 0.5]]);
    expect(candidateWindows(x, SR, 1, 1)).toHaveLength(1);
    expect(candidateWindows(x, SR, 1, 2)).toHaveLength(2);
    expect(candidateWindows(x, SR, 1, 3)).toHaveLength(3);
  });

  it('窗口长度为 seconds × sampleRate', () => {
    const x = withLoudRegion(3, [[0, 3, 0.5]]);
    for (const w of candidateWindows(x, SR, 1, 3)) expect(w.length).toBe(SR);
  });
});
