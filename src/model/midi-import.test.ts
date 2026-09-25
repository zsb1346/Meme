/**
 * MIDI 导入映射与统计的单元测试（纯函数，零 IO）。
 *
 * 这里守的是几条**不许退化**的契约：
 *   ① 键下标 = 音号 − 键域起点（一步减法）—— 「音名 = 实际发声」的根；
 *   ② 超域音符**分门别类**统计，绝不折叠（折叠会把 C4 与 C5 撞到同一个键）；
 *   ③ 被丢弃的音符必须**每一类都有计数**，不能静默（旧版只数了一种）；
 *   ④ 轨道筛选 / 截断 / 时长过滤各自只影响自己那一档。
 */
import { describe, expect, it } from 'vitest';
import type { Midi } from '@tonejs/midi';
import {
  analyzeMidiTracks,
  createTakeFromMidi,
  midiToKeyIndex,
  midiToTakeEvents,
  neededLanesFor,
  DEFAULT_MAX_NOTES,
} from './midi-import';
import { KEY_BASE_MIDI, KEY_DOMAIN_MAX_COUNT, midiNoteName } from './pitch-map';

/** 音符简写：[音号, 起始秒, 时长秒] */
type NoteSpec = [number, number, number];
interface TrackSpec {
  name?: string;
  instrument?: string;
  notes: NoteSpec[];
}

/**
 * 造一个「长得像 Midi」的鸭子对象。
 *
 * ⚠️ 刻意不真的构造 @tonejs/midi 的 Midi：那需要编码一份二进制文件，
 * 测出来的是**解析器**的行为，不是**我们映射逻辑**的行为。
 * 模型层只读 tracks[].notes[] 与 header.tempos，鸭子类型足够且更快。
 */
function mkMidi(tracks: TrackSpec[], bpm = 120): Midi {
  return {
    header: { tempos: [{ bpm }] },
    tracks: tracks.map((t) => ({
      name: t.name ?? '',
      instrument: { name: t.instrument ?? '' },
      notes: t.notes.map(([midi, time, duration]) => ({
        midi,
        time,
        duration,
        velocity: 0.8,
      })),
    })),
  } as unknown as Midi;
}

/** 单轨、一堆音符的便捷构造 */
function mkSingle(notes: NoteSpec[], track?: Partial<TrackSpec>): Midi {
  return mkMidi([{ notes, ...track }]);
}

describe('midiToKeyIndex（一步减法）', () => {
  it('键下标 = 音号 − 键域起点', () => {
    expect(midiToKeyIndex(KEY_BASE_MIDI)).toBe(0);
    expect(midiToKeyIndex(60)).toBe(60 - 48); // C4 → 12
    expect(midiToKeyIndex(67)).toBe(67 - 48); // G4 → 19
  });

  it('域外**不折叠**：负数如实返回负数，不绕回高音区', () => {
    expect(midiToKeyIndex(40)).toBe(-8);
    expect(midiToKeyIndex(120)).toBeGreaterThan(KEY_DOMAIN_MAX_COUNT);
  });
});

describe('neededLanesFor（按整八度补齐）', () => {
  it('最高音 D6(86) 需要 4 个八度 = 48 格', () => {
    expect(neededLanesFor(86, 48)).toBe(48);
  });
  it('最高音刚好落在八度末（B5 = 83）→ 36 格', () => {
    expect(neededLanesFor(83, 48)).toBe(36);
  });
  it('最高音越界也不超过键域格数 61', () => {
    expect(neededLanesFor(127, 48)).toBe(KEY_DOMAIN_MAX_COUNT);
  });
  it('最低不低于 12（一个八度）', () => {
    expect(neededLanesFor(48, 48)).toBe(12);
  });
});

describe('analyzeMidiTracks（逐轨体检）', () => {
  it('空轨与有音符的轨分别如实报出', () => {
    const midi = mkMidi([
      { name: '', notes: [] },
      { name: 'Default', instrument: 'acoustic grand piano', notes: [[67, 0, 0.5], [69, 1, 0.5]] },
    ]);
    const tracks = analyzeMidiTracks(midi);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ index: 0, usable: 0, noteCount: 0, name: '轨道 1' });
    expect(tracks[1]).toMatchObject({
      index: 1,
      usable: 2,
      noteCount: 2,
      name: 'Default',
      instrument: 'acoustic grand piano',
      minMidi: 67,
      maxMidi: 69,
    });
  });

  it('黑键音符单独计数（G#4 = 68 是黑键，G4/A4 不是）', () => {
    const midi = mkSingle([[67, 0, 0.5], [68, 1, 0.5], [69, 2, 0.5]]);
    expect(analyzeMidiTracks(midi)[0].blackKeyNotes).toBe(1);
  });

  it('太短的音符计入 tooShort 且不计入 usable', () => {
    const midi = mkSingle([[67, 0, 0.5], [68, 1, 0.01]]);
    expect(analyzeMidiTracks(midi)[0]).toMatchObject({ noteCount: 2, usable: 1, tooShort: 1 });
  });
});

describe('midiToTakeEvents', () => {
  it('音名与实际发声一致：G4 落在下标 19 的键上', () => {
    const { events } = midiToTakeEvents(mkSingle([[67, 0, 0.5]]), { keyCount: 48 });
    expect(events).toHaveLength(1);
    expect(events[0].keyIndex).toBe(19);
    expect(events[0].pitch).toBe(67);
    /** 键域起点 + 键下标 = 原音号 —— 这条等式就是「不会跑调」的证明 */
    expect(KEY_BASE_MIDI + events[0].keyIndex).toBe(67);
  });

  it('多轨合并：首轨为空、音符在第二轨也能导入', () => {
    const midi = mkMidi([{ notes: [] }, { notes: [[67, 0, 0.5]] }]);
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(events).toHaveLength(1);
    expect(summary.usedTracks).toBe(2);
  });

  it('trackIndices 只取指定轨；空数组 = 全部', () => {
    const midi = mkMidi([
      { notes: [[60, 0, 0.5]] },
      { notes: [[72, 1, 0.5]] },
    ]);
    expect(midiToTakeEvents(midi, { keyCount: 48, trackIndices: [1] }).events).toHaveLength(1);
    expect(midiToTakeEvents(midi, { keyCount: 48, trackIndices: [1] }).events[0].pitch).toBe(72);
    expect(midiToTakeEvents(midi, { keyCount: 48, trackIndices: [] }).events).toHaveLength(2);
  });

  it('超域**分类**统计：低于起点与高于 C8 各算各的', () => {
    const midi = mkSingle([
      [40, 0, 0.5], // 低于 C3
      [41, 1, 0.5], // 低于 C3
      [60, 2, 0.5], // 正常
      [120, 3, 0.5], // 高于 C8
    ]);
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(summary.belowRange).toBe(2);
    expect(summary.aboveRange).toBe(1);
    expect(events).toHaveLength(1);
    /** 被丢弃的音**照常参与音域统计** —— 用户问的是「这首歌需要多大音域」 */
    expect(summary.minMidi).toBe(40);
    expect(summary.maxMidi).toBe(120);
  });

  it('太短的音符不漏计（旧版这里完全没有计数）', () => {
    const midi = mkSingle([[60, 0, 0.001], [62, 1, 0.5]]);
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(summary.tooShort).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('超过 maxNotes 的部分计入 truncated，且按时间顺序截取', () => {
    const notes: NoteSpec[] = Array.from({ length: 10 }, (_, i) => [60 + (i % 5), i * 0.1, 0.5]);
    const midi = mkSingle(notes);
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24, maxNotes: 4 });
    expect(summary.truncated).toBe(6);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.tSec)).toEqual([0, 0.1, 0.2, 0.30000000000000004]);
  });

  it('同一键上重复出现 → pressCount 递增（同键连击靠它区分）', () => {
    const midi = mkSingle([[60, 0, 0.2], [60, 1, 0.2], [60, 2, 0.2]]);
    const { events } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(events.map((e) => e.pressCount)).toEqual([1, 2, 3]);
  });

  it('黑键事件单独计数（G#4 → 下标 20，且当前音域装得下）', () => {
    const midi = mkSingle([[68, 0, 0.5]]); // G#4 → 下标 20
    const { summary } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(summary.blackKeyEvents).toBe(1);
    expect(summary.keptEvents).toBe(1);
    expect(summary.neededLanes).toBe(24);
    expect(summary.fits).toBe(true);
  });

  it('音域不够时 fits=false 且 neededLanes 给出扩容目标', () => {
    const midi = mkSingle([[86, 0, 0.5]]); // D6
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24 });
    /** 事件照常保留（仍在键域内），只是当前音域装不下 —— 由调用方扩容 */
    expect(events).toHaveLength(1);
    expect(summary.fits).toBe(false);
    expect(summary.neededLanes).toBe(48);
  });

  it('空文件不抛异常，返回零值摘要', () => {
    const { events, summary } = midiToTakeEvents(mkMidi([{ notes: [] }]), { keyCount: 24 });
    expect(events).toHaveLength(0);
    expect(summary.keptEvents).toBe(0);
    expect(summary.neededLanes).toBe(24);
  });

  it('全部音符都太短时返回空摘要（用于「没有可用音符」提示）', () => {
    const midi = mkSingle([[60, 0, 0.001], [64, 1, 0.001]]);
    const { events, summary } = midiToTakeEvents(midi, { keyCount: 24 });
    expect(events).toHaveLength(0);
    expect(summary.tooShort).toBe(2);
  });

  it('默认上限是 2000 个音', () => {
    expect(DEFAULT_MAX_NOTES).toBe(2000);
  });
});

describe('createTakeFromMidi', () => {
  it('产出 Take + 摘要；durationSec 取最后一个音的结束时刻', () => {
    const midi = mkSingle([[60, 0, 0.5], [62, 1, 0.25]]);
    const r = createTakeFromMidi(midi, { keyCount: 24 }, '测试曲');
    expect(r).not.toBeNull();
    expect(r!.take.name).toBe('测试曲');
    expect(r!.take.events).toHaveLength(2);
    expect(r!.take.durationSec).toBeCloseTo(1.25, 5);
    expect(r!.summary.keptEvents).toBe(2);
  });

  it('没有可用音符时返回 null', () => {
    expect(createTakeFromMidi(mkSingle([]), { keyCount: 24 }, 'x')).toBeNull();
  });
});

describe('真实素材的特征值（回归护栏）', () => {
  it('《这么可爱真是抱歉（调教用）》的音域 G4–D6 → 需要 48 格', () => {
    /* 该文件实测：244 音符 / 音域 67–86 / 48 个黑键音符 / 0.188s 起 */
    const notes: NoteSpec[] = [
      [67, 0, 0.188],
      [68, 0.5, 0.188],
      [86, 1, 0.75],
    ];
    const { summary } = midiToTakeEvents(mkSingle(notes), { keyCount: 24 });
    expect(midiNoteName(summary.minMidi)).toBe('G4');
    expect(midiNoteName(summary.maxMidi)).toBe('D6');
    expect(summary.neededLanes).toBe(48);
    expect(summary.blackKeyEvents).toBe(1);
  });
});
