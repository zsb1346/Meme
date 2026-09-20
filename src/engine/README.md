# 音频引擎层 API 契约（P2 UI 对接必读）

> 本目录是**纯 TS 引擎层，禁止 import React**（也不 import `model/store.ts`）。
> 所有模块通过**参数注入**接收配置；UI 层负责把 zustand store 的状态喂进来。
> **所有音乐时序一律来自 `audioContext.currentTime`**（本层已保证），UI 代码同样禁止用 `Date.now()` 参与任何调度。

## 0. 模块地图 & 依赖方向

```
core.ts ──→ (Tone.setContext 绑定)
effects.ts ──→ buildEffectChain / getMasterChain
sample-player.ts ──→ decode / cache / playSample
key-machine.ts ──→ KeyMachine（演奏语义）
recorder.ts ──→ TakeRecorder（录制 + 钢琴反馈音）
take-player.ts ──→ TakePlayer（Take 预览，lookahead 调度）
pitch.ts ──→ YIN 检测 / 半音换算（纯函数）
exporter.ts ──→ renderTake / encodeWav / encodeMp3 / exportTake
```

依赖规则：engine 内部只允许 `core → 其他` 单向引用；engine 不反向依赖 model/store/UI。

---

## 1. core.ts — 启动与解锁

```ts
import { installAudioUnlock, ensureAudioStarted, getAudioContext } from './engine/core';

// App 挂载时调用一次（幂等）：任意 pointerdown/touchend/keydown 自动 ctx.resume()
installAudioUnlock();

// 需要立即出声前：
const ctx = ensureAudioStarted();   // resume() 异步触发，失败仅告警
await ctx.resume();                 // 手势回调里可 await 确保就绪

// 任何地方需要原生上下文（解码、Analyser 等）：
getAudioContext();
```

要点：`getAudioContext()` 首次调用会创建 AudioContext 并 `Tone.setContext()` 绑定，
**必须先于任何 Tone 节点创建**。UI 只需保证「先调 core 再调 effects」。

---

## 2. effects.ts — 主总线效果链

链路固定：`input → EQ3 → Compressor → Chorus → Reverb → masterGain → Destination`，
每级可旁路。实时链是单例；离线渲染由 exporter 用同一个 builder 重建（导出=预览）。

```ts
import { getMasterChain } from './engine/effects';
import { useStore } from './model/store';

// 首次获取必须传 settings（App 启动时做一次即可）：
const chain = getMasterChain(useStore.getState().project.effects);

// store 里 effects 变化时重复调用同一函数 → 自动 apply 新参数（幂等）：
useStore.subscribe((s) => getMasterChain(s.project.effects));

// KeyMachine / TakePlayer / playSample 的 destination 都传 chain.input
// 需要「旁路监听」或接 Analyser 时从 chain.output 取
```

| API | 说明 |
|---|---|
| `getMasterChain(settings?)` | 实时主链单例；首次必传 settings，之后传则 apply |
| `buildEffectChain(settings)` | 在当前 Tone 上下文新建一条链（exporter 内部用；UI 不要直接调） |
| `chain.input / chain.output` | 接入点 / 取样点（Tone.Gain） |
| `chain.ready` | Reverb IR 就绪 Promise（离线渲染前必须 await；实时场景可忽略） |

---

## 3. sample-player.ts — 解码 / 缓存 / 播放

```ts
import {
  decodeAudioBlob, cacheBuffer, getCachedBuffer, dropCachedBuffer,
  playSample,
} from './engine/sample-player';

// 上传素材后（store.addSampleFromFile 已自动完成解码+缓存+时长/音高回填）：
const buf = getCachedBuffer(sampleId);          // 可能 null（页面刷新后未预热）

// 页面刷新后按需重建缓存：
const blob = useStore.getState().blobs[sampleId];
if (blob && !getCachedBuffer(sampleId)) {
  const buffer = await decodeAudioBlob(blob);
  cacheBuffer(sampleId, buffer);
}

// 直接播一声（一般不用；演奏请走 KeyMachine）：
playSample({
  buffer,
  destination: getMasterChain().input,
  semitones: 3,        // playbackRate = 2^(3/12)
  gainLinear: 1,
});
```

| API | 说明 |
|---|---|
| `decodeAudioBlob(blob)` | Blob → AudioBuffer（全局 ctx 解码） |
| `cacheBuffer(id, buf)` / `getCachedBuffer(id)` / `dropCachedBuffer(id)` | 运行时缓存 CRUD；删除素材时务必 drop |
| `playSample(opts)` | 底层播放。~4ms attack + ~12ms release 包络防爆音；返回 `{ when, durationSec, stop(fadeSec?) }` |

**缓存预热约定（P2）**：进入舞台/录制棚前，遍历本项目 keys.sequence 引用的 sampleId，
对未命中的逐个 `decodeAudioBlob(blobs[id])` + `cacheBuffer`。

---

## 4. key-machine.ts — 演奏核心语义

> 全项目最重要的不变量：**每次触发播放 `sequence[cursor]`，然后 `cursor=(cursor+1)%len`；
> 键与键完全隔离（各自独立游标）。**

```ts
import { KeyMachine } from './engine/key-machine';
import { computeSampleSemitones } from './engine/pitch';
import { getCachedBuffer } from './engine/sample-player';
import { getMasterChain } from './engine/effects';
import { useStore } from './model/store';

const machine = new KeyMachine({
  keys: useStore.getState().project.keys,
  resolveBuffer: (id) => getCachedBuffer(id),
  resolveSemitones: (id) => {
    const s = useStore.getState();
    const sample = s.project.samples.find((x) => x.id === id);
    return sample ? computeSampleSemitones(sample, s.project.settings) : 0;
  },
  destination: getMasterChain(useStore.getState().project.effects).input,
});

// StagePage pointerdown：
const result = machine.trigger(keyIndex);
// result: { triggered, slotIndex, cursorBefore, cursorAfter, ... }
// → 用 cursorAfter 更新 store 的 key.cursor（纯展示），并驱动按压动画

// 键配置被编辑后（增删键/改序列）必须同步：
machine.syncKeys(useStore.getState().project.keys);
```

| API | 说明 |
|---|---|
| `machine.trigger(keyIndex, {when?, velocity?})` | 触发一键；序列为空或缓冲缺失 = 哑触发（游标照常推进） |
| `machine.syncKeys(keys)` | 键数组变化后调用（按下标保留游标并夹取） |
| `machine.getCursor(i)` / `resetCursor(i)` / `resetAllCursors()` | 游标读取与重置 |
| `slotIndexForPress(pressCount, len)` | **确定性重放规则** `(pressCount-1)%len`；TakePlayer 与 exporter 共用，UI 不要另造规则 |

---

## 5. recorder.ts — 录制 + 钢琴反馈音

```ts
import { TakeRecorder } from './engine/recorder';

const recorder = new TakeRecorder();

// StudioPage「开始录制」：
recorder.start();

// 键位 pointerdown（录制中）——录音与发声已拆开：
//   notifyKeyPress 只记录事件，不发声；
//   playFeedback 只播钢琴参考音，不记录。
// 两步都由 StudioPage.wrappedTapKey 控制 —— 统一决策，杜绝叠加。
const ev = recorder.notifyKeyPress(keyIndex);
if (ev) recorder.playFeedback(keyIndex);   // 仅录制中需要

// 「停止」：
const take = recorder.stop(`录制 ${new Date().toLocaleTimeString('zh-CN')}`);
useStore.getState().addTake(take);

// 放弃 / 静音反馈：
recorder.cancel();
recorder.setFeedbackMuted(true);
```

- 反馈音 = 大调音阶真实音准（键位 0..n → C4 起 do re mi…跨八度循环），PolySynth 合成。
- 反馈音走独立 gain 直连输出：**不进效果链、不进导出**（物理隔离，无需 UI 处理）。
- `notifyKeyPress` 返回记录的 `TakeEvent`（含 1-based pressCount），可用于即时高亮。
- **不再内部发声**：`notifyKeyPress` 被拆成纯记录；发声统一由调用方 `playFeedback` 显式调用，避免与调用方的采样音叠加。

---

## 6. take-player.ts — Take 预览（lookahead 调度器）

25ms tick / 100ms 视界，事件用 ctx 时钟精确调度；槽位规则与导出一致。

```ts
import { TakePlayer } from './engine/take-player';

const player = new TakePlayer({
  project: useStore.getState().project,
  take,                                   // 要预览的 Take
  destination: getMasterChain().input,
  resolveBuffer: (id) => getCachedBuffer(id),
  resolveSemitones: (id) => /* 同 §4 */,
  callbacks: {
    onEventScheduled: (ev, when) => {/* 卷帘扫线/高亮 */},
    onEnded: () => {/* 复位播放按钮 */},
  },
});

player.start(0);      // 可传起始秒
player.isPlaying;     // boolean
player.stop();        // 未发声的已调度采样会被掐掉
```

---

## 7. pitch.ts — 音高检测与变调决策（纯函数）

```ts
import { detectPitchYin, computeSampleSemitones, playbackRateForSemitones } from './engine/pitch';

// 检测（store.addSampleFromFile 已自动做）；失败返回 null → UI 提供「手动锚定」输入框，
// 用户填 Hz 后调 store.updateSample(id, { detectedPitchHz }) 即可，引擎无感。
const hz: number | null = detectPitchYin(buffer);

// 最终半音偏移（归一开关在 settings.pitchNormalizationEnabled，LibraryPage 控制）：
const semis = computeSampleSemitones(sample, settings);
// semis → playbackRate = playbackRateForSemitones(semis)   [= 2^(semis/12)]
```

手动微调滑条（±半音）写 `store.updateSample(id, { manualSemitoneOffset })`；
归一关闭时它就是唯一变调来源。

---

## 8. exporter.ts — 导出 wav/mp3

```ts
import { exportTake, renderTake, encodeWav } from './engine/exporter';
import { downloadBlob } from './model/transfer';
import { flushSave } from './model/persistence';

const input = {
  project: useStore.getState().project,
  take,
  resolveBuffer: (id) => getCachedBuffer(id),   // 先按 §3 预热缓存！
};

// 一站式（渲染+编码+命名）：
const res = await exportTake(input, 'wav');     // 或 'mp3'（lamejs 动态加载，稍慢首帧）
downloadBlob(res.blob, res.filename);

// 只要渲染结果（ExportDialog 试听渲染产物时）：
const audioBuffer = await renderTake(input, { tailSec: 2.5 });
```

- 渲染期间会临时切换 Tone 全局上下文到 OfflineAudioContext，结束自动恢复；
  **渲染过程中不要并发触发实时发声**（ExportDialog 应在导出时禁用演奏区）。
- mp3 编码器是懒加载 chunk：首次点击导出会有一次网络/编译延迟，UI 请显示 loading。

---

## 9. P2 各页面对接速查

| 页面 | 必用模块 | 关键动作 |
|---|---|---|
| LibraryPage | pitch(间接) / store | 归一开关 `setPitchNormalization`；手动锚定 `updateSample(detectedPitchHz)` |
| SampleEditorModal | wavesurfer + store | 双击素材波形打开；Shift 拖拽选区 → `addSampleFromFile(regionBlob, name)` |
| StagePage | key-machine / effects / sample-player | 缓存预热 → `KeyMachine` → trigger 结果回写 cursor |
| StudioPage | recorder / key-machine / take-player | 录制三联：`TakeRecorder` + `KeyMachine` 并行；试听用 `TakePlayer` |
| MixPage | effects / store | 参数面板全部走 store setter（链自动 apply） |
| ExportDialog | exporter / transfer / persistence | 导出前 `flushSave()`；完成后 `downloadBlob` |

## 10. 已知坑位（务必遵守）

1. **先 core 后一切**：任何发声路径前确保 `ensureAudioStarted()` 已被调用过（App 已装解锁）。
2. **destination 永远传 `getMasterChain().input`**（除非刻意旁路，如反馈音）。
3. **不要缓存 `getMasterChain()` 的返回值跨模块传递**——HMR/测试可能 dispose 重建；用时现取。
4. **离线渲染串行化**：同时只允许一个 renderTake（内部切全局 Tone 上下文）。
5. **pressCount 是重放的唯一真相**：编辑 Take 事件时不得破坏 pressCount 的每键 1-based 连续性。
