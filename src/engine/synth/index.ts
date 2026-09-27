/**
 * 合成声部的**对外唯一入口**。
 *
 * 这一层负责三件事，别的一律不做：
 *
 *   ① **单例与生命周期**：引擎懒建、常驻复用（反复建图会有爆音，也会让
 *      Convolver 反复重算 IR）。只在上下文被换掉时重建。
 *
 *   ② **patch 的权威副本**：`currentPatch` 是「当前音色」在引擎侧的记忆。
 *      模块级持有而不是塞进引擎，是为了让 `setSynthPatch` 在**音频上下文
 *      还不存在**时也能工作 —— 存档 hydrate 就发生在那个时刻，
 *      而 hydrate 绝不该顺手把一个 AudioContext 建出来。
 *
 *   ③ **稳定、不会传错参数的函数签名**。这里刻意用「MIDI 音号 + 具名选项」，
 *      不用位置参数：旧实现是 `triggerSynthNoteAt(keyIndex, whenCtxSec, pitchMidi?)`，
 *      于是 `StudioPage` 里写出了 `triggerSynthNoteAt(pitchMidi, currentTime)` ——
 *      一个 MIDI 音号被当成键下标，经 `keyPitchAt(48)` 推出 `96`，
 *      按下 C3 听到的是 C7（**高了 4 个八度**）。参数位置相近、类型都是
 *      `number`，编译器一声不吭。改成具名选项后这个错误**写不出来**。
 *
 * 与导出无关：本声部只服务试听与按键反馈，不进离线渲染、不进导出。
 */

import { getAudioContext } from '../core';
import { SynthEngine, type SynthChannel, type SynthNoteOptions } from './engine';
import {
  DEFAULT_SYNTH_PATCH,
  MACRO_NAMES,
  applyMacroToPatch,
  isMacroName,
  sanitizeSynthParamValue,
  sanitizeSynthPatch,
  type MacroName,
  type SynthPatch,
} from './patch';

export type { SynthChannel, SynthNoteOptions };
export { SynthEngine } from './engine';
export * from './patch';

let engine: SynthEngine | null = null;
let currentPatch: SynthPatch = { ...DEFAULT_SYNTH_PATCH };

/**
 * 宏的**基准**：四个宏都在 0 位时的那份 patch。
 *
 * ⛔ 宏必须是「相对基准的偏移」，不能是「绝对赋值」——否则每款预设里辛苦调好的
 * `filterCutoff` / `unison` 会被宏旋钮一律抹平（原型在 `macroThick` 上真栽过：
 * 映射函数忽略基准，于是「厚度 = 0」反而把 Unison 打回 1，全部超锯变单声部）。
 *
 * 生命周期刻意做成**自清理**的，避免它随存档来回传播：
 *   · 任一宏从 0 被抬起来 → 捕获一次（此后连续拖动都从同一基准算，不会自己叠加）；
 *   · 四个宏全部回到 0 → 丢弃。此时被联动的参数已经被还原成基准值，
 *     所以下次抬起来重新捕获拿到的就是同一个基准。
 * 唯一需要外力干预的是「整份换 patch」（预设 / 重置 / 存档 hydrate）——
 * 那走 `loadSynthPatch`，它无条件清掉基准。
 */
let macroBase: SynthPatch | null = null;

function allMacrosZero(p: SynthPatch): boolean {
  return MACRO_NAMES.every((k) => !(Number(p[k]) > 0));
}

/** 取（必要时创建）引擎。上下文被换掉时重建，保证节点与时钟同源。 */
function ensureEngine(): SynthEngine {
  const ctx = getAudioContext();
  if (!engine || engine.ctx !== ctx) {
    engine?.dispose();
    engine = new SynthEngine(ctx, currentPatch);
  }
  return engine;
}

/**
 * 响一个音。
 *
 * @param midi MIDI 音号（60 = C4）。**传音高，不传键下标** —— 键下标 → 音高
 *             的换算属于 `model/pitch-map`，不在这一层做第二次。
 * @param opts 起音时刻 / 时长 / 力度 / 通道，全部具名。
 */
export function playSynthNote(midi: number, opts?: SynthNoteOptions): void {
  if (!Number.isFinite(midi)) return;
  ensureEngine().noteOn(midi, opts);
}

/** 全部停止（试听停止 / 切换页面 / 录制中止时调用） */
export function releaseAllSynthNotes(): void {
  engine?.releaseAll();
}

/**
 * 松开**某一个**音（电脑键盘弹奏 / 左栏点键的「松手」）。
 *
 * 为什么不复用 `releaseAllSynthNotes`：那是旋律乐器，按下的和弦要能分次
 * 松手；而给 `playSynthNote` 一个长 `durationSec` 也只是「到点自动收」，
 * 与「手放开就停」是两回事。
 *
 * 引擎不存在 = 从来没发过声 → 直接返回：绝不为了一次松手去建 AudioContext。
 */
export function releaseSynthNote(midi: number, fast = true): void {
  if (!Number.isFinite(midi)) return;
  engine?.noteOff(midi, fast);
}

/** 通道静音：录制跟弹参考声的开关不该连坐试听声 */
export function setSynthChannelMuted(channel: SynthChannel, muted: boolean): void {
  engine?.setChannelMuted(channel, muted);
}

/**
 * 整体套用音色（预设 / 存档 hydrate / 面板「重置」之外的一切批量写入）。
 * **不建上下文**：音频还没起来时只更新记忆，等第一次发声时再一起进引擎。
 *
 * ⚠️ **不重置宏基准**。这条路径同时被「面板的 120ms 尾随落库」复用，
 * 而落库写入的 patch 里已经带着宏联动出来的值 —— 在这里重置基准，下一次
 * 拖宏就会以「已经被宏改过的值」为新基准，**指数式漂移**。
 * 整份换 patch 请走 `loadSynthPatch`。
 */
export function setSynthPatch(patch: unknown): void {
  currentPatch = sanitizeSynthPatch(patch);
  engine?.setPatch(currentPatch);
}

/**
 * **整份装载**音色（切换预设 / 重置 / 存档 hydrate）。
 *
 * 与 `setSynthPatch` 的唯一区别：**清掉宏基准**。换了一整份 patch 之后，
 * 旧的基准（上一份 patch 里那些参数的值）已经没有意义，留着只会让
 * 第一次拖宏从一个不相干的基准出发。
 */
export function loadSynthPatch(patch: unknown): void {
  macroBase = null;
  setSynthPatch(patch);
}

/** 当前 patch 的一份拷贝（只读；面板读数 / 测试断言用） */
export function getSynthPatch(): SynthPatch {
  return { ...currentPatch };
}

/** 单参数写入（面板拖动）。同样不建上下文。 */
export function updateSynthParam(name: keyof SynthPatch, value: unknown): SynthPatch {
  const v = sanitizeSynthParamValue(name, value, currentPatch);

  if (isMacroName(String(name))) {
    if (macroBase === null) macroBase = { ...currentPatch };
    const derived = applyMacroToPatch(macroBase, name as MacroName, v as number);
    currentPatch = { ...currentPatch, [name]: v, ...derived } as SynthPatch;
    // 逐键推给引擎（**不能**走 `setPatch`：那条路会立刻重建混响 IR，
    // 而「空间」宏正在改 reverbSize，拖一次就是一帧几百 KB 的脉冲响应）
    engine?.applyParam(name, v);
    for (const k of Object.keys(derived) as Array<keyof SynthPatch>) {
      engine?.applyParam(k, derived[k]);
    }
    if (allMacrosZero(currentPatch)) macroBase = null;
    return { ...currentPatch };
  }

  if (currentPatch[name] === v) return { ...currentPatch };
  currentPatch = { ...currentPatch, [name]: v } as SynthPatch;
  // 手动拧过的参数成为新的基准分支：否则「先拧 cutoff、再动亮度宏」会把
  // cutoff 拽回动宏之前的那个值 —— 用户会觉得「我刚拧的被吃掉了」
  if (macroBase !== null && typeof v === 'number') {
    (macroBase as unknown as Record<string, unknown>)[name as string] = v;
  }
  engine?.applyParam(name, v);
  return { ...currentPatch };
}

/** 给可视化用的分析器；引擎尚未建立时返回 null（不为了画频谱去建一个上下文） */
export function getSynthAnalyser(): AnalyserNode | null {
  return engine?.getAnalyser() ?? null;
}

/** 面板打开时调用：确保引擎与频谱分析器就绪 */
export function ensureSynthReady(): AnalyserNode {
  return ensureEngine().getAnalyser();
}

/** 在响的声部数（探针断言用） */
export function getSynthActiveVoices(): number {
  return engine?.activeVoices ?? 0;
}

/**
 * 声部账目（探针断言用）。
 *
 * 不变式：**`created` 迟早等于 `disposed`** —— 差多少就是泄漏了多少个声部。
 * 这个口子存在的唯一理由见 `engine.ts` 的 `dying` 字段注释：声部泄漏
 * **不报错、不崩溃，只是越用越卡**，没有一个能读出账目的入口就抓不住它。
 */
export function getSynthVoiceStats(): {
  live: number;
  dying: number;
  created: number;
  disposed: number;
} {
  return engine?.voiceStats ?? { live: 0, dying: 0, created: 0, disposed: 0 };
}

/** 测试 / HMR：丢弃单例（不影响 Tone 链） */
export function disposeSynthForTest(): void {
  engine?.dispose();
  engine = null;
  currentPatch = { ...DEFAULT_SYNTH_PATCH };
  macroBase = null;
}
