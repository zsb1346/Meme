/**
 * 音高 worker 的**故障归类**与**重生闸门** —— 纯函数，无任何依赖，便于单测。
 *
 * ══ 为什么单独一个文件 ══
 *
 * 用户报过来的原始日志是这一句：
 *
 *     pitch-async.ts:271 [pitch-async] AI 检测硬失败，回退 YIN
 *     Error: 音高 worker 异常退出
 *
 * 这句话把**「本地 dev server 已经不在跑了」**说成了**「音高算法坏了」**。
 * 拿它去排查，会一路往 DSP / 模型 / wasm 的方向走，而真因在三百米外的进程列表里。
 *
 * 根因是 `new Worker(url)` 的脚本加载是**异步**的，失败时浏览器给的是一个
 * `ErrorEvent`，它的 `message` 常常是**空串** —— 真正的位置信息在 `filename`/`lineno`，
 * 或者干脆什么都没有（跨源 / 网络层失败）。旧实现只读 `e.message`：
 *
 *     new Error(e.message || '音高 worker 异常退出')
 *
 * 于是所有信息都被丢掉了，只剩一句指向错误方向的兜底话。
 *
 * **规矩**：兜底文案不许是「出了个错」，必须写成「最可能是什么 + 下一步查哪儿」。
 * 报错指错地方比不报错更贵 —— 这条在本项目已经踩过不止一次。
 *
 * ══ 第二个职责：重生闸门 ══
 *
 * worker 一死，`worker = null`，下一个请求就 `new Worker(...)` 一次。
 * 若死因是「脚本根本拿不到」（server 挂了 / 模块编译失败），
 * **每个请求都会生成一个注定失败的 worker** —— 日志里刷出四份同样的报错，
 * 而每一份都要等一次网络失败。加一个冷却窗，让「已知拿不到」的那段时间里
 * 请求**立刻失败**（调用方据此走 JS 应急退路），而不是再赌一次。
 */

/** 故障类别。区分它是因为**处置完全不同**。 */
export type WorkerFailureKind =
  /** worker 脚本本身没能加载/编译：dev server 不可达、模块 404、语法错误。重生无用，得先修环境。 */
  | 'script_load'
  /** 脚本起来了，跑的过程中抛的错。重生通常有效。 */
  | 'runtime'
  /** 拿不到任何线索，只能给出最可能的原因。 */
  | 'unknown';

export interface WorkerFailure {
  kind: WorkerFailureKind;
  /** 给人看的**一整个原因**（含定位线索）。必须能据此决定「下一步查哪儿」。 */
  reason: string;
}

/** 失败后多久之内不再尝试新建 worker。 */
export const WORKER_RESPAWN_COOLDOWN_MS = 2000;

/**
 * 症状 → 类别 + 一句能定位的原因。
 *
 * 传入的字段来自浏览器给 worker 的 `ErrorEvent`（`lib.dom` 的字段名）。
 * 三类判据按**可信度**排序，不要按「看起来像」排序：
 *  1. `message` 里出现加载/导入类字样 → 直接判 `script_load`（最明确，且处置相反）；
 *  2. 有 `message` → `runtime`（worker 内部抛的）；
 *  3. 什么都没有、或只有 `filename` → `script_load`（拿不到脚本，最多的情形）。
 */
export function classifyWorkerFailure(e: {
  message?: string | null;
  filename?: string | null;
  lineno?: number | null;
  colno?: number | null;
}): WorkerFailure {
  const message = (e.message ?? '').trim();
  const filename = (e.filename ?? '').trim();
  const where = filename
    ? `${filename}${e.lineno ? `:${e.lineno}${e.colno ? `:${e.colno}` : ''}` : ''}`
    : '';

  /*
    加载类失败的文案实测长这样（Chrome，module worker）：
      · "Failed to fetch dynamically imported module: http://localhost:5173/..."
      · "Uncaught NetworkError: Failed to import ..."
      · "Uncaught SyntaxError: ..."（模块编译不过）
    它们都属于「脚本没跑起来」，与「跑起来了但抛错」是两回事。
  */
  const loadLike = /Failed to (fetch|load)|NetworkError|dynamically imported|Failed to import|SyntaxError|ERR_CONNECTION|404|not found/i;

  if (message && loadLike.test(message)) {
    return {
      kind: 'script_load',
      reason: `${message}${where ? `（${where}）` : ''} —— worker 脚本没能加载，先确认本地 dev server 在跑`,
    };
  }

  if (message) {
    return { kind: 'runtime', reason: where ? `${message}（${where}）` : message };
  }

  if (where) {
    return { kind: 'script_load', reason: `worker 脚本在 ${where} 处没能执行` };
  }

  return {
    kind: 'unknown',
    reason:
      'worker 脚本没能加载，且浏览器未给出任何位置信息' +
      '（最常见：本地 dev server 已退出 / 端口变了 / 资源被拦）',
  };
}

/**
 * 现在该不该新建一个 worker？
 *
 * `failedAt === null` = 没有失败记录 → 建。
 * 否则只有距上次失败**满一个冷却窗**才允许再试一次 —— 这样「拿不到脚本」的
 * 那段窗口里，连续 N 个请求只会产生 **1 次**真实尝试，其余立刻失败并走应急退路。
 *
 * 负数差（时钟回拨 / 用了不同的时基）按「刚失败过」处理：宁可少赌一次。
 */
export function shouldSpawnWorker(
  now: number,
  failedAt: number | null,
  cooldownMs: number = WORKER_RESPAWN_COOLDOWN_MS,
): boolean {
  if (failedAt === null) return true;
  return now - failedAt >= cooldownMs;
}

/**
 * 「worker 起不来」这一类失败。**单独一个类型**是真有用的：
 * 调用方据此区分「这条请求本身出错」（超时、参数不对 → 照旧抛给上层）
 * 与「整个 worker 都没了」（→ 走主线程 JS 应急退路，而不是让音高面板全黑）。
 */
export class PitchWorkerUnavailableError extends Error {
  readonly failure: WorkerFailure;

  constructor(failure: WorkerFailure) {
    super(failure.reason);
    this.name = 'PitchWorkerUnavailableError';
    this.failure = failure;
  }
}

export function isWorkerUnavailable(err: unknown): err is PitchWorkerUnavailableError {
  return err instanceof PitchWorkerUnavailableError;
}
