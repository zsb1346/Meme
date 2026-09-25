/**
 * MIDI 文件导入 IO 层。
 *
 * 动态 import @tonejs/midi（~40KB），只在用户真的点「导入 MIDI」时才加载。
 *
 * ══ 为什么拆成「解析」与「构建」两段（2026-09-25）══
 *
 * 旧 API 是一步到底的 `importMidiFile(file) → Take`，调用方拿到结果时
 * Take 已经写进工程了 —— 于是「导入前先告诉用户这首歌长什么样」
 * （几条轨、多少音、音域多宽、有多少黑键、会丢几个音）在结构上做不到。
 *
 * 现在拆开：
 *   · `parseMidiFile` —— 读文件 + 逐轨体检，**不碰工程状态**；
 *   · `buildMidiTake` —— 用户确认后才真正生成 Take。
 *
 * `Midi` 实例只在这一层出现，模型层（`src/model/midi-import.ts`）保持纯函数、
 * 零依赖，测试里可以用鸭子类型直接喂假数据。
 */
import type { Midi } from '@tonejs/midi';
import {
  analyzeMidiTracks,
  createTakeFromMidi,
  DEFAULT_MIN_DURATION_SEC,
  type MidiImportOptions,
  type MidiImportSummary,
  type MidiTakeWithSummary,
  type MidiTrackInfo,
} from '../model/midi-import';

/** 解析结果 —— 供导入弹窗预览 */
export interface ParsedMidiFile {
  /** 解析出的 MIDI 对象（弹窗确认后交给 buildMidiTake 复用，不重新读文件） */
  midi: Midi;
  /** 建议的片段名（文件名去掉扩展名） */
  takeName: string;
  /** 逐轨体检结果 */
  tracks: MidiTrackInfo[];
  /** 建议默认勾选的轨道：有可用音符的那些 */
  defaultTrackIndices: number[];
}

/**
 * 读文件 → 解析 → 逐轨体检。**不修改任何工程状态**。
 *
 * 抛出的错误带足诊断信息：真实原因往往是下面三种之一，而旧文案只写
 * 「没有可用音符」，用户和排查的人都无从下手 ——
 *   · 文件里一条音符都没有（纯控制数据 / 空工程）；
 *   · 所有音符都短于 minDurationSec；
 *   · 文件根本不是 MIDI（解析器会抛自己的错，原样透出）。
 */
export async function parseMidiFile(
  file: File,
  opts: { minDurationSec?: number } = {},
): Promise<ParsedMidiFile> {
  const minDur = opts.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
  const { Midi: MidiCtor } = await import('@tonejs/midi');
  const arrayBuffer = await file.arrayBuffer();
  const midi = new MidiCtor(arrayBuffer);

  const tracks = analyzeMidiTracks(midi, minDur);
  const takeName = file.name.replace(/\.midi?$/i, '') || 'MIDI 导入';

  const totalNotes = tracks.reduce((n, t) => n + t.noteCount, 0);
  if (totalNotes === 0) {
    throw new Error(
      `MIDI 文件里没有任何音符（共 ${tracks.length} 条轨道）—— 请确认导出时勾选了音符轨`,
    );
  }

  const defaultTrackIndices = tracks.filter((t) => t.usable > 0).map((t) => t.index);
  if (defaultTrackIndices.length === 0) {
    /*
      意图：循环找最短音符时长，替代 `Math.min(...flatMap(...))`。
      展开运算符有参数上限（JS 引擎约 ~60000），交响乐 MIDI 轻松超过
      → RangeError 崩溃。循环写法无上限。
    */
    let shortest = Infinity;
    for (const t of midi.tracks) {
      for (const n of t.notes) {
        if (n.duration < shortest) shortest = n.duration;
      }
    }
    if (!Number.isFinite(shortest)) shortest = 0;
    throw new Error(
      `MIDI 里 ${totalNotes} 个音符全部短于 ${minDur}s（最短 ${shortest.toFixed(3)}s），没有可用音符`,
    );
  }

  return { midi, takeName, tracks, defaultTrackIndices };
}

/** 导入结果：Take + 摘要（摘要用于如实告知用户发生了什么） */
export interface MidiImportOutcome {
  take: MidiTakeWithSummary['take'];
  summary: MidiImportSummary;
}

/**
 * 用户确认后，把解析结果真正变成 Take。
 *
 * 没有任何可用音符时抛错（正常流程下 `parseMidiFile` 已经拦过一道，
 * 这里是为了「用户把所有能用的轨都取消勾选」这条路径）。
 */
export function buildMidiTake(parsed: ParsedMidiFile, opts: MidiImportOptions): MidiImportOutcome {
  const result = createTakeFromMidi(parsed.midi, opts, parsed.takeName);
  if (!result) {
    throw new Error('所选轨道里没有可用音符 —— 请至少勾选一条有音符的轨道');
  }
  return result;
}
