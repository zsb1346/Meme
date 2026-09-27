/**
 * 缓存预热服务 —— 五处 prewarm 副本的单一真相（Wave A 地基）。
 *
 * 收编副本：
 *  - pages/StudioPage.tsx            prewarmKeyBuffers（keys 引用集）
 *  - 素材箱批量操作 prewarmAllSampleBuffers（装配面板只按需解码当前候选）
 *  - pages/ExportDialog.tsx          prewarmBuffers（keys 引用集，回传缺失）
 *  - hooks/useKeyMachineController.ts 内联预热
 *  - components/audio/SampleChip.tsx 单素材预热
 *
 * 行为对齐（engine/README §3 缓存预热约定）：
 *  - 已命中 getCachedBuffer 的直接跳过；
 *  - 无 Blob 或解码失败 → 计入缺失清单（调用方决定如何提示）；
 *  - 并发合并：同一 sampleId 的解码 Promise 全局共享，重复调用不重复解码。
 *
 * 本模块位于 model 层，允许依赖 store；但引擎依赖仅限 sample-player 的
 * 缓存 API，保持「engine 不反向依赖 model」的架构红线不变。
 */
import {
  cacheBuffer,
  decodeAudioBlobShared,
  getCachedBuffer,
} from '../engine/sample-player';
import { getAudioContext } from '../engine/core';
import { resolveSlotVoice } from '../engine/event-voice';
import { getActiveShift } from '../engine/external-shift';
import { playbackRateForSemitones } from '../engine/pitch';
import {
  ensureRushLoaded,
  isRushReady,
  RUSH_CACHE_BUDGET_BYTES,
  transformBuffer,
} from '../engine/rush/transform';
import { resolveSemitonesIn } from './pitch-resolve';
import { useStore } from './store';
import type { Key, Project } from './types';

export interface PrewarmOptions {
  /** Blob 提供器；缺省读全局 store.blobs */
  getBlob?(id: string): Blob | undefined;
  /** 完成后回调缺失清单（可选；函数返回值是同一份数组） */
  onMissing?(missingIds: string[]): void;
}

/** 进行中的解码任务表：sampleId → Promise（成功进缓存，失败得 null） */
const inflight = new Map<string, Promise<AudioBuffer | null>>();

async function decodeIntoCache(id: string, blob: Blob): Promise<AudioBuffer | null> {
  try {
    // 共享 worker 解码入口：与导入/波形缩略同 id 去重，主线程零解码
    const { buffer } = await decodeAudioBlobShared(id, blob);
    cacheBuffer(id, buffer);
    return buffer;
  } catch (err) {
    console.warn('[buffer-cache] 预热解码失败', id, err);
    return null;
  }
}

function defaultGetBlob(id: string): Blob | undefined {
  return useStore.getState().blobs[id];
}

/**
 * 预热给定 sampleId 集合的解码缓存；返回缺失的 sampleId 清单
 * （无 Blob、解码失败、或共享中的任务最终失败都算缺失）。
 */
export async function prewarmBuffers(
  ids: Iterable<string>,
  opts: PrewarmOptions = {},
): Promise<string[]> {
  const getBlob = opts.getBlob ?? defaultGetBlob;
  const idList = [...new Set(ids)];
  const jobs: Array<Promise<AudioBuffer | null>> = [];

  for (const id of idList) {
    if (getCachedBuffer(id)) continue;
    const pending = inflight.get(id);
    if (pending) {
      jobs.push(pending);
      continue;
    }
    const blob = getBlob(id);
    if (!blob) continue; // 最终统一按「缓存未命中」记缺失
    const task = decodeIntoCache(id, blob).finally(() => {
      inflight.delete(id);
    });
    inflight.set(id, task);
    jobs.push(task);
  }

  await Promise.all(jobs);

  // 统一判定：凡此刻仍未命中缓存的请求 id 即为缺失
  const missing = idList.filter((id) => !getCachedBuffer(id));
  opts.onMissing?.(missing);
  return missing;
}

/**
 * 收集「可能被发声」的 sampleId（去重保序）：
 *  ① 各 Take 事件的自身 sampleId —— 一声源规则下预览/导出/舞台只认它；
 *     全局回退已删除，若这里不预热事件素材，装配音将永远解码不出来。
 *  ② 全局 keys[].sequence —— 保留给乐器包导入/舞台 KeyMachine 直演等
 *     仍引用键序列的路径（无害超集）。
 */
export function collectReferencedSampleIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const take of project.takes) {
    for (const ev of take.events) if (ev.sampleId) ids.add(ev.sampleId);
  }
  for (const k of project.keys) {
    for (const ref of k.sequence) if (ref.sampleId) ids.add(ref.sampleId);
  }
  return [...ids];
}

/**
 * 舞台/录制棚/导出语义：只预热会被发声引用到的素材。
 * （对应原 StudioPage.prewarmKeyBuffers / ExportDialog.prewarmBuffers）
 */
export function prewarmProjectBuffers(
  project: Project,
  opts: PrewarmOptions = {},
): Promise<string[]> {
  return prewarmBuffers(collectReferencedSampleIds(project), opts);
}

/** 素材箱批量语义：预热项目全部素材；逐音装配试听不要调用此函数。 */
export function prewarmAllSampleBuffers(
  opts: PrewarmOptions = {},
): Promise<string[]> {
  return prewarmBuffers(
    useStore.getState().project.samples.map((s) => s.id),
    opts,
  );
}

// ---------------------------------------------------------------------------
// 变换预热 —— 解码预热的下一步
// ---------------------------------------------------------------------------

/**
 * 让出主线程一个宏任务。
 *
 * 预热每条之间都要让一次：变换是**同步**跑在主线程上的（`transformBuffer`），
 * 一条就可能几十到几百毫秒。不让出的话，预热会变成一段不可中断的假死，
 * 首屏渲染、渐变、预热指示灯全都停住。
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface TransformPrewarmReport {
  /** 成功预热（进缓存）的组合数 */
  warmed: number;
  /** 跳过：素材未解码 / 恒等变换 / 单条太大 / PSOLA 对该素材无效 / 超出时间预算 */
  skipped: number;
  /** 去重后的 (素材, 音高, 时长) 组合总数 */
  total: number;
  /** 是否因为时间预算耗尽而提前收工 */
  timedOut: boolean;
}

/**
 * 预热**当前键位映射会用到的变换结果**。
 *
 * ── 为什么必须有这一段 ──
 *
 * `prewarmBuffers` 只是把 mp3 解码成 `AudioBuffer`；真正贵的下一步是
 * `transformBuffer`（整段 PSOLA 变调），它是**同步跑在主线程**上的。
 * 键位映射下**每个键一个独立音高**，于是「按下一个从没按过的键」
 * 就等于「主线程冻结一次整段变换」。
 *
 * 实测（0.45s 素材 / 立体声 / 同一进程内 A/B）：单次变换改前约 300ms。
 * 也就是说弹 12 个键 = 3.6 秒的累计冻结，而这些冻结全部落在**用户正在弹**的时刻。
 * 预热把它们挪到「用户还没开始弹」的那几秒里 —— 弹奏期间的变换成本归零。
 *
 * ── 为什么只预热 mode 1 ──
 *
 * `playSample` 的默认降级链是 `[1, 2]`（PSOLA 优先，静默空转才退 SOLA）。
 * 预热同样先试 mode 1：命中的话弹奏时第一次就命中；
 * 抛异常（`PsolaSilentNoopError`）就不预热，交给弹奏时的降级链去试 mode 2
 * —— 那是少数素材（实测 13/41），不值得在这里复刻第二套选择逻辑。
 * ⛔ 预热**不许自己挑引擎**：`playSample` 首选哪个 mode，这里就预热哪个，
 * 否则预热出来的 key 与播放时请求的 key 对不上 —— 白预热，而且从外面完全看不出来。
 *
 * ── 为什么跳过「太大的」──
 *
 * 变换结果缓存的额度是**字节**（`RUSH_CACHE_BUDGET_BYTES` / 每源素材）。
 * 单条就接近额度的素材（3 分钟人声约 66MB）算出来也会立刻被淘汰，预热纯属浪费，
 * 还得白付一次整段变换的时间。判据用「额度的一半」，保证预热出来的东西至少留得住。
 */
export async function prewarmKeyTransforms(
  keys: ReadonlyArray<Key>,
  opts: {
    onProgress?: (done: number, total: number) => void;
    /**
     * 预热总时间上限（ms）。
     *
     * 为什么要有：预热的全部收益都建立在「用户弹之前算完」上，而它的成本
     * 与键数、素材长度成正比 —— 61 键的工程可能要好几十秒。**没有上限**的话
     * 「预热」指示灯会一直亮着，用户只能等，比不预热还糟。
     * 超时就收工：已经算好的照样命中，没算到的那几个键退回「首次按会卡一下」，
     * 也就是回到预热之前的行为，不会有额外损失。
     */
    budgetMs?: number;
    /**
     * 取消检查：返回 true 就立刻收工。
     *
     * 预热是「趁用户还没开始弹」做的，而用户随时可能切走。
     * 没有这个口子的话，切页之后预热还会在主线程上把剩下的组合一条条算完
     * （每条几十到几百毫秒的同步阻塞）—— 于是「切到别的页面反而更卡」。
     */
    isCancelled?: () => boolean;
  } = {},
): Promise<TransformPrewarmReport> {
  const empty: TransformPrewarmReport = { warmed: 0, skipped: 0, total: 0, timedOut: false };

  /*
    ⛔ 这里**必须等** WASM，不能只看一眼 `isRushReady()` 就 return。

    两者返回的是同一个「空的报告」，而调用方（`useKeyMachineController` 的预热
    effect）拿它当「预热完成」直接把指示灯点亮。于是只要这次预热跑在 WASM
    加载完成之前，现场就是：

      · 指示灯写「音色已就绪」；
      · 实际**一条变换都没算**；
      · 用户照着「就绪」按下去，付的是第一轮冷变换（实机 12 键 = 12 条全部没算，
        补算一次 237ms，且头几个键的按下耗时 45~71ms，还伴随 77ms 的主线程长任务）。

    这不是理论风险：探针 `probe-play-perf.mjs` 的 S0 诊断每次都能复现。
    WASM 加载是**必然完成**的（`ensureRushLoaded` 幂等），等它一下就是了。
  */
  try {
    await ensureRushLoaded();
  } catch {
    // WASM 彻底不可用 → playSample 会走「原声保真退路」，没有可预热的东西。
    // 这个空报告是**真结论**，不是"还没开始"。
    return empty;
  }
  if (!isRushReady()) return empty;
  // 第三方引擎分支开启时 playSample 根本不走 wasm 缓存，预热会白做（见函数头）
  if (getActiveShift() !== null) return empty;

  const ctx = getAudioContext();
  const project = useStore.getState().project;

  const seen = new Set<string>();
  const jobs: Array<{ buffer: AudioBuffer; pitch: number; time: number }> = [];
  let skipped = 0;

  for (const key of keys) {
    for (const ref of key.sequence) {
      const buffer = getCachedBuffer(ref.sampleId);
      if (!buffer) {
        // 解码还没完成（或失败）—— 由 prewarmBuffers 的 missing 清单负责报出来
        skipped++;
        continue;
      }
      const voice = resolveSlotVoice(
        resolveSemitonesIn(project, ref.sampleId, ref.targetPitchMidi),
        ref,
      );
      const pitch = playbackRateForSemitones(voice.semitones);
      const time = voice.timeFactor;
      // 恒等变换：transformBuffer 开头直接返回源（不拷不缓存），预热它没有任何意义
      if (Math.abs(pitch - 1) < 1e-4 && Math.abs(time - 1) < 1e-4) continue;
      // 单条就占掉半个额度以上 → 算出来也留不住
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      if (bytes * 2 > RUSH_CACHE_BUDGET_BYTES) {
        skipped++;
        continue;
      }
      const dedup = `${ref.sampleId}|${pitch.toFixed(4)}|${time.toFixed(4)}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      jobs.push({ buffer, pitch, time });
    }
  }

  const deadline = performance.now() + (opts.budgetMs ?? 4000);
  let warmed = 0;
  let timedOut = false;
  for (let i = 0; i < jobs.length; i++) {
    if (opts.isCancelled?.()) {
      skipped += jobs.length - i;
      timedOut = true;
      break;
    }
    if (performance.now() > deadline) {
      // 超预算：剩下的原地退回「弹奏时首次再算」，不改变任何状态
      skipped += jobs.length - i;
      timedOut = true;
      break;
    }
    await yieldToMain();
    const j = jobs[i];
    try {
      transformBuffer(ctx, j.buffer, j.pitch, j.time, 1);
      warmed++;
    } catch {
      // 静默空转（这个素材没有可同步的周期）或变换失败 —— 都不是错误，
      // 弹奏时走的是同一条降级链。预热不替它做决定，也不改变任何状态。
      skipped++;
    }
    opts.onProgress?.(i + 1, jobs.length);
  }

  return { warmed, skipped, total: jobs.length, timedOut };
}
