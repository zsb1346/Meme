/**
 * 结构守卫：**合成声绝不经过项目主效果链（EQ / 压缩 / 合唱 / 混响）。**
 *
 * 用户原话：「电子音不能被 Meme 项目的 EQ、混响影响，只被自己的影响。」
 *
 * 这条约束的现状是**已经成立**的（见 `engine.ts` 末尾那句
 * `analyser.connect(ctx.destination)`），但它随时可能被无意破坏 —— 而破坏之后
 * 没有任何报错：只会多一层混响，听感上很像「音色变好听了」，特别容易被收下。
 * 所以把它变成测试期的红。
 *
 * 为什么是「读源码断言」而不是跑一次听：
 *   · 判据本质是**依赖方向 + 出口唯一性**，两者都是静态可查的；
 *   · 真要听，得把 Tone 主链、AudioContext、Convolver 全跑起来，
 *     在 node 环境下测不到（这正是 `scripts/probe-synth.mjs` 存在的理由）。
 *
 * 为什么「不 import tone」就等于「不经过主链」：
 *   Tone 的主链（`buildEffectChain`）是 Tone 对象模型建起来的，链路入口
 *   `getMasterChain().input` 只在 `engine/effects.ts` 暴露。合成引擎只用原生
 *   WebAudio 节点、只 import `core`（上下文持有者）与 `pitch`（频率换算），
 *   它拿不到主链的任何节点 —— 除非有人主动去 import 它们。于是「不许 import」
 *   就是「物理上接不进去」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** 合成声部的全部产品源文件（不含测试） */
const SYNTH_SOURCES = ['engine.ts', 'index.ts', 'patch.ts'] as const;

/** 主效果链的持有者：Tone 本身，以及本项目组装它的那层 */
const FORBIDDEN = ['tone', '../effects', 'effect-units'] as const;

/**
 * 去注释后再看。两个理由：
 *   ① 本文件大量注释在**讨论** tone / 主链 / 混响（正是为了说明「为什么不许用」），
 *      不去注释的话这些负面断言会被自己的注释绊倒；
 *   ② 反过来，正面断言（必须出现的那句连接）去注释后依然在。
 * 只摘「行首的 //」，所以字符串里的 `https://` 不会被误伤。
 */
function readCode(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1');
}

/**
 * 抠出所有被 import 的模块说明符（静态 import / `export … from` / 副作用 import /
 * 动态 `import()` 全都要抓）。
 *
 * ⚠️ 必须允许**换行**：本仓库到处是
 *     `import {\n  A,\n  B,\n} from './x';`
 * 这种多行写法。第一版把换行排除在字符类外，于是多行 import 一个都抓不到 ——
 * 守卫在「提取器失灵」时会**空洞通过**，而一个永远为绿的守卫比没有守卫更糟：
 * 它让人以为这条规矩已经被守住了。（这个洞是被下面那条自检用例抓住的。）
 */
function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  // 允许 import 子句跨行，靠非贪婪在**第一个** from '…' 处收住
  for (const m of code.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)\b[\s\S]{0,800}?from\s*['"]([^'"]+)['"]/g,
  )) {
    out.push(m[1]);
  }
  for (const m of code.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push(m[1]);
  }
  return out;
}

/** 依赖方向命中判定：'tone' 命中 'tone'；'../effects' 命中 '../effects' / './effects' */
function matchesForbidden(spec: string): string | null {
  for (const f of FORBIDDEN) {
    if (spec === f || spec.endsWith(`/${f}`) || spec.startsWith(`${f}/`)) return f;
    // '../effects' 这种相对路径：比对最后两段，允许 './effects'
    const tail = f.startsWith('../') ? f.slice(3) : f;
    if (f.startsWith('../') && (spec === `./${tail}` || spec.endsWith(`/${tail}`))) return f;
  }
  return null;
}

describe('合成声不经过项目主效果链', () => {
  /*
    先证明「提取器真的在抓东西」。
    没有这一条，下面那些 `toEqual([])` 在提取器失灵时会**空洞通过**。
  */
  it('提取器本身有效（否则下面的断言都是空洞通过）', () => {
    const engineSpecs = importSpecifiers(readCode('engine.ts'));
    // 这一个是**多行** import，正是第一版漏掉的那类
    expect(engineSpecs).toContain('./patch');
    expect(engineSpecs).toContain('../pitch');
    // 各种写法都要认
    expect(importSpecifiers(`import * as Tone from 'tone';`)).toContain('tone');
    expect(importSpecifiers(`export { x } from '../effects';`)).toContain('../effects');
    expect(importSpecifiers(`import 'x';`)).toContain('x');
    expect(importSpecifiers(`await import('@audio/shift-pvoc');`)).toContain(
      '@audio/shift-pvoc',
    );
    expect(importSpecifiers("import {\n  a,\n  b,\n} from 'y';")).toContain('y');
  });

  it('合成声部的任何源文件都不 import Tone，也不 import 主链', () => {
    const offenders: string[] = [];
    for (const name of SYNTH_SOURCES) {
      for (const spec of importSpecifiers(readCode(name))) {
        const hit = matchesForbidden(spec);
        if (hit) offenders.push(`${name} → ${spec}`);
      }
    }
    expect(
      offenders,
      `合成声一旦 import 这些东西，就可能被接到 EQ / 混响后面：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('引擎的出口只有 ctx.destination 一处（不经过任何中间总线）', () => {
    const code = readCode('engine.ts');
    expect(code).toContain('analyser.connect(ctx.destination)');
    // 反证：主链入口、Tone 目的地都不许出现
    expect(code).not.toContain('getMasterChain');
    expect(code).not.toContain('Tone.getDestination');
  });

  it('入口层同样不碰主链（它只负责单例与 patch 记忆）', () => {
    const code = readCode('index.ts');
    expect(code).not.toContain('getMasterChain');
    expect(code).not.toContain('masterChain');
  });

  it('合成声不 import 导出链路（不进离线渲染 = 不进导出）', () => {
    const offenders: string[] = [];
    for (const name of SYNTH_SOURCES) {
      for (const spec of importSpecifiers(readCode(name))) {
        if (/exporter|offline/.test(spec)) offenders.push(`${name} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
