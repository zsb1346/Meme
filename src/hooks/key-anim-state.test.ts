/**
 * `key-anim-state`（按键动画纯状态内核）的守卫。
 *
 * ══ 这两组症状是本次要防的回归 ══
 *
 * 用户实报：「按下一个按键会播放一个变蓝的动画，但同时按多个的话只会有一个有动画，
 * 这样就很割裂；且不能长按。期望同时按多个都能有动画，且可以支持长按。」
 *
 * 根因不是「少了个判断」，而是**状态的粒度**：旧版把「当前哪个键被按住」存成
 * 全局单槽 `lastPress: { keyIndex, pressed }`，再叠一个 260ms 定时器自动松手。
 * 于是多键同按只剩最后一个、长按 260ms 后自己弹回。
 *
 * 所以守卫必须钉住两件事：
 *   ① 状态代数 —— 多键并存、只松开自己、无变化时引用不变；
 *   ② 结构约束 —— 按下态**不许**有定时器（下面那条读源码的用例）。
 *      定时器不会在任何状态断言里露馅（它只是在「某个时刻」改状态），
 *      所以纯代数测试测不到「长按被定时器毁掉」这件事，只能靠结构守卫。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLASH_MS,
  clearFlashIn,
  pressKeyIn,
  releaseKeyFrom,
  setFlashIn,
  type KeyFlash,
} from './key-anim-state';

/** 集合 → 升序数组（断言可读） */
const list = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);

const noKeys = (): ReadonlySet<number> => new Set<number>();
const noFlashes = (): ReadonlyMap<number, KeyFlash> => new Map<number, KeyFlash>();

// ═══════════════════════════════════════════════════════════════════════════
// ① 按下集合
// ═══════════════════════════════════════════════════════════════════════════

describe('按下集合：多键同按', () => {
  it('三个键能同时在集合里（旧版单槽只留得住最后一个）', () => {
    let s = noKeys();
    s = pressKeyIn(s, 3);
    s = pressKeyIn(s, 7);
    s = pressKeyIn(s, 11);
    expect(list(s)).toEqual([3, 7, 11]);
  });

  it('松开一个键只影响它自己 —— 另外两个还按着', () => {
    let s = noKeys();
    s = pressKeyIn(s, 3);
    s = pressKeyIn(s, 7);
    s = pressKeyIn(s, 11);

    s = releaseKeyFrom(s, 7);

    expect(s.has(7)).toBe(false);
    expect(list(s)).toEqual([3, 11]); // ⛔ 旧版这里是空集（一次松开清掉全部）
  });

  it('幂等：重复按下 / 松开没按过的键都不改变内容', () => {
    const a = pressKeyIn(noKeys(), 5);
    expect(list(pressKeyIn(a, 5))).toEqual([5]);
    expect(list(releaseKeyFrom(a, 9))).toEqual([5]);
    expect(list(releaseKeyFrom(noKeys(), 9))).toEqual([]);
  });

  it('引用不变 ≡ 不重渲染：无变化时必须返回入参本身', () => {
    const a = pressKeyIn(noKeys(), 5);
    // ⛔ 必须用 toBe（同一引用）；toEqual 只比值，漏掉「每次都新建 Set」这种退化 ——
    //    那会让 14~36 个 MemeKey 在每次重复点击时集体重渲染。
    expect(pressKeyIn(a, 5)).toBe(a);
    expect(releaseKeyFrom(a, 9)).toBe(a);

    const none = noKeys();
    expect(releaseKeyFrom(none, 9)).toBe(none);
  });

  it('长按：除显式松开外，没有任何路径能把键移出集合', () => {
    // 「长按」在纯逻辑层就是这个样子：状态写进去以后只能由 releaseKeyFrom 撤销。
    // 旧版的撤销者是一个 260ms 定时器（在 useKeyAnimations 里）→ 见下方结构守卫。
    let s = noKeys();
    for (let i = 0; i < 500; i++) s = pressKeyIn(s, 2); // 长按会反复触发按下
    expect(list(s)).toEqual([2]);

    s = releaseKeyFrom(s, 2);
    expect(list(s)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 闪灯映射
// ═══════════════════════════════════════════════════════════════════════════

describe('闪灯映射：每键一份', () => {
  it('两个键可以同时闪（旧版单槽只留得住最后一个）', () => {
    let m = noFlashes();
    m = setFlashIn(m, 1, 0, true, 1);
    m = setFlashIn(m, 5, 2, false, 2);

    expect(m.get(1)).toMatchObject({ slotIndex: 0, triggered: true });
    expect(m.get(5)).toMatchObject({ slotIndex: 2, triggered: false });
  });

  it('clearFlashIn 只清自己那一次：迟到的旧定时器不许掐掉新闪灯', () => {
    /*
      同一键 200ms 内连点两次 → 第一次的 token=1、第二次 token=2。
      第一次的定时器 260ms 到点，而此刻第二次的闪灯才闪了 60ms。
      若它无条件清空，用户看到的就是「连点第二次闪不出来」。
    */
    let m = noFlashes();
    m = setFlashIn(m, 4, 0, true, 1);
    m = setFlashIn(m, 4, 3, true, 2);

    const afterStale = clearFlashIn(m, 4, 1); // 第一次的定时器来晚了
    expect(afterStale).toBe(m); // 原样返回
    expect(afterStale.get(4)?.slotIndex).toBe(3); // 新闪灯还在

    const afterFresh = clearFlashIn(m, 4, 2);
    expect(afterFresh.has(4)).toBe(false);
  });

  it('每次写入都是新引用（MemeKey 靠引用变化判定「又触发了一次」）', () => {
    const m = setFlashIn(noFlashes(), 6, 1, true, 1);
    const m2 = setFlashIn(m, 6, 1, true, 2); // 内容相同，token 不同
    expect(m.get(6)).not.toBe(m2.get(6));
  });

  it('清一个不存在 / 从未写入的键 = 无变化', () => {
    const m = noFlashes();
    expect(clearFlashIn(m, 8, 1)).toBe(m);
  });

  it('slotIndex 允许为 null（空序列键：闪灯只表示「触发了但没槽位」）', () => {
    const m = setFlashIn(noFlashes(), 9, null, false, 1);
    expect(m.get(9)?.slotIndex).toBeNull();
    expect(m.get(9)?.triggered).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 结构守卫 —— 纯代数测不到的那一半
// ═══════════════════════════════════════════════════════════════════════════

describe('结构守卫：定时器只准出现在闪灯路径', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('useKeyAnimations 里只有一个 setTimeout，它属于闪灯而不是按下态', () => {
    const src = read('./useKeyAnimations.ts');

    // 「按下」是持续态，只能由松开事件结束。一旦这里出现第二个定时器，
    // 它十有八九就是那个「260ms 自动松手」（长按失效的根因）。
    expect([...src.matchAll(/window\.setTimeout\(/g)]).toHaveLength(1);

    // 按下态的写入点固定三处：pressKey / releaseKey / clearPressed（失焦兜底）。
    // 多出来的第四处意味着有人在别的地方偷偷改按下态。
    expect([...src.matchAll(/setPressedKeys\(/g)]).toHaveLength(3);
  });

  it('MemeKey 不再自带 FLASH_MS 常量（闪灯时长单一来源）', () => {
    const src = read('../components/keys/MemeKey.tsx');

    expect(src).toContain("from '../../hooks/key-anim-state'");
    // 两条路径（指针 / 键盘）各自写一个常量 → 「点一下和按键盘闪得不一样长」。
    // 这种不一致没有任何状态断言能发现，只能靠这条。
    expect(/const\s+FLASH_MS\s*=/.test(src)).toBe(false);
    expect(FLASH_MS).toBeGreaterThan(0);
  });

  it('MemeKey 的按下态是「取或」，不是「外部信号说了算」', () => {
    const src = read('../components/keys/MemeKey.tsx');

    // 旧版：`else setPressed(false)` —— 外部信号有权清掉本地按下态，
    // 于是按住 A 再按 B 时，A 被 B 的信号清掉（手指还在按，动画弹回去）。
    expect(src).toContain('const showPressed = pressed || externalHeld;');
    expect(/setPressed\(false\)\s*;?\s*\}\s*\]\s*,\s*\[external/.test(src)).toBe(false);
  });

  it('⭐ MemeKey 的三处按下态渲染决策都走 showPressed（不许读裸 pressed）', () => {
    /*
      ⭐ 这条是补上来的 —— 上面那句 `toContain` **骗过了第一版守卫**。

      实际落地那次改动里，`transform:` 与两个 className 分支读的仍是本地
      `pressed`（同一文件的多处编辑被后来的覆盖掉了，静默）；`showPressed`
      那行代码**在**，但没被用上。后果：状态里明明有键、画面上什么都不亮，
      而且**只有键盘路径会坏** —— 指针路径靠 MemeKey 的本地态，照样正常。
      所以红的是实机探针（`probe-keys-anim.mjs` 的 S3），单测全绿。

      教训：`toContain('那行代码')` 只能证明「代码存在」，证明不了「被用上」。
      要钉「行为」就得钉**判据出现在决策点上**。
    */
    const src = read('../components/keys/MemeKey.tsx');

    // 三处决策点必须读 showPressed
    expect(/showPressed\s*\n\s*\?\s*'border-flame-400/.test(src)).toBe(true); // 边框/底色
    expect(src).toContain(
      "transform: showPressed ? pressedTransform : 'scale(1) rotate(0deg) scaleY(1)'",
    );
    expect(/:\s*showPressed\s*\n\s*\?\s*'transform 110ms/.test(src)).toBe(true); // 过渡时长

    // 反面：这三处曾经读的是本地 pressed（多行形态用行锚点抓）
    expect(/^\s*pressed\s*$/m.test(src)).toBe(false);
    expect(/:\s*pressed\s*$/m.test(src)).toBe(false);
    expect(/transform:\s*pressed\s*\?/.test(src)).toBe(false);
  });
});
