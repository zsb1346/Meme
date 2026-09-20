/**
 * Compressor 效果单元 —— 节点创建与参数应用逐字取自旧 effects.ts
 * （buildEffectChain 的 Compressor 分支 + applyCompressor），零改动。
 *
 * 已修 Bug：旧版 `params` 只登记了 thresholdDb / ratio，而 create/apply
 * 使用了 attackSec / releaseSec —— 混音台上改不了启动与释放时间
 * （此前只有 VST 风格弹层用 EXTRA_PARAMS 临时补了两个旋钮，两处不一致）。
 * 现已补全为 4 参数，弹层的 EXTRA_PARAMS 应随之清空。
 */
import * as Tone from 'tone';
import type { CompressorSettings } from '../../model/types';
import type { EffectUnit } from './types';

/** def 镜像自 model/store DEFAULT_EFFECTS（引擎层不 import store，见 eq.ts 注） */
export const compressorUnit: EffectUnit<CompressorSettings, Tone.Compressor> = {
  id: 'compressor',
  label: '压缩器',
  en: 'Compressor',
  flowLabel: 'COMP',
  create: (s) =>
    new Tone.Compressor({
      threshold: s.thresholdDb,
      ratio: s.ratio,
      attack: s.attackSec,
      release: s.releaseSec,
    }),
  apply: (node, s) => {
    /**
     * 意图：同 chorus.ts —— 每个参数过 Number.isFinite 检查。
     * 压缩器参数（threshold/ratio/attack/release）任一为 undefined/NaN
     * 都会导致 AudioParam 写入抛异常，整页崩溃。
     * 坏值时节点保持上一次的有效值，听感不变但不崩。
     */
    if (Number.isFinite(s.thresholdDb)) node.threshold.value = s.thresholdDb;
    if (Number.isFinite(s.ratio)) node.ratio.value = s.ratio;
    if (Number.isFinite(s.attackSec)) node.attack.value = s.attackSec;
    if (Number.isFinite(s.releaseSec)) node.release.value = s.releaseSec;
  },
  readValue: (slice, key) => slice[key],
  params: [
    { key: 'thresholdDb', label: '阈值', unit: 'db', min: -60, max: 0, step: 1, def: -18 },
    { key: 'ratio', label: '压缩比', unit: 'ratio', min: 1, max: 20, step: 0.5, def: 3 },
    {
      key: 'attackSec',
      label: '启动',
      unit: 'sec',
      min: 0.001,
      max: 0.5,
      step: 0.001,
      def: 0.005,
      hint: '越长越保留瞬态',
    },
    {
      key: 'releaseSec',
      label: '释放',
      unit: 'sec',
      min: 0.01,
      max: 1,
      step: 0.01,
      def: 0.18,
      hint: '越长越平滑',
    },
  ],
};
