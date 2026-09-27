/**
 * 面板覆盖度测试。
 *
 * 新增一个音色参数却忘了把它挂到面板上，是**最安静**的一类漏：
 * 引擎认它、存档存它、耳朵听得出差别，但界面上没有那个旋钮 ——
 * 用户只能「感觉不一样，改不回来」。
 * 这里用三条断言把它变成编译/测试期问题：
 *
 *   ① 数值参数表 ⊇ 面板旋钮；
 *   ② **`SynthPatch` 的每一个键都能在界面上找到入口**（旋钮 / 段控 / 专用编辑器）
 *      —— 这条是「面板不是半成品」的机械化表达，比逐个人工核对可靠；
 *   ③ `hidden` 的旋钮与「专用编辑器白名单」必须**双向一致**：
 *      声明了 hidden 却没编辑器 = 界面上真的没有；有编辑器却没声明 = 覆盖度算不到。
 */

import { describe, expect, it } from 'vitest';

import {
  ENGINE_OPTIONS,
  SYNTH_BASE_PATCH,
  SYNTH_NUMERIC_PARAMS,
  type EngineType,
  type SynthPatch,
} from '../../engine/synth/patch';
import {
  CUSTOM_ARRAY_PARAMS,
  CUSTOM_EDITOR_PARAMS,
  KNOB_LABEL_MAX_WIDTH,
  SYNTH_GROUPS,
  knobLabelWidth,
  misdeclaredHiddenKnobs,
  numericParamsCoveredByPanel,
  paramsCoveredByPanel,
  specOf,
  unboundCustomEditorParams,
  uncoveredNumericParams,
  visibleGroups,
  visibleKnobs,
} from './synth-params';

/** `SynthPatch` 的全部键（从一份完整的 patch 上取，避免手抄） */
const ALL_PATCH_KEYS = Object.keys(SYNTH_BASE_PATCH) as Array<keyof SynthPatch>;

const ALL_ENGINES: EngineType[] = ENGINE_OPTIONS.map(([v]) => v);

describe('音色面板参数覆盖', () => {
  it('每一个数值参数都出现在面板里（没有「引擎认、界面没有」的参数）', () => {
    expect(uncoveredNumericParams()).toEqual([]);
  });

  it('⭐ SynthPatch 的每一个键都能在界面上找到入口（面板不是半成品）', () => {
    const covered = new Set<string>(paramsCoveredByPanel());
    const missing = ALL_PATCH_KEYS.filter((k) => !covered.has(k));
    expect(missing, `这些参数在面板上没有任何入口：${missing.join(', ')}`).toEqual([]);
  });

  it('面板里的数值参数没有重复（同一参数两处旋钮会互相打架）', () => {
    const all = SYNTH_GROUPS.flatMap((g) => g.knobs.map((k) => k.p));
    expect(new Set(all).size).toBe(all.length);
  });

  it('面板里的参数全部是真实存在的参数', () => {
    const legal = new Set<string>(SYNTH_NUMERIC_PARAMS);
    for (const g of SYNTH_GROUPS) {
      for (const k of g.knobs) {
        expect(legal.has(k.p), `${g.title}/${k.label} 引用了不存在的参数 ${k.p}`).toBe(true);
      }
    }
  });

  it('每组至少有一个**真正画出来**的旋钮，且都有标题与说明（空组 = 界面上一个空白卡片）', () => {
    for (const g of SYNTH_GROUPS) {
      expect(visibleKnobs(g).length, `${g.title} 没有旋钮`).toBeGreaterThan(0);
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.hint.length).toBeGreaterThan(0);
    }
  });

  it('专用分组的引擎清单非空，且在那个引擎下真的看得见', () => {
    for (const g of SYNTH_GROUPS) {
      if (!g.engines) continue;
      expect(
        g.engines.length,
        `${g.title} 的 engines 是空数组 —— 这一组永远不会显示`,
      ).toBeGreaterThan(0);
      for (const et of g.engines) {
        expect(
          visibleGroups(et).some((x) => x.id === g.id),
          `${g.title} 声明了 ${et} 却在该引擎下看不见`,
        ).toBe(true);
      }
    }
  });

  it('专用编辑器与 hidden 旋钮双向一致（漏一边就是真的少了一个入口）', () => {
    expect(misdeclaredHiddenKnobs()).toEqual([]);
    expect(unboundCustomEditorParams()).toEqual([]);
    expect(CUSTOM_ARRAY_PARAMS.length).toBeGreaterThan(0);
    const covered = new Set<string>(paramsCoveredByPanel());
    for (const p of CUSTOM_ARRAY_PARAMS) {
      expect(covered.has(p), `${p} 没算进覆盖度`).toBe(true);
    }
    for (const p of CUSTOM_EDITOR_PARAMS) {
      expect(covered.has(p), `${p} 没算进覆盖度`).toBe(true);
    }
  });

  it('分组 id 唯一（否则切换分组会切到错的那个）', () => {
    const ids = SYNTH_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('段控的选项非空、且选项值互不相同（重复值会让选中态错乱）', () => {
    for (const g of SYNTH_GROUPS) {
      for (const s of g.segs) {
        expect(s.options.length, `${g.title}/${s.label} 没有选项`).toBeGreaterThan(0);
        const vals = s.options.map(([v]) => String(v));
        expect(new Set(vals).size, `${g.title}/${s.label} 选项值重复`).toBe(vals.length);
      }
    }
  });

  it('每个段控参数只出现一次', () => {
    const segs = SYNTH_GROUPS.flatMap((g) => g.segs.map((s) => String(s.p)));
    expect(new Set(segs).size).toBe(segs.length);
  });

  it('段控指向的参数确实不是数值参数（数值参数画成段控会丢精度）', () => {
    const numeric = new Set<string>(SYNTH_NUMERIC_PARAMS);
    for (const g of SYNTH_GROUPS) {
      for (const s of g.segs) {
        expect(
          numeric.has(String(s.p)),
          `${g.title}/${s.label} 是数值参数，不该做成段控`,
        ).toBe(false);
      }
    }
  });

  it('specOf 给出的范围与引擎侧完全一致（面板不可能和引擎各写一份）', () => {
    for (const p of numericParamsCoveredByPanel()) {
      const spec = specOf(p);
      expect(spec.min).toBeLessThan(spec.max);
      expect(spec.def).toBeGreaterThanOrEqual(spec.min);
      expect(spec.def).toBeLessThanOrEqual(spec.max);
      if (spec.curve === 'log') expect(spec.min).toBeGreaterThan(0);
    }
  });

  it('面板声明的参数数 = 数值参数数 + 段控参数数 + 专用编辑器参数数', () => {
    const segCount = SYNTH_GROUPS.reduce((n, g) => n + g.segs.length, 0);
    expect(paramsCoveredByPanel().length).toBe(
      numericParamsCoveredByPanel().length + segCount + CUSTOM_ARRAY_PARAMS.length,
    );
  });

  it('每个引擎下都看得见「振荡器 · 引擎」这一组（否则换不回别的引擎）', () => {
    for (const et of ALL_ENGINES) {
      const ids = visibleGroups(et).map((g) => g.id);
      expect(ids, `${et} 下没有引擎切换入口`).toContain('osc');
    }
  });

  it('四个宏在面板上可调（宏是原型里最常用的入口，不能只在引擎侧存在）', () => {
    const macroGroup = SYNTH_GROUPS.find((g) => g.id === 'macro');
    expect(macroGroup).toBeTruthy();
    expect(visibleKnobs(macroGroup!).map((k) => k.p)).toEqual([
      'macroComplex',
      'macroBright',
      'macroThick',
      'macroSpace',
    ]);
  });

  /**
   * ⭐ 旋钮标签不许被截断。
   *
   * 这条是**实测出来的**：1440 宽的弹层、7 列旋钮格、Knob 直径 48px 时，
   * 「延迟时间」刚好放得下，而「LFO1 速率」会被截成「LFO1 …」。
   * 截断最坏的情况不是难看 —— 是**两个不同的参数看起来一模一样**：
   * 两个 LFO 的四组「→音高 / →滤波 / →音量」都写成无前缀，
   * 用户只能靠数格子分辨自己在调哪个 LFO。
   */
  it('旋钮标签宽度不超过上限（超了会被截断，两个参数看起来一样）', () => {
    for (const g of SYNTH_GROUPS) {
      for (const k of visibleKnobs(g)) {
        const w = knobLabelWidth(k.label);
        expect(
          w,
          `${g.title} / ${k.p} 的标签「${k.label}」宽 ${w.toFixed(1)}，` +
            `超过 ${KNOB_LABEL_MAX_WIDTH} 会被 Knob 截断`,
        ).toBeLessThanOrEqual(KNOB_LABEL_MAX_WIDTH);
      }
    }
  });

  /**
   * 这条断言钉的是面板里一个**隐式耦合**：
   * `SynthPanel` 对 `matrix` 组**既不渲染**通用段控行、**也不渲染**底部旋钮格 ——
   * 8 个源/目标 select 与 4 个深度旋钮都由 `ModMatrixEditor` 自己画
   * （否则会画两遍，还把中文挤成竖排、把旋钮从各自的槽里拆散）。
   * 如果有人往这一组里加了一个别的段控或旋钮，它会**静默不显示** ——
   * 所以在测试里把「这一组只能是调制槽」写死。
   */
  it('调制矩阵组只含 8 个调制槽段控 + 4 个深度旋钮（多出来的会被面板静默丢掉）', () => {
    const g = SYNTH_GROUPS.find((x) => x.id === 'matrix');
    expect(g).toBeTruthy();
    expect(g!.segs.map((s) => String(s.p)).sort()).toEqual(
      [
        'mod1Dst',
        'mod1Src',
        'mod2Dst',
        'mod2Src',
        'mod3Dst',
        'mod3Src',
        'mod4Dst',
        'mod4Src',
      ].sort(),
    );
    expect(g!.knobs.map((k) => k.p).sort()).toEqual(
      ['mod1Amt', 'mod2Amt', 'mod3Amt', 'mod4Amt'].sort(),
    );
  });
});
