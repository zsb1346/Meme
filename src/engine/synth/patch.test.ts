/**
 * 音色 patch 模型的回归测试。
 *
 * 这些用例针对的不是「算法对不对」，而是**数据表与校验闸门**：
 * 65 个参数里的任何一个越界、任何一个预设里的笔误、任何一次
 * `undefined` 漏进 `AudioParam`，在本项目的历史上都能升级成
 * 「整页黑屏」级别的事故。所以这里逐条钉死。
 */

import { describe, expect, it } from 'vitest';

import {
  CLASSIC_WAVE_OPTIONS,
  DEFAULT_SYNTH_PATCH,
  ENGINE_OPTIONS,
  GRAN_TEX_OPTIONS,
  MOD_DST_OPTIONS,
  MOD_SRC_OPTIONS,
  NOISE_COLOR_OPTIONS,
  SYNTH_BASE_PATCH,
  SYNTH_DEFAULT_PRESET_NAME,
  SYNTH_NUMERIC_PARAMS,
  SYNTH_NUMERIC_SPECS,
  SYNTH_PRESETS,
  SYNTH_PRESET_NAMES,
  WT_CAT_OPTIONS,
  patchFromPreset,
  MACRO_NAMES,
  MAX_UNISON,
  applyMacroToPatch,
  patchIsAudible,
  quantizeSynthParam,
  sanitizeSynthParamValue,
  sanitizeSynthPatch,
  type SynthPatch,
} from './patch';

/**
 * 每个枚举键的**合法取值**（独立列一份，用来验 `sanitizeSynthPatch` 的回落）。
 * 值来源是各选项表 —— 校验逻辑与展示选项共用一份，不会各说一套。
 */
const ENUM_ALLOWED: Record<string, string[]> = {
  osc1Wave: CLASSIC_WAVE_OPTIONS.map(([v]) => v),
  osc2Wave: CLASSIC_WAVE_OPTIONS.map(([v]) => v),
  osc3Wave: CLASSIC_WAVE_OPTIONS.map(([v]) => v),
  engineType: ENGINE_OPTIONS.map(([v]) => v),
  wtCat: WT_CAT_OPTIONS.map(([v]) => v),
  noiseColor: NOISE_COLOR_OPTIONS.map(([v]) => v),
  granTex: GRAN_TEX_OPTIONS.map(([v]) => v),
  filterType: ['lowpass', 'highpass', 'bandpass', 'notch'],
  masterFilterType: ['lowpass', 'highpass', 'bandpass', 'notch'],
  lfoWave: ['sine', 'triangle', 'square', 'sawtooth'],
  lfo2Wave: ['sine', 'triangle', 'square', 'sawtooth'],
  driveType: ['soft', 'hard', 'fold'],
  mod1Src: MOD_SRC_OPTIONS.map(([v]) => v),
  mod2Src: MOD_SRC_OPTIONS.map(([v]) => v),
  mod3Src: MOD_SRC_OPTIONS.map(([v]) => v),
  mod4Src: MOD_SRC_OPTIONS.map(([v]) => v),
  mod1Dst: MOD_DST_OPTIONS.map(([v]) => v),
  mod2Dst: MOD_DST_OPTIONS.map(([v]) => v),
  mod3Dst: MOD_DST_OPTIONS.map(([v]) => v),
  mod4Dst: MOD_DST_OPTIONS.map(([v]) => v),
};

const ENUM_KEYS = Object.keys(ENUM_ALLOWED);
/** 非数值、非枚举的键：`monoMode` 是 0/1 数字，`addHarm` 是 32 条谐波数组 */
const EXTRA_KEYS = ['monoMode', 'addHarm'];
const ALL_KEYS = [...SYNTH_NUMERIC_PARAMS, ...ENUM_KEYS, ...EXTRA_KEYS];

describe('参数规格表', () => {
  it('每个参数的默认值都落在自己的 [min, max] 内', () => {
    for (const p of SYNTH_NUMERIC_PARAMS) {
      const s = SYNTH_NUMERIC_SPECS[p];
      expect(s.min, `${p}.min`).toBeLessThan(s.max);
      expect(s.def, `${p}.def`).toBeGreaterThanOrEqual(s.min);
      expect(s.def, `${p}.def`).toBeLessThanOrEqual(s.max);
    }
  });

  it('对数曲线的参数 min 必须 > 0（对数需要正数，否则面板算 NaN）', () => {
    for (const p of SYNTH_NUMERIC_PARAMS) {
      const s = SYNTH_NUMERIC_SPECS[p];
      if (s.curve === 'log') {
        expect(s.min, `${p} 用了 log 曲线但 min<=0`).toBeGreaterThan(0);
      }
    }
  });

  it('基准 patch 覆盖全部参数键（不多不少）', () => {
    expect(Object.keys(SYNTH_BASE_PATCH).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('基准 patch 的每个数值都在范围内、每个枚举都合法', () => {
    expect(() => assertPatchInRange(SYNTH_BASE_PATCH)).not.toThrow();
  });
});

describe('sanitizeSynthPatch —— 引擎入口的唯一闸门', () => {
  it('空输入 / null / undefined → 完整默认（键一个不少、值都是有限数）', () => {
    for (const raw of [undefined, null, {}, 'nonsense', 42]) {
      const p = sanitizeSynthPatch(raw);
      expect(Object.keys(p).sort()).toEqual([...ALL_KEYS].sort());
      for (const k of SYNTH_NUMERIC_PARAMS) {
        expect(Number.isFinite(p[k]), `${k} 应为有限数`).toBe(true);
      }
    }
  });

  it('NaN / Infinity / 字符串数字 / 布尔 → 回落默认值（不是 0，也不是原值）', () => {
    const bad = {
      filterCutoff: Number.NaN,
      filterReso: Number.POSITIVE_INFINITY,
      osc1Level: '0.5',
      drive: true,
      delayTime: Number.NEGATIVE_INFINITY,
    };
    const p = sanitizeSynthPatch(bad);
    expect(p.filterCutoff).toBe(SYNTH_NUMERIC_SPECS.filterCutoff.def);
    expect(p.filterReso).toBe(SYNTH_NUMERIC_SPECS.filterReso.def);
    expect(p.osc1Level).toBe(SYNTH_NUMERIC_SPECS.osc1Level.def);
    expect(p.drive).toBe(SYNTH_NUMERIC_SPECS.drive.def);
    expect(p.delayTime).toBe(SYNTH_NUMERIC_SPECS.delayTime.def);
  });

  it('越界 → 夹取到边界（而不是丢回默认值）', () => {
    const p = sanitizeSynthPatch({
      filterCutoff: 999999,
      osc1Detune: -999,
      reverbSize: -5,
      volume: 12,
    });
    expect(p.filterCutoff).toBe(SYNTH_NUMERIC_SPECS.filterCutoff.max);
    expect(p.osc1Detune).toBe(SYNTH_NUMERIC_SPECS.osc1Detune.min);
    expect(p.reverbSize).toBe(SYNTH_NUMERIC_SPECS.reverbSize.min);
    expect(p.volume).toBe(SYNTH_NUMERIC_SPECS.volume.max);
  });

  it('未知键被丢弃（脏键不许随存档来回传播）', () => {
    const p = sanitizeSynthPatch({ osc1Level: 0.5, 随便一个键: 1, __proto__evil: 2 });
    expect(Object.keys(p)).not.toContain('随便一个键');
    expect(Object.keys(p).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('非法枚举 → 回落默认；合法枚举原样保留', () => {
    const p = sanitizeSynthPatch({ osc1Wave: 'squarewave', filterType: 'notch', driveType: 7 });
    expect(p.osc1Wave).toBe('sawtooth');
    expect(p.filterType).toBe('notch');
    expect(p.driveType).toBe('soft');
  });

  it('monoMode 只接受 0 / 1（数字或字符串 "1"）', () => {
    expect(sanitizeSynthPatch({ monoMode: 1 }).monoMode).toBe(1);
    expect(sanitizeSynthPatch({ monoMode: '1' }).monoMode).toBe(1);
    expect(sanitizeSynthPatch({ monoMode: 0 }).monoMode).toBe(0);
    expect(sanitizeSynthPatch({ monoMode: 2 }).monoMode).toBe(0);
    expect(sanitizeSynthPatch({ monoMode: 'true' }).monoMode).toBe(0);
  });

  it('幂等：sanitize(sanitize(x)) 与 sanitize(x) 逐键相同', () => {
    const once = sanitizeSynthPatch({ filterCutoff: 999999, osc2Wave: 'bogus' });
    expect(sanitizeSynthPatch(once)).toEqual(once);
  });

  it('单参数入口与整体入口给出一致的判定', () => {
    const cur = { ...DEFAULT_SYNTH_PATCH };
    expect(sanitizeSynthParamValue('filterReso', Number.NaN, cur)).toBe(
      SYNTH_NUMERIC_SPECS.filterReso.def,
    );
    expect(sanitizeSynthParamValue('volume', 3, cur)).toBe(SYNTH_NUMERIC_SPECS.volume.max);
    expect(sanitizeSynthParamValue('osc3Wave', 'square', cur)).toBe('square');
  });
});

describe('预设表', () => {
  it('预设名唯一且非空', () => {
    expect(SYNTH_PRESET_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SYNTH_PRESET_NAMES).size).toBe(SYNTH_PRESET_NAMES.length);
  });

  it('出厂默认预设名在表里', () => {
    expect(SYNTH_PRESET_NAMES).toContain(SYNTH_DEFAULT_PRESET_NAME);
  });

  it('每个预设只写合法键、且值都在范围内（抓拼写错误）', () => {
    const legal = new Set(ALL_KEYS);
    for (const [name, preset] of Object.entries(SYNTH_PRESETS)) {
      for (const [key, value] of Object.entries(preset)) {
        expect(legal.has(key), `预设「${name}」含未知键 ${key}`).toBe(true);
        if (key in ENUM_ALLOWED) {
          expect(
            ENUM_ALLOWED[key].includes(String(value)),
            `预设「${name}」的 ${key}=${String(value)} 不是合法枚举`,
          ).toBe(true);
        } else if (key === 'monoMode') {
          expect([0, 1]).toContain(value);
        } else {
          const spec = SYNTH_NUMERIC_SPECS[key as keyof typeof SYNTH_NUMERIC_SPECS];
          expect(typeof value, `预设「${name}」的 ${key} 必须是数字`).toBe('number');
          expect(value as number).toBeGreaterThanOrEqual(spec.min);
          expect(value as number).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it('每个预设都能套成一个完整 patch，且与基准 + 覆盖一致', () => {
    for (const name of SYNTH_PRESET_NAMES) {
      const patch = patchFromPreset(name);
      expect(Object.keys(patch).sort()).toEqual([...ALL_KEYS].sort());
      expect(patch).toEqual(sanitizeSynthPatch({ ...SYNTH_BASE_PATCH, ...SYNTH_PRESETS[name] }));
    }
  });

  it('「基础锯齿 · 初始」就是基准 patch（预设的底没被写歪）', () => {
    expect(patchFromPreset('基础锯齿 · 初始')).toEqual(SYNTH_BASE_PATCH);
  });

  it('出厂默认 = 参考音 · 清铃', () => {
    expect(DEFAULT_SYNTH_PATCH).toEqual(patchFromPreset(SYNTH_DEFAULT_PRESET_NAME));
  });

  /**
   * ⚠️ 绝对量判据（不是相对量）。
   * 「所有振荡器音量都是 0」是唯一真正「按下去没声」的配置；相对指标在
   * 静音时是 0/0，永远判不出来。这里就查这个绝对和。
   */
  it('没有一款预设是静音的（绝对量判据）', () => {
    for (const name of SYNTH_PRESET_NAMES) {
      const patch = patchFromPreset(name);
      expect(patchIsAudible(patch), `预设「${name}」按下去没声`).toBe(true);
    }
  });

  it('出厂默认刻意「干」：延迟干湿为 0（参考音不能被尾巴糊住拍点）', () => {
    expect(DEFAULT_SYNTH_PATCH.delayMix).toBe(0);
    expect(DEFAULT_SYNTH_PATCH.reverbMix).toBeLessThan(0.2);
  });

  it('⛔ 出厂参考音必须与按下的键**同音高**（osc1Oct 必须是 0）', () => {
    // 「参考音 · 清铃」的全部价值，是让你听出**自己按的音对不对**。
    // 它曾照抄原型的 `osc1Oct: 1 / osc2Oct: 2` → 按 C4 实际响 C5，
    // 跟弹时「我按对了没有」这个判据当场失效（离线渲染实测基频 521.7Hz vs 期望 261.6Hz）。
    // 想保留八度叠色，必须**整组一起**上下移，不能让基频脱离按键音高。
    expect(SYNTH_DEFAULT_PRESET_NAME).toBe('参考音 · 清铃');
    expect(DEFAULT_SYNTH_PATCH.osc1Oct).toBe(0);
    // 叠色用的上层振荡器只许往上叠
    expect(DEFAULT_SYNTH_PATCH.osc2Oct).toBeGreaterThan(0);
  });
});

describe('quantizeSynthParam', () => {
  it('按 step 量化并夹取', () => {
    expect(quantizeSynthParam('bitDepth', 7.4)).toBe(7);
    expect(quantizeSynthParam('bitDepth', 7.6)).toBe(8);
    expect(quantizeSynthParam('bitDepth', 99)).toBe(16);
    // 八度下限是 -3 不是 -2：预设里「低吼 Bass」真的用了 -3（见 patch.ts 的 spec 注释）
    expect(quantizeSynthParam('osc1Oct', -9)).toBe(-3);
  });

  it('缺省步进 0.001：浮点尾差被削掉，不产生 0.30000000000000004', () => {
    expect(quantizeSynthParam('delayTime', 0.1 + 0.2)).toBe(0.3);
  });
});

/** 断言 patch 全部字段在各自范围内（预设表与基准表共用） */
function assertPatchInRange(patch: SynthPatch): void {
  for (const p of SYNTH_NUMERIC_PARAMS) {
    const s = SYNTH_NUMERIC_SPECS[p];
    const v = patch[p];
    if (!Number.isFinite(v)) throw new Error(`${p} 非有限数：${String(v)}`);
    if (v < s.min || v > s.max) throw new Error(`${p}=${v} 越界 [${s.min}, ${s.max}]`);
  }
  for (const [key, allowed] of Object.entries(ENUM_ALLOWED)) {
    const v = patch[key as keyof SynthPatch];
    if (!allowed.includes(String(v))) throw new Error(`${key}=${String(v)} 非法`);
  }
  if (patch.monoMode !== 0 && patch.monoMode !== 1) {
    throw new Error(`monoMode=${String(patch.monoMode)} 非法`);
  }
}

// ---------------------------------------------------------------------------
// 宏：必须是「相对基准的偏移」，不能是「绝对赋值」
// ---------------------------------------------------------------------------
//
// 原型在这里栽过一次，而且**从界面上完全看不出来**：
// `macroThick → unison` 原本写成 `1 + round(m*7)`，完全忽略基准 b ——
// 于是「厚度 = 0」时任何预设里写好的 Unison 都被强行打回 1，
// 全部超锯 / 铺底音色变成单声部。用户会以为「这个预设本来就是单声部」。

describe('宏映射', () => {
  it('m = 0 时不改变任何被联动的参数（旋钮在 0 位就必须等于原样）', () => {
    for (const macro of MACRO_NAMES) {
      const base = { ...SYNTH_BASE_PATCH, unison: 8, filterCutoff: 1200, reverbMix: 0.3 };
      const out = applyMacroToPatch(base, macro, 0);
      for (const [k, v] of Object.entries(out)) {
        const b = base[k as keyof SynthPatch];
        if (typeof b !== 'number') continue;
        // 量化到 step 之后可能与基准差半个 step，用容差判
        expect(Math.abs((v as number) - b), `${macro}.${k} 在 0 位改了值`).toBeLessThan(0.06);
      }
    }
  });

  it('基准必须被尊重：厚度宏不能把预设里写好的 Unison 抹掉', () => {
    const base = { ...SYNTH_BASE_PATCH, unison: 8, unisonDetune: 20 };
    const off = applyMacroToPatch(base, 'macroThick', 0);
    expect(off.unison).toBe(8);
    const full = applyMacroToPatch(base, 'macroThick', 1);
    expect(full.unison).toBe(MAX_UNISON);
    // 基准 8 抬到满量程 = 8 + 15，夹到上限 16
    const half = applyMacroToPatch(base, 'macroThick', 0.5);
    expect(half.unison).toBe(Math.round(8 + 0.5 * (MAX_UNISON - 1)));
  });

  it('联动出来的每个键都必须是真的数值参数（否则写不进 AudioParam）', () => {
    const numeric = new Set<string>(SYNTH_NUMERIC_PARAMS);
    for (const macro of MACRO_NAMES) {
      const out = applyMacroToPatch(SYNTH_BASE_PATCH, macro, 0.7);
      expect(Object.keys(out).length).toBeGreaterThan(0);
      for (const k of Object.keys(out)) {
        expect(numeric.has(k), `${macro} 联动了非数值键 ${k}`).toBe(true);
      }
    }
  });

  it('输出永远在范围内（宏不能把参数推出界）', () => {
    for (const macro of MACRO_NAMES) {
      for (const m of [0, 0.25, 0.5, 0.75, 1]) {
        const out = applyMacroToPatch(SYNTH_BASE_PATCH, macro, m);
        for (const [k, v] of Object.entries(out)) {
          const s = SYNTH_NUMERIC_SPECS[k as keyof typeof SYNTH_NUMERIC_SPECS];
          expect(v as number).toBeGreaterThanOrEqual(s.min);
          expect(v as number).toBeLessThanOrEqual(s.max);
        }
      }
    }
  });
});

describe('patchIsAudible 必须按引擎分派', () => {
  it('粒子 / 噪声 / 弦鸣 / FM 引擎不能因为 osc 音量是 0 就被判成静音', () => {
    const silentOsc = { osc1Level: 0, osc2Level: 0, osc3Level: 0, noiseLevel: 0 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['classic', { osc1Level: 0.6 }],
      ['wavetable', { osc1Level: 0.6 }],
      ['fm', { fmCar: 0.7 }],
      ['additive', { osc1Level: 0.6 }],
      ['string', { strLevel: 0.8 }],
      ['granular', { granLevel: 0.7 }],
      ['noise', { noiseEngLevel: 0.55 }],
    ];
    for (const [engineType, extra] of cases) {
      const p = sanitizeSynthPatch({ ...SYNTH_BASE_PATCH, ...silentOsc, engineType, ...extra });
      expect(patchIsAudible(p), `${engineType} 有源却被判成静音`).toBe(true);
      const muted = sanitizeSynthPatch({ ...p, ...silentOsc, fmCar: 0, fmSub: 0, strLevel: 0, granLevel: 0, noiseEngLevel: 0, osc1Level: 0 });
      expect(patchIsAudible(muted), `${engineType} 真的静音了却被判成有声`).toBe(false);
    }
  });
});
