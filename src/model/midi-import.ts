/**
 * MIDI → TakeEvent 映射（纯函数，零 IO）。
 *
 * 设计：MIDI 导入产生的 TakeEvent[] 和手敲录制产生的完全一样，
 * 下游（卷帘、装配、导出）不需要知道来源。
 *
 * ══ 映射规则（2026-09-25 重做）══
 *
 * 键集恒为「从键域起点（新工程 = C3 = 48）起的**连续半音序列**」，
 * 所以映射是一步减法，没有折叠、没有锚点平移：
 *
 *     键下标 = MIDI 音号 − 键域起点音高
 *
 * 于是**音名与实际发声严格一致**：一个 G4 的音符落在标签写着 G4 的键上。
 *
 * ⚠️ 旧实现把锚点定死在 C4（键道 0 = C4），再用 `laneOffset = −minLane`
 * 把歌曲最低音平移到键 0。结果是一首音域 G4–D6 的曲子，G4 的音符会坐在
 * **标着 C3 的键**上（差 19 个半音）—— 卷帘左侧钢琴栏、键位标签、
 * 实际发声音高三者互相对不上，而且不报错。锚点平移这条设计已废弃。
 *
 * ⚠️ 超域音符**绝不折叠**。旧实现用 `% keyCount` 把超范围音符折回范围内，
 * 于是 C4 与 C5 会落到同一个键、整首歌撞成一团。现在如实分类统计
 * （低于起点 / 高于 C8），由调用方决定扩容或如实告知用户。
 *
 * ══ 这一版补上的东西（2026-09-25 第三轮：导入功能优化）══
 *
 * 旧实现的反馈只有一句笼统的「已导入 N 个音符」，而下列事实全部是**静默**的：
 *   · 短于阈值的音符被丢掉（不计数）；
 *   · 超过 maxNotes 的音符被截断（不计数）；
 *   · 文件里有多条轨、音符是从几条轨合并来的（不提）；
 *   · 有多少音符落在黑键上（不提 —— 而「半音键」开关默认是关的，
 *     等于导入完有一大批音在键盘上**没有可点的位置**）。
 *
 * 现在这些全部进 `MidiImportSummary`，UI 只负责如实展示。
 */

import type { Midi } from '@tonejs/midi';
import type { Take, TakeEvent } from './types';
import { isBlackMidi, KEY_BASE_MIDI, KEY_DOMAIN_MAX_COUNT, SEMITONES_PER_OCTAVE } from './pitch-map';
import { uid } from '../utils/uid';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认丢弃的极短音符阈值（秒）—— 低于它的多半是装饰性碎音 / 解析噪声 */
export const DEFAULT_MIN_DURATION_SEC = 0.05;
/** 默认音符数上限（防炸内存） */
export const DEFAULT_MAX_NOTES = 2000;
/** 单文件最少音域格数（低于此值一个八度都放不下） */
export const MIN_LANE_COUNT = SEMITONES_PER_OCTAVE;
/** 音域格数上限（= 键域格数 61，C3–C8） */
export const MAX_LANE_COUNT = KEY_DOMAIN_MAX_COUNT;

/** 键域上限音高（C8；高于它的音符键域装不下） */
const KEY_HI_MIDI = KEY_BASE_MIDI + KEY_DOMAIN_MAX_COUNT - 1;

// ---------------------------------------------------------------------------
// 音高 → 键下标
// ---------------------------------------------------------------------------

/**
 * MIDI 音号 → 键下标（**不做折叠**）。
 *
 * 负数 = 低于键域起点（这个音域放不下）；≥ 61 = 高于键域上限 C8。
 * 两种情况都只能丢弃，调用方用摘要里的 `belowRange` / `aboveRange` 如实告知。
 */
export function midiToKeyIndex(midi: number, baseMidi = KEY_BASE_MIDI): number {
  return Math.round(midi) - baseMidi;
}

/** 键域能否容纳这个音高 */
export function isMidiInDomain(midi: number, baseMidi = KEY_BASE_MIDI): boolean {
  const p = Math.round(midi);
  return p >= baseMidi && p <= Math.min(KEY_HI_MIDI, baseMidi + KEY_DOMAIN_MAX_COUNT - 1);
}

// ---------------------------------------------------------------------------
// 轨道体检（导入前的「这首歌长什么样」）
// ---------------------------------------------------------------------------

/** 单条轨道的体检结果 */
export interface MidiTrackInfo {
  /** 轨道路径下标（`midi.tracks[index]`） */
  index: number;
  /** 轨道名；文件里没写时回落成「轨道 N」 */
  name: string;
  /** 乐器名；读不到时为「未知乐器」 */
  instrument: string;
  /** 原始音符数（未过滤） */
  noteCount: number;
  /** 短于阈值、会被丢掉的音符数 */
  tooShort: number;
  /** 过滤后仍留下的音符数 */
  usable: number;
  /** 可用音符的最低音 / 最高音（无可用音符时 null） */
  minMidi: number | null;
  maxMidi: number | null;
  /** 可用音符里落在黑键上的个数 */
  blackKeyNotes: number;
}

/**
 * 给每条轨道做一次体检 —— 导入弹窗用它列轨道、也用它算「全选会得到什么」。
 *
 * ⚠️ 必须**逐轨**统计而不是只看合并结果：真实 MIDI 里
 * 「伴奏轨 / 打击轨 / 主旋律轨」混在一起很常见，用户需要能挑。
 * 项目里那份《这么可爱真是抱歉（调教用）.mid》就是典型：
 * track 0 是空轨、track 1 装了全部 244 个音符。
 */
export function analyzeMidiTracks(
  midi: Midi,
  minDurationSec: number = DEFAULT_MIN_DURATION_SEC,
): MidiTrackInfo[] {
  return midi.tracks.map((track, index) => {
    let noteCount = 0;
    let tooShort = 0;
    let minMidi: number | null = null;
    let maxMidi: number | null = null;
    let blackKeyNotes = 0;
    let usable = 0;
    for (const note of track.notes) {
      noteCount++;
      if (!(note.duration >= minDurationSec)) {
        /* `!(a >= b)` 而不是 `a < b`：duration 为 NaN / undefined 时也算丢弃，
           否则 NaN 会一路渗到映射里变成 NaN 键下标。 */
        tooShort++;
        continue;
      }
      usable++;
      const m = Math.round(note.midi);
      minMidi = minMidi === null ? m : Math.min(minMidi, m);
      maxMidi = maxMidi === null ? m : Math.max(maxMidi, m);
      if (isBlackMidi(m)) blackKeyNotes++;
    }
    return {
      index,
      name: track.name?.trim() || `轨道 ${index + 1}`,
      instrument: track.instrument?.name?.trim() || '未知乐器',
      noteCount,
      tooShort,
      usable,
      minMidi,
      maxMidi,
      blackKeyNotes,
    };
  });
}

// ---------------------------------------------------------------------------
// 音域
// ---------------------------------------------------------------------------

/**
 * 容纳到 `maxMidi` 需要多少格（按整八度向上补齐并夹到 12..61）。
 *
 * 按整八度补齐是为了让键盘**排出来永远是满行**（每行一个八度、7 个白键），
 * 而不是最后一行只剩孤零零两个键。返回值可直接丢给 `setKeyCount`。
 */
export function neededLanesFor(
  maxMidi: number,
  baseMidi: number = KEY_BASE_MIDI,
): number {
  const span = Math.round(maxMidi) - baseMidi + 1;
  const rounded = Math.ceil(Math.max(1, span) / SEMITONES_PER_OCTAVE) * SEMITONES_PER_OCTAVE;
  return Math.max(MIN_LANE_COUNT, Math.min(MAX_LANE_COUNT, rounded));
}

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

export interface MidiImportOptions {
  /** 当前音域**格数**（= 键集长度） */
  keyCount: number;
  /** 键域起点音高（默认 C3 = 48）。键集恒为该起点起的连续半音序列 */
  baseMidi?: number;
  /** 过滤极短音符（默认 0.05s） */
  minDurationSec?: number;
  /** 最大音符数（防炸内存，默认 2000） */
  maxNotes?: number;
  /**
   * 只取这些轨道（`midi.tracks` 的下标）。
   * 省略 / 空数组 = 全部轨道合并 —— 这是默认行为，因为大量 DAW 导出的
   * MIDI 会把主旋律放在非首轨，甚至首轨完全是空的。
   */
  trackIndices?: readonly number[];
}

/** 一次导入到底发生了什么 —— UI 只负责如实展示，不再自己猜 */
export interface MidiImportSummary {
  /** 文件里的轨道总数 */
  totalTracks: number;
  /** 真正参与合并的轨道数（`trackIndices` 的长度，或全部） */
  usedTracks: number;
  /** 参与合并的轨道里、被时长过滤前丢弃的碎音数 */
  tooShort: number;
  /** 低于键域起点（`baseMidi`）而丢弃的音符数 */
  belowRange: number;
  /** 高于键域上限（C8）而丢弃的音符数 */
  aboveRange: number;
  /** 超过 `maxNotes` 被截断的音符数 */
  truncated: number;
  /** 最终写进 Take 的触键事件数 */
  keptEvents: number;
  /** 其中落在黑键上的事件数（> 0 就必须让黑键可见） */
  blackKeyEvents: number;
  /** 全部可用音符的音域（截断前、含被丢弃的音） */
  minMidi: number;
  maxMidi: number;
  /** 歌曲总时长（秒，截断前） */
  durationSec: number;
  /** MIDI 原始 BPM */
  bpm: number;
  /** 装下最高音需要多少格（≥ 当前 `keyCount` 时应扩容） */
  neededLanes: number;
  /** 当前音域是否装得下全部保留的事件 */
  fits: boolean;
}

export interface MidiImportResult {
  events: TakeEvent[];
  summary: MidiImportSummary;
}

/** 空文件 / 全被过滤时的零值摘要（避免调用方到处判空） */
function emptySummary(opts: MidiImportOptions, totalTracks: number): MidiImportSummary {
  return {
    totalTracks,
    usedTracks: 0,
    tooShort: 0,
    belowRange: 0,
    aboveRange: 0,
    truncated: 0,
    keptEvents: 0,
    blackKeyEvents: 0,
    minMidi: 0,
    maxMidi: 0,
    durationSec: 0,
    bpm: 120,
    neededLanes: opts.keyCount,
    fits: true,
  };
}

export function midiToTakeEvents(midi: Midi, opts: MidiImportOptions): MidiImportResult {
  const minDur = opts.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
  const maxN = Math.max(1, opts.maxNotes ?? DEFAULT_MAX_NOTES);
  const baseMidi = opts.baseMidi ?? KEY_BASE_MIDI;
  const allTracks = midi.tracks;
  const bpm = midi.header.tempos[0]?.bpm ?? 120;

  /*
    轨道筛选：`trackIndices` 为空 = 全部。
    越界下标直接忽略（调用方拿到的下标来自 analyzeMidiTracks，正常不会越界）。
  */
  const picked =
    opts.trackIndices && opts.trackIndices.length > 0
      ? opts.trackIndices
          .filter((i) => Number.isInteger(i) && i >= 0 && i < allTracks.length)
          .map((i) => allTracks[i])
      : allTracks;

  if (picked.length === 0) {
    return { events: [], summary: emptySummary(opts, allTracks.length) };
  }

  /*
    ══ 必须合并**所有选中轨道**，不能只读 tracks[0] ══

    真实案例：`这么可爱真是抱歉（调教用）.mid` 有 2 条轨道 ——
      track 0 = 空轨（0 个音符），track 1 = 244 个音符。
    旧实现只读 `midi.tracks[0]`，于是判定「没有可用音符」拒绝导入。
    很多 DAW（尤其带「调教轨 / 伴奏轨」分轨的工程）导出的 MIDI
    都会把音符放在非首轨，甚至首轨完全是空的。
  */
  let tooShort = 0;
  const usable: Array<{ midi: number; time: number; duration: number; velocity: number }> = [];
  for (const track of picked) {
    for (const note of track.notes) {
      if (!(note.duration >= minDur)) {
        tooShort++;
        continue;
      }
      usable.push({
        midi: Math.round(note.midi),
        time: note.time,
        duration: note.duration,
        velocity: note.velocity,
      });
    }
  }

  if (usable.length === 0) {
    const s = emptySummary(opts, allTracks.length);
    s.usedTracks = picked.length;
    s.tooShort = tooShort;
    s.bpm = bpm;
    return { events: [], summary: s };
  }

  usable.sort((a, b) => a.time - b.time);

  /* 音域与时长按**截断前**的全量算 —— 用户问的是「这首歌需要多大音域」，
     而不是「被我截断后剩下的那段需要多大音域」。 */
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  let durationSec = 0;
  for (const n of usable) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
    const end = n.time + n.duration;
    if (end > durationSec) durationSec = end;
  }

  const kept = usable.length > maxN ? usable.slice(0, maxN) : usable;
  const truncated = usable.length - kept.length;

  const pressCounts = new Map<number, number>();
  const events: TakeEvent[] = [];
  let belowRange = 0;
  let aboveRange = 0;
  let blackKeyEvents = 0;

  for (const note of kept) {
    const keyIndex = midiToKeyIndex(note.midi, baseMidi);
    /*
      只丢弃「键域根本放不下」的音（低于起点，或高于域上限 C8）。
      高于**当前音域**但仍在域内的音**照常保留** —— 调用方会按
      `summary.neededLanes` 扩容，扩完它们就都落在键盘上了。
    */
    if (keyIndex < 0) {
      belowRange++;
      continue;
    }
    if (keyIndex >= KEY_DOMAIN_MAX_COUNT) {
      aboveRange++;
      continue;
    }
    if (isBlackMidi(note.midi)) blackKeyEvents++;
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

  const hiLimit = baseMidi + opts.keyCount - 1;
  const summary: MidiImportSummary = {
    totalTracks: allTracks.length,
    usedTracks: picked.length,
    tooShort,
    belowRange,
    aboveRange,
    truncated,
    keptEvents: events.length,
    blackKeyEvents,
    minMidi,
    maxMidi,
    durationSec,
    bpm,
    neededLanes: neededLanesFor(maxMidi, baseMidi),
    /* 「装得下」只对**真的写进去了**的音成立：被丢弃的音不算在内 */
    fits: belowRange === 0 && aboveRange === 0 && maxMidi <= hiLimit,
  };
  return { events, summary };
}

/** 带摘要的导入结果 */
export interface MidiTakeWithSummary {
  take: Take;
  summary: MidiImportSummary;
}

/**
 * MIDI → Take + 导入摘要。返回 `null` 表示没有任何可用音符。
 *
 * `Take` 结构不携带摘要（那会污染持久化数据），所以摘要走返回值给 UI 用一次。
 */
export function createTakeFromMidi(
  midi: Midi,
  opts: MidiImportOptions,
  name: string,
): MidiTakeWithSummary | null {
  const { events, summary } = midiToTakeEvents(midi, opts);
  if (events.length === 0) return null;

  const durationSec = events.reduce((m, e) => Math.max(m, e.tSec + (e.duration ?? 0)), 0);

  return {
    take: { id: uid(), name, events, durationSec, createdAtMs: Date.now() },
    summary,
  };
}
