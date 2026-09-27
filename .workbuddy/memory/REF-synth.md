# REF-synth —— 合成声部（音色设计面板）内部结构

> 上游原型：`原型/效果器/VFX.html`（「清音合成器 Pro」，66 参数）。
> 摘要与硬规矩见 `MEMORY.md §L`；此处放结构细节。

## 1. 文件分工（单一职责，别再合并）

| 文件 | 职责 |
| --- | --- |
| `src/engine/synth/patch.ts` | **音色数据模型 + 唯一事实来源**：枚举/`*_OPTIONS`、`RAW_NUMERIC_SPECS`、`SynthPatch`(65 字段，无可选)、`SYNTH_BASE_PATCH`、`SYNTH_PRESETS`(**27 款**)、`sanitizeSynthPatch`、`quantizeSynthParam`、`patchIsAudible`、`patchFromPreset` |
| `src/engine/synth/engine.ts` | VFX 图结构的 TS 移植：`buildFx`(整链) + `SynthVoice` + `SynthEngine` + 两条曲线构造（`makeDistCurve` / `makeBitCurve`，导出**只为测试**） |
| `src/engine/synth/index.ts` | **对外唯一入口**：模块级单例 + `currentPatch` 权威副本；`playSynthNote` 等 |
| `src/components/synth/synth-params.ts` | 面板布局定义（`SYNTH_GROUPS` 六组）+ `paramsCoveredByPanel()` / `specOf()`。**范围不在这里** |
| `src/components/synth/SynthPanel.tsx` | 面板 UI（预设 / 试听 / 示波器+频谱 / 旋钮矩阵） |
| `scripts/probe-synth.mjs` | **绝对量验收入口**（见 §5） |

## 2. VFX 信号链（`buildFx` 严格照此顺序）

```
osc1 osc2 osc3 noise
  → 混音 → WaveShaper(soft|hard|fold) → 合唱
  → 延迟(HP/LP/反馈/声像) → 混响(Convolver + 预延迟 + 阻尼)
  → 位深量化(bitDepth) → 手写立体声矩阵(ChannelSplitter/Merger, 4 增益交叉)
  → 总声像 → 总滤波
```
调制路由：`FM`(osc2 → osc1.frequency)、`RM`(osc2 → rmGain.gain)、2 组 LFO（各带 pitch/filter/amp 三路增益）。

- **原生 WebAudio，不引 Tone.js**：本引擎只用原生节点（`WaveShaper.oversample`、
  `ChannelSplitter/Merger`、`Convolver` 原生更直接）。**唯一交汇是最后一句
  `analyser.connect(ctx.destination)`**，而 `ctx` 就是 `core.getAudioContext()` → 同硬件同钟。
- **⭐ 刻意删掉 VFX 那 6 个「增益恒为 1 的二传 LFO 节点」**：引擎级 LFO 增益直连声部参数
  → 32 声部省近 200 个节点。
- `MAX_VOICES = 32`（VFX 原 16），抢占最旧；`voiceBus` / `feedbackBus` 两条独立 0.9 增益。
- 主控：`masterGain → DynamicsCompressor(-12/24/8/0.003/0.22) → Analyser → destination`
  （线内限幅，防数字削顶）。
- 辅助函数：`makeDistCurve`、`makeBitCurve`、`makeIR`、`holdParam`。
- **`MIN_GAIN = 1e-4`**：`exponentialRampToValueAtTime(0)` 会抛 / 静音。
- **`cancelAndHoldAtTime` 兼容**：旧 Safari 无 → `holdParam()` 退回「读当前值 + cancel +
  `setValueAtTime`」。
- **`delayFb` 硬夹 0.92** 防自激啸叫。
- **TS 5.7+ TypedArray 缓冲区泛型**：`WaveShaperNode.curve` 要 `Float32Array<ArrayBuffer>`，
  手写 `: Float32Array` 会推成 `ArrayBufferLike` → **去掉返回类型注解让推断决定**。

## 3. 27 款预设

出厂两个：**「参考音 · 清铃」**（= `DEFAULT_SYNTH_PATCH`，刻意「干」：`delayMix=0`、
`reverbMix<0.2`，尾巴不能糊住拍点）+ **「基础锯齿 · 初始」**（= `SYNTH_BASE_PATCH`）。
其余 25 款移植自 VFX，族别：主音 / 贝斯 / 铺底 / Pluck / 键盘钟琴类 / 铃类 / Pad / 8bit / Riser。

⛔ **「参考音 · 清铃」的 `osc1Oct` 必须是 0** —— 参考音必须与按下的键**同音高**。
曾照抄原型的 `osc1Oct: 1 / osc2Oct: 2` → 按 C4 实际响 C5（离线渲染实测基频 521.7Hz）。
「跟弹参考音」的全部价值就是让你听出自己按的音对不对，高一个八度直接让判据失效。
想保留八度叠色 → **整组一起**下移。回归：`patch.test.ts`「出厂参考音必须与按键同音高」。

## 3.1 ⛔ 振幅包络的**起音必须线性**，不能跟衰减/释放一样用指数

指数斜坡从 `MIN_GAIN`(1e-4) 升到峰值，前 x% 的时间只走掉极小振幅：
`增益(t) = 1e-4 · (peak/1e-4)^(t/attack)`。取 peak≈0.26 → 比值 2600：
`ampAttack = 2s` 的音色在 t = 0.9s（面板试听音长）处增益只有 **5.7e-3**（比峰值低 45 dB）→ 等于没声。

**实测**：`上升 Riser · 紧张` 整段 rms ≈ 0（不是「小」，是没声）；把 `ampAttack` 改成 0.001
立刻出声；改成线性斜坡后 5 款慢起音预设（Pad / Riser）全部回到可闻，minRms 从 **0 → 1.4e-3**。

- 受害面是**整个慢起音家族**，而它们恰恰最需要「慢慢涨起来」——用户只会以为「这音色坏了」。
- decay / release 仍用指数（那是自然的衰减形态）；filter 包络也仍用指数（对数频率扫频是对的）。
- 多数预设的 `ampAttack ≤ 0.02s`，两种曲线在 20ms 内听不出差别 → 这个改动**只影响本来就该被听见的音色**。
- 相关：`noteOn` 的默认 `durationSec = 0.5`；面板试听用 0.9s；**没有任何 UI 路径按「按住」延音**
  （都是固定时长 + 自动 release），所以「起音时长 > 音符时长」＝ 直接静音。

## 3.2 ⛔ 波形整形曲线长度必须是**奇数**（`CURVE_LEN = 2049`）

`WaveShaperNode` 把输入 `x∈[−1,1]` 映射到索引 `(x+1)/2·(n−1)`。
`n` 为偶数时，输入 0 → 索引 `(n−1)/2` 是**半整数**，插值出一个非零常量 → **直流偏置**。

- 实测指纹：**rms ≈ peak**（常量信号的签名），−60 dBFS。正弦过零、乃至「所有音量=0」的静音 patch 都带。
- 直流听不见，但会喂进延迟/混响反馈，更要紧的是**污染「静音 = 绝对零」这条基线** ——
  而项目规矩是「判有没有出声必须用**绝对量**」，基线不干净则绝对量失效。
- 取奇数后 `x=0` 恰好落在 `i=(n−1)/2`，奇对称整形函数输出恒为 0。**修完静音 patch 渲染出精确 0**。
- 回归：`curve.test.ts`（把 WaveShaper 的索引映射照抄一遍，直接问「输入 0 时曲线给什么」）+
  探针里的 `静音 patch rms 必须 === 0`。

## 4. 测试

- `src/engine/synth/patch.test.ts`（28）：spec 默认值在范围内、log 的 min>0、基准 patch 键齐、
  sanitize 五种畸形输入 + 幂等、预设表（名唯一 / 只写合法键与值 / 无一款静音 / **出厂参考音同音高**）、quantize。
  （`FM_ALGOS` 也在这份里 —— 它是**数据**不是信号处理，放这儿 UI 侧就不必 import 整个引擎模块。）
- `src/components/synth/synth-params.test.ts`（17）：**每个数值参数都出现在面板**（含 `hidden`
  旋钮与 `addHarm` 数组）、无重复、组 id 唯一、段控选项非空互异、`specOf` 与引擎一致、
  `hidden` 旋钮 ↔ 专用编辑器白名单**双向一致**、每引擎下 `osc` 组都可见、`matrix` 组只含
  8 段控 + 4 深旋钮、**旋钮标签宽度 ≤ `KNOB_LABEL_MAX_WIDTH`**。
- `src/components/synth/fm-algo.test.ts`（9）：FM 算法图的几何 —— 4 个方框、无 `NaN`、
  坐标在视口内、输出轨数 = 发声中算子数、边数一致、算子 1 在底部、越界算法号被夹取、文案指向真实算法。
- `src/components/synth/wave-preview.test.ts`（11）：波表预览的几何 —— 采样点贴边界、全零/空数组
  是平线、非有限输入当 0、越界不画出画框、**归一化不变量（整体 ×10 形状不变）**、直流被忽略。
- `src/engine/synth/curve.test.ts`（5）：曲线长度奇数、输入 0 输出精确 0（三种削波 × 各档强度 + 各档位深）、
  旁通档是恒等直线。
- `src/engine/synth/voice-lifecycle.test.ts`（31）：**声部生命周期的唯一守卫**。自带一个
  **假 `BaseAudioContext`**（记录节点创建 / 连线 / start-stop / AudioParam 排程），
  因为 vitest 没有 Web Audio，整条「回收 + 归零」路径在单测里本来是**盲区**。
  覆盖：60 轮按下+松手不漏节点、`releaseAll`、同音抢占、自动释放、`dispose()`、
  **reaper 在 `dying` 未空时不许停表**、不留残余定时器、调制 LFO 不许直连 `AudioParam`、
  深度归零排在正确的时刻（自动释放排未来 / 松手提前到当下）、释放以精确 0 收尾、
  **七个引擎逐个按下都不抛**（见 §6.6）。
  四条**自检**用例证明 mock 真的在抓东西（节点数增长、`disconnect` 对未连接目的地抛错、
  **`start()` 第二次必须抛**、`stop()` 可以重复调）。
- `src/engine/synth/synth-isolation.test.ts`（5）：合成声不 import Tone / 主效果链 / 导出链路。

## 5. ⭐ 绝对量验收入口：`node scripts/probe-synth.mjs 5173`

**vitest 跑在 node 环境，没有 Web Audio** → `OfflineAudioContext` 不存在，
「到底有没有出声」在单测里**测不到**。所以退到浏览器：把 `SynthEngine` 直接实例化到
`OfflineAudioContext` 真渲染，量 rms / peak / 直流 / 基频。

- ⛔ 先起 dev server（`npx vite --port 5173 --strictPort`）；⛔ 跑前 `unset HTTP_PROXY …`（本机挂环境代理）。
- 退出码 0/1，失败项逐条列出。判定全为**绝对量或明确不变式**：
  ① 静音 patch 渲染必须**精确 0**；② 每款预设 rms > 2e-4（≈ −74 dBFS）；
  ③ 无预设 peak > 1.0；④ 出厂参考音基频落在 C4 ±3%；⑤ 恶意 patch 不许抛异常。
- **改音色表 / 改引擎后重跑**（面板试听与它用同一个引擎、同一音长 0.9s）。

## 5.1 ⭐ 第二入口：`node scripts/probe-synth-lifecycle.mjs 5173`

`probe-synth.mjs` 管「**按下去有没有出声**」；这个管「**松开之后有没有停**」。
三节，全部是绝对量或明确不变式（细节与修复前后对照 → §6.5）：

1. **释放结束之后必须静音**（27 款预设，干信号）：每款按其自己的 `ampRelease/fRelease`
   推量测窗口，量 `rms` —— 修复后**全部精确 0**。
2. **颤音必须还在**（反向守卫）：同音色「有 / 无 `lfoAmpAmt`」两组在同一时刻的能量比，
   期望 > 1.5（实测 4.31）。防的是「为了静音把 LFO 直接摘掉」这种矫枉过正。
3. **声部账目**：60 轮按下+松手后 `created === disposed`（实测 60/60；修复前 60/0）。

⛔ **必须证明它抓得住 bug**：把三处修复临时回退后重跑，会红 15 项、
且精确复现「14 款预设一直发声（全部 `lfoAmpAmt > 0`）+ 泄漏 60 个声部」。

## 6. ⛔ 「释放」与「回收」是两条**互相独立**的不变式

用户报的两个症状看起来像两件事，其实是同一段代码的两种走法：

> 「电子音是不是有 bug，有一些预设会一直发声（混响的回音）」
> 「按的多了就会声音卡顿，然后没声」

### 6.1 回收：`voices` 与 `dying` 是两个集合，缺一不可

`voices`（在响，谁该被热更新参数）与 `dying`（已释放，谁该被拆节点）**必须分开存**，
**任何释放都只经 `retire()` 把声部移交进 `dying`**。

- 老 bug：`noteOn` / `noteOff` / `releaseAll` 都是「`voices.delete()` → `voice.release()`」，
  而清扫器 `sweepVoices` **只遍历 `voices`** → **松过手的声部从此不可达，永远拆不掉**。
  - 后果①：调制源还连着 → 一直响（见 §6.2）
  - 后果②：每组声部约 20 个节点，按 60 次键就漏掉约 1200 个节点，
    全部仍在音频线程上跑 → **卡顿 → 没声**
- 另外 `release()` **必须允许 fast 抢占提速**（已 `dead` 但新的 `disposeAtSec` 更早时重排包络）：
  否则同音重按时，旧声部会拖着自己 2~4 秒的长释放继续响。
- `sweepVoices` 的停表条件必须是 **`voices.size === 0 && dying.size === 0`** ——
  只看 `voices` 会让 `dying` 里的声部没人收（这一条有专门的用例）。

### 6.2 静音：靠**排程**，不能靠 `disconnect`

`AudioParam` 的实际值 = 内置值 **+** 连入信号之和。所以「释放斜坡把包络拉到 `MIN_GAIN`」
**不等于静音** —— 只要 LFO 还连着，增益就一直在 `1e-4 ± lfoAmpAmt` 之间摆。

**⛔ 但也不能改成「release 时 disconnect」**：`disconnect()` **无法排程到未来时刻**，
而 `release()` 有一半的调用来自 `noteOn` 里那句「排一个 `durationSec` 之后才发生的自动释放」
—— 在那儿断开，等于**每次按音都把颤音当场摘掉**。
（这个坑真发生过：第一版修复就是这么写的，被 `voice-lifecycle.test.ts`
的「归零时刻」断言当场抓住 —— 症状是**所有带 `lfoAmpAmt` 的预设失去颤音**。）

**正解**：两路调制各走一个**声部私有、可排程**的深度级 ——

```
lfoAmp    ┐
          ├→ lfoAmpDepth(1)    ─→ amp.gain
lfo2Amp   ┘
lfoFilter ┐
          ├→ lfoFilterDepth(1) ─→ filter.frequency
lfo2Filter┘
```

释放时两条 `setValueAtTime(0, at)` 精确归零；深度为 1 时与直连在信号上完全等价（**音色不变**）。
**音高 LFO 不需要深度级**：振荡器被包络门控，调制它产生不了输出（有深度级就是白多一个节点）。

> 换句话说，`lfoAmp` / `lfoFilter` 这两路**永远不许直连 `AudioParam`** ——
> 这是一条结构性守卫，`voice-lifecycle.test.ts` 里有对应用例。

### 6.3 ⛔ 滤波那一侧更要紧：包络**管不住**它

滤波器在链路里位于包络**之前**（`mixer → filter → amp`），所以包络归零只能把滤波器输出
**乘小**，不能阻止它**继续产生**输出。而振荡器要到拆节点时才 `stop()` ——
也就是说释放之后，滤波器仍在被满幅信号持续喂着。

- 高 Q + 扫频 LFO 会**自激振铃**：「酸性 · 303 贝斯」（`filterReso: 18`、锯齿 LFO
  `lfoFilterAmt: 400`）修复前释放后 rms **2.83e-3**，反推滤波器自身电平约 **20**（远超 1.0）。
  → 归零 `lfoFilterDepth` 后降到 1.33e-4。
- 光归零调制还不够：包络停在 `MIN_GAIN = 1e-4` 时，`filterReso: 14 / 10` 的
  「低音 · 神经质」「低吼 Bass · 工业」残留恰好 **2.09e-4 / 2.04e-4** ——
  **正好卡在可闻下限 2e-4 上**。补一条 `amp.gain.setValueAtTime(0, at + rel)` 收尾到
  **精确 0**（指数斜坡到不了 0），残留归零。

### 6.4 探针窗口必须按**每个预设自己的释放长度**推

写死 `[2s, 4s]` 会把「管钟 · 教堂」的 **4 秒正常长释放**判成「还在响」—— 假阳性，
第一版就栽在这儿。`fromSec = noteSec + max(ampRelease, fRelease) + 0.4`。

### 6.5 复现与验收（修复前后对照，全部绝对量）

把三处修复临时回退后重跑探针，**红 15 项**，且精确复现用户原话：

| | 回退后（= 修复前） | 修复后 |
|---|---|---|
| 「一直发声」的预设 | **14 款**，全部 `lfoAmpAmt > 0`，rms 0.003~0.037 | **0 款** |
| 最响的那款 | 「颤音琴 · 流动」`lfoAmpAmt = 0.22` → **0.0368** | **0** |
| 「酸性 · 303 贝斯」（filterReso=18） | 0.00283 | **0** |
| 60 轮按键账目 | `created=60 / disposed=0` | **60 / 60** |
| 颤音仍在（能量比） | 4.31 | 4.31（**未被误伤**） |

> ⭐「**有一些**预设」这个分布本身就是线索：它排除了「全局效果器」「延迟反馈」
> 这类猜测，指向**逐声部的调制连接**。**症状的「分布」往往比症状本身更能定位根因。**

### 6.6 ⛔ 起振清单一份只能背一种语义（2026-09-27）

**症状**（只有探针看得见）：`probe-synth.mjs` 新增的「七引擎逐个离线渲染」段当场抛
`InvalidStateError: Failed to execute 'start' on 'AudioBufferSourceNode: cannot call start more than once`
—— 而且**只有 string 引擎中招**。

**真因**：`trigger()` 里那两条起振清单**一度是同一个数组** `extraStarts`：

```ts
for (const src of this.extraStarts) src.start(at);   // ① 通用起振
…
if (this.string) { …; st.burst.start(at); st.burst.stop(at + 0.06); }   // ② 弦鸣专属
```

而 `buildString()` 里 `this.extraStarts.push(burst)` → ① 和 ② **各 start 一次**。
异常从 `trigger()` 里逃出去 → `noteOn()` 后半段（排自动释放 + 注册声部）**整段被跳过**
→ 表现是「这个音色按下去完全没声」。

**两个清单的分工（现状，别再合并）**：

| 清单 | 语义 | 谁 push |
|---|---|---|
| `triggerStarts` | **`trigger` 负责 start** | 白噪声叠加支路、噪声引擎主源 |
| `extraStarts` | **只登记回收，`trigger` 不碰** | 粒子 grain（`scheduleGrains` 里自己 start）、噪声换色时换上的新源（`updateParam` 里自己 start）、弦鸣起振脉冲（`trigger` 的弦鸣分支自己 start 并排 0.06s 后的 stop） |

`dispose()` 两个清单都遍历（都要 stop + disconnect）。

**⛔ 为什么单测当时 29 条全绿也照不出来**：假 `BaseAudioContext` 的 `MockSource.start()`
只是把 `started = true` 置位（**幂等**），真机的 `InvalidStateError` 它根本不模拟。
**「假实现比真实现宽容」的地方就是这个 mock 的盲区。**

**已补的两道守卫**：

1. `guardStart()` —— `MockOsc` / `MockConstSource` / `MockSource` 的 `start()` 第二次一律抛
   （`stop()` 仍允许重复调，真机就是「最后一次生效」，别把释放路径误判成 bug）。
   加完之后**回退 `trigger` 的修复、证明这条会红**（红在
   `七个引擎按下去都不许抛` 与既有的 `${engineType}：能建出声部…` 两条）。
2. `七个引擎按下去都不许抛，且没有源被 start 两次` —— 逐引擎 `noteOn` + 同音重按 +
   换音（多声部），全程不许抛。

**⭐ 通用教训**：**一个清单背两种语义 = 一颗只在真机上炸的雷**。判据很简单 ——
往清单里 `push` 之前先问「**谁会 start 它，是不是同一处**」。
另外：**预设表全是经典引擎**（27/27），六个新引擎**只有把探针铺开才覆盖得到** ——
`probe-synth.mjs` 的七引擎段就是为这个存在的，别删。
