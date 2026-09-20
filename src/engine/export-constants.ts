import type { EffectSettings } from '../model/types';

/** 渲染尾部留白：保证混响尾 + 余量完整入包 */
export function tailSecFor(effects: EffectSettings): number {
  if (!effects.reverb.enabled) return 0.5;
  return effects.reverb.decaySec + effects.reverb.preDelaySec + 0.5;
}

/** 首部留白：防首样本被截 */
export const LEAD_IN_SEC = 0.05;
