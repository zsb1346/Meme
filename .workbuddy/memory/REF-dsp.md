# REF-dsp —— 降调沙沙的完整推导、实测表与参考项目

> 这是 `MEMORY.md` 的**附录**。MEMORY.md 只写「规矩」，本文件保存推导过程、
> 实测数字与外部参考 —— 需要**理解为什么**或**重新论证**时读这里。
> 对应主题：`psola.rs`、降调 HNR、PitchNet 对照、第三方变调引擎选型。

---

## 1. PitchNet 的三条出声路径（别混）

| # | 路径 | 代码位置 | 特征 |
|---|---|---|---|
| ① | 拖动音符试听 | `ResampledLoopAudition::render` | **纯线性重采样** `out[i]=src[i*pitchRatio]`，增益 −6dB。零颗粒、零合成，不可能因合成变毛 |
| ② | 最终渲染（默认） | `Vocoder` | HiFiGAN 声码器 |
| ③ | 经典 PSOLA | `usePsola = (synthesisEngine == Psola)` | Linux 或推理失败才走。**这条才是我们移植的对象**（v0.5.5 的 "classic rendering algorithm"） |

②/③ 的二选一在 `IncrementalSynthesizer.cpp:1767`：
`if (usePsola) psola.renderAsync(...) else vocoder->inferAsync(...)`。

默认引擎在 `原型/.../Source/Audio/SynthesisEngineType.h:19-26`：
```cpp
#if JUCE_LINUX
    return SynthesisEngineType::Psola;   // 只有 Linux 默认经典 PSOLA
#else
    return SynthesisEngineType::Vocoder; // macOS/Windows 默认 PC-NSF-HiFiGAN
#endif
```

### 判断「听到的是什么」——读日志，不要靠代码推测

| 文件 | 里面有 |
|---|---|
| `%APPDATA%/PitchNet/config.json` | `synthesisEngine`（`"Vocoder"`/`"PSOLA"`）、`liveAuditionEnabled`、`pitchDetector`、`device` |
| `%APPDATA%/PitchNet/Logs/debug_<会话>.log` | **每次渲染一行** `synthesizeRegion: engine=Vocoder\|PSOLA … 0.75s` |
| `%APPDATA%/PitchNet/Logs/vocoder_<会话>.txt` | 模型加载与执行设备（`Execution device set to: CPU`） |

统计：
```bash
grep -h "synthesizeRegion: engine=" debug_*.log | sed 's/.*engine=//' | awk '{print $1}' | sort | uniq -c
```

**2026-09-19 实测**：`config.json` = `"synthesisEngine": "Vocoder"` + `"liveAuditionEnabled": false`；
4 个会话共 **152/152 次 `engine=Vocoder`**，零次 PSOLA、零次 DirectML 回退。
→ 用户**从来没听过** PitchNet 的 PSOLA；他说的「干净舒服」百分百是神经声码器。
→ 路径①（拖动试听）在他机器上是**关着**的，那次听感与 `ResampledLoopAudition` 无关。

### 声码器为什么天然干净 + 天然保共振峰

- 模型 **2 个输入**：`mel[T,128]` + `f0[T]`。`Vocoder.cpp:411-412`
  `inputTensorScratch.reserve(2)` / `melShapeScratch.resize(3)` / `f0ShapeScratch.resize(2)`。
  日志只打印 `inputNames[0]` → 看起来像只有一个输入，**别被那行日志骗**。
- **mel 来自导入时预算的源音频**（`IncrementalSynthesizer.cpp:1200`
  `melRange.assign(audioData.melSpectrogram…)`），**变调完全不改 mel**，只改 F0。
  → 频谱包络不动 = **共振峰自动保持**（不变花栗鼠），同时 NSF 用新 F0 生成干净周期激励。
- mel 参数（`MelSpectrogram.h`）：`nFft=2048, hop=512, numMels=128, fMin=40, fMax=16000`，log 刻度。
- `hnsep/hnsep_VR.onnx`(92MB) 在 `Source/` 里**零引用**（未启用的谐波/噪声分离模型），不是管线的一部分。

---

## 2. HNR 判据与实测

`scripts/_probe-hnr.mjs`（带 `--selftest`）。原理：h = 周期同步平均（谐波），r = x − h，
`HNR = 20log10(rms(h)/rms(r))`。**必须分数周期 + 按相位索引模板**，否则干净的元音也量出负值
（`--selftest` 就是防这个：纯谐波应 >25dB 且随噪声单调下降）。

同一输出音高下三路对比（关键是 **PSOLA vs 纯重采样**：两者输出 f0 相同、估计器偏置相同）：

| 素材 | 半音 | 源 HNR | 纯重采样 | PSOLA | PSOLA−重采样 |
|---|---|---|---|---|---|
| 慢米 | −1.8 | 9.27 | 9.36 | 10.35 | **+0.99** |
| 米 | −5.6 | 2.01 | 4.39 | 1.76 | −2.63 |
| 龙.001 | −8.2 | 10.26 | 13.27 | 9.32 | −3.95 |
| 啊 | −9.1 | −2.97 | 2.80 | −3.35 | −6.15 |
| 高北 | −12.0 | 4.97 | 11.73 | 1.98 | **−9.75** |

**拐点在约 −5 半音**：比这浅 PSOLA 不吃亏（甚至 +1dB），比这深**单调加噪**，−12 时差近 10dB，
且周期性同步塌（0.973→0.883）。同时**源本身就很毛**（龙 10dB、米 2dB），PSOLA 忠实搬运
→ 「沙沙」= 源的毛 + 降调时叠的 4~10dB。

**已排除**：局部增益匹配（`MAX_GAIN` 临时改 1.0 只许衰减，HNR 变化 **0.00dB**）。

---

## 3. 为什么只有降调受害 —— 收敛成一个几何量

令 `A = 1/ratio = advance/period`，接缝处三件事全部由它决定：

- 重叠占比 = `1 − 1/(2A)`（占窗宽）：`A=1.33(.75)→33%`、`A=1.61(.62)→19%`、`A=2(.50)→**0%**`
- 窗和 `Σw = 1 + cos(πA/2)`：`A=1.5→0.293`、`A=2→0`
  （`MIN_ENVELOPE=0.3` 的 floor 从 −7.02 半音起介入）
- **相干增益 = |cos(π·frac(A))|** —— 重叠区两颗颗粒读的是源里相隔 `frac(A)` 个周期的材料，
  所以接缝相位失配**恰好等于 A 的小数部分**：
  `A=1.5→0`（**完全抵消**，−7 那个台阶的成因）、`A=1.6129→0.35`、`A=1.25→0.5`、`A=1→1`

三者叠加 = 接缝处**局部 SNR 下陷，以颗粒率（= 输出音高）做幅度调制** → 听成沙沙/嗡嗡。
深降调时接缝占比上升、Σw 趋零；−12 时干脆没有重叠 = 一串孤立 Hann 包夹着静音（100% AM）。

**更正旧记录**：「Σw 除法把噪声放大了 ×5」**不准确** —— 除法对信噪比中性（分子分母同比）。
真实机制是**相干抵消打在谐波上**，而不相干叠加的噪声只按 √ 衰减（×0.707）
→ 接缝 SNR 相对中段下陷。

**推论**：以上恶化**全部来自 `A ≠ 1`**，而 `A = 1/ratio` 只是因为**单段式让颗粒几何去承担变调**。

### 判决实验（仍然有效，别丢）

同一套 marks、同样颗粒几何，只换喂进内核的内容（龙.001 @−8.23）：
原始素材 **9.07 dB** / 严格周期成分 **14.02 dB**（比源 10.72 还干净）
→ 重叠相加对周期内容是干净的，**沙沙来自源里的非周期成分被颗粒重排**。
但「所以要把非周期成分拿出去」这个推论是错的 —— 正确的是
「非周期成分要**跟着一起变调**，只是不走颗粒重排」。

---

## 4. 已否决路 A：mode 3 = PSOLA + 谐波/噪声分离

**结论先行**：`hajimi_tx_run` 的 mode 3 把降调侧 HNR 提上去、HF 分档压到源以下，
**每一项客观指标都变「干净」**，但用户戴上耳机的判定是 ——
**「这个结果很糟糕，噪音变成另一种形式了」**。已从 `sample-player.ts` 默认链路撤下（回 `[1,2]`）。
实现与探针保留，但**不要重新接回默认链路**，除非有听感证据翻转。

**为什么指标好、耳朵坏**（本项目最重要的一条教训）：
HNR 这类「周期可解释度」**对"净化"的奖励是单调的** —— 纯正弦的 HNR 是 +∞。
拿它当目标函数，最优点必然是把人声做成合成器。实际发生的是：
1. 抽掉的「非周期成分」不是脏东西，它是**气声、辅音、微抖动** —— 恰恰是让声音像人声的部分；
2. 剩下的严格周期谐波在颗粒重排下变成**机械的嗡嗡/金属声**。这不是新增失真，
   而是 TD-PSOLA 的固有 artifact（文献里叫 **buzzyness**）—— 源里的气声本来**掩盖**着它，
   把气声抽走等于把它露出来；
3. 残余只加回一半（β(0.62)=0.5），且加在**原位频谱**上，而谐波已经下移 8 个半音 ——
   两层不再属于同一个声音，噪声变成「浮在低音上面的一层」。

**为什么这条路本身也不对**：成熟做法是**按频带**估非周期性并把噪声**用谱包络重新生成**
（WORLD/D4C），而不是「全带波形相减 + 残余原样加回」。文献里甚至有和本次现象逐字对应的
已知失效：「密集的全带齿音气流在重合成为谐波成分后会变成**刺耳的脉冲串**」。

---

## 5. 已否决路 B：两段式（TSM + 重采样）

原理上直击 `A≠1` 的根因（伸缩阶段颗粒间距恒 = 分析周期 → `A ≡ 1`、重叠恒 50%、`Σw ≡ 1`），
且几乎零改动：
```
两段式 = apply_planar(x, sr, pitch=1, time = time*pitch)   // 复用现有内核，内核一行不改
         + resample(1/pitch)                               // 唯一的新代码
```
`wasm/src/` 里**目前没有任何重采样器**（`grep resample|sinc` 为空）。

**⛔ 2026-09-19 已与用户当面确认：代价不可接受 → 撤回，不落地。**
代价是重采样把**共振峰一起搬走**（×ratio），而用户要的听感（PitchNet 那种「干净又舒服」）
恰恰来自**共振峰不动**（声码器 mel 不变、只换 F0）。那是拿一个缺陷换另一个缺陷，
不是净改善，且用户明确说「成本太高」。
**后续别再把它当新方案提出来**，除非目标明确是「怪物音」这类刻意改变音色的效果。

---

## 6. 成熟方向与参考资料

在纯 DSP 里往上走的正确一步是**源-滤波器**，不是继续在 PSOLA 上做波形级分离。

| 项目 | 是什么 | 为什么值得看 |
|---|---|---|
| **WORLD / D4C**（mmorise/World，BSD，无专利） | F0(DIO/Harvest) + 谱包络(CheapTrick) + **频带非周期性(D4C)** 三分量 | **该走的路线**：非周期不是「残差波形」而是**每频带的 α**，合成时用 `α²P_x / (1−α²)P_x` 把噪声**重新生成** → 噪声天然跟着变调。已知坑与我们的同源：V/UV 边界 + 齿音把噪声误判成谐波 → 刺耳脉冲串 |
| **Praat**（Boersma & Weenink） | `Sound: Change pitch`，PSOLA 教科书写法 | pitch mark 用自相关 + 严格清浊判决；窗长取局部周期 **2~4 倍**（50%~75% 重叠） |
| **PyTSMod** | `tdpsola`/`hptsm`/`wsola`/`pv` | 做 A/B 最省事 |
| **Autotalent** / **TalentedHack** | 开源**修音**插件（PSOLA 系） | 「修音」场景的现成实现 |
| **sannawag/TD-PSOLA** | 最小 TD-PSOLA | README 自述：**<700 音分才基本无 artifact，位移越大越差，只对 voiced 成立** |
| **Rubber Band R3** / **signalsmith-stretch** | 现代高质量 | 「高质量长什么样」的对照 |
| **Longster 2003** / **SBrT'05** | TD-PSOLA 失真研究 | artifact 就叫 **buzzyness**；「非周期段做 TSM 会给噪声引入周期性 → 金属声」 |

**⚠️ 我们已经是 TD-PSOLA**：`psola.rs` 的五个特征（pitch mark 检测 + 互相关精修、
Hann 颗粒长度恒 2 个**分析**周期、以源 mark 为锚、以新间距排放、Σw 归一）逐条就是
Moulines & Charpentier 的教科书写法。TD = time-domain，对立面是 FD-PSOLA / LP-PSOLA。
**所以「改用 TD-PSOLA」不是一个可选项**；网上「改良 TD-PSOLA」改的都是同一份里的**参数与阶段划分**。

---

## 7. 体积基线

| 项 | 数值 |
|---|---|
| `public/hajimi_audio.wasm` | **1142 KB raw / 483 KB gzip / 379 KB brotli** |
| `wasm/src/` 自有源码 | ≈161 KB / 4387 行（`psola.rs` 97KB / 2311 行是大头） |
| `public/` 合计 | 现在只有 3 个文件（wasm + tfjs model + shard），探针 WAV 已移出 |

- **产品约束：高性能、可离线部署的静态网页、体积要小。**
- WORLD 全量估 **+130~280 KB gzip**（未实测），且两点与需求冲突：
  ① 假设单一音源，而鬼畜素材带伴奏/音效（本项目已记录「带伴奏时 F0 本来就不准」）；
  ② Harvest 比我们的 YIN 慢一个量级。
  → 真要上 WORLD，**只搬 CheapTrick + D4C、F0 继续用我们自己的 YIN** 是唯一折中。
- 神经声码器 ≈99MB 权重（PitchNet 的 pc_nsf_hifigan 56MB + fcpe 43MB），与「体积要小」直接冲突。

---

## 8. 第三方变调引擎实测（分支 `feat/lib-engines`）

同一输出音高下 HNR（dB）、质心、耗时。源质心：龙.001 3855 / 高北 5141。

| 引擎 | 龙.001 HNR(−8.2) | 高北 HNR(−12) | 质心 | 耗时 |
|---|---|---|---|---|
| 我们 mode1 | 9.07 | **2.02** | 3837 / 5045 | 213 / 200ms |
| ST 默认 | 12.73 | 9.95 | 2281 / 2482 | 101 / 87ms |
| ST 长窗 | 12.69 | **12.04** | 2275 / 2350 | 89 / 63ms |
| ST 声码器 | 12.37 | 8.88 | 2298 / 2410 | 203 / 194ms |
| lib wsola | 13.76 | — | 2192 | 177ms |
| 纯重采样 | 13.19 | 11.53 | 2239 | 4ms |

→ **大降调时 `st-long` 明显最好**（−12 档 12.04 是全场最高），`st-wsola` 与它 −8 档持平。
→ 所有引擎输出时长都精确等于源（补静音修好之后）。
→ 注意质心：ST 系质心只有源的一半（2200 vs 3855）→ 听感会**偏闷**，这是它换来的「干净」的代价。

---

## 9. 探针脚本清单（`scripts/`）

全部用真素材 `素材/*.mp3`（41 个）。判据尽量用**波形差异度**，不要用 F0 ——
鬼畜素材带伴奏/音效时 F0 本来就测不准。

| 脚本 | 量什么 |
|---|---|
| `_probe-clickcount.mjs` | **咔哒簇计数**（报爆音/杂音先跑它） |
| `_probe-artifact.mjs` | 全段最陡跳变 + 同一时刻源波形对照（区分源的瞬态 vs 合成的爆音） |
| `_probe-gain.mjs` | 逐 10ms 帧 `RMS(输出)/RMS(源)` 剖面 + 峰值增量 |
| `_probe-hnr.mjs` | **HNR**（量化沙沙），带 `--selftest` |
| `_probe-hnsep.mjs` | 降调沙沙判决实验：mode1/mode3/谐波重建 + 纯重采样参照；含 `spectral()`（质心 / >4k / 分档 dB） |
| `_probe-pitchnet-ref.mjs` | 对照真 PitchNet 导出（`原型/PitchNet-master/导出测试.wav`）的分档 dB |
| `_probe-material-detect.mjs` | `hajimi_detect_pitch` 未检出率 |
| `_probe-material-pitch.mjs` | 内核级：mode 1/2 有没有真的变调 |
| `_probe-degradation-chain.mjs` | **链路级**：复现 `playSample` 模式循环，报最终生效模式 |
| `_probe-material-level.mjs` | 各档中段电平比 + 质心比（判断是否保共振峰） |
| `_probe-palette.mjs` | **装配面板交互/样式**（38 条断言；端口上已有 dev server 会复用） |
| `measure-psola.mjs` / `measure-autotune.mjs` | 合成信号质量体检 |
| `probe-ai/_probe-wasm-exports.mjs` | wasm 导出清单 + 220Hz 冒烟（改 wasm 后第一时间跑） |
| `probe-ai/probe-*.html` | AI 弃权率全量扫 / 阈值诊断 / 主线程策略层 / YIN 一致性 |
| `.workbuddy/tmp/libsurvey/probe-chain.mjs` | `@audio/shift-*` + `@audio/stretch-*` 串联语义（25/25 PASS） |

真浏览器探针统一走 `node scripts/probe-ai/_run-probe.mjs <url路径>`（见技能 `browser-probe-driven-tuning`）。
**UI 问题不能靠读 JSX 下结论** —— `getComputedStyle` 才是唯一可信口。
