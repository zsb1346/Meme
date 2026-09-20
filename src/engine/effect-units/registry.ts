/**
 * 效果单元注册表 —— 链路顺序的唯一事实来源：
 * EQ3 → Compressor → Chorus → Reverb（与重构前 effects.ts 的硬编码顺序一致）。
 *
 * effects.ts 的链路组装与 MixPage 的面板渲染都按本数组序迭代：
 * 新增/调整一级 = 新增一个单元模块并在此登记，两处消费方自动跟随，
 * 不再各自维护一份会漂移的清单。
 */
import type { AnyEffectUnit, StageId } from './types';
import { chorusUnit } from './chorus';
import { compressorUnit } from './compressor';
import { eqUnit } from './eq';
import { reverbUnit } from './reverb';

/**
 * 有序注册表：数组顺序 = 信号流顺序。
 * 不得重排 —— buildEffectChain 按此序布线，导出渲染与实时预览共用
 * 同一条链，「导出 = 预览」依赖此序稳定。
 */
export const EFFECT_UNITS: readonly AnyEffectUnit[] = [
  eqUnit,
  compressorUnit,
  chorusUnit,
  reverbUnit,
];

export type { StageId };
