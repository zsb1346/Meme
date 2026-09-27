/**
 * 按键动画的**纯状态内核**（不依赖 React、不依赖 DOM）。
 *
 * ══ 为什么要有这个文件 ══
 *
 * 动画状态原来是「单槽」的：`lastPress: { keyIndex, pressed } | null`。
 * 一个全局槽位承担了本该**每键一份**的状态，于是：
 *
 *   · 多键同按 → 只有最后按下的那个键有动画。先按的键被顶成 `false`，
 *     可它的手指还按在屏幕上 —— 画面与触觉对不上，用户原话「这样就很割裂」。
 *   · 长按 → 一个共享的 260ms 定时器到点就把 `lastPress` 清成 null，
 *     于是按键动画在 260ms 后自己弹回去，**物理上还按着**。用户原话「不能长按」。
 *
 * 两条症状同一根因：**状态的粒度错了**（全局 1 份 vs 每键 1 份）。
 * 所以修法不是「加个判断」，而是把粒度改对：按下 = 一个集合，闪灯 = 一张映射。
 *
 * ══ 为什么是纯函数 ══
 *
 * 本仓库的 vitest 跑在 node 环境（没有 jsdom），React 组件测不了。
 * 把状态迁移抽成纯函数，就能直接钉住上面两条症状 —— 而它们正是这次要防的回归。
 * 守卫见 `key-anim-state.test.ts`。
 *
 * ══ 一条容易写错的规矩：引用不变 ≡ 不重渲染 ══
 *
 * 所有函数在「结果没变」时必须**返回入参本身**。这不是省内存的洁癖：
 * React 的 `useState` 在 `Object.is(prev, next)` 为真时会**跳过重渲染**。
 * 按同一个键的第二、三次点击、松开一个从未按下的键 —— 这些高频路径
 * 若每次都新建 Set/Map，整个键区会跟着重渲染一遍（14~36 个 MemeKey）。
 */

/**
 * 闪灯（游标槽位短闪白）的持续时长。
 *
 * ⛔ **单一来源**：指针路径（MemeKey 本地闪灯）与键盘路径（本模块驱动的闪灯）
 *    必须用同一个值。两条路各自写一个常量，就会「点一下和按键盘闪得不一样长」——
 *    这种不一致没有报错、只能靠肉眼发现。
 */
export const FLASH_MS = 260;

/** 一次闪灯：哪个槽位、是否真的出声，以及「这是第几次触发」。 */
export interface KeyFlash {
  /** 本次实际播放的槽位下标（0-based；空序列为 null） */
  readonly slotIndex: number | null;
  /** 是否真的出声（哑触发 = false） */
  readonly triggered: boolean;
  /**
   * 触发序号（单调递增）。
   *
   * ⛔ 存在的唯一理由是**防止旧定时器越权**：同一个键在 200ms 内连点两次，
   *    第一次的定时器会在 260ms 到点 —— 那时刻第二次的闪灯才闪了 60ms。
   *    没有 token，第一次的定时器就会把第二次的闪灯清掉（闪一下就没）。
   *    `clearFlashIn` 只清「还是自己那一次」的闪灯，就靠这个字段判身份。
   */
  readonly token: number;
}

/**
 * 记下一次按下。已在集合里则**原样返回**（同一引用 → React 跳过重渲染）。
 *
 * 幂等是必需的：同一个键可能同时收到指针按下与键盘按下两条路径的信号，
 * 而 `keydown` 的长按重复（`e.repeat`）也会反复调用。
 */
export function pressKeyIn(
  pressed: ReadonlySet<number>,
  keyIndex: number,
): ReadonlySet<number> {
  if (pressed.has(keyIndex)) return pressed;
  const next = new Set(pressed);
  next.add(keyIndex);
  return next;
}

/**
 * 松开一个键。**只影响它自己** —— 这是「多键同按」的核心不变式：
 * 松开 A 不许把 B、C 的按下态一起带走。
 *
 * 未按下过的键 → 原样返回（多余的 pointercancel / keyup 不该引起任何变化）。
 */
export function releaseKeyFrom(
  pressed: ReadonlySet<number>,
  keyIndex: number,
): ReadonlySet<number> {
  if (!pressed.has(keyIndex)) return pressed;
  const next = new Set(pressed);
  next.delete(keyIndex);
  return next;
}

/** 写入一次闪灯。每次都产生**新的对象引用** —— MemeKey 靠引用变化判定「又触发了一次」。 */
export function setFlashIn(
  flashes: ReadonlyMap<number, KeyFlash>,
  keyIndex: number,
  slotIndex: number | null,
  triggered: boolean,
  token: number,
): ReadonlyMap<number, KeyFlash> {
  const next = new Map(flashes);
  next.set(keyIndex, { slotIndex, triggered, token });
  return next;
}

/**
 * 清除一次闪灯 —— 但**只清自己那一次**。
 *
 * 若该键此后又被触发过（`token` 已变），说明这次定时器来晚了，
 * 必须原样返回，否则会把新的闪灯提前掐掉。见 `KeyFlash.token` 的说明。
 */
export function clearFlashIn(
  flashes: ReadonlyMap<number, KeyFlash>,
  keyIndex: number,
  token: number,
): ReadonlyMap<number, KeyFlash> {
  const cur = flashes.get(keyIndex);
  if (cur === undefined || cur.token !== token) return flashes;
  const next = new Map(flashes);
  next.delete(keyIndex);
  return next;
}
