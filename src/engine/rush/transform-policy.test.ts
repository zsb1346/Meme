/**
 * transform-policy.test —— 降级链的判据（纯函数，不碰 wasm）。
 *
 * 盯的是那个**静默失效**：PSOLA 在没有周期可同步的素材上返回合法音频、音高却
 * 一动没动，而降级链（PSOLA → SOLA → 原声）是靠异常推进的，于是永远停在 PSOLA。
 * `isPsolaSilentNoop` 把那种状态翻译成降级信号，这里把它的边界钉死。
 *
 * 真素材上的端到端验证在 `scripts/_probe-material-pitch.mjs`（修复前 13/41
 * 静默不变调，修复后 0/41）。
 */
import { describe, expect, it } from 'vitest';
import { isPsolaSilentNoop, PsolaSilentNoopError } from './transform';

const P5 = 2 ** (5 / 12);

describe('PSOLA 静默空转判定', () => {
  it('没有 pitch mark 且有变调意图 → 判为静默空转', () => {
    expect(isPsolaSilentNoop(1, P5, 0, 0)).toBe(true);
    // voiced 帧存在但一个 run 都没够两个周期 → 同样没有 mark，同样没做颗粒重排
    expect(isPsolaSilentNoop(1, P5, 0, 12)).toBe(true);
  });

  it('有 pitch mark → 正常，不降级', () => {
    expect(isPsolaSilentNoop(1, P5, 37, 41)).toBe(false);
  });

  it('纯拉伸（pitch≈1）不降级 —— 固定颗粒路径是预期行为', () => {
    expect(isPsolaSilentNoop(1, 1, 0, 0)).toBe(false);
    expect(isPsolaSilentNoop(1, 1.00001, 0, 0)).toBe(false);
    // 降调 / 升调都是变调意图，即使幅度很小也要判
    expect(isPsolaSilentNoop(1, 0.9995, 0, 0)).toBe(true);
  });

  it('其它模式不受此判据约束（SOLA 不依赖清浊判断）', () => {
    expect(isPsolaSilentNoop(2, P5, 0, 0)).toBe(false);
    expect(isPsolaSilentNoop(0, P5, 0, 0)).toBe(false);
  });

  it('wasm 没导出可观测点时不下结论 —— 宁可照旧走成功路径', () => {
    expect(isPsolaSilentNoop(1, P5, -1, 0)).toBe(false);
    expect(isPsolaSilentNoop(1, P5, -1, -1)).toBe(false);
  });

  it('错误类型可被 instanceof 认出（sample-player 据此打印专门日志）', () => {
    const e = new PsolaSilentNoopError(P5);
    expect(e).toBeInstanceOf(PsolaSilentNoopError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PsolaSilentNoopError');
    expect(e.message).toContain('SOLA');
  });
});

/**
 * mode 3 = PSOLA + 降调谐波/噪声分离，是 `playSample` 现在的默认第一档。
 *
 * 它与 mode 1 共用同一套颗粒编排，只在**明确降调**时多一道拆分，所以
 * 「有没有周期可同步」的判据对它一字不差 —— 漏掉这条，mode 3 上的静默空转
 * 又会永远停在第一档（正是上面那个 bug 的复发路径）。
 */
describe('mode 3（PSOLA + 降调谐波分离）的降级判据', () => {
  it('静默空转判定对 mode 3 一样成立', () => {
    expect(isPsolaSilentNoop(3, P5, 0, 0)).toBe(true);
    expect(isPsolaSilentNoop(3, P5, 0, 12)).toBe(true);
    expect(isPsolaSilentNoop(3, P5, 37, 41)).toBe(false);
  });

  it('纯拉伸（pitch≈1）与「wasm 没导出计数」在 mode 3 上同样不降级', () => {
    expect(isPsolaSilentNoop(3, 1, 0, 0)).toBe(false);
    expect(isPsolaSilentNoop(3, 1.00001, 0, 0)).toBe(false);
    expect(isPsolaSilentNoop(3, P5, -1, 0)).toBe(false);
  });
});
