/**
 * Chorus 效果单元 —— 节点创建与参数应用逐字取自旧 effects.ts
 * （buildEffectChain 的 Chorus 分支 + applyChorus），零改动。
 *
 * 已修 Bug：旧版 `params` 只登记了 wet / depth / delayTimeMs，而
 * create/apply 使用了 rateHz / spreadDegrees —— 混音台上改不了 LFO 速率
 * 与立体声展开（此前只有 VST 风格弹层用 EXTRA_PARAMS 临时补了两个旋钮）。
 * 现已补全为 5 参数，弹层的 EXTRA_PARAMS 应随之清空。
 */
import * as Tone from 'tone';
import type { ChorusSettings } from '../../model/types';
import type { EffectUnit } from './types';

/** def 镜像自 model/store DEFAULT_EFFECTS（引擎层不 import store，见 eq.ts 注） */
export const chorusUnit: EffectUnit<ChorusSettings, Tone.Chorus> = {
  id: 'chorus',
  label: '合唱',
  en: 'Chorus',
  flowLabel: 'CHORUS',
  create: (s) =>
    // Chorus 的 LFO 必须 start() 才会动
    new Tone.Chorus({
      frequency: s.rateHz,
      delayTime: s.delayTimeMs,
      depth: s.depth,
      spread: s.spreadDegrees,
      wet: s.wet,
    }).start(),
  apply: (node, s) => {
    /**
     * 意图：每个参数过 Number.isFinite 检查，非有限值跳过不写。
     * 与 reverb-unit.ts 的 setParam 同理 —— 老存档缺字段时 undefined
     * 喂进 AudioParam 会抛 TypeError: non-finite，整页黑屏。
     * reverb-unit 已经修过这个坑（注释专门写了），合唱/压缩没做，
     * 同一个坑补上。坏值时节点保持上一次的有效值，不会崩。
     */
    if (Number.isFinite(s.rateHz)) node.frequency.value = s.rateHz;
    if (Number.isFinite(s.delayTimeMs)) node.delayTime = s.delayTimeMs / 1000;
    if (Number.isFinite(s.depth)) node.depth = s.depth;
    if (Number.isFinite(s.spreadDegrees)) node.spread = s.spreadDegrees;
    if (Number.isFinite(s.wet)) node.wet.value = s.wet;
  },
  readValue: (slice, key) => slice[key],
  params: [
    { key: 'wet', label: '干湿', unit: 'pct', min: 0, max: 1, step: 0.01, def: 0.35 },
    { key: 'depth', label: '深度', unit: 'pct', min: 0, max: 1, step: 0.01, def: 0.35 },
    { key: 'delayTimeMs', label: '延迟', unit: 'ms', min: 2, max: 30, step: 0.5, def: 6 },
    {
      key: 'rateHz',
      label: '速率',
      unit: 'hz',
      min: 0.1,
      max: 8,
      step: 0.1,
      def: 1.6,
      hint: 'LFO 调制频率',
    },
    {
      key: 'spreadDegrees',
      label: '立体声',
      unit: 'deg',
      min: 0,
      max: 180,
      step: 5,
      def: 120,
      hint: '左右声道的相位展开角度',
    },
  ],
};
