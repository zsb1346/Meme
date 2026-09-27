/**
 * `registerKeyUp`（松开通道）的守卫。
 *
 * ══ 为什么单给「松开」写一组测试 ══
 *
 * 用户要求「同时按多个键动画都要有，且支持长按」。动画的一半在按下、另一半在松开 ——
 * 按下态要由**真实的松开事件**结束（旧版用一个 260ms 定时器假装松手，所以长按失效）。
 *
 * 而「松开」的派发规则与「按下」**恰好相反**（见 `shortcuts.ts` 文件头）：
 *
 *   · keydown 命中即**短路**（一次按键只该触发一个动作）；
 *   · keyup 必须**派发给所有匹配者** —— 短路会吃掉后面那些键的松开事件，
 *     它们就永远卡在按下态。
 *
 * 把 keydown 的规矩照搬到 keyup 上，症状是「按 A 再按 B、松开 B 之后 A 松不掉了」，
 * 而这种错位不会在类型检查或任何单点断言里暴露 —— 所以下面第一条用例专门钉它。
 *
 * ⚠️ 本仓库的 vitest 跑在 node（没有 jsdom），没有 window。
 *    `registerKeyUp` 的监听器安装因此在 node 里是空操作，`dispatchKeyUp` 单独导出
 *    正是为了能在这条环境下驱动真实的派发逻辑（测的是分发规则，不是浏览器的 keyup）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dispatchKeyUp, registerKeyUp, unregisterAllShortcuts } from './shortcuts';

/** 假事件：派发逻辑只读 `event.target`（且 guardInput 默认关闭） */
const ev = (target: unknown = null): KeyboardEvent =>
  ({ key: 'a', target } as unknown as KeyboardEvent);

/** 收信机：记录收到过哪些键 */
function recorder() {
  const seen: string[] = [];
  return {
    seen,
    handler: (_e: KeyboardEvent, key: string) => {
      seen.push(key);
    },
  };
}

afterEach(() => {
  unregisterAllShortcuts();
});

describe('registerKeyUp：松开必须送达', () => {
  it('⭐ 两个注册都收得到（不短路）——「多键同按」在键盘层的核心', () => {
    const a = recorder();
    const b = recorder();
    registerKeyUp({ id: 't-a', keys: ['a'], handler: a.handler });
    registerKeyUp({ id: 't-b', keys: ['a'], handler: b.handler });

    dispatchKeyUp(ev(), 'a');

    expect(a.seen).toEqual(['a']);
    // ⛔ keydown 的「命中即短路」若照搬到这里，b 就永远收不到松开 → 卡在按下态。
    expect(b.seen).toEqual(['a']);
  });

  it('不写 keys = 接收全部松开（绑定表被改也不漏收）', () => {
    const r = recorder();
    registerKeyUp({ id: 't-all', handler: r.handler });

    dispatchKeyUp(ev(), 'a');
    dispatchKeyUp(ev(), 'Space');
    dispatchKeyUp(ev(), 'F13');

    expect(r.seen).toEqual(['a', 'Space', 'F13']);
  });

  it('写了 keys 就只收匹配的，且字面空格归一化为 Space', () => {
    const r = recorder();
    registerKeyUp({ id: 't-space', keys: [' '], handler: r.handler });

    dispatchKeyUp(ev(), 'Space'); // 监听器侧已归一化
    dispatchKeyUp(ev(), 'a');

    expect(r.seen).toEqual(['Space']);
  });

  it('多个注册各收各的键，互不干扰', () => {
    const a = recorder();
    const b = recorder();
    registerKeyUp({ id: 't-a2', keys: ['a'], handler: a.handler });
    registerKeyUp({ id: 't-b2', keys: ['b'], handler: b.handler });

    dispatchKeyUp(ev(), 'a');
    dispatchKeyUp(ev(), 'b');
    dispatchKeyUp(ev(), 'c');

    expect(a.seen).toEqual(['a']);
    expect(b.seen).toEqual(['b']);
  });

  it('注销后不再送达（effect cleanup 路径）', () => {
    const r = recorder();
    const off = registerKeyUp({ id: 't-off', keys: ['a'], handler: r.handler });

    dispatchKeyUp(ev(), 'a');
    expect(r.seen).toEqual(['a']);

    off();
    dispatchKeyUp(ev(), 'a');
    expect(r.seen).toEqual(['a']); // 没有增长
  });

  it('同 id 重复注册 = 覆盖（不会收到两次）', () => {
    const first = recorder();
    const second = recorder();
    registerKeyUp({ id: 't-dup', keys: ['a'], handler: first.handler });
    registerKeyUp({ id: 't-dup', keys: ['a'], handler: second.handler });

    dispatchKeyUp(ev(), 'a');

    expect(second.seen).toEqual(['a']);
    expect(first.seen).toEqual([]);
  });

  it('when 能拦住（文档已警告：拦掉松开 = 卡在按下态）', () => {
    const r = recorder();
    let open = true;
    registerKeyUp({
      id: 't-when',
      keys: ['a'],
      when: () => open,
      handler: r.handler,
    });

    dispatchKeyUp(ev(), 'a');
    open = false;
    dispatchKeyUp(ev(), 'a');

    expect(r.seen).toEqual(['a']); // 第二次被拦
  });

  it('无 window 环境也能注册/注销（node 测试能跑的前提）', () => {
    // 这条顺带说明「监听器的安装」与「派发规则」是两件事：
    // 前者依赖浏览器，后者是纯逻辑、可被直接断言。
    expect(typeof window).toBe('undefined');
    const off = registerKeyUp({ id: 't-node', handler: () => {} });
    expect(typeof off).toBe('function');
    off();
  });
});
