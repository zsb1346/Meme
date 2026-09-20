import { KeyMachine } from './key-machine';
import { useStore } from '../model/store';
import { getCachedBuffer } from './sample-player';
import { getMasterChain } from './effects';
import { resolveSemitonesIn } from '../model/pitch-resolve';
import type { Key } from '../model/types';

let machine: KeyMachine | null = null;

/**
 * 全局唯一 KeyMachine；两页共用同一实例，游标一致。
 *
 * destination 改为每次 trigger 时现查 getMasterChain()：
 * 主效果链若被重建（HMR / 开发时常见），旧的 destination 指向已拆掉的节点，
 * 之后按键全哑。动态 getter 保证始终接最新的链。
 */
export function getKeyMachine(): KeyMachine {
  if (!machine) {
    machine = new KeyMachine({
      keys: useStore.getState().project.keys,
      resolveBuffer: (id) => getCachedBuffer(id),
      resolveSemitones: (id, targetPitchMidi) =>
        resolveSemitonesIn(useStore.getState().project, id, targetPitchMidi),
      // destination 改为动态 getter，每次 trigger 时现查
      get destination() {
        return getMasterChain(useStore.getState().project.effects).input;
      },
    });
  }
  return machine;
}

/** 配置变更后同步 */
export function syncKeyMachine(keys?: Key[]): void {
  machine?.syncKeys(keys ?? useStore.getState().project.keys);
}

/** 重置单例（测试/HMR 用） */
export function resetKeyMachineSingleton(): void {
  machine = null;
}
