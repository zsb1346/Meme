import { create } from 'zustand';
import type {
  EffectSettings,
  EqBand,
  EqSettings,
  FillItem,
  Key,
  PageId,
  Project,
  Sample,
  SampleId,
  SampleRef,
  Settings,
  Take,
  TakeEvent,
  TakeId,
} from './types';
import { uid } from '../utils/uid';
import { DEFAULT_REVERB_SETTINGS } from '../engine/effect-units/reverb-defaults';
import { cacheBuffer, decodeAudioBlobShared, dropCachedBuffer } from '../engine/sample-player';
import {
  KEY_BASE_MIDI,
  KEY_DOMAIN_MAX_COUNT,
  KEY_MAX_MIDI,
  isDiatonicMidi,
  keyPitch,
  keyPitchAt,
  legacyPitchOfLane,
  midiNoteName,
} from './pitch-map';

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/**
 * 效果链出厂默认值。
 *
 * EQ 段的「默认形态」刻意做成**近似旁路**：低切 20Hz / 低架 120Hz /
 * 峰值 1kHz / 高架 8kHz / 高切 20kHz，增益全 0。
 * 这样新工程开箱时 EQ 开启也不会改变音色 —— 只有用户主动拧才有声音变化，
 * 避免「默认值就染色」这种专业软件里最招骂的行为。
 */
export const DEFAULT_EFFECTS: EffectSettings = {
  eq: {
    enabled: true,
    bands: [
      { enabled: true, type: 'highpass', frequencyHz: 20, gainDb: 0, q: 0.71 },
      { enabled: true, type: 'lowshelf', frequencyHz: 120, gainDb: 0, q: 0.71 },
      { enabled: true, type: 'peaking', frequencyHz: 1000, gainDb: 0, q: 1 },
      { enabled: true, type: 'highshelf', frequencyHz: 8000, gainDb: 0, q: 0.71 },
      { enabled: true, type: 'lowpass', frequencyHz: 20000, gainDb: 0, q: 0.71 },
    ],
  },
  compressor: {
    enabled: true,
    thresholdDb: -18,
    ratio: 3,
    attackSec: 0.005,
    releaseSec: 0.18,
  },
  chorus: {
    enabled: false,
    rateHz: 1.6,
    delayTimeMs: 6,
    depth: 0.35,
    spreadDegrees: 120,
    wet: 0.35,
  },
  // 混响默认值来自引擎层唯一事实来源（引擎不 import model，故方向是 model → engine）
  reverb: { ...DEFAULT_REVERB_SETTINGS },
  masterGainDb: -3,
};

/**
 * 老存档迁移：把 3 段 EQ（`lowDb/midDb/highDb + 两个分频点`）转成多段 bands。
 *
 * 为什么必须迁移：`persistence.loadAll()` 原样返回存档、不做任何校验，
 * 直接换数据结构会让所有老工程在读取时崩（`effects.eq.bands` 为 undefined）。
 *
 * 映射策略 —— 尽量保留用户原本的听觉意图：
 *   · 旧 lowFrequencyHz  → 低架频率
 *   · 旧 highFrequencyHz → 高架频率
 *   · 三段增益按位置平移，Q 取 0.71（架子滤波的常用值）
 *   · 低切/高切用默认的 20Hz / 20kHz（旧实现没有这两个概念，等于不切）
 *
 * 纯函数、幂等：已是新结构时原样返回。
 */
function migrateEqFromLegacy(raw: unknown): EqSettings {
  const legacy = raw as Partial<{
    enabled: boolean;
    lowDb: number;
    midDb: number;
    highDb: number;
    lowFrequencyHz: number;
    highFrequencyHz: number;
    bands: unknown;
  }>;
  if (Array.isArray(legacy.bands)) {
    return { enabled: legacy.enabled ?? true, bands: legacy.bands as EqBand[] };
  }
  const lowF = Number.isFinite(legacy.lowFrequencyHz) ? legacy.lowFrequencyHz! : 120;
  const highF = Number.isFinite(legacy.highFrequencyHz) ? legacy.highFrequencyHz! : 8000;
  return {
    enabled: legacy.enabled ?? true,
    bands: [
      { enabled: true, type: 'highpass', frequencyHz: 20, gainDb: 0, q: 0.71 },
      { enabled: true, type: 'lowshelf', frequencyHz: lowF, gainDb: legacy.lowDb ?? 0, q: 0.71 },
      {
        enabled: true,
        type: 'peaking',
        // 中频段的中心取两个旧分频点的几何平均，与旧 EQ3 的 mid 行为一致
        frequencyHz: Math.sqrt(lowF * highF),
        gainDb: legacy.midDb ?? 0,
        q: 1,
      },
      { enabled: true, type: 'highshelf', frequencyHz: highF, gainDb: legacy.highDb ?? 0, q: 0.71 },
      { enabled: true, type: 'lowpass', frequencyHz: 20000, gainDb: 0, q: 0.71 },
    ],
  };
}

/**
 * 存档整体迁移入口（hydrate 时调用一次）。
 *
 * ══ 为什么必须逐级补默认值，而不是只处理 EQ ══
 *
 * 老存档里缺的字段一律是 `undefined`，而 `undefined` 会一路渗到两个地方：
 *
 *   1. **音频参数** —— `AudioParam.setTargetAtTime(undefined)` 抛
 *      `TypeError: The provided float value is non-finite`；
 *   2. **UI 读数** —— `undefined.toFixed()` 抛 TypeError。
 *
 * 这两类异常都发生在**渲染期**，于是整页被 React 卸载 —— 用户看到的就是
 * 「切换过去画面变黑」。真实案例：`reverb` 新增了 7 个字段（size /
 * damping / diffusion / early / lowCutHz / highCutHz / width），
 * 老存档没有这些键，切到混音台/演奏台/制作台立刻报上面两个错。
 *
 * 结论：**新增设置字段时，必须同时在这里补默认值**（或用展开默认值兜底）。
 * 这里的做法是「以 DEFAULT_EFFECTS 为底、用存档覆盖」——
 * 对任何未来新增的字段都自动生效，不需要每次改这个函数。
 */
export function migrateProject(raw: Project | null): Project | null {
  if (!raw) return null;
  const p = raw;

  /*
    settings 一律「默认值打底 + 存档覆盖」：新增字段（如 semitoneModeEnabled）
    在老存档里是 undefined，不补的话 UI 读到 undefined 会按 false 走 ——
    多数情况恰好等价，但「字段存在但为 undefined」与「字段不存在」在
    序列化回写时会分叉，统一在这里落地。
  */
  p.settings = {
    ...DEFAULT_SETTINGS,
    ...p.settings,
    keyBindings: p.settings?.keyBindings ?? {},
  };

  /*
    ══ 键迁移（2026-09-25 第二次定稿）══

    键集的语义从「用户一格格攒出来的键」升级为
    「**后台默认就铺好的连续半音序列**」（用户原话：「默认应该在后台上就
    加载好了那些半音按键，半音只是控制是否开启」）。

    于是迁移要做两件事：

    ① **补全音域**：老键集只铺了它用得着的那些音（自然音键集里没有黑键，
       老半音键集里也未必连续），这里按 [base, hi] 铺满**每一个半音格**，
       老键按 pitchMidi 原地保留（音高、装配、游标、自定义标签全不动）。

    ② **重映射下标**：键的身份没变，但**下标变了**（中间插进了黑键）。
       Take 事件与按键绑定都是**按下标**存的，必须跟着搬 ——
       漏掉这一步，老工程里所有的音符都会落到隔壁键上，
       而且看上去「音符都在、就是全跑调」，是最难查的那类事故。

    本函数**幂等**：键集已经是连续半音序列时，补全结果与原键集逐格相同、
    重映射是恒等映射，跑多少次都没有变化。
  */
  const normalized = (p.keys ?? []).map((k, i) => {
    const pitchMidi =
      typeof k.pitchMidi === 'number' && Number.isFinite(k.pitchMidi)
        ? k.pitchMidi
        : legacyPitchOfLane(i);
    // 标签换轨：仍是出厂默认唱名（do / do' / do″…）的改写为音名；
    // 用户自己改过的标签（不匹配出厂图案）原样保留。
    const label = LEGACY_DEFAULT_LABEL.test(k.label ?? '') ? midiNoteName(pitchMidi) : k.label;
    return { ...k, pitchMidi, label };
  });

  const { keys, indexRemap } = completeKeySet(normalized);
  p.keys = keys;
  p.settings.keyCount = keys.length;

  /*
    重映射 Take 事件。优先用事件自带的 `pitch`（绝对音高，与下标无关）——
    它从 2026-09 起就在写；没有时才回退到「老下标 → 新下标」映射。
  */
  p.takes = (p.takes ?? []).map((t) => ({
    ...t,
    events: (t.events ?? []).map((ev) => {
      // 新键集起点（补齐后 keys[0] 必定存在 —— 上面 completeKeySet 保证非空）
      const baseMidi = keys[0]?.pitchMidi;
      const byPitch =
        typeof ev.pitch === 'number' && Number.isFinite(ev.pitch) && baseMidi !== undefined
          ? Math.round(ev.pitch) - baseMidi
          : null;
      const next = byPitch ?? indexRemap.get(ev.keyIndex) ?? ev.keyIndex;
      return next === ev.keyIndex ? ev : { ...ev, keyIndex: next };
    }),
  }));

  /* 按键绑定同样是按下标存的，一并搬；指向已消失键的绑定直接丢弃 */
  const bindings: Record<number, string> = {};
  for (const [oldIdxRaw, keyName] of Object.entries(p.settings.keyBindings ?? {})) {
    const next = indexRemap.get(Number(oldIdxRaw));
    if (next !== undefined && next >= 0 && next < keys.length) bindings[next] = keyName;
  }
  p.settings.keyBindings = bindings;

  /*
    四级效果设置逐级「默认值打底 + 存档覆盖」。
    注意 EQ 的 bands 要单独走迁移（结构从 3 段扁平变成了多段数组），
    其余三级只是缺字段，浅合并即可。
  */
  const saved = (p.effects ?? {}) as Partial<EffectSettings>;
  p.effects = {
    ...structuredClone(DEFAULT_EFFECTS),
    ...saved,
    eq: saved.eq ? migrateEqFromLegacy(saved.eq) : structuredClone(DEFAULT_EFFECTS.eq),
    compressor: { ...DEFAULT_EFFECTS.compressor, ...(saved.compressor ?? {}) },
    chorus: { ...DEFAULT_EFFECTS.chorus, ...(saved.chorus ?? {}) },
    reverb: { ...DEFAULT_EFFECTS.reverb, ...(saved.reverb ?? {}) },
    masterGainDb:
      typeof saved.masterGainDb === 'number' && Number.isFinite(saved.masterGainDb)
        ? saved.masterGainDb
        : DEFAULT_EFFECTS.masterGainDb,
  };
  return p;
}

export const DEFAULT_SETTINGS: Settings = {
  pitchNormalizationEnabled: true,
  referencePitchHz: 261.6255653, // C4 = 261.63 Hz
  /*
    默认音域 = **2 个八度 = 24 个半音格**（C3–B4）。
    关掉半音键时键盘上恰好是 14 个白键 —— 与旧版默认观感逐键一致，零视觉回归；
    打开半音键就多出 10 个黑键，音域一点没变。
  */
  keyCount: 24,
  keyBindings: {},
  autoTuneEnabled: true,
  /** 半音键（黑键）是否显示 —— 纯视图开关，不参与键集/音域的任何计算 */
  semitoneModeEnabled: false,
};

/** 出厂默认标签图案（旧唱名制）：do / do' / do″…；迁移时仅改写匹配此图案的 */
const LEGACY_DEFAULT_LABEL = /^(?:do|re|mi|fa|sol|la|si)['′]*$/;

/**
 * 新建 count 个键：**连续半音序列**，从键域起点 C3 起一格一个半音。
 *
 * ⚠️ 这里**不再有「模式」参数**。旧实现按 `chromatic` 决定铺自然音还是半音，
 * 于是「关掉开关后已存在的黑键被当白键、挤掉别人的位置」。现在键集与开关
 * 彻底解耦：**默认就在后台上把半音键全部铺好**，开关只决定它们显不显示。
 */
export function createDefaultKeys(count: number): Key[] {
  const n = Math.max(1, Math.min(KEY_DOMAIN_MAX_COUNT, Math.round(count)));
  return Array.from({ length: n }, (_, i) => {
    const pitchMidi = keyPitchAt(i);
    return { id: uid(), label: midiNoteName(pitchMidi), pitchMidi, sequence: [], cursor: 0 };
  });
}

/**
 * 把一个键集**补全成连续半音序列**（幂等）。
 *
 * 返回 `indexRemap`：老下标 → 新下标。**必须**用它把 Take 事件与按键绑定
 * 一起搬过去 —— 键的身份（pitchMidi）不变，但下标会因为中间插进黑键而改变。
 *
 * 音域范围 = `[min(KEY_BASE_MIDI, 最低音), 最高音]`，一格不缺。
 * 老键按音高原地保留（同音高的重复键只保留第一个）。
 */
export function completeKeySet(oldKeys: Key[]): {
  keys: Key[];
  indexRemap: Map<number, number>;
} {
  const indexRemap = new Map<number, number>();
  if (oldKeys.length === 0) {
    return { keys: createDefaultKeys(DEFAULT_SETTINGS.keyCount), indexRemap };
  }
  const pitches = oldKeys.map((k, i) => keyPitch(k, i));
  const base = Math.min(KEY_BASE_MIDI, ...pitches);
  const hi = Math.max(...pitches);
  const span = Math.max(1, hi - base + 1);

  const byPitch = new Map<number, Key>();
  oldKeys.forEach((k, i) => {
    const p = pitches[i];
    if (!byPitch.has(p)) byPitch.set(p, k);
    indexRemap.set(i, p - base);
  });

  const keys: Key[] = [];
  for (let i = 0; i < span; i++) {
    const p = base + i;
    const existing = byPitch.get(p);
    keys.push(
      existing
        ? { ...existing, pitchMidi: p }
        : { id: uid(), label: midiNoteName(p), pitchMidi: p, sequence: [], cursor: 0 },
    );
  }
  if (keys.length > KEY_DOMAIN_MAX_COUNT) keys.length = KEY_DOMAIN_MAX_COUNT;
  return { keys, indexRemap };
}

export function createEmptyTake(name: string): Take {
  return {
    id: uid(),
    name,
    events: [],
    durationSec: 0,
    createdAtMs: Date.now(),
  };
}

export function createDefaultProject(): Project {
  return {
    schemaVersion: 2,
    id: uid(),
    name: '未命名工程',
    samples: [],
    keys: createDefaultKeys(DEFAULT_SETTINGS.keyCount),
    takes: [],
    effects: structuredClone(DEFAULT_EFFECTS),
    settings: { ...DEFAULT_SETTINGS },
    updatedAtMs: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AddSampleResult {
  ok: boolean;
  sampleId?: SampleId;
  error?: string;
}

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------

interface AppState {
  /** 存档是否已从 IndexedDB 恢复完成（P2 页面在 true 前不要读 project 渲染关键 UI） */
  hydrated: boolean;
  activePage: PageId;
  /** 工程元数据（不含 Blob） */
  project: Project;
  /** 素材原始文件 Blob，键为 sampleId；与 IndexedDB audio 库同构 */
  blobs: Record<SampleId, Blob>;

  // —— 导航 / 水合 ——
  /** 切换主页面 */
  setActivePage(page: PageId): void;
  hydrate(project: Project | null, blobs: Record<SampleId, Blob>): void;

  // —— 工程 ——
  renameProject(name: string): void;

  // —— 素材箱 ——
  /** 上传素材：乐观插入 → 异步解码回填时长/音高；失败自动回滚。 */
  addSampleFromFile(file: Blob, name?: string): Promise<AddSampleResult>;
  removeSample(id: SampleId): void;
  updateSample(id: SampleId, patch: Partial<Omit<Sample, 'id'>>): void;
  /**
   * 撤销删除素材：原子恢复 元数据 + Blob + 持有该素材的键（Wave C 可撤销删除）。
   * index 为删除前在 samples 数组中的下标；keys 为删除前持其引用的整键快照。
   */
  restoreSample(args: {
    sample: Sample;
    blob: Blob | undefined;
    index: number;
    keys: Array<{ index: number; key: Key }>;
  }): void;

  // —— 全局设置 ——
  setPitchNormalization(enabled: boolean): void;
  setReferencePitchHz(hz: number): void;
  /**
   * 键数 = **音域格数**（半音格），1..61。键集恒为「起点起的连续半音序列」，
   * 所以本操作只是把序列伸长/截短，**不动任何幸存键的音高**。
   *
   * ⚠️ 半音键关闭时，扩张会**自动越过黑键**停在下一个白键上 ——
   * 否则「＋」会把音域扩到一个看不见的黑键上，用户点了半天毫无变化
   * （详见 `nextVisiblePitch`）。
   */
  setKeyCount(count: number): void;
  /** 半音键（黑键）显示开关 —— 纯视图状态，不改键集、不改音域、不改音符 */
  setSemitoneMode(enabled: boolean): void;
  setKeyBinding(keyIndex: number, key: string): void;
  clearKeyBinding(keyIndex: number): void;
  clearAllKeyBindings(): void;
  setAutoTuneEnabled(enabled: boolean): void;

  // —— 键序列（舞台编辑模式）——
  setKeyLabel(keyIndex: number, label: string): void;
  /** 整体替换某键的序列（编辑模式矩阵拖拽后提交） */
  setKeySequence(keyIndex: number, sampleIds: SampleId[]): void;
  /** 写入带装配参数的键序列；用于让舞台演奏复用卷帘装配结果。 */
  setKeySequenceRefs(keyIndex: number, refs: SampleRef[]): void;
  appendSampleToKey(keyIndex: number, sampleId: SampleId): void;
  removeKeySlot(keyIndex: number, slotIndex: number): void;
  resetKeyCursor(keyIndex: number): void;
  setKeyCursor(keyIndex: number, cursor: number): void;

  // —— 录制棚 ——
  addTake(take: Take, atIndex?: number): void;
  deleteTake(takeId: string): void;
  updateTakeEvents(takeId: string, events: TakeEvent[]): void;
  /** 重命名某次录制（Wave 1 新增，供录制棚/素材箱复用） */
  renameTake(takeId: TakeId, name: string): void;
  /** 清空 takes，落一个空的并作为唯一 take（导入乐器时用） */
  resetTakes(initial: Take): void;
  /** 整体替换演奏台素材与键位（导入乐器包时用） */
  replaceStage(input: { samples: Sample[]; keys: Key[]; blobs: Record<SampleId, Blob> }): void;

  // —— 填词（辅助计算，供 NotePalette/进度显示使用）——
  buildFillItems(takeId: string): FillItem[];

  // —— 混音台 ——
  /**
   * 通用效果器写入：把 patch 浅合并进 project.effects[id] 并 touch()。
   * 仅四级（eq/compressor/chorus/reverb）；主增益统一走 setMasterGainDb。
   */
  setEffect<K extends Exclude<keyof EffectSettings, 'masterGainDb'>>(
    id: K,
    patch: Partial<EffectSettings[K]>,
  ): void;
  setMasterGainDb(db: number): void;

  // —— 均衡器段级写入 ——
  /**
   * 精准写单段 EQ 的若干字段。
   *
   * 为什么不用 `setEffect('eq', {...})`：EQ 的参数是**嵌套**的
   * （5 段 × 4 字段），用扁平 patch 表达就得先读整份 bands、改一格、
   * 再整份写回 —— 调用方每次都要拼数组，滑杆拖动时尤其啰嗦且易错。
   * 这里收敛成「按段写字段」，调用方只关心自己那一段。
   */
  setEqBand(index: number, patch: Partial<EqBand>): void;
  /** 整体替换全部 EQ 段（复位 / 预设用） */
  setEqBands(bands: EqBand[]): void;
}

function touch(project: Project): Project {
  return { ...project, updatedAtMs: Date.now() };
}

function omitRecord<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rec };
  delete next[key];
  return next;
}

/** 从所有键序列中剔除某素材的引用 */
function stripSampleFromKeys(keys: Key[], sampleId: SampleId): Key[] {
  return keys.map((k) => {
    if (!k.sequence.some((r) => r.sampleId === sampleId)) return k;
    const sequence = k.sequence.filter((r) => r.sampleId !== sampleId);
    return { ...k, sequence, cursor: k.cursor % Math.max(sequence.length, 1) };
  });
}

export const useStore = create<AppState>()((set, get) => ({
  hydrated: false,
  activePage: 'material',
  project: createDefaultProject(),
  blobs: {},

  setActivePage: (page) =>
    set(() => {
      return { activePage: page };
    }),

  hydrate: (project, blobs) =>
    set(() => {
      // 老存档迁移统一走 migrateProject（含 3 段 EQ → 多段 bands 的转换）
      const p = migrateProject(project) ?? createDefaultProject();
      return {
        hydrated: true,
        project: p,
        blobs,
      };
    }),

  renameProject: (name) =>
    set((s) => ({ project: touch({ ...s.project, name }) })),

  // ------------------------------------------------------------------ 素材箱
  addSampleFromFile: async (file, name) => {
    const id = uid();
    const meta: Sample = {
      id,
      name: name ?? `素材 ${get().project.samples.length + 1}`,
      durationSec: 0,
      detectedPitchHz: null,
      manualSemitoneOffset: 0,
      createdAtMs: Date.now(),
    };
    set((s) => ({
      project: touch({
        ...s.project,
        samples: [...s.project.samples, meta],
      }),
      blobs: { ...s.blobs, [id]: file },
    }));
    try {
      // 解码 + 音高检测在 Web Worker 内完成（共享去重入口：与波形缩略/预热
      // 同 sampleId 并发时只真正解一次），主线程保持响应
      const { buffer, detectedPitchHz } = await decodeAudioBlobShared(id, file);
      cacheBuffer(id, buffer);
      set((s) => ({
        project: touch({
          ...s.project,
          samples: s.project.samples.map((x) =>
            x.id === id
              ? { ...x, durationSec: buffer.duration, detectedPitchHz }
              : x,
          ),
        }),
      }));
      return { ok: true, sampleId: id };
    } catch (err) {
      // 解码失败：回滚刚插入的元数据与 Blob，避免脏数据进入持久层
      set((s) => ({
        project: touch({
          ...s.project,
          samples: s.project.samples.filter((x) => x.id !== id),
        }),
        blobs: omitRecord(s.blobs, id),
      }));
      return { ok: false, error: `音频解码失败：${String(err)}` };
    }
  },

  removeSample: (id) => {
    dropCachedBuffer(id);
    return set((s) => ({
      project: touch({
        ...s.project,
        samples: s.project.samples.filter((x) => x.id !== id),
        keys: stripSampleFromKeys(s.project.keys, id),
      }),
      blobs: omitRecord(s.blobs, id),
    }));
  },

  restoreSample: ({ sample, blob, index, keys }) =>
    set((s) => {
      const samples = [...s.project.samples];
      const at = Math.min(Math.max(index, 0), samples.length);
      samples.splice(at, 0, sample);
      const nextKeys = [...s.project.keys];
      for (const { index: ki, key } of keys) {
        if (ki >= 0 && ki < nextKeys.length) nextKeys[ki] = key;
      }
      return {
        project: touch({ ...s.project, samples, keys: nextKeys }),
        blobs: blob ? { ...s.blobs, [sample.id]: blob } : s.blobs,
      };
    }),

  updateSample: (id, patch) =>
    set((s) => ({
      project: touch({
        ...s.project,
        samples: s.project.samples.map((x) =>
          x.id === id ? { ...x, ...patch } : x,
        ),
      }),
    })),

  // ------------------------------------------------------------ 全局设置
  setPitchNormalization: (enabled) =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: { ...s.project.settings, pitchNormalizationEnabled: enabled },
      }),
    })),

  setReferencePitchHz: (hz) =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: { ...s.project.settings, referencePitchHz: hz },
      }),
    })),

  setAutoTuneEnabled: (enabled) =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: { ...s.project.settings, autoTuneEnabled: enabled },
      }),
    })),

  setKeyCount: (count) =>
    set((s) => {
      const keys = [...s.project.keys];
      if (keys.length === 0) return {};
      const semitoneEnabled = s.project.settings.semitoneModeEnabled;
      const base = keyPitch(keys[0], 0);

      /*
        上限一律用**与开关无关**的键域格数（61）。
        旧实现按模式取上限（自然 36 / 半音 61），于是「半音下的 61 键工程 →
        关掉开关 → 点一下键数」会把目标夹到 36 → 静默截断 25 个键。
      */
      let n = Math.max(1, Math.min(KEY_DOMAIN_MAX_COUNT, Math.round(count)));

      /*
        关闭半音键时，把目标格数**对齐到可见的白键格**。
        否则「＋」可能把音域扩到一个**看不见的**黑键上 —— 用户连点五次，
        键盘一次变化都没有（键集是后台铺好的，黑键只是不显示）。
        收缩同理：减到黑键上会「减了没反应」，再减一下掉两个键。
      */
      if (!semitoneEnabled) {
        if (n > keys.length) {
          while (n < KEY_DOMAIN_MAX_COUNT && !isDiatonicMidi(base + n - 1)) n++;
        } else if (n < keys.length) {
          while (n > 1 && !isDiatonicMidi(base + n - 1)) n--;
        }
      }

      // 收缩：直接截断 —— 幸存键的 pitchMidi 原样保留（键的身份是音高）
      if (keys.length > n) keys.length = n;
      /*
        扩张：键集恒为「从 base 起的连续半音序列」，所以新键音高 = base + 下标，
        既不用问模式、也不用读最后一个键（它必然是 base + length − 1）。
      */
      while (keys.length < n) {
        const pitchMidi = base + keys.length;
        if (pitchMidi > KEY_MAX_MIDI) break;
        keys.push({
          id: uid(),
          label: midiNoteName(pitchMidi),
          pitchMidi,
          sequence: [],
          cursor: 0,
        });
      }
      return {
        project: touch({
          ...s.project,
          settings: { ...s.project.settings, keyCount: keys.length },
          keys,
        }),
      };
    }),

  /**
   * 半音键（黑键）显示开关 —— **纯视图状态**。
   *
   * ⚠️ 它只改这一个布尔值：键集、音域、Take 里的音符、按键绑定**一个都不碰**。
   * 关掉只是想「先不摆黑键」，不是把黑键删掉 —— 关掉再打开，一个音都不跑。
   *
   * （旧实现把「追加键取哪条序列」也塞进这个开关，于是关掉之后已存在的
   *   黑键被当白键、挤掉 D3 的位置；用户实报「半音会被当做音符块挤占
   *   其他的地方」。根因是布局层去读了这个开关。）
   */
  setSemitoneMode: (enabled) =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: { ...s.project.settings, semitoneModeEnabled: enabled },
      }),
    })),

  setKeyBinding: (keyIndex, key) =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: {
          ...s.project.settings,
          keyBindings: { ...s.project.settings.keyBindings, [keyIndex]: key },
        },
      }),
    })),

  clearKeyBinding: (keyIndex) =>
    set((s) => {
      const { [keyIndex]: _, ...rest } = s.project.settings.keyBindings;
      return {
        project: touch({
          ...s.project,
          settings: { ...s.project.settings, keyBindings: rest },
        }),
      };
    }),

  clearAllKeyBindings: () =>
    set((s) => ({
      project: touch({
        ...s.project,
        settings: { ...s.project.settings, keyBindings: {} },
      }),
    })),

  // -------------------------------------------------------------- 键序列
  setKeyLabel: (keyIndex, label) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex ? { ...k, label } : k,
        ),
      }),
    })),

  setKeySequence: (keyIndex, sampleIds) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex
            ? {
                ...k,
                sequence: sampleIds.map((sampleId) => ({ sampleId })),
                cursor: 0,
              }
            : k,
        ),
      }),
    })),

  setKeySequenceRefs: (keyIndex, refs) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex ? { ...k, sequence: refs, cursor: 0 } : k,
        ),
      }),
    })),

  appendSampleToKey: (keyIndex, sampleId) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex
            ? { ...k, sequence: [...k.sequence, { sampleId }] }
            : k,
        ),
      }),
    })),

  removeKeySlot: (keyIndex, slotIndex) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) => {
          if (i !== keyIndex) return k;
          const sequence = k.sequence.filter((_, j) => j !== slotIndex);
          return {
            ...k,
            sequence,
            cursor: sequence.length > 0 ? k.cursor % sequence.length : 0,
          };
        }),
      }),
    })),

  resetKeyCursor: (keyIndex) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex ? { ...k, cursor: 0 } : k,
        ),
      }),
    })),

  setKeyCursor: (keyIndex, cursor) =>
    set((s) => ({
      project: touch({
        ...s.project,
        keys: s.project.keys.map((k, i) =>
          i === keyIndex ? { ...k, cursor } : k,
        ),
      }),
    })),

  // -------------------------------------------------------------- 录制棚
  addTake: (take, atIndex) =>
    set((s) => {
      const takes = [...s.project.takes];
      const at =
        atIndex === undefined ? 0 : Math.min(Math.max(atIndex, 0), takes.length);
      takes.splice(at, 0, take);
      return { project: touch({ ...s.project, takes }) };
    }),

  deleteTake: (takeId) =>
    set((s) => ({
      project: touch({
        ...s.project,
        takes: s.project.takes.filter((t) => t.id !== takeId),
      }),
    })),

  updateTakeEvents: (takeId, events) =>
    set((s) => ({
      project: touch({
        ...s.project,
        takes: s.project.takes.map((t) =>
          t.id === takeId
            ? {
                ...t,
                events,
                durationSec: events.reduce((m, e) => Math.max(m, e.tSec), 0),
              }
            : t,
        ),
      }),
    })),

  renameTake: (takeId, name) =>
    set((s) => ({
      project: touch({
        ...s.project,
        takes: s.project.takes.map((t) =>
          t.id === takeId ? { ...t, name } : t,
        ),
      }),
    })),

  resetTakes: (initial) =>
    set((s) => ({
      project: touch({ ...s.project, takes: [initial] }),
    })),

  replaceStage: (input) =>
    set((s) => ({
      project: touch({
        ...s.project,
        samples: input.samples,
        keys: input.keys,
      }),
      blobs: input.blobs,
    })),

  buildFillItems: (takeId) => {
    const take = get().project.takes.find((t) => t.id === takeId);
    if (!take) return [];
    return take.events.map((ev, eventIndex) => ({
      eventIndex,
      keyIndex: ev.keyIndex,
      pressCount: ev.pressCount,
      filledSampleId:
        resolveFilledSample(get().project, ev) ?? null,
    }));
  },

  // -------------------------------------------------------------- 混音台
  /**
   * 通用效果器写入（Wave 1 新增）：把 patch 浅合并进 project.effects[id]
   * 并 touch()。效果器四个键与 masterGainDb 统一入口。
   */
  setEffect: (id, patch) =>
    set((s) => {
      const key = id as Exclude<keyof EffectSettings, 'masterGainDb'>;
      return {
        project: touch({
          ...s.project,
          effects: {
            ...s.project.effects,
            [key]: { ...s.project.effects[key], ...patch },
          },
        }),
      };
    }),

  setMasterGainDb: (db) =>
    set((s) => ({
      project: touch({
        ...s.project,
        effects: { ...s.project.effects, masterGainDb: db },
      }),
    })),

  // -------------------------------------------------------------- 均衡器
  setEqBand: (index, patch) =>
    set((s) => {
      const bands = s.project.effects.eq.bands;
      if (index < 0 || index >= bands.length) return s;
      const next = bands.map((b, i) => (i === index ? { ...b, ...patch } : b));
      return {
        project: touch({
          ...s.project,
          effects: { ...s.project.effects, eq: { ...s.project.effects.eq, bands: next } },
        }),
      };
    }),

  setEqBands: (bands) =>
    set((s) => ({
      project: touch({
        ...s.project,
        effects: { ...s.project.effects, eq: { ...s.project.effects.eq, bands } },
      }),
    })),
}));

/**
 * 事件装配态解析 —— 声音唯一来源规则下的单一真相：
 * 只看事件自身的 sampleId（填词/编辑台写入的装配成果），不再生成时
 * 回退全局 Key.sequence（那是跨 Take 泄漏旧音的通道，已退役为镜像）。
 * 空骨架事件 = 未装配（null）→ 调色板显示待填、导出按静音计。
 * project 形参保留仅为兼容既有调用点签名。
 */
export function resolveFilledSample(
  _project: Project,
  ev: TakeEvent,
): SampleId | null {
  return ev.sampleId ? ev.sampleId : null;
}

/** 便捷选择器：当前工程（引用稳定） */
export function selectProject(state: AppState): Project {
  return state.project;
}
