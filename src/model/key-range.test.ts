/**
 * 键集模型的行为边界 —— 「后台铺好的连续半音序列」。
 *
 * ══ 这一版的核心不变量（2026-09-25 与用户第二次定稿）══
 *
 *   1. `project.keys` **恒为从键域起点起的连续半音序列**（第 i 键音高 = base + i）；
 *   2. 「半音键开关」是**纯视图状态** —— 不动键集、不动音域、不动音符；
 *   3. Take 事件与按键绑定是**按下标**存的，所以键集补全（下标重排）时
 *      必须跟着重映射 —— 漏掉这一步，老工程的音符会整体错位到隔壁键，
 *      而且看上去「音符都在、就是全跑调」。
 */
import { describe, expect, it } from 'vitest';
import {
  completeKeySet,
  createDefaultKeys,
  createDefaultProject,
  migrateProject,
  useStore,
} from './store';
import { KEY_BASE_MIDI, keyPitch, keyPitchAt, legacyPitchOfLane, midiNoteName } from './pitch-map';
import type { Key, Project } from './types';

/** 造一个初始工程并 hydrate，返回 hydrate 后的快照 */
function seed(patch: (p: Project) => void): Project {
  const p = createDefaultProject();
  patch(p);
  useStore.getState().hydrate(p, {});
  return useStore.getState().project;
}

/** 按给定音高造键（id 写下标，便于断言「同一个键」有没有被保留） */
const keysFromPitches = (pitches: number[]): Key[] =>
  pitches.map((p, i) => ({
    id: `k${i}`,
    label: midiNoteName(p),
    pitchMidi: p,
    sequence: [],
    cursor: 0,
  }));

/** C3 起 14 键自然音（C3 D3 E3 F3 G3 A3 B3 C4 D4 E4 F4 G4 A4 B4） */
const DIATONIC_14 = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71];
/** C4 起 14 键自然音（旧存档的锚点：lane 0 = C4 = 60） */
const LEGACY_C4_14 = Array.from({ length: 14 }, (_, i) => legacyPitchOfLane(i));

const pitchesNow = () => useStore.getState().project.keys.map((k) => k.pitchMidi);
const chromaticRun = (n: number, base = KEY_BASE_MIDI) =>
  Array.from({ length: n }, (_, i) => base + i);

describe('completeKeySet（把老键集补全成连续半音序列）', () => {
  it('中间的黑键被补齐，音域不变，老键按音高原样保留', () => {
    const old = keysFromPitches(DIATONIC_14);
    const { keys, indexRemap } = completeKeySet(old);

    expect(keys).toHaveLength(24); // 48..71
    expect(keys.map((k) => k.pitchMidi)).toEqual(chromaticRun(24));
    // ⭐ 音域严格不变：起点 C3、终点 B4，一个半音都没外扩
    expect(keys[0].pitchMidi).toBe(48);
    expect(keys[23].pitchMidi).toBe(71);

    // 老键按音高原地保留：id 跟着音高走，不是跟着下标走
    expect(keys[0].id).toBe('k0'); // 48 → C3
    expect(keys[2].id).toBe('k1'); // 50 → D3（原来的下标 1）
    expect(keys[23].id).toBe('k13'); // 71 → B4
    // 插入的黑键是新建的，装配为空
    expect(keys[1].pitchMidi).toBe(49);
    expect(keys[1].sequence).toEqual([]);

    // 下标重映射：老下标 3（F3 = 53）→ 新下标 5
    expect(indexRemap.get(3)).toBe(5);
    expect(keys[5].pitchMidi).toBe(53);
  });

  it('⭐ 幂等：已经是连续半音序列时不产生任何变化', () => {
    const once = completeKeySet(keysFromPitches(DIATONIC_14)).keys;
    const twice = completeKeySet(once).keys;
    expect(twice.map((k) => ({ id: k.id, pitch: k.pitchMidi }))).toEqual(
      once.map((k) => ({ id: k.id, pitch: k.pitchMidi })),
    );
    // 重映射退化为恒等
    const remap = completeKeySet(once).indexRemap;
    for (const [from, to] of remap) expect(to).toBe(from);
  });

  it('旧锚点（C4 起）的键集：补到域起点 C3，老键一个不丢', () => {
    const { keys } = completeKeySet(keysFromPitches(LEGACY_C4_14));
    expect(keys[0].pitchMidi).toBe(48); // 域起点仍是 C3
    expect(keys.map((k) => k.pitchMidi)).toEqual(chromaticRun(36)); // 48..83
    // 老键 C4(60) 落在新下标 12，装配随键走
    expect(keys[12].pitchMidi).toBe(60);
    expect(keys[12].id).toBe('k0');
  });

  it('空键集 → 默认音域（不返回空键盘）', () => {
    const { keys } = completeKeySet([]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.map((k) => k.pitchMidi)).toEqual(chromaticRun(keys.length));
  });
});

describe('migrateProject（老存档：补全键集 + 重映射下标）', () => {
  /** 老工程：14 键自然音 + 一个 Take + 一条按键绑定，全部**按下标**存 */
  function legacyProject(): Project {
    const p = createDefaultProject();
    p.schemaVersion = 1;
    p.settings.keyCount = 14;
    p.keys = keysFromPitches(DIATONIC_14);
    p.takes = [
      {
        id: 't1',
        name: 'T',
        durationSec: 1,
        createdAtMs: 0,
        events: [
          // 带 pitch 的（2026-09 之后录的都有）：F3
          { keyIndex: 3, pressCount: 1, tSec: 0, pitch: 53 },
          // 不带 pitch 的老事件：老下标 1（D3）
          { keyIndex: 1, pressCount: 2, tSec: 0.5 },
        ],
      },
    ];
    p.settings.keyBindings = { 3: 'a', 13: 'b' };
    return p;
  }

  it('⭐ Take 事件的 keyIndex 跟着音高重编号（漏掉这步整首歌会错位）', () => {
    const out = migrateProject(legacyProject())!;
    const [withPitch, withoutPitch] = out.takes[0].events;

    // F3 = 53 → 新下标 5
    expect(withPitch.keyIndex).toBe(5);
    expect(out.keys[withPitch.keyIndex].pitchMidi).toBe(53);
    // 老下标 1（D3 = 50）→ 新下标 2
    expect(withoutPitch.keyIndex).toBe(2);
    expect(out.keys[withoutPitch.keyIndex].pitchMidi).toBe(50);
  });

  it('按键绑定同样是按下标存的，一并搬', () => {
    const out = migrateProject(legacyProject())!;
    expect(out.settings.keyBindings).toEqual({ 5: 'a', 23: 'b' });
  });

  it('settings.keyCount 跟着键集长度走（否则 UI 读数与键盘不符）', () => {
    const out = migrateProject(legacyProject())!;
    expect(out.settings.keyCount).toBe(24);
    expect(out.keys).toHaveLength(24);
  });

  it('迁移是幂等的：跑两遍结果一致', () => {
    const once = migrateProject(legacyProject())!;
    const twice = migrateProject(structuredClone(once))!;
    expect(twice.keys.map((k) => k.pitchMidi)).toEqual(once.keys.map((k) => k.pitchMidi));
    expect(twice.takes[0].events.map((e) => e.keyIndex)).toEqual(
      once.takes[0].events.map((e) => e.keyIndex),
    );
    expect(twice.settings.keyBindings).toEqual(once.settings.keyBindings);
  });

  it('已迁移过的工程（store 内 hydrate）音符仍落在同一个音上', () => {
    const out = migrateProject(legacyProject())!;
    useStore.getState().hydrate(out, {});
    const now = useStore.getState().project;
    const ev = now.takes[0].events[0];
    expect(keyPitch(now.keys[ev.keyIndex], ev.keyIndex)).toBe(53);
  });
});

describe('setKeyCount（音域格数：只增删末尾，不动已有键的音高）', () => {
  it('扩张：新键音高 = 起点 + 下标，已有键一个都不动', () => {
    seed((p) => {
      p.settings.keyCount = 24;
      p.keys = createDefaultKeys(24);
    });
    useStore.getState().setKeyCount(36);
    expect(pitchesNow()).toEqual(chromaticRun(36));
  });

  it('收缩：截断末尾，幸存键音高不变', () => {
    seed((p) => {
      p.settings.keyCount = 24;
      p.keys = createDefaultKeys(24);
      p.keys[3].sequence = [{ sampleId: 's1' }];
    });
    useStore.getState().setKeyCount(12);
    expect(pitchesNow()).toEqual(chromaticRun(12));
    useStore.getState().setKeyCount(24);
    // 扩回来：下标 3 的键还在原位（键的身份是音高，但这里是同一格）
    expect(useStore.getState().project.keys[3].pitchMidi).toBe(51);
  });

  it('半音键**开着**时，「＋」逐半音推进（含黑键）', () => {
    seed((p) => {
      p.settings.semitoneModeEnabled = true;
      p.settings.keyCount = 12;
      p.keys = createDefaultKeys(12);
    });
    useStore.getState().setKeyCount(13);
    expect(pitchesNow()).toEqual(chromaticRun(13));
    expect(pitchesNow()[12]).toBe(60); // C4
  });

  it('⭐ 半音键**收起**时，「＋」自动跳过黑键（否则加了个看不见的键）', () => {
    seed((p) => {
      p.settings.semitoneModeEnabled = false;
      p.settings.keyCount = 12; // C3..B3
      p.keys = createDefaultKeys(12);
    });
    // 13 格里第 13 个是 C4（白键）→ 不该跳
    useStore.getState().setKeyCount(13);
    expect(useStore.getState().project.keys).toHaveLength(13);
    expect(pitchesNow()[12]).toBe(60); // C4

    // 再 +1 → 14 格里第 14 个是 C#4（黑键）→ 必须跳到 D4（62），span 变 15
    useStore.getState().setKeyCount(14);
    expect(useStore.getState().project.keys).toHaveLength(15);
    expect(pitchesNow()[14]).toBe(62); // D4
    expect(useStore.getState().project.settings.keyCount).toBe(15);
  });

  it('⭐ 收起时收缩同理：不会停在黑键上（点了没反应）', () => {
    seed((p) => {
      p.settings.semitoneModeEnabled = false;
      p.settings.keyCount = 14; // 48..61，第 14 格是 C#4（黑键）
      p.keys = createDefaultKeys(14);
    });
    useStore.getState().setKeyCount(13); // 会先落到 13 格（顶音 60 = C4，白键）
    expect(useStore.getState().project.keys).toHaveLength(13);
    expect(pitchesNow()[12]).toBe(60);
  });

  it('夹取在域内，且 keyCount 设置与键数组等长', () => {
    seed((p) => {
      p.settings.semitoneModeEnabled = true;
    });
    useStore.getState().setKeyCount(999);
    const st = useStore.getState().project;
    expect(st.keys).toHaveLength(61);
    expect(st.settings.keyCount).toBe(61);
    expect(st.keys[60].pitchMidi).toBe(108); // C8
  });

  it('⭐ 键集恒为连续半音序列（不变量）', () => {
    seed((p) => {
      p.settings.semitoneModeEnabled = true;
    });
    useStore.getState().setKeyCount(37);
    const ks = useStore.getState().project.keys;
    ks.forEach((k, i) => expect(k.pitchMidi).toBe(keyPitchAt(i)));
  });
});

describe('setSemitoneMode（纯视图开关）', () => {
  it('⭐ 开关不动键集：音高、长度、装配、音符全部原样', () => {
    seed((p) => {
      p.settings.keyCount = 24;
      p.keys = createDefaultKeys(24);
      p.keys[1].sequence = [{ sampleId: 's1' }]; // C#3 上装了东西
      p.takes = [
        {
          id: 't1',
          name: 'T',
          durationSec: 1,
          createdAtMs: 0,
          events: [{ keyIndex: 1, pressCount: 1, tSec: 0, pitch: 49 }],
        },
      ];
    });
    const before = structuredClone(useStore.getState().project);

    useStore.getState().setSemitoneMode(true);
    useStore.getState().setSemitoneMode(false);
    const after = useStore.getState().project;

    expect(after.keys).toEqual(before.keys);
    expect(after.keys[1].sequence).toEqual([{ sampleId: 's1' }]);
    expect(after.takes).toEqual(before.takes);
    expect(after.settings.keyCount).toBe(before.settings.keyCount);
  });
});
