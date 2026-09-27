/**
 * 变换缓存额度的守卫。
 *
 * ── 为什么这个文件必须存在 ──
 *
 * `transformBuffer` 本体需要真 `AudioBuffer`（vitest 跑在 node 环境，没有 Web
 * Audio），所以「缓存会淘汰什么、留下什么」在单测里本来是**盲区**。
 * 而它恰好是「弹奏卡不卡」的直接决定因素：额度太小 → LRU 抖动 →
 * 每次按键都重算一整段同步变换。
 *
 * 所以淘汰逻辑被抽成了 `evictToBudget`（纯函数、只认 duck-typed AudioBuffer），
 * 这份测试守的就是它。**三处缓存（变调 / 修音 / 第三方引擎）共用这一个实现**，
 * 所以这一份覆盖对三处都成立。
 */
import { describe, expect, it } from 'vitest';
import { evictToBudget, RUSH_CACHE_BUDGET_BYTES, transformBytes } from './transform';

/** 鸭子类型的 AudioBuffer —— `transformBytes` 只读 length / numberOfChannels。 */
function fakeBuffer(bytes: number): AudioBuffer {
  return { length: bytes / 4, numberOfChannels: 1 } as unknown as AudioBuffer;
}

/** 0.45s 立体声 48k 切片：0.45 × 48000 × 2 × 4 ≈ 173KB（真实素材的量级）。 */
const SHORT_CLIP = 173 * 1024;

describe('transformBytes', () => {
  it('= 帧数 × 通道 × 4（f32 每样点四字节）', () => {
    const b = { length: 48000, numberOfChannels: 2 } as unknown as AudioBuffer;
    expect(transformBytes(b)).toBe(48000 * 2 * 4);
  });

  it('单声道与立体声差一倍', () => {
    const mono = { length: 1000, numberOfChannels: 1 } as unknown as AudioBuffer;
    const stereo = { length: 1000, numberOfChannels: 2 } as unknown as AudioBuffer;
    expect(transformBytes(stereo)).toBe(transformBytes(mono) * 2);
  });
});

describe('evictToBudget', () => {
  it('不超预算时一条都不动（不做无谓的删除）', () => {
    const m = new Map<string, AudioBuffer>([
      ['a', fakeBuffer(1024)],
      ['b', fakeBuffer(1024)],
      ['c', fakeBuffer(1024)],
    ]);
    evictToBudget(m, 10 * 1024, transformBytes);
    expect([...m.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('超预算时从最久未用的那头开始删', () => {
    const m = new Map<string, AudioBuffer>();
    for (const k of ['old', 'mid', 'new']) m.set(k, fakeBuffer(1024));
    // 预算只够两条
    evictToBudget(m, 2 * 1024, transformBytes);
    expect([...m.keys()]).toEqual(['mid', 'new']);
  });

  it('删到刚好落回预算内就停手', () => {
    const m = new Map<string, AudioBuffer>();
    for (let i = 0; i < 10; i++) m.set(`k${i}`, fakeBuffer(1024));
    evictToBudget(m, 3 * 1024, transformBytes);
    expect(m.size).toBe(3);
    expect([...m.keys()]).toEqual(['k7', 'k8', 'k9']);
  });

  it('⭐ 至少保留一条 —— 哪怕它自己就超过整个预算', () => {
    // 3 分钟人声约 66MB，单条就远超 8MB 额度。
    // 若允许删空，那个素材就变成「永远不缓存」= 每次按键重算，
    // 比超预算更糟（预算是防爆内存的，不是防「缓存」的）。
    const m = new Map<string, AudioBuffer>([['huge', fakeBuffer(66 * 1024 * 1024)]]);
    evictToBudget(m, RUSH_CACHE_BUDGET_BYTES, transformBytes);
    expect(m.size).toBe(1);
    expect(m.has('huge')).toBe(true);
  });

  it('⭐ 额度按**字节**而不是条数：12 个键的短素材组合全部留得住', () => {
    /*
      这条是本文件的主角。旧的实现是「每源素材最多 8 条」——
      而键位映射下每个键一个独立音高，12 个键就是 12 条：
      第 9 个键进来时把第 1 个挤掉，回头再按第 1 个又把它挤掉……
      **每一次按键都可能是未命中**，也就是每次都要重算一整段同步变换。
      实测那正是「弹奏一卡一卡、有时干脆没声」的来源。
    */
    const m = new Map<string, AudioBuffer>();
    for (let i = 0; i < 12; i++) {
      m.set(`key${i}`, fakeBuffer(SHORT_CLIP));
      evictToBudget(m, RUSH_CACHE_BUDGET_BYTES, transformBytes);
    }
    expect(m.size).toBe(12);
    expect(transformBytes(fakeBuffer(SHORT_CLIP)) * 12).toBeLessThan(
      RUSH_CACHE_BUDGET_BYTES,
    );
  });

  it('⭐ 长素材自然存得少：同一额度下 4 秒素材只留得下几条', () => {
    // 额度是「字节预算」的另一个方向：不能为了「存得多」把长素材也硬塞，
    // 那是 8MB 而不是固定条数要表达的第二层意思。
    const long = 4 * 48000 * 2 * 4; // 4s 立体声 ≈ 1.5MB
    const m = new Map<string, AudioBuffer>();
    for (let i = 0; i < 12; i++) {
      m.set(`k${i}`, fakeBuffer(long));
      evictToBudget(m, RUSH_CACHE_BUDGET_BYTES, transformBytes);
    }
    expect(m.size).toBeGreaterThan(1);
    expect(m.size).toBeLessThan(12);
    expect(m.size * long).toBeLessThanOrEqual(RUSH_CACHE_BUDGET_BYTES);
  });

  it('空 Map 不抛', () => {
    const m = new Map<string, AudioBuffer>();
    expect(() => evictToBudget(m, 0, transformBytes)).not.toThrow();
    expect(m.size).toBe(0);
  });
});
