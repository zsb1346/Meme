/**
 * 音高 worker 的故障归类 / 重生闸门 / 不可用错误类型 —— 纯逻辑回归。
 *
 * ══ 这条测试守的是什么（用户实报）══
 *
 * 用户把控制台日志贴过来时，里面唯一与音高有关的一句是：
 *
 *     [pitch-async] AI 检测硬失败，回退 YIN
 *     Error: 音高 worker 异常退出
 *
 * 而同一份日志里还有四条 `net::ERR_CONNECTION_REFUSED` ——
 * **本地 dev server 已经不在跑了**。也就是说那句报错把
 * 「进程没了」说成了「音高算法坏了」，排查方向会直接跑偏。
 *
 * 根因：worker 的脚本加载是异步的，失败时浏览器给的 `ErrorEvent`
 * 里 `message` 常常是**空串**（真信息在 `filename`/`lineno`，或什么都没有），
 * 而旧代码只读 `e.message`，于是退化成一句不含任何线索的兜底话。
 *
 * 所以下面第一条断言不是「分类对不对」，而是**兜底文案里必须出现
 * 「dev server」这个可执行线索** —— 这是这条回归的真正锚点。
 */
import { describe, expect, it } from 'vitest';
import {
  PitchWorkerUnavailableError,
  WORKER_RESPAWN_COOLDOWN_MS,
  classifyWorkerFailure,
  isWorkerUnavailable,
  shouldSpawnWorker,
} from './pitch-worker-health';

const ev = (o: Partial<{ message: string; filename: string; lineno: number; colno: number }>) => ({
  message: o.message ?? '',
  filename: o.filename ?? '',
  lineno: o.lineno ?? 0,
  colno: o.colno ?? 0,
});

describe('classifyWorkerFailure：把「拿不到脚本」与「跑起来后抛错」分开', () => {
  it("⛔ 兜底文案不许是「音高 worker 异常退出」这种零线索的话", () => {
    const f = classifyWorkerFailure(ev({}));
    expect(f.reason).not.toContain('异常退出');
    // 必须给出**下一步查哪儿**，否则等于没说
    expect(f.reason).toContain('dev server');
  });

  it('空事件 → kind 不敢乱断（unknown），但原因仍是可执行的', () => {
    const f = classifyWorkerFailure(ev({}));
    expect(f.kind).toBe('unknown');
    expect(f.reason).toContain('未给出任何位置信息');
  });

  it('「Failed to fetch dynamically imported module: …」→ script_load，且带出原始 URL', () => {
    const url = 'http://localhost:5173/node_modules/.vite/deps/@audio_shift-pvoc.js';
    const f = classifyWorkerFailure(ev({ message: `Failed to fetch dynamically imported module: ${url}` }));
    expect(f.kind).toBe('script_load');
    expect(f.reason).toContain(url);
    expect(f.reason).toContain('dev server');
  });

  it('NetworkError / ERR_CONNECTION 也算 script_load（同一类处置）', () => {
    expect(classifyWorkerFailure(ev({ message: 'Uncaught NetworkError: Failed to import' })).kind).toBe(
      'script_load',
    );
    expect(classifyWorkerFailure(ev({ message: 'net::ERR_CONNECTION_REFUSED' })).kind).toBe('script_load');
  });

  it('模块编译不过（SyntaxError）同样归 script_load —— 脚本从未跑起来', () => {
    const f = classifyWorkerFailure(ev({ message: 'Uncaught SyntaxError: Unexpected token' }));
    expect(f.kind).toBe('script_load');
  });

  it('worker 内部抛的运行时错误 → runtime，且带上 message 与位置', () => {
    const f = classifyWorkerFailure(
      ev({ message: 'Uncaught TypeError: x is not a function', filename: 'http://x/pitch-worker.ts', lineno: 42, colno: 7 }),
    );
    expect(f.kind).toBe('runtime');
    expect(f.reason).toContain('x is not a function');
    expect(f.reason).toContain('pitch-worker.ts:42:7');
  });

  it('有 message 无位置 → runtime，reason 就是 message 本身', () => {
    const f = classifyWorkerFailure(ev({ message: 'wasm 内存越界' }));
    expect(f.kind).toBe('runtime');
    expect(f.reason).toBe('wasm 内存越界');
  });

  it('有位置无 message → script_load 且指出位置（拿不到脚本的常见形态）', () => {
    const f = classifyWorkerFailure(ev({ filename: 'http://x/pitch-worker.ts' }));
    expect(f.kind).toBe('script_load');
    expect(f.reason).toContain('http://x/pitch-worker.ts');
  });

  it('字段是 null / undefined 也不炸（ErrorEvent 的字段确实可能是空）', () => {
    const f = classifyWorkerFailure({ message: null, filename: null, lineno: null, colno: null });
    expect(f.kind).toBe('unknown');
    expect(f.reason.length).toBeGreaterThan(0);
  });
});

describe('shouldSpawnWorker：冷却窗（防「每个请求生成一个注定失败的 worker」）', () => {
  it('没失败过 → 建', () => {
    expect(shouldSpawnWorker(1000, null)).toBe(true);
  });

  it('刚失败 → 不建（这就是「四份同样的报错」的源头，必须挡掉）', () => {
    expect(shouldSpawnWorker(1000, 1000)).toBe(false);
    expect(shouldSpawnWorker(1000 + WORKER_RESPAWN_COOLDOWN_MS - 1, 1000)).toBe(false);
  });

  it('满一个冷却窗 → 允许再试一次', () => {
    expect(shouldSpawnWorker(1000 + WORKER_RESPAWN_COOLDOWN_MS, 1000)).toBe(true);
    expect(shouldSpawnWorker(1000 + WORKER_RESPAWN_COOLDOWN_MS * 5, 1000)).toBe(true);
  });

  it('时钟回拨（now < failedAt）按「刚失败过」处理：宁可少赌一次', () => {
    expect(shouldSpawnWorker(500, 1000)).toBe(false);
  });

  it('冷却时长可覆盖（便于按环境调）', () => {
    expect(shouldSpawnWorker(1500, 1000, 200)).toBe(true);
    expect(shouldSpawnWorker(1100, 1000, 200)).toBe(false);
  });
});

describe('PitchWorkerUnavailableError：调用方据此区分「worker 没了」与「这条请求出错」', () => {
  it('isWorkerUnavailable 只认它自己', () => {
    const err = new PitchWorkerUnavailableError({ kind: 'script_load', reason: '拿不到脚本' });
    expect(isWorkerUnavailable(err)).toBe(true);
    expect(isWorkerUnavailable(new Error('音高检测超时（8000ms）'))).toBe(false);
    expect(isWorkerUnavailable(null)).toBe(false);
    expect(isWorkerUnavailable('拿不到脚本')).toBe(false);
  });

  it('message 就是 reason（这样它被冒泡上去时仍然带着线索）', () => {
    const err = new PitchWorkerUnavailableError({ kind: 'unknown', reason: '先确认本地 dev server 在跑' });
    expect(err.message).toBe('先确认本地 dev server 在跑');
    expect(err.name).toBe('PitchWorkerUnavailableError');
  });

  it('failure 原样带着，冷却窗内「立刻失败」时可以把上一次的真原因报出去', () => {
    const failure = { kind: 'script_load' as const, reason: 'worker 脚本没能加载' };
    expect(new PitchWorkerUnavailableError(failure).failure).toEqual(failure);
  });
});
