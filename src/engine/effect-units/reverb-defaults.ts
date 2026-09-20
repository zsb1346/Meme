/**
 * 混响出厂默认值 —— **引擎层的单一事实来源**。
 *
 * 为什么要单独一个文件：
 *   · `model/store.ts` 的 `DEFAULT_EFFECTS` 需要它（新工程默认值）；
 *   · `engine/effect-units/reverb.ts` 的 `params[].def` 也需要它
 *     （双击旋钮复位用）。
 * 两处若各写一份数字，改一处必然漂移 —— 而「双击复位到 0 而不是默认值」
 * 这种不一致极难发现（`原型/js/components/knob.js` 就踩过这个坑：
 * 它的双击复位用的是量程中点，而不是 `def`）。
 *
 * 依赖方向：本文件在 engine/ 层，**不允许** import model/。
 * 所以是 model 来 import 这里，不是反过来。
 *
 * 数值取自 `原型/效果器/混响.html` 的 `state.defaults`：
 *   size 1.20 / decay 2.50s / preDelay 20ms / damping 0.40 /
 *   diffusion 0.70 / early 0.55 / lowCut 80Hz / highCut 12kHz /
 *   width 1.00 / mix 0.40
 */
import type { ReverbSettings } from '../../model/types';

/** 与原型 `state.defaults` 一一对应（字段名按本项目的命名约定转写） */
export const DEFAULT_REVERB_IR = {
  size: 1.2,
  decaySec: 2.5,
  preDelaySec: 0.02,
  damping: 0.4,
  diffusion: 0.7,
  early: 0.55,
  lowCutHz: 80,
  highCutHz: 12000,
  width: 1,
  wet: 0.4,
} as const;

/** 可直接塞进 `DEFAULT_EFFECTS.reverb` 的完整对象 */
export const DEFAULT_REVERB_SETTINGS: ReverbSettings = {
  enabled: true,
  ...DEFAULT_REVERB_IR,
};
