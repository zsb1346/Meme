/**
 * 结构守卫：**卷帘永远只能发合成声，不能碰素材**。
 *
 * 用户原话：「我希望的是只播放合成音，不播放素材」。
 * 这条约束的特点是**没有运行时症状** —— 一旦破坏，用户按一个键会同时听到
 * 「参考音 + 素材」两响，音量叠起来更像「音色变厚了」，很容易被当成音色
 * 调得好而收下。所以把它变成测试期的红，而不是等人耳朵发现。
 *
 * 为什么是「读源码断言」而不是跑一次听：素材播放路径依赖已解码的
 * AudioBuffer、依赖 AudioContext 真跑起来，在 node 里测不到；而这条约束
 * 本质是**依赖方向**的问题 —— 依赖方向恰好是静态可查的。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** 卷帘这一族的全部源文件（含新建的纯映射层） */
const ROLL_SOURCES = [
  'useRollController.ts',
  'renderer.ts',
  'geometry.ts',
  'keyboard-play.ts',
  'RollCanvas.tsx',
  'RollEmptyState.tsx',
] as const;

/** 这些模块都会（或可能）真的把素材送去发声 —— 卷帘一律不许依赖 */
const FORBIDDEN = [
  'sample-player',
  'take-player',
  'engine/recorder',
  'engine/exporter',
  'engine/offline',
] as const;

const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('卷帘只发合成声', () => {
  it('卷帘的任何源文件都不 import 素材播放 / 导出链路', () => {
    const offenders: string[] = [];
    for (const name of ROLL_SOURCES) {
      const src = read(name);
      for (const bad of FORBIDDEN) {
        if (src.includes(`'${bad}'`) || src.includes(`"${bad}"`)) {
          offenders.push(`${name} → ${bad}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('键盘弹奏确实接了合成声部（否则守卫会因为「什么都没接」而假绿）', () => {
    const src = read('useRollController.ts');
    expect(src).toContain("from '../../engine/synth'");
    expect(src).toContain('playSynthNote');
    expect(src).toContain('releaseSynthNote');
  });

  it('按下与松手成对出现（按住延音靠 keyup 收，缺一边会留下挂住的长音）', () => {
    const src = read('useRollController.ts');
    expect(src).toContain("addEventListener('keydown'");
    expect(src).toContain("addEventListener('keyup'");
    // 失焦也必须收：切窗口 / 切标签页时 keyup 收不到
    expect(src).toContain("addEventListener('blur'");
  });
});
