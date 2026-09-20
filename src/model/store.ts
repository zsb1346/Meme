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
  // 老存档的 settings 可能缺 keyBindings（既有逻辑，保留）
  if (!p.settings?.keyBindings) {
    p.settings = { ...p.settings, keyBindings: {} };
  }

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
  referencePitchHz: 261.6255653, // C4 = do
  keyCount: 14,
  keyBindings: {},
  autoTuneEnabled: true,
};

const SOLFEGE = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'] as const;

function defaultKeyLabel(index: number): string {
  // 每跨一个八度追加一个撇号：0-6 → do…si；7-13 → do'…si'；14-20 → do''…
  return SOLFEGE[index % 7] + "'".repeat(Math.floor(index / 7));
}

export function createDefaultKeys(count: number): Key[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uid(),
    label: defaultKeyLabel(i),
    sequence: [],
    cursor: 0,
  }));
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
    schemaVersion: 1,
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
  setKeyCount(count: number): void;
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
      const n = Math.max(1, Math.min(32, Math.round(count)));
      const existing = s.project.keys.slice(0, n);
      const padded = [
        ...existing,
        ...createDefaultKeys(n).slice(existing.length),
      ];
      return {
        project: touch({
          ...s.project,
          settings: { ...s.project.settings, keyCount: n },
          keys: padded.map((k) => ({ ...k, cursor: k.cursor })),
        }),
      };
    }),

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
