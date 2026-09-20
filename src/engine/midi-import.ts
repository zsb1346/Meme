/**
 * MIDI 文件导入 IO 层。
 * 动态 import @tonejs/midi（~40KB），只在用户真的点「导入 MIDI」时才加载。
 */
import {
  createTakeFromMidiWithRange,
  type MidiImportOptions,
  type MidiRangeInfo,
} from '../model/midi-import';
import type { Take } from '../model/types';

/** 导入结果：Take + 音域分析（range 用于自动调整演奏台键数） */
export interface MidiImportOutcome {
  take: Take;
  range: MidiRangeInfo;
}

export async function importMidiFile(
  file: File,
  opts: MidiImportOptions,
): Promise<MidiImportOutcome> {
  const { Midi } = await import('@tonejs/midi');
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);

  const takeName = file.name.replace(/\.midi?$/i, '') || 'MIDI 导入';
  const result = createTakeFromMidiWithRange(midi, opts, takeName);
  if (!result) {
    /*
      报错要**带上诊断信息**，否则用户（和排查的人）无从下手。
      旧文案只写「没有可用音符」，而真实原因往往是下面三种之一：
        · 文件里一条音符都没有（纯控制数据 / 空工程）；
        · 所有音符都短于 minDurationSec（默认 0.05s）；
        · 音符数超过 maxNotes 被截断后仍为空（不可能，但列上以防变化）。
      把轨道数、音符总数、最短时长都报出来，一眼就能分辨。
    */
    const trackCount = midi.tracks.length;
    const totalNotes = midi.tracks.reduce((n, t) => n + t.notes.length, 0);
    const minDur = opts.minDurationSec ?? 0.05;
    /**
     * 意图：循环找最短音符时长，替代旧版 Math.min(...flatMap(...))。
     * 展开运算符有参数上限（JS 引擎约 ~60000），交响乐 MIDI 轻松超过
     * → RangeError 崩溃。循环写法无上限。
     */
    let shortest = Infinity;
    for (const t of midi.tracks) {
      for (const n of t.notes) {
        if (n.duration < shortest) shortest = n.duration;
      }
    }
    if (!Number.isFinite(shortest)) shortest = 0;
    throw new Error(
      totalNotes === 0
        ? `MIDI 文件里没有任何音符（共 ${trackCount} 条轨道）`
        : `MIDI 里 ${totalNotes} 个音符全部短于 ${minDur}s（最短 ${shortest.toFixed(3)}s），没有可用音符`,
    );
  }
  return result;
}