/**
 * `withAlpha` —— 纯函数的**记忆化**守卫。
 *
 * ## 为什么要有这个文件
 *
 * 卷帘每帧要为每个可见音符块取 3~5 个半透明变体；高密度画面下这是每帧
 * 上千次调用。原来的实现每次都跑一遍 `正则 exec + parseInt + 模板字符串`，
 * 产出**新字符串**。缓存之后有三个必须守住的性质：
 *
 *  1. **值不变** —— `withAlpha` 是画面上百处颜色的唯一来源，改错一个
 *     就是整片配色走样，而且很难用眼睛看出「是哪里不对」。
 *  2. **同一个 `(hex, alpha)` 必须返回同一个字符串实例** —— 这不是洁癖：
 *     调用方 `ctx.fillStyle = s` 依赖「字符串复用」才能让浏览器短路掉
 *     重复的 CSS 颜色解析（这是本轮性能改造收益的一部分）。
 *     `toBe` 断言的就是**同一实例**，`toEqual` 会漏掉它。
 *  3. **非法输入原样返回** —— 设计如此（不吞色，便于排查），
 *     不能被缓存逻辑改成返回 `undefined`。
 */
import { describe, expect, it } from 'vitest';
import { invalidateTokenCache, withAlpha } from './getTokens';

describe('withAlpha', () => {
  it('十六进制 + alpha → rgba()，值不变', () => {
    expect(withAlpha('#409CFF', 0.55)).toBe('rgba(64,156,255,0.55)');
    expect(withAlpha('#000000', 0)).toBe('rgba(0,0,0,0)');
    expect(withAlpha('#ffffff', 1)).toBe('rgba(255,255,255,1)');
    // 不带 # 也接受；大小写不敏感
    expect(withAlpha('409cff', 0.5)).toBe('rgba(64,156,255,0.5)');
  });

  it('同一个 (hex, alpha) 返回**同一个字符串实例**（缓存生效）', () => {
    const a = withAlpha('#409CFF', 0.13);
    const b = withAlpha('#409CFF', 0.13);
    expect(a).toBe(b); // ⛔ toBe 才是「同一实例」；toEqual 会漏掉缓存失效
  });

  it('alpha 不同 → 不同结果', () => {
    expect(withAlpha('#409CFF', 0.13)).not.toBe(withAlpha('#409CFF', 0.14));
  });

  it('hex 不同 → 不同结果', () => {
    expect(withAlpha('#409CFF', 0.5)).not.toBe(withAlpha('#2E8AEC', 0.5));
  });

  it('非法输入原样返回（不吞色），且不会被缓存成空值', () => {
    expect(withAlpha('not-a-color', 0.5)).toBe('not-a-color');
    expect(withAlpha('', 0.5)).toBe('');
    expect(withAlpha('#12345', 0.5)).toBe('#12345');
    // 再取一次仍然原样返回
    expect(withAlpha('not-a-color', 0.5)).toBe('not-a-color');
  });

  it('大量不同组合之后，早期条目的值依旧正确（缓存不会串味）', () => {
    const first = withAlpha('#409CFF', 0.13);
    for (let i = 0; i < 400; i++) {
      withAlpha('#123456', i / 400);
    }
    expect(withAlpha('#409CFF', 0.13)).toBe(first);
    expect(withAlpha('#409CFF', 0.13)).toBe('rgba(64,156,255,0.13)');
  });

  it('令牌缓存失效不影响 alpha 结果（hex 是入参，不依赖主题状态）', () => {
    const before = withAlpha('#409CFF', 0.42);
    invalidateTokenCache();
    expect(withAlpha('#409CFF', 0.42)).toBe(before);
  });
});
