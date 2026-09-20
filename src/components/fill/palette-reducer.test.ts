/**
 * palette-reducer 特征化测试。
 *
 * 钉死 NotePalette 命令面板的纯状态机语义：
 * 1. filterSamples：拼音感知搜索（复用 utils/sample-search）+ id 子串兜底，
 *    有查询时按相关度排序（不再是原始顺序）；
 * 2. SetFilter → activeIdx 归零、候选跟随过滤首行、已选中项被筛掉则清空；
 * 3. NavDelta ↑/↓ 在列表两端夹取（clamp），空列表恒为 0；且**不动** selected；
 * 4. Arm（鼠标单击）= 光标 + 选中一起落定；
 * 5. Confirm（回车）双保险：光标行未选中 → 只选中；已选中 → 产出 apply 决策；
 *    → 键 = Cancel；无候选时 Confirm 退化为 Cancel；
 * 6. Apply（应用按钮）目标 = 已选中行，无则光标行；
 * 7. computeStepSec 步进下限（floor 0.05，未解码 0 时长素材兜底）；
 * 8. clampTau：下限 stepSec/sampleDur、上限 8；
 * 9. AdjustStretch 按 stepSec/sampleDur 递增并受 clampTau 约束；
 * 10. Cancel 丢弃全部 staging（delta 归 0、τ 归 1、候选与选中清空）。
 * 12. **「这条音符本来就装着素材」也算有目标**（2026-09-20 用户实报）：
 *     `placedId` 由打开面板时的 effectiveSampleId 决定、**不随光标变**；
 *     `tuneTargetId` = 已选中行 ?? placedId（不含光标兜底）；
 *     `resolveTargetId` = tuneTargetId ?? 光标行（只给「应用」兜底）。
 */

import { describe, expect, it } from 'vitest';

import {
  clampTau,
  computeStepSec,
  createInitialState,
  filterSamples,
  reducer,
  resolveTargetId,
  tuneTargetId,
} from './palette-reducer';
import type { PaletteSample } from './palette-reducer';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const SAMPLES: PaletteSample[] = [
  { id: 's1', name: '哈吉米', durationSec: 0.8 },
  { id: 's2', name: '吉米米', durationSec: 1.5 },
  { id: 's3', name: '瓦鲁多', durationSec: 0.05 },
];

/** 用户验收用例的原样素材：中文名 + 扩展名 */
const CN_SAMPLES: PaletteSample[] = [
  { id: 'p1', name: '张三.mp3', durationSec: 1.0 },
  { id: 'p2', name: '李四.mp3', durationSec: 1.2 },
  { id: 'p3', name: '张三丰.mp3', durationSec: 0.9 },
];

function fresh(overrides?: {
  initialCandidateId?: string | null;
  semitoneDelta?: number;
  timeFactor?: number;
}) {
  return createInitialState({ samples: SAMPLES, ...overrides });
}

// ---------------------------------------------------------------------------
// 1. filterSamples 谓词（拼音感知 + 相关度排序）
// ---------------------------------------------------------------------------

describe('filterSamples', () => {
  it('空白过滤词返回全量（trim 判空，且不重排）', () => {
    expect(filterSamples(SAMPLES, '')).toEqual(SAMPLES);
    expect(filterSamples(SAMPLES, '   ')).toEqual(SAMPLES);
  });

  it('按名称子串匹配（大小写不敏感）', () => {
    const r = filterSamples(SAMPLES, '吉米');
    // 「吉米米」子串起点在 0，「哈吉米」在 1 → 相关度更高的排前面
    expect(r.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('按 id 子串匹配（旧 CustomPicker 行为保留，排在名称命中之后）', () => {
    expect(filterSamples(SAMPLES, 'S2').map((s) => s.id)).toEqual(['s2']);
  });

  it('无匹配返回空数组', () => {
    expect(filterSamples(SAMPLES, '不存在')).toEqual([]);
  });

  // ── 用户验收用例：四种输入都要能搜到「张三.mp3」 ──
  it('原文子串：张三 → 张三.mp3 / 张三丰.mp3', () => {
    expect(filterSamples(CN_SAMPLES, '张三').map((s) => s.name)).toEqual([
      '张三.mp3',
      '张三丰.mp3',
    ]);
  });

  it('拼音前缀：zhang → 张三.mp3', () => {
    expect(filterSamples(CN_SAMPLES, 'zhang').map((s) => s.name)).toContain('张三.mp3');
  });

  it('首字母：zs → 张三.mp3（张三丰是 zsf，也命中前缀）', () => {
    const names = filterSamples(CN_SAMPLES, 'zs').map((s) => s.name);
    expect(names).toContain('张三.mp3');
  });

  it('全拼：zhangsan → 张三.mp3（精准命中排在三丰之前）', () => {
    expect(filterSamples(CN_SAMPLES, 'zhangsan')[0]?.name).toBe('张三.mp3');
  });

  it('全拼：lisi → 李四.mp3', () => {
    expect(filterSamples(CN_SAMPLES, 'lisi').map((s) => s.name)).toEqual(['李四.mp3']);
  });

  it('大小写不敏感：ZhangSan 同样命中', () => {
    expect(filterSamples(CN_SAMPLES, 'ZhangSan')[0]?.name).toBe('张三.mp3');
  });

  it('不相关查询返回空', () => {
    expect(filterSamples(CN_SAMPLES, 'wangwu')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. SetFilter → activeIdx 归零
// ---------------------------------------------------------------------------

describe('SetFilter', () => {
  it('输入过滤词后 activeIdx 重置为 0 且候选指向过滤首行', () => {
    let st = fresh();
    // 先导航到下标 2
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES });
    expect(st.activeIdx).toBe(2);
    // 再改过滤词 → 必须回到 0
    const filtered = filterSamples(SAMPLES, '吉米');
    st = reducer(st, { type: 'SetFilter', filter: '吉米', filtered });
    expect(st.activeIdx).toBe(0);
    expect(st.staged.candidateId).toBe('s2'); // 「吉米米」相关度更高，排在首行
  });

  it('过滤到空列表时候选为 null', () => {
    const st = reducer(fresh(), {
      type: 'SetFilter',
      filter: '查无此人',
      filtered: [],
    });
    expect(st.activeIdx).toBe(0);
    expect(st.staged.candidateId).toBeNull();
  });

  it('已选中项仍在过滤结果里 → 保留（打字不该清掉用户的选择）', () => {
    let st = fresh({ initialCandidateId: 's1' });
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES }); // 选中 s1
    expect(st.armedId).toBe('s1');
    const filtered = filterSamples(SAMPLES, '吉');
    st = reducer(st, { type: 'SetFilter', filter: '吉', filtered });
    expect(st.armedId).toBe('s1');
  });

  it('已选中项被筛掉 → 清空选中（绝不提交用户看不见的候选）', () => {
    let st = fresh();
    st = reducer(st, { type: 'Arm', index: 2, filtered: SAMPLES }); // 选中 s3 瓦鲁多
    expect(st.armedId).toBe('s3');
    const filtered = filterSamples(SAMPLES, '吉米'); // 瓦鲁多被筛掉
    st = reducer(st, { type: 'SetFilter', filter: '吉米', filtered });
    expect(st.armedId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. NavDelta 两端夹取
// ---------------------------------------------------------------------------

describe('NavDelta', () => {
  it('↑ 在顶部夹取为 0，不越界', () => {
    let st = fresh();
    st = reducer(st, { type: 'NavDelta', delta: -1, filtered: SAMPLES });
    expect(st.activeIdx).toBe(0);
    st = reducer(st, { type: 'NavDelta', delta: -5, filtered: SAMPLES });
    expect(st.activeIdx).toBe(0);
  });

  it('↓ 在底部夹取为 length-1，不越界', () => {
    let st = fresh();
    st = reducer(st, { type: 'NavDelta', delta: 99, filtered: SAMPLES });
    expect(st.activeIdx).toBe(SAMPLES.length - 1);
    expect(st.staged.candidateId).toBe('s3');
  });

  it('空列表恒为 0 且候选为 null', () => {
    const st = reducer(fresh(), { type: 'NavDelta', delta: 1, filtered: [] });
    expect(st.activeIdx).toBe(0);
    expect(st.staged.candidateId).toBeNull();
  });

  it('移动光标**不动**已选中项（悬停/↑↓ 是无意识动作，不能改提交目标）', () => {
    let st = fresh();
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES }); // 选中 s1
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES }); // 光标飘到 s3
    expect(st.activeIdx).toBe(2);
    expect(st.staged.candidateId).toBe('s3');
    expect(st.armedId).toBe('s1'); // 选中项纹丝不动
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toEqual({
      kind: 'apply',
      sampleId: 's1',
      semitoneDelta: 0,
      timeFactor: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 3b. Arm（鼠标单击 = 光标 + 选中一起落定）
// ---------------------------------------------------------------------------

describe('Arm', () => {
  it('单击某行：光标与选中同时落到该行', () => {
    const st = reducer(fresh(), { type: 'Arm', index: 1, filtered: SAMPLES });
    expect(st.activeIdx).toBe(1);
    expect(st.armedId).toBe('s2');
    expect(st.staged.candidateId).toBe('s2');
    expect(st.decision).toBeNull(); // 单击**不**提交
  });

  it('单击越界下标为无操作', () => {
    const st = reducer(fresh(), { type: 'Arm', index: 99, filtered: SAMPLES });
    expect(st.armedId).toBeNull();
  });

  it('单击 + 回车 = 两次动作 → 提交（与键盘同构）', () => {
    let st = reducer(fresh(), { type: 'Arm', index: 2, filtered: SAMPLES });
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision).toEqual({
      kind: 'apply',
      sampleId: 's3',
      semitoneDelta: 0,
      timeFactor: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Confirm（回车）双保险语义
// ---------------------------------------------------------------------------

describe('Confirm = 第一次选中、第二次确认', () => {
  it('光标行未被选中 → 只选中，绝不提交', () => {
    const st = reducer(fresh({ initialCandidateId: 's1' }), { type: 'Confirm' });
    expect(st.armedId).toBe('s1');
    expect(st.decision).toBeNull();
  });

  it('光标停在已选中行 → 真正确认，产出 apply 决策', () => {
    let st = fresh({ initialCandidateId: 's1' });
    st = reducer(st, { type: 'Confirm' }); // 第一次：选中
    expect(st.decision).toBeNull();
    st = reducer(st, { type: 'Confirm' }); // 第二次：确认
    expect(st.decision?.kind).toBe('apply');
    if (st.decision?.kind === 'apply') expect(st.decision.sampleId).toBe('s1');
  });

  it('选中 A 后光标切到 B，回车视为「选中 B」而非提交 A', () => {
    let st = fresh();
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES }); // 选中 s1
    st = reducer(st, { type: 'NavDelta', delta: 1, filtered: SAMPLES }); // 光标到 s2
    st = reducer(st, { type: 'Confirm' });
    expect(st.armedId).toBe('s2');
    expect(st.decision).toBeNull();
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision?.kind).toBe('apply');
    if (st.decision?.kind === 'apply') expect(st.decision.sampleId).toBe('s2');
  });

  it('无候选时 → cancel（与旧 Apply 兜底一致）', () => {
    const st = reducer(createInitialState({ samples: [] }), { type: 'Confirm' });
    expect(st.decision?.kind).toBe('cancel');
  });
});

describe('Apply / Cancel 决策', () => {
  it('未经选中的 Apply 走光标行，并携带 staging 值', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'AdjustPitch', delta: 3 });
    st = reducer(st, { type: 'AdjustStretch', direction: 1, sampleDur: 1.5 });
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toEqual({
      kind: 'apply',
      sampleId: 's2',
      semitoneDelta: 3,
      timeFactor: expect.closeTo(1 + 0.05 / 1.5, 10),
    });
  });

  it('已选中时 Apply 以选中项为准（应用按钮 = 显式确认）', () => {
    let st = fresh({ initialCandidateId: 's1' });
    st = reducer(st, { type: 'Arm', index: 2, filtered: SAMPLES }); // 选中 s3
    st = reducer(st, { type: 'Apply' });
    expect(st.decision?.kind).toBe('apply');
    if (st.decision?.kind === 'apply') expect(st.decision.sampleId).toBe('s3');
  });

  it('无候选时 Apply 退化为 cancel（绝不产出空 apply）', () => {
    let st = reducer(fresh(), {
      type: 'SetFilter',
      filter: '查无此人',
      filtered: [],
    });
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toEqual({ kind: 'cancel' });
  });

  it('Cancel（→/Esc 共用）产出 cancel 决策并清空选中', () => {
    let st = reducer(fresh(), { type: 'Arm', index: 1, filtered: SAMPLES });
    st = reducer(st, { type: 'Cancel' });
    expect(st.decision).toEqual({ kind: 'cancel' });
    expect(st.armedId).toBeNull();
  });

  it('决策落定后为终态：后续动作不再改写 decision', () => {
    let st = reducer(fresh(), { type: 'Cancel' });
    st = reducer(st, { type: 'AdjustPitch', delta: 5 });
    st = reducer(st, { type: 'Apply' });
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision).toEqual({ kind: 'cancel' });
  });
});

// ---------------------------------------------------------------------------
// 5. computeStepSec 步进下限
// ---------------------------------------------------------------------------

describe('computeStepSec', () => {
  it('常规素材：0.05 上限', () => {
    expect(computeStepSec(2.0)).toBe(0.05);
    expect(computeStepSec(0.8)).toBe(0.05);
  });

  it('短素材/未解码素材：floor 0.05 兜底（0.2×dur 低于下限时抬升）', () => {
    expect(computeStepSec(0.1)).toBe(0.05); // 0.1*0.2=0.02 → floor
    expect(computeStepSec(0)).toBe(0.05); // durationSec=0（解码未回填）
    expect(computeStepSec(-1)).toBe(0.05); // 非法值兜底
  });
});

// ---------------------------------------------------------------------------
// 6. clampTau
// ---------------------------------------------------------------------------

describe('clampTau', () => {
  it('下限 = stepSec / sampleDur（默认 0.05/dur）', () => {
    expect(clampTau(0.001, 0.05, 1)).toBe(0.05);
    expect(clampTau(0.04, 0.05, 0.25)).toBeCloseTo(0.2, 10); // 0.05/0.25
  });

  it('上限 = 8', () => {
    expect(clampTau(9, 0.05, 1)).toBe(8);
    expect(clampTau(100, 0.05, 1)).toBe(8);
  });

  it('区间内原样通过', () => {
    expect(clampTau(1.2, 0.05, 1)).toBe(1.2);
  });

  it('sampleDur<=0 时退化为 stepSec 下限（不产生 Infinity）', () => {
    expect(clampTau(0, 0.05, 0)).toBe(0.05);
    expect(Number.isFinite(clampTau(0, 0.05, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. AdjustStretch 步进数学
// ---------------------------------------------------------------------------

describe('AdjustStretch', () => {
  it('每次 ±stepSec/sampleDur 的 τ 增量', () => {
    let st = fresh({ initialCandidateId: 's1' }); // dur 0.8, step 0.05
    st = reducer(st, { type: 'AdjustStretch', direction: 1, sampleDur: 0.8 });
    expect(st.staged.timeFactor).toBeCloseTo(1 + 0.05 / 0.8, 10);
    st = reducer(st, { type: 'AdjustStretch', direction: -1, sampleDur: 0.8 });
    expect(st.staged.timeFactor).toBeCloseTo(1, 10);
  });

  it('连续下调被 clampTau 下限夹住', () => {
    let st = fresh({ initialCandidateId: 's2' }); // dur 1.5 → floor 0.05/1.5
    for (let i = 0; i < 50; i++) {
      st = reducer(st, { type: 'AdjustStretch', direction: -1, sampleDur: 1.5 });
    }
    expect(st.staged.timeFactor).toBeCloseTo(0.05 / 1.5, 10);
  });

  it('连续上调被上限 8 夹住', () => {
    let st = fresh({ initialCandidateId: 's2' });
    for (let i = 0; i < 500; i++) {
      st = reducer(st, { type: 'AdjustStretch', direction: 1, sampleDur: 1.5 });
    }
    expect(st.staged.timeFactor).toBe(8);
  });

  it('sampleDur<=0（未解码）时不动作', () => {
    const st = reducer(fresh(), {
      type: 'AdjustStretch',
      direction: 1,
      sampleDur: 0,
    });
    expect(st.staged.timeFactor).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. AdjustPitch / TabFocus / SetStep / staging 丢弃
// ---------------------------------------------------------------------------

describe('AdjustPitch', () => {
  it('±1 累加，可为负', () => {
    let st = fresh();
    st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    st = reducer(st, { type: 'AdjustPitch', delta: -3 });
    expect(st.staged.semitoneDelta).toBe(-1);
  });
});

describe('TabFocus 循环', () => {
  it('input → pitch → stretch → input', () => {
    let st = fresh();
    expect(st.focus).toBe('input');
    st = reducer(st, { type: 'TabFocus' });
    expect(st.focus).toBe('pitch');
    st = reducer(st, { type: 'TabFocus' });
    expect(st.focus).toBe('stretch');
    st = reducer(st, { type: 'TabFocus' });
    expect(st.focus).toBe('input');
  });
});

describe('ResetFocusValue（Home 复位）', () => {
  it('target=pitch → delta 归 0，τ 不动', () => {
    let st = fresh({ semitoneDelta: 4, timeFactor: 1.3 });
    st = reducer(st, { type: 'ResetFocusValue', target: 'pitch' });
    expect(st.staged.semitoneDelta).toBe(0);
    expect(st.staged.timeFactor).toBe(1.3);
  });

  it('target=stretch → τ 归 1，delta 不动', () => {
    let st = fresh({ semitoneDelta: 4, timeFactor: 1.3 });
    st = reducer(st, { type: 'ResetFocusValue', target: 'stretch' });
    expect(st.staged.timeFactor).toBe(1);
    expect(st.staged.semitoneDelta).toBe(4);
  });
});

describe('SetStep', () => {
  it('合法正数更新 stepSec', () => {
    const st = reducer(fresh(), { type: 'SetStep', stepSec: 0.1 });
    expect(st.staged.stepSec).toBe(0.1);
  });

  it('非法值（0/负数/NaN）忽略', () => {
    expect(reducer(fresh(), { type: 'SetStep', stepSec: 0 }).staged.stepSec).toBe(0.05);
    expect(reducer(fresh(), { type: 'SetStep', stepSec: -2 }).staged.stepSec).toBe(0.05);
    expect(reducer(fresh(), { type: 'SetStep', stepSec: NaN }).staged.stepSec).toBe(0.05);
  });
});

describe('Cancel 丢弃 staging', () => {
  it('取消后 delta 归 0、τ 归 1、候选与选中清空', () => {
    let st = fresh({ initialCandidateId: 's2', semitoneDelta: 2, timeFactor: 1.4 });
    st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    st = reducer(st, { type: 'NavDelta', delta: 1, filtered: SAMPLES });
    expect(st.staged.semitoneDelta).toBe(3);
    st = reducer(st, { type: 'Cancel' });
    expect(st.decision).toEqual({ kind: 'cancel' });
    expect(st.staged.semitoneDelta).toBe(0);
    expect(st.staged.timeFactor).toBe(1);
    expect(st.staged.candidateId).toBeNull();
    expect(st.armedId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. createInitialState 起点
// ---------------------------------------------------------------------------

describe('createInitialState', () => {
  it('initialCandidateId 命中时 activeIdx 定位到该行并带入初始 delta/τ', () => {
    const st = fresh({ initialCandidateId: 's2', semitoneDelta: -2, timeFactor: 0.9 });
    expect(st.activeIdx).toBe(1);
    expect(st.staged.candidateId).toBe('s2');
    expect(st.staged.semitoneDelta).toBe(-2);
    expect(st.staged.timeFactor).toBe(0.9);
    expect(st.staged.stepSec).toBe(0.05);
    expect(st.decision).toBeNull();
    expect(st.focus).toBe('input');
  });

  it('打开面板不预置选中项（否则首次回车就直接提交，双保险形同虚设）', () => {
    expect(fresh({ initialCandidateId: 's2' }).armedId).toBeNull();
    expect(fresh().armedId).toBeNull();
  });

  it('initialCandidateId 未命中/为空时回退首行', () => {
    expect(fresh({ initialCandidateId: 'nope' }).activeIdx).toBe(0);
    expect(fresh({ initialCandidateId: null }).staged.candidateId).toBe('s1');
    expect(fresh().staged.candidateId).toBe('s1');
  });

  it('空素材列表：候选 null、stepSec 兜底 0.05', () => {
    const st = createInitialState({ samples: [] });
    expect(st.staged.candidateId).toBeNull();
    expect(st.staged.stepSec).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// 11. AdjustPitch 的 ±24 夹取（2026-09-20 用户实报「变调后无声」）
//
// 为什么这条必须有测试：`AdjustPitch` 会被**按键连发**命中（NotePalette 把
// `e.repeat` 直接传进来），而它早先没有上限 —— 按住 Shift+↑ 几秒就能把增量
// 推到 ±60。实测那个档位上 `@audio/shift-sample` 输出 −46.3dB（听不见）、
// `ST-声码器` 在 ratio≥8 时长度只剩 0.35× 且峰值 32 倍满刻度。
// 这个坏值还会被提交进事件并持久化，之后回放/导出**一直是坏的**。
// ---------------------------------------------------------------------------

describe('AdjustPitch 夹取（±24 半音）', () => {
  it('连按 100 次到顶也停在 +24，不会一路跑到 +60', () => {
    let st = fresh();
    for (let i = 0; i < 100; i++) st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    expect(st.staged.semitoneDelta).toBe(24);
  });

  it('反向同理停在 −24', () => {
    let st = fresh();
    for (let i = 0; i < 100; i++) st = reducer(st, { type: 'AdjustPitch', delta: -1 });
    expect(st.staged.semitoneDelta).toBe(-24);
  });

  it('夹取之内逐半音照常走（不到顶时不能被误夹）', () => {
    let st = fresh();
    for (let i = 0; i < 5; i++) st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    expect(st.staged.semitoneDelta).toBe(5);
  });

  it('打开面板时把存量坏值收口（上线前存下的 ±60 不再原样带回来）', () => {
    expect(fresh({ semitoneDelta: 60 }).staged.semitoneDelta).toBe(24);
    expect(fresh({ semitoneDelta: -60 }).staged.semitoneDelta).toBe(-24);
  });

  it('非有限值归零（NaN 会让 ratio 变 NaN，库直接抛「ratio must be finite」）', () => {
    expect(fresh({ semitoneDelta: Number.NaN }).staged.semitoneDelta).toBe(0);
    let st = fresh();
    st = reducer(st, { type: 'AdjustPitch', delta: Number.NaN });
    expect(st.staged.semitoneDelta).toBe(0);
  });

  it('提交进决策的值同样是夹过的（UI 显示与实际写入不会分家）', () => {
    let st = fresh();
    for (let i = 0; i < 40; i++) st = reducer(st, { type: 'AdjustPitch', delta: 1 });
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES });
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision).toMatchObject({ kind: 'apply', semitoneDelta: 24 });
  });
});

// ---------------------------------------------------------------------------
// 12. 「这条音符本来就装着素材」= 已经有目标（2026-09-20 用户实报）
//
// 旧语义把「有可调目标」等同于「用户按过 Enter」（`armedId != null`），
// 于是对着**已经装好素材**的音符按 Shift+A 进来调音，会被拦下并提示
// 「还没有选择素材 请按Enter选择素材」—— 明明有素材，却说没选素材。
//
// 修法：把「用户本次明确选中」（armedId）与「这条音符本来就装着的」（placedId）
// 分成两个概念，两者都能当目标。关键差别：
//   · armedId  —— 用户主动指向，可能是在**换**素材；
//   · placedId —— 这条放置的**现状**，只在打开面板时定下，光标改不动它。
// 正因为它不随光标变，才可以安全地当调音目标（光标会被鼠标悬停带走）。
// ---------------------------------------------------------------------------

describe('placedId：这条音符本来就装着的素材', () => {
  it('initialCandidateId 命中候选列表 → placedId 记下它', () => {
    expect(fresh({ initialCandidateId: 's2' }).placedId).toBe('s2');
  });

  it('没有 effectiveSampleId → placedId 为 null（这才真的「没有素材」）', () => {
    expect(fresh().placedId).toBeNull();
    expect(fresh({ initialCandidateId: null }).placedId).toBeNull();
  });

  it('effectiveSampleId 指向一个已不存在的素材 → placedId 为 null', () => {
    // 找不到就没有 durationSec 可用来算 τ 步进，界面上也指不出是哪一行
    expect(fresh({ initialCandidateId: '已删除的素材' }).placedId).toBeNull();
  });

  it('空素材列表：placedId 为 null（不会凭空造出目标）', () => {
    expect(createInitialState({ samples: [], initialCandidateId: 's1' }).placedId).toBeNull();
  });

  it('placedId 是「事实」：过滤/移动光标都不会改它', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES });
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES }); // 光标+选中一起去 s1
    expect(st.placedId).toBe('s2');
  });

  it('placedId 被过滤筛掉后依然有效（它是这条放置的现状，不是列表里的一行）', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'SetFilter', filter: '哈吉米', filtered: [SAMPLES[0]] });
    expect(st.placedId).toBe('s2');
    expect(tuneTargetId(st)).toBe('s2');
  });
});

describe('tuneTargetId：调音 / 变速 / 试听的目标', () => {
  it('既没选中、也没装配过 → null（这是唯一该弹「还没有选择素材」的情形）', () => {
    expect(tuneTargetId(fresh())).toBeNull();
  });

  it('只有 placedId → 它就是目标（不必先按 Enter）', () => {
    expect(tuneTargetId(fresh({ initialCandidateId: 's2' }))).toBe('s2');
  });

  it('armedId 优先于 placedId（用户明确改选了别的素材）', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'Arm', index: 0, filtered: SAMPLES }); // 选 s1
    expect(tuneTargetId(st)).toBe('s1');
    expect(st.placedId).toBe('s2'); // 事实不变，只是不再当目标
  });

  it('⛔ 绝不回落到光标行：光标移开也不改变目标（悬停不能改调音对象）', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'NavDelta', delta: 1, filtered: SAMPLES }); // 光标 → s3
    expect(st.staged.candidateId).toBe('s3');
    expect(tuneTargetId(st)).toBe('s2');
  });

  it('没有 placedId 时也不给光标兜底（宁可拦下，也不改路过的行）', () => {
    let st = fresh(); // 未装配
    st = reducer(st, { type: 'NavDelta', delta: 1, filtered: SAMPLES });
    expect(st.staged.candidateId).toBe('s2');
    expect(tuneTargetId(st)).toBeNull();
  });
});

describe('resolveTargetId：「应用」的目标（多一层光标兜底）', () => {
  it('只有 placedId → 用 placedId（调音改了谁就提交谁）', () => {
    expect(resolveTargetId(fresh({ initialCandidateId: 's2' }))).toBe('s2');
  });

  it('armedId 优先', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'Arm', index: 2, filtered: SAMPLES });
    expect(resolveTargetId(st)).toBe('s3');
  });

  it('⚠️ placedId 优先于光标行 —— 否则会出现「调的是 A、提交的是 B」', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'NavDelta', delta: 1, filtered: SAMPLES }); // 光标 → s3
    expect(resolveTargetId(st)).toBe('s2');
  });

  it('两者都没有才兜底光标行（既有契约保持不变）', () => {
    let st = fresh();
    st = reducer(st, { type: 'Arm', index: 1, filtered: SAMPLES });
    st = reducer(st, { type: 'Cancel' }); // 只验证 Apply 那一条，换一个干净路径
    st = fresh();
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES });
    expect(st.armedId).toBeNull();
    expect(st.placedId).toBeNull();
    expect(resolveTargetId(st)).toBe(st.staged.candidateId);
  });

  it('三处都空 → null（Apply 因此退化为 cancel）', () => {
    let st = reducer(fresh(), { type: 'SetFilter', filter: '查无此人', filtered: [] });
    expect(resolveTargetId(st)).toBeNull();
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toEqual({ kind: 'cancel' });
  });
});

describe('已装配音符：调音与提交同源（用户实报的那条链路）', () => {
  it('未按 Enter，直接调音再点「应用」→ 提交的就是这条放置的素材 + 新 Δ/τ', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'AdjustPitch', delta: 3 });
    st = reducer(st, { type: 'AdjustStretch', direction: 1, sampleDur: 1.5 });
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toEqual({
      kind: 'apply',
      sampleId: 's2',
      semitoneDelta: 3,
      timeFactor: expect.closeTo(1 + 0.05 / 1.5, 10),
    });
  });

  it('把光标移到别的行之后调音 + 应用 → 仍然落在原来那条（光标没改变目标）', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES }); // 光标 → s3
    st = reducer(st, { type: 'AdjustPitch', delta: -5 });
    st = reducer(st, { type: 'Apply' });
    expect(st.decision).toMatchObject({ kind: 'apply', sampleId: 's2', semitoneDelta: -5 });
  });

  it('回车选别的素材后就走正常链路：目标切到选中项', () => {
    let st = fresh({ initialCandidateId: 's2' });
    st = reducer(st, { type: 'NavDelta', delta: 2, filtered: SAMPLES }); // 光标 → s3
    st = reducer(st, { type: 'Confirm' }); // 第一次回车：只选中
    expect(tuneTargetId(st)).toBe('s3');
    st = reducer(st, { type: 'AdjustPitch', delta: 2 });
    st = reducer(st, { type: 'Confirm' }); // 第二次回车：确认
    expect(st.decision).toMatchObject({ kind: 'apply', sampleId: 's3', semitoneDelta: 2 });
  });

  it('⚠️ 双保险不因 placedId 而破功：光标停在已装配素材上时，首次回车仍只「选中」', () => {
    let st = fresh({ initialCandidateId: 's1' }); // 光标落在 s1（= placedId）
    expect(st.staged.candidateId).toBe('s1');
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision).toBeNull(); // 没有直接提交
    expect(st.armedId).toBe('s1');
    st = reducer(st, { type: 'Confirm' });
    expect(st.decision).toMatchObject({ kind: 'apply', sampleId: 's1' });
  });
});
