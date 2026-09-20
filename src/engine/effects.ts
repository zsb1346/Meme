import * as Tone from 'tone';
import { ensureAudioStarted } from './core';
import type { EffectSettings } from '../model/types';
import { EFFECT_UNITS } from './effect-units/registry';
import type { StageId } from './effect-units/types';

/**
 * 主总线效果链（计划 §4）：EQ3 → Compressor → Chorus → Reverb → 主增益 → 输出。
 * - 全部用 Tone.connectSeries 显式连接，规避 Tone/原生混接坑
 * - 每一级可独立旁路（BypassableStage：直连 or 经节点）
 * - 同一个 buildEffectChain 同时服务实时链与 OfflineAudioContext 导出渲染，
 *   保证「导出 = 预览」
 *
 * Wave 2 重构：各级节点的创建/应用参数逻辑下沉到 effect-units/*（注册表），
 * 本文件只保留链路组装、旁路壳与实时单例 —— 组装按 EFFECT_UNITS 的数组序
 * 迭代，不再硬编码任何一级。
 */

export interface EffectChain {
  /** 原生采样源接这里（KeyMachine / TakePlayer / playSample 的 destination） */
  readonly input: Tone.Gain;
  /** 链路末端（已连到当前上下文的 Destination） */
  readonly output: Tone.Gain;
  /** 应用新参数/开关（幂等，可高频调用） */
  apply(settings: EffectSettings): void;
  /** Reverb 冲激响应就绪；离线渲染前必须 await */
  readonly ready: Promise<void>;
  dispose(): void;
  /**
   * 按 stage id 取已创建的节点实例（供 UI 获取 EQ 段节点等内部状态）。
   * id 不存在或节点类型不匹配时返回 null。
   */
  getStageNode<T extends Tone.ToneAudioNode>(id: StageId): T | null;
}

/**
 * 安全断连：Web Audio 规范规定，对「没有任何输出连接」的节点调用
 * disconnect() 必须抛 InvalidAccessError，且规范未提供连接查询 API，
 * try/catch 是唯一可移植的探测手段。此处的异常恒为「本来就未连接」的
 * 预期分支（如默认关闭的级在首次初始化旁路时），静默是正确语义。
 */
function safeDisconnect(node: Tone.ToneAudioNode, destination?: Tone.ToneAudioNode): void {
  try {
    if (destination) node.disconnect(destination);
    else node.disconnect();
  } catch {
    // 未建立连接 —— 预期路径，非错误
  }
}

/** 单级旁路包装：enabled 时 in→node→out，否则 in→out 直连。 */
class BypassableStage<T extends Tone.ToneAudioNode> {
  readonly in: Tone.Gain;
  readonly out: Tone.Gain;
  private enabled: boolean;

  constructor(
    private readonly node: T,
    initiallyEnabled: boolean,
  ) {
    this.in = new Tone.Gain(1);
    this.out = new Tone.Gain(1);
    // 先置为相反状态，强制 setEnabled 完成初始布线
    // （避免「默认启用」时跳过 setEnabled 而残留直连边）
    this.enabled = !initiallyEnabled;
    this.setEnabled(initiallyEnabled);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    safeDisconnect(this.in);
    if (on) {
      this.in.connect(this.node);
      this.node.connect(this.out);
    } else {
      safeDisconnect(this.node, this.out);
      this.in.connect(this.out);
    }
    this.enabled = on;
  }

  dispose(): void {
    this.in.dispose();
    this.out.dispose();
  }
}

/** 注册表一级的运行时挂载：单元 + 已创建的节点 + 旁路壳 */
interface StageMount {
  readonly unit: (typeof EFFECT_UNITS)[number];
  readonly node: Tone.ToneAudioNode;
  readonly stage: BypassableStage<Tone.ToneAudioNode>;
}

/**
 * 在「当前 Tone 全局上下文」里搭建一条完整效果链并接到 Destination。
 * 实时链：先 core.getAudioContext()（内部已 Tone.setContext）。
 * 离线渲染：exporter 会临时把 Tone 上下文切到 OfflineAudioContext 再调本函数。
 */
export function buildEffectChain(settings: EffectSettings): EffectChain {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(Tone.dbToGain(settings.masterGainDb));

  // 按注册表序创建各级节点并包旁路壳（数组顺序即信号流顺序）
  const mounted: StageMount[] = EFFECT_UNITS.map((unit) => {
    const slice = settings[unit.id];
    const node = unit.create(slice);
    return { unit, node, stage: new BypassableStage(node, slice.enabled) };
  });

  // 显式分段连接：connectSeries 只用于「上一级 out → 下一级 in」的边界，
  // 绝不能把 stage.in / stage.out 连续传入同一个 connectSeries ——
  // 那会给每级额外加一条 in→out 直连干声边，破坏旁路语义。
  let prev: Tone.ToneAudioNode = input;
  for (const m of mounted) {
    Tone.connectSeries(prev, m.stage.in);
    prev = m.stage.out;
  }
  Tone.connectSeries(prev, output);
  Tone.connect(output, Tone.getDestination());

  // 聚合各单元的 ready()（目前只有 Reverb 的 IR）；任一失败降级为干声继续
  const ready: Promise<void> = Promise.all(
    mounted.map(({ unit, node }) => (unit.ready ? unit.ready(node) : Promise.resolve())),
  )
    .then(() => undefined)
    .catch((err) => {
      console.warn('[effects] Reverb 冲激响应生成失败，将以干声继续', err);
      /**
       * 意图：IR 失败时把 reverb 级的 wet 设为 0，真正降级为纯干声。
       * 旧版只打了 console.warn，没有改 wet —— 表现是"干声 60% + 湿声静音 40%"
       * （reverb 节点仍在信号路径中但没 IR → 静音），音量掉了 40% 而不是没混响。
       * 设 wet=0 后 reverb 级变为纯直通，音量正常。
       */
      for (const m of mounted) {
        if (m.unit.id === 'reverb') {
          m.unit.apply(m.node, { enabled: true, wet: 0 } as any);
          break;
        }
      }
    });

  const chain: EffectChain = {
    input,
    output,
    ready,
    apply(next: EffectSettings) {
      for (const m of mounted) {
        const slice = next[m.unit.id];
        m.unit.apply(m.node, slice);
        m.stage.setEnabled(slice.enabled);
      }
      output.gain.rampTo(Tone.dbToGain(next.masterGainDb), 0.05);
    },
    getStageNode<T extends Tone.ToneAudioNode>(id: StageId): T | null {
      const m = mounted.find((m) => m.unit.id === id);
      return m ? (m.node as T) : null;
    },
    dispose() {
      for (const { stage, node } of mounted) {
        stage.dispose();
        node.dispose();
      }
      input.dispose();
      output.dispose();
    },
  };
  return chain;
}

// ---------------------------------------------------------------------------
// 实时主链单例
// ---------------------------------------------------------------------------

let master: EffectChain | null = null;

/**
 * 取实时主效果链单例。
 * 首次调用必须传 settings（App 启动时用 store 里的 project.effects）；
 * 之后任何时机再传都会 apply 最新参数 —— App 订阅 store 变化时重复调用即可。
 *
 * 根治「Tone 默认上下文漂移」：若调用方在本函数之前从未触发
 * core.getAudioContext()，Tone 会自建默认 AudioContext，导致主链与后续
 * 原生节点（采样源/AnalyserNode）分属两个 context，connect 时抛
 * InvalidAccessError。故此处先 ensureAudioStarted() 强制对齐 —— 它是幂等的：
 * ctx 已存在时不会重复 setContext，因此不影响 exporter 的离线渲染切换。
 */
export function getMasterChain(settings?: EffectSettings): EffectChain {
  ensureAudioStarted();
  if (!master) {
    if (!settings) {
      throw new Error('[effects] 首次获取主效果链必须传入 EffectSettings');
    }
    master = buildEffectChain(settings);
  } else if (settings) {
    master.apply(settings);
  }
  return master;
}

/** 测试/HMR 用：销毁并丢弃实时主链。 */
export function disposeMasterChain(): void {
  master?.dispose();
  master = null;
}
