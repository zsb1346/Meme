/**
 * Reverb 效果单元 —— 自研 IR 合成 + 湿声滤波 + 立体声宽度。
 *
 * ══ 算法来源 ══
 * `原型/效果器/混响.html` 的 `generateIR()`，见 `./prototype-reverb.ts`。
 * 相对裸 `Tone.Reverb` 的差别是实质性的：后者的 IR 只是「噪声 × 指数衰减」
 * 一条平滑尾巴；本实现含四个物理环节 ——
 *   ① 左右独立的 7 个早期反射抽头（4/9/15/23/33/47/63ms，幅度 0.68^k）
 *   ② 扩散（0~3 次单极点低通，把噪声抹开）
 *   ③ 频率相关阻尼（截止随 damping 指数下降）
 *   ④ 双指数包络 `(1-t)^1.4 · e^(-2.2t)`
 * 空间感与前后层次是这四者叠加出来的，不是调出来的。
 *
 * ══ 10 个参数分两类（这个区分决定了 IR 会不会被无谓重建）══
 *   IR 参数：size / decay / damping / diffusion / early → 重建脉冲响应
 *   路径参数：preDelay / lowCut / highCut / width / wet → 只改 AudioParam
 * `preDelay` 在本实现里归入 IR 参数（拼成 IR 开头的静音段），
 * 而非原型的独立 DelayNode —— 这样 IR 自包含，少一个节点。
 */
import { DEFAULT_REVERB_IR } from './reverb-defaults';
import type { ReverbSettings } from '../../model/types';
import type { EffectUnit } from './types';
import { ReverbUnit } from './reverb-unit';

/** def 镜像自 model/store DEFAULT_EFFECTS（引擎层不 import store，见 eq.ts 注） */
export const reverbUnit: EffectUnit<ReverbSettings, ReverbUnit> = {
  id: 'reverb',
  label: '混响',
  en: 'Reverb',
  flowLabel: 'VERB',

  create: (s) =>
    new ReverbUnit({
      decay: s.decaySec,
      preDelay: s.preDelaySec,
      damping: s.damping,
      diffusion: s.diffusion,
      size: s.size,
      early: s.early,
      lowCutHz: s.lowCutHz,
      highCutHz: s.highCutHz,
      width: s.width,
      wet: s.wet,
    }),

  apply: (node, s) => {
    /*
      只写真正变化的字段。
      IR 参数的 setter 会触发整段脉冲响应重建（毫秒级 CPU + 内存分配），
      每次全量赋值会让「只改干湿」也重建一次 IR —— 白白卡一下且制造 GC 压力。
    */
    node.setIrParams({
      decay: s.decaySec,
      preDelay: s.preDelaySec,
      damping: s.damping,
      diffusion: s.diffusion,
      size: s.size,
      early: s.early,
    });
    // 路径参数：实时平滑，全程不碰 IR
    node.setWet(s.wet);
    node.setLowCut(s.lowCutHz);
    node.setHighCut(s.highCutHz);
    node.setWidth(s.width);
  },

  // 归一为 Promise<void>：聚合侧只关心「就绪与否」，不消费 IR 本体
  ready: (node) => node.ready,

  readValue: (slice, key) => slice[key],

  /**
   * 10 个参数，按原型的四组排列。
   *
   * `debounceMs` 只给 IR 参数加（400ms）—— 它们每次写入都重建 IR；
   * 路径参数保持默认 60ms，拖动时手感连续。
   */
  params: [
    /* ── 空间 / 时间 ── */
    {
      key: 'size',
      label: '空间',
      unit: 'raw',
      min: 0.3,
      max: 3,
      step: 0.01,
      def: DEFAULT_REVERB_IR.size,
      hint: '缩放早期反射的到达时间：越大空间越开阔',
      debounceMs: 400,
    },
    {
      key: 'decaySec',
      label: '衰减',
      unit: 'sec',
      min: 0.3,
      max: 10,
      step: 0.1,
      def: DEFAULT_REVERB_IR.decaySec,
      hint: '尾长。改动会重建脉冲响应',
      debounceMs: 400,
    },
    {
      key: 'preDelaySec',
      label: '预延迟',
      unit: 'ms',
      min: 0,
      max: 0.15,
      step: 0.005,
      def: DEFAULT_REVERB_IR.preDelaySec,
      hint: '干声与混响之间的间隔：越大空间感越远',
      debounceMs: 400,
    },

    /* ── 质感 ── */
    {
      key: 'damping',
      label: '阻尼',
      unit: 'pct',
      min: 0,
      max: 1,
      step: 0.01,
      def: DEFAULT_REVERB_IR.damping,
      hint: '高频吸收：0 明亮发硬，1 暗而闷',
      debounceMs: 400,
    },
    {
      key: 'diffusion',
      label: '扩散',
      unit: 'pct',
      min: 0,
      max: 1,
      step: 0.01,
      def: DEFAULT_REVERB_IR.diffusion,
      hint: '0 只听见离散反射（颗粒感），1 完全弥散',
      debounceMs: 400,
    },
    {
      key: 'early',
      label: '早期',
      unit: 'pct',
      min: 0,
      max: 1,
      step: 0.01,
      def: DEFAULT_REVERB_IR.early,
      hint: '早期反射强度 —— 人脑判断空间形状的主要依据',
      debounceMs: 400,
    },

    /* ── 滤波 / 立体声 ── */
    {
      key: 'lowCutHz',
      label: '低切',
      unit: 'hz',
      min: 20,
      max: 1000,
      step: 1,
      def: DEFAULT_REVERB_IR.lowCutHz,
      hint: '去掉混响里的低频堆积，避免糊底',
    },
    {
      key: 'highCutHz',
      label: '高切',
      unit: 'hz',
      min: 1000,
      max: 20000,
      step: 50,
      def: DEFAULT_REVERB_IR.highCutHz,
      hint: '让混响尾巴变柔，不刺耳',
    },
    {
      key: 'width',
      label: '宽度',
      unit: 'pct',
      min: 0,
      max: 2,
      step: 0.01,
      def: DEFAULT_REVERB_IR.width,
      hint: '0 单声道，1 原始，2 极宽（差分量加倍）',
    },

    /* ── 混合 ── */
    {
      key: 'wet',
      label: '干湿比',
      unit: 'pct',
      min: 0,
      max: 1,
      step: 0.01,
      def: DEFAULT_REVERB_IR.wet,
    },
  ],
};
