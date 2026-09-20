/**
 * MIDI → TakeEvent 映射（纯函数，零 IO）。
 *
 * 设计：MIDI 导入产生的 TakeEvent[] 和手敲录制产生的完全一样，
 * 下游（卷帘、装配、导出）不需要知道来源。
 */
import type { Midi } from '@tonejs/midi';
import type { Take, TakeEvent } from './types';
import { uid } from '../utils/uid';

// ---------------------------------------------------------------------------
// 音高 → 键下标映射
// ---------------------------------------------------------------------------

/** 白键音高类 → 键内下标（do re mi fa sol la si） */
const WHITE_CHROMA: Record<number, number> = {
  0: 0, // C → do
  2: 1, // D → re
  4: 2, // E → mi
  5: 3, // F → fa
  7: 4, // G → sol
  9: 5, // A → la
  11: 6, // B → si
};

/**
 * MIDI 音高 → 键下标。
 * - 黑键 → 落到下方白键（唱名直觉）
 * - 超高/超低 → 折叠到 keyCount 范围内
 * - C4 (MIDI 60) → 键 0 (do)
 */
export function midiNoteToKeyIndex(
  midi: number,
  keyCount: number,
  laneOffset = 0,
): number {
  const raw = midiNoteToRawLane(midi) + laneOffset;
  return ((raw % keyCount) + keyCount) % keyCount; // 折叠到键数范围内
}

/**
 * MIDI 音高 → **未折叠**的键道下标（可为负 / 超出范围）。
 *
 * 约定：**C4 (MIDI 60) = 键道 0 (do)**，每个八度 7 条键道。
 * 黑键落到下方白键（唱名直觉）。
 *
 * 为什么不直接返回折叠后的下标：折叠会把超范围的八度**叠回同一个键**
 * （C4 与 C5 都变成键道 0），音符一多就全撞在一起。
 * 正确的做法是先取原始下标，分析出 MIDI 的真实音域，
 * 再决定要多少条键道 —— 见 `analyzeMidiRange()`。
 */
export function midiNoteToRawLane(midi: number): number {
  const chroma = ((midi % 12) + 12) % 12;
  let inOctave = WHITE_CHROMA[chroma];
  if (inOctave === undefined) {
    // 黑键 → 落到下方白键
    inOctave = WHITE_CHROMA[(chroma - 1 + 12) % 12] ?? 0;
  }
  const baseOctave = 4; // C4 = MIDI 60 = 第 1 个八度
  const octave = Math.floor(midi / 12) - baseOctave;
  return octave * 7 + inOctave;
}

/** 单文件最多允许多少条键道（演奏台 UI 与 KeyLayout 的硬上限） */
export const MAX_LANE_COUNT = 28;
/** 单文件最少键道数（低于此值没有意义，一个八度都放不下） */
export const MIN_LANE_COUNT = 7;
/** 键道数向上取整的粒度：按整八度（7 的倍数）补齐，保持网格整齐 */
const LANE_GRANULARITY = 7;

/** MIDI 音域分析结果 */
export interface MidiRangeInfo {
  /** 最低音的原始键道下标（可为负） */
  minLane: number;
  /** 最高音的原始键道下标 */
  maxLane: number;
  /**
   * 键道锚点偏移 —— **解决「导入后音全错位」的关键**。
   *
   * 乐器锚点固定在 `C4 = 键道 0`，而 MIDI 的 do 未必从 C4 起。
   * 实测《这么可爱真是抱歉（调教用）》音域是 MIDI 67..86（G4..D6），
   * 比锚点高整整一个八度：若不平移，低音 G4/A4/B4 会被折回上八度
   * （落到键道 11/12/13），而中间 9/10 空着 —— 映射整体错位。
   *
   * `laneOffset = -minLane` 把最低音对齐到键道 0，相对音程关系不变。
   */
  laneOffset: number;
  /** 容纳整个音域所需的最少键道数（已按整八度补齐） */
  neededLanes: number;
  /** 当前设置的键道数够不够（不够就会被折叠 → 同键撞音） */
  fits: boolean;
  /**
   * **折叠撞音**：不同音高被折到同一键道的数量。
   *
   * 统计的是「不同音高」，不是「音符数 − 键道数」。
   * 后者等于同键连击（本工具的正常功能），拿它当撞音指标会得到
   * 232 这种巨大且无意义的数字 —— 我第一版就是这么写错的。
   */
  collisions: number;
}

/**
 * 分析 MIDI 的真实音域，算出「需要多少条键道才能不折叠」。
 *
 * 返回的 `neededLanes` 已按整八度（7 的倍数）向上取整并夹到
 * [MIN_LANE_COUNT, MAX_LANE_COUNT]，可直接作为演奏台键数使用。
 *
 * `collisions` = 折叠后落到同一键道的音符数 − 去重后的键道数，
 * 用来量化「折叠有多严重」：为 0 表示当前键数完全够用。
 */
export function analyzeMidiRange(
  midis: readonly number[],
  currentKeyCount: number,
): MidiRangeInfo {
  if (midis.length === 0) {
    return {
      minLane: 0,
      maxLane: 0,
      laneOffset: 0,
      neededLanes: currentKeyCount,
      fits: true,
      collisions: 0,
    };
  }
  let minLane = Infinity;
  let maxLane = -Infinity;
  for (const m of midis) {
    const lane = midiNoteToRawLane(m);
    if (lane < minLane) minLane = lane;
    if (lane > maxLane) maxLane = lane;
  }
  // 音域跨度 → 所需键道数；再按整八度补齐
  const span = maxLane - minLane + 1;
  const rounded = Math.ceil(span / LANE_GRANULARITY) * LANE_GRANULARITY;
  const neededLanes = Math.max(MIN_LANE_COUNT, Math.min(MAX_LANE_COUNT, rounded));

  // 把最低音对齐到键道 0（见 laneOffset 的说明）
  const laneOffset = -minLane;

  /*
    撞音统计：**不同音高落到同一键道**的数量。
    必须在「加了 laneOffset、且按最终键数折叠」之后统计，
    否则测不到真实的碰撞。
  */
  const laneToPitch = new Map<number, number>();
  let collisions = 0;
  for (const m of midis) {
    const lane = midiNoteToKeyIndex(m, currentKeyCount, laneOffset);
    const prev = laneToPitch.get(lane);
    if (prev === undefined) laneToPitch.set(lane, m);
    else if (prev !== m) collisions++;
  }

  return {
    minLane,
    maxLane,
    laneOffset,
    neededLanes,
    // 「够用」判定用**原始音域跨度**：折叠后的下标永远落在范围内，看不出问题
    fits: span <= currentKeyCount,
    collisions,
  };
}

// ---------------------------------------------------------------------------
// 核心转换
// ---------------------------------------------------------------------------

export interface MidiImportOptions {
  keyCount: number;
  /** 过滤极短音符（默认 0.05s） */
  minDurationSec?: number;
  /** 最大音符数（防炸内存，默认 2000） */
  maxNotes?: number;
}

export interface MidiImportResult {
  events: TakeEvent[];
  /** 被跳过的音符数 */
  skipped: number;
  /** MIDI 原始 BPM */
  bpm: number;
  /** 音域分析：用于导入后自动调整演奏台键数（见 analyzeMidiRange） */
  range: MidiRangeInfo;
}

export function midiToTakeEvents(
  midi: Midi,
  opts: MidiImportOptions,
): MidiImportResult {
  const minDur = opts.minDurationSec ?? 0.05;
  const maxN = opts.maxNotes ?? 2000;

  /*
    ══ 必须合并**所有轨道**，不能只读 tracks[0] ══

    真实案例：`这么可爱真是抱歉（调教用）.mid` 有 2 条轨道 ——
      track 0 = 空轨（0 个音符），track 1 = 244 个音符。
    旧实现只读 `midi.tracks[0]`，于是判定「没有可用音符」拒绝导入。
    很多 DAW（尤其带「调教轨 / 伴奏轨」分轨的工程）导出的 MIDI
    都会把音符放在非首轨，甚至首轨完全是空的。

    合并策略：
      · 收集全部轨道里 duration ≥ minDur 的音符；
      · 统一按 time 排序后截取前 maxNotes 个。
    多轨同时发声时会变成「同一时刻多个音」——这正是本工具要的效果
    （每个音各自映射到键道，用 pressCount 区分同键连击）。
  */
  const allNotes = midi.tracks.flatMap((track) => track.notes);
  if (allNotes.length === 0) {
    return {
      events: [],
      skipped: 0,
      bpm: midi.header.tempos[0]?.bpm ?? 120,
      range: analyzeMidiRange([], opts.keyCount),
    };
  }

  const sorted = allNotes
    .filter((n) => n.duration >= minDur)
    .sort((a, b) => a.time - b.time)
    .slice(0, maxN);

  /*
    先算音域并拿到 laneOffset —— **必须在建事件之前**。
    乐器锚点固定在 C4 = 键道 0，而 MIDI 的 do 未必从 C4 起；
    不平移的话低音会被折回上八度，整首歌错位（实测差一个八度）。
  */
  const range = analyzeMidiRange(
    sorted.map((n) => n.midi),
    opts.keyCount,
  );

  const pressCounts = new Map<number, number>();
  const events: TakeEvent[] = [];
  let skipped = 0;

  for (const note of sorted) {
    const keyIndex = midiNoteToKeyIndex(note.midi, opts.keyCount, range.laneOffset);
    if (keyIndex < 0 || keyIndex >= opts.keyCount) {
      skipped++;
      continue;
    }
    const count = (pressCounts.get(keyIndex) ?? 0) + 1;
    pressCounts.set(keyIndex, count);
    events.push({
      keyIndex,
      pressCount: count,
      tSec: note.time,
      pitch: note.midi,
      duration: note.duration,
      velocity: note.velocity,
    });
  }

  return {
    events,
    skipped,
    bpm: midi.header.tempos[0]?.bpm ?? 120,
    range,
  };
}

/**
 * MIDI → Take。返回 `null` 表示没有任何可用音符。
 *
 * 需要音域信息（用于自动调整键数）的调用方请改用
 * `createTakeFromMidiWithRange` —— `Take` 结构不携带 `range`，
 * 硬塞进去会污染持久化数据。
 */
export function createTakeFromMidi(
  midi: Midi,
  opts: MidiImportOptions,
  name: string,
): Take | null {
  return createTakeFromMidiWithRange(midi, opts, name)?.take ?? null;
}

/** 带音域分析的导入结果 */
export interface MidiTakeWithRange {
  take: Take;
  range: MidiRangeInfo;
}

/** MIDI → Take + 音域分析（UI 用它来决定是否需要调大键数） */
export function createTakeFromMidiWithRange(
  midi: Midi,
  opts: MidiImportOptions,
  name: string,
): MidiTakeWithRange | null {
  const { events, range } = midiToTakeEvents(midi, opts);
  if (events.length === 0) return null;

  const durationSec = events.reduce(
    (m, e) => Math.max(m, e.tSec + (e.duration ?? 0)),
    0,
  );

  return {
    take: { id: uid(), name, events, durationSec, createdAtMs: Date.now() },
    range,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   键道 ↔ 唱名 / 音名 —— UI 展示用（与卷帘键盘栏同源）
   ═══════════════════════════════════════════════════════════════════ */

/** 首调唱名（大音阶七音） */
export const SOLFEGE_NAMES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;
/** 十二平均律音名 */
export const PITCH_CLASS_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

/**
 * **已加 laneOffset 的**键道下标 → 唱名。
 *
 * 装配面板用它显示「这一个音在卷帘的哪一行」。
 * 必须与 `midiNoteToKeyIndex(midi, keyCount, laneOffset)` 的结果一致，
 * 否则面板显示的唱名会和卷帘键盘栏对不上。
 */
export function laneToSolfege(lane: number): string {
  const l = Math.max(0, Math.round(lane));
  return SOLFEGE_NAMES[l % 7] + '′'.repeat(Math.floor(l / 7));
}

/** 键道所属的八度组序号（0 起；7 行一组） */
export function laneToOctaveGroup(lane: number): number {
  return Math.floor(Math.max(0, Math.round(lane)) / 7);
}

/** MIDI 音高 → 音名（60 → "C4"；A4 = 69） */
export function midiToNoteName(midi: number): string {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  return `${PITCH_CLASS_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}