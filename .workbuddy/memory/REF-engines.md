# 第三方变调引擎 —— 实测档案（`feat/lib-engines`）

> 这是「要数字/要为什么」的地方。**不变量与硬规矩**在 `MEMORY.md` §F。
> 逐日经过在 `YYYY-MM-DD.md`；DSP 推导在 `REF-dsp.md`。

---

## 1. roster：19 个对象 = 我们 1 + 外部 18

`@audio/shift` 的**全部 15 个算法**都接了 —— 判据不是它的宣传语，而是 meta 包
`@audio/shift@1.1.4` 的 `dependencies`：正好 15 个算法子包（逐个独立安装、
逐个独立 `import()`）。外加 SoundTouchJS 3 个。

| 域 | 引擎 id | 包 | chip |
|---|---|---|---|
| — | `wasm` | 本项目 `wasm/src/psola.rs` | 我们的 PSOLA |
| 频域 | `lib-vocoder` | `@audio/shift-pvoc` | vocoder |
| 频域 | `lib-phaselock` | `@audio/shift-pvoc-lock` | phaseLock |
| 频域 | `lib-transient` | `@audio/shift-transient` | transient |
| 频域 | `lib-formant` | `@audio/shift-formant` | formant |
| 频域 | `lib-hpss` | `@audio/shift-hpss` | hpss |
| 频域 | `lib-sms` | `@audio/shift-sms` | sms |
| 频域 | `lib-paulstretch` | `@audio/shift-paulstretch` | paulstretch |
| 时域 | `lib-psola` | `@audio/shift-psola` | psola |
| 时域 | `lib-wsola` | `@audio/shift-wsola` | wsola |
| 时域 | `lib-ola` | `@audio/shift-ola` | ola |
| 时域 | `lib-delay` | `@audio/shift-delay` | delay |
| 时域 | `lib-granular` | `@audio/shift-granular` | granular |
| 时域 | `lib-sample` | `@audio/shift-sample` | sample ⚠ |
| 源-滤波 | `lib-lpc` | `@audio/shift-lpc` | lpc |
| 混合 | `lib-hybrid` | `@audio/shift-hybrid` | hybrid |
| ST | `st-wsola` / `st-long` / `st-pvoc` | `@soundtouchjs/*` | ST-WSOLA / ST-长窗 / ST-声码器 |

**`pitchShift` 刻意不接**：它是 meta 包 `@audio/shift` 的默认导出（README 表格第 16 行），
是个「按 `content` 自动选 psola/sms/transient」的包装器，不是算法。它的 `index.js`
**静态 re-export 全部 15 个子包** —— 一旦 `import('@audio/shift')`，Vite 就把 15 个算法
打进同一个 chunk，按需加载全废。想要这个能力自己写 3 行分发，别 import 它。

---

## 2. 实测：两个基准档（19 行全表）

判据沿用项目既有那套（`frameHnr` 周期同步平均 HNR + 频谱侧写），
脚本 `.workbuddy/tmp/libsurvey/probe-all15.mjs`。
「增益」= 包络时间比的判别量，含义与陷阱见 §3.2。

**基准 A：`龙.001`，ratio 0.6216（−8.23 半音），源 HNR 10.72 / 质心 3855**

| 引擎 | HNR | 质心 | >4k% | 电平 | 包络a | 增益 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 我们 mode1 | 9.07 | 3837 | 9.1 | ±0.0 | 0.995 | +0.000 | 381ms |
| vocoder | 10.17 | 2154 | 1.7 | −0.3 | 0.995 | +0.000 | 145ms |
| phaseLock | 8.40 | 2186 | 1.8 | −0.4 | 0.995 | +0.000 | 77ms |
| transient | 8.24 | 2177 | 1.7 | −0.4 | 0.995 | +0.000 | 79ms |
| formant | 7.75 | 2296 | 3.3 | −0.4 | 0.995 | +0.000 | 99ms |
| hpss | 11.02 | 2891 | 2.3 | −0.4 | 0.995 | +0.000 | 233ms |
| sms | 8.52 | 1974 | 1.1 | −0.1 | 0.995 | +0.000 | 53ms |
| paulstretch | 3.68 | 2374 | 2.6 | +0.3 | 1.461 | +0.384 | 179ms |
| psola | 11.19 | 2278 | 2.1 | −0.1 | 0.995 | +0.000 | 198ms |
| **wsola** | **13.76** | 2192 | 1.7 | −0.1 | 0.904 | +0.109 | 125ms |
| ola | 3.32 | 2520 | 3.1 | −5.0 | 0.862 | +0.088 | 30ms |
| delay | 11.26 | 2296 | 2.1 | −0.4 | 0.822 | +0.133 | 74ms |
| granular | −0.01 | 2250 | 2.6 | −1.5 | 0.995 | +0.000 | 54ms |
| sample | 12.32 | 2408 | 2.4 | +0.3 | 0.616 | +0.544 | 22ms |
| lpc | 6.47 | 2408 | 5.4 | ±0.0 | 0.822 | +0.117 | 168ms |
| hybrid | 8.40 | 2186 | 1.8 | −0.4 | 0.995 | +0.000 | 385ms |
| st-wsola | 12.73 | 2281 | 2.2 | ±0.0 | 0.949 | +0.072 | 191ms |
| st-long | 12.69 | 2275 | 2.4 | −0.1 | 0.995 | +0.000 | 178ms |
| st-pvoc | 12.37 | 2298 | 2.1 | −0.2 | 0.783 | +0.177 | 452ms |

**基准 B：`高北`，ratio 0.5（−12 半音），源 HNR 5.58 / 质心 5141 —— 项目最坏档**

| 引擎 | HNR | 质心 | >4k% | 电平 | 包络a | 增益 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 我们 mode1 | **2.02** | 5045 | 41.6 | ±0.0 | 0.995 | +0.000 | 328ms |
| **delay** | **10.40** | 2447 | 3.4 | −0.6 | 0.746 | +0.225 | 51ms |
| **st-long** | **12.04** | 2350 | 3.6 | +0.1 | 0.616 | +0.398 | 161ms |
| st-wsola | 9.95 | 2482 | 3.3 | −1.9 | 0.587 | +0.280 | 192ms |
| st-pvoc | 8.88 | 2410 | 3.2 | −0.6 | 0.646 | +0.462 | 561ms |
| sample | 8.65 | 2221 | 2.3 | +1.1 | 0.485 | +0.984 | 18ms |
| wsola | 8.62 | 2369 | 2.7 | −0.1 | 0.822 | +0.207 | 65ms |
| hpss | 7.19 | 3560 | 7.9 | −0.5 | 0.995 | +0.000 | 163ms |
| vocoder | 5.93 | 2431 | 3.1 | −1.1 | 0.995 | +0.000 | 144ms |
| psola | 4.55 | 2484 | 3.5 | −0.9 | 0.995 | +0.000 | 186ms |
| lpc | 4.05 | 3551 | 19.5 | ±0.0 | 0.949 | +0.059 | 132ms |
| ola | 3.22 | 2504 | 3.5 | −4.5 | 0.711 | +0.348 | 22ms |
| sms | 2.06 | 2311 | 2.4 | −2.3 | 1.044 | +0.017 | 52ms |
| formant | 1.02 | 2733 | 10.8 | −1.3 | 0.995 | +0.000 | 75ms |
| phaseLock / transient / hybrid | 0.91 | 2464 | 3.4 | −1.3 | 0.995 | +0.000 | 97/53/214ms |
| granular | 0.82 | 2447 | 3.9 | −1.1 | 0.995 | +0.000 | 39ms |
| paulstretch | −1.64 | 2440 | 3.7 | +4.6 | 1.096 | +0.060 | 144ms |

### 读这张表必须带的三条免责

1. **HNR 不能选优，只能排除**（项目头号规矩，见 MEMORY §B）。它奖励「频谱被抹平」，
   纯正弦 = +∞。`sample`（纯重采样）HNR 12.32 高于 `wsola` —— 那不是「更干净」，
   是**它把内容压过去了**（§3）。`granular` −0.01 也不代表不能用，
   该库明确写着「和弦上的碎裂是特性不是 bug」。
2. **质心掉一半 = 听感变闷**，这是「干净」的代价，不是优点。频域一族除
   `hpss`(2891/3560) 与 `lpc`(3551) 外，质心普遍掉到源的一半（3855→~2200）。
3. **耗时波动很大**（同一引擎跨轮次能差 2 倍，如 mode1 实测 179/245/268/381ms）——
   机器负载敏感，只看量级。量级结论：**我们是最慢的一组**（m1 中位约 180~270ms），
   多数第三方 10~50ms。这条要计入选型：点一下 chip 就要出声。

---

## 3. 两个判据：为「指标全绿但东西坏了」准备的

**背景**：`@audio/shift-sample` 是播放速率式纯重采样，自述
`No time preservation: output duration = input_length / ratio, zero-padded`。
于是它**通过所有常规判据**：输出数组长度与输入完全相等、电平对（+0.3dB）、
f0 也确实降了。只有内容被按 ratio 压过 —— 降调时只读到源的前 ratio 比例，
**尾巴整段丢掉**。常规指标一个都发现不了。

### 3.1 尾巴标记测试（决定性，**唯一可信的判据**）

造「音 − 静音 − 音」三段合成信号（各 0.3s），量 `输出尾部 25% 能量 / 头部 25% 能量`：
正经变调器 ≈ **1.0**（两段音都在）；播放速率型 ≈ **0.0**（第二段音根本没读到）。

实测（两个比例都跑过，结论一致）：

| ratio | 结果 |
|---|---|
| 0.6216 | `sample` **0.000**（正弦与噪声都是）；其余 18 个 0.95~1.09 |
| 0.5 | `sample` **0.000**；其余 18 个 0.95~1.10。**ST 三个是 0.998/0.997/1.102** |

**必须同时跑正弦与噪声两版**：`lpc` 那类源-滤波算法在**纯正弦**上会退化
（该库原话：AR 包络就是那个分音，滤波器锁住它），只用正弦会冤枉它 ——
实测 `lpc` 正弦 0.124 / 噪声 0.952。`ola` 同理（正弦 0.494 / 噪声 0.914）。
**判据以噪声列为准。**

### 3.2 包络时间比 `a`（辅助，**判读方式极易错，别单独用它定罪**）

把输出的 RMS 包络去和「源包络按 `a` 倍重采样」比，取最匹配的 `a`
（5ms 帧，`pred[i] = srcEnv(i·a)`）。`a≈1` = 内容时间轴没变；`a≈ratio` = 被压过。

**陷阱一：不能只看 argmax。** RMS 包络平滑慢变，整体拉伸一点依然高度相关，
峰值很**平** —— `psola`/`wsola`/`ola`/`delay`/`lpc` 的 argmax 落在 0.78~0.90，
但 `a=1` 处与 argmax 处的匹配度只差 0.00~0.03。按 argmax 报会把它们全误判成
「内容被改过」——正是本项目最忌讳的假结论。

**陷阱二：增益大 ≠ 真被改。** 实测同一引擎在不同档位的增益差异巨大，
而尾巴标记证明它们**都没有**丢内容：

| 引擎 | 增益 @−8.23 | 增益 @−12 | 尾巴标记 @−12 |
|---|---:|---:|---|
| `sample` | +0.544 | **+0.984** | ⚠ **0.000（真丢）** |
| `st-pvoc` | +0.177 | +0.462 | 1.084 ✓ |
| `st-long` | +0.000 | +0.398 | 1.005 ✓ |
| `st-wsola` | +0.072 | +0.280 | 1.007 ✓ |
| `psola` | +0.000 | +0.000 | 0.954 ✓ |
| `delay` | +0.133 | +0.225 | 0.972 ✓ |

结论：**只有 `sample` 的增益是压倒性的、并被 3.1 独立证实**；
ST 三个在 −12 档涨到 +0.28~0.46 却完全没丢内容 ——
最可能是它们的流水线**内部延迟**把包络整体推后，而这个没有 lag 参数的
scale 拟合会把延迟吸收成「轻微的压缩」，大降调时内容更长、吸收得更多，增益就更大。
**所以这个量只用来发现异常，硬判据永远用 3.1。**

---

## 4. 稳健性：19 对象 × 41 素材（ratio 0.6216）

- **抛异常 0 · 时长违约 0 · 疑似空转（互相关>0.99）0** —— 19 个全部干净。
- 电平偏离 >6dB：只有 `paulstretch` 3 个（+6.3~6.5dB）与 `ola` 4 个（−6.3~−7.3dB）。
- 中位耗时（一次运行，负载相关）：`sample` 8 `ola` 9 `phaseLock` 16 `granular` 17
  `sms` 18 `vocoder` 19 `delay` 19 `transient` 19 `paulstretch` 29 `formant` 32
  `lpc` 52 `wsola` 58 `hpss` 79 `st-wsola` 84 `st-long` 85 `hybrid` 120 `psola` 134
  `st-pvoc` 194 **`mode1` 268**

→ 19 个里**没有一个**会炸、会截断（除 sample 的已知行为）、会空转。
所以任何「切了不稳健」的现象，先去查 `external-shift.ts` 那套状态机（MEMORY §F）。

---

## 5. 接线不变量（改这块必须同时改的地方）

1. `src/engine/external-shift.ts` 的 `LOADERS`（**字面量** `import()`，
   换成变量 Vite 就打不出包）
2. `vite.config.ts` 的 `optimizeDeps.include` —— 15 个 `@audio/shift-*`
   + `@audio/stretch-psola` + 2 个 `@soundtouchjs/*`。
   漏了会在用户点选那一刻才预构建 → **整页 reload**，打断试听并丢掉 staging。
3. `EngineMeta` 四个字段都有用途，不是装饰：
   `family`（UI 分组）/ `keepsFormant`（说明行标记）/ `note`（一句话讲类别与代价）
   / `durationSafe`（**唯一能暴露 `sample` 那类坑的机制**）。
4. `EXTERNAL_ENGINES` 的顺序 = chip 渲染顺序（UI 按 `FAMILY_ORDER` 分组、组内保持声明顺序）。
5. `scripts/_probe-palette.mjs` 第 7 节把 18 个 id 逐组列死 —— **改引擎清单要同步改它**，
   否则「少接了一个」从界面上根本看不出来（没人会去数）。

## 6. SoundTouchJS 驱动（`src/engine/soundtouch-engine.ts`）三条坑

`@soundtouchjs/core@2.1.1` + `@soundtouchjs/stretch-phase-vocoder`，**MPL-2.0**。
三个引擎共用这一个模块。语义按「先伸缩再重采样」的出厂链路，但**别自己拼两段式**：

1. **SampleBuffer 是立体声交错**（每帧 `L,R`）—— 单声道素材必须复制成 `L=R`，否则左右声道错位。
2. **只设 `st.pitch = ratio` 就行**：库内部自己派生 `_rate`/`_tempo`，并**自动交换串联顺序**。
   手动拼「先 stretch 再 pitch」会得到错的结果。
3. **必须尾部补静音**（`PAD_SEC = 0.3`）再按输入帧数裁回：输入喂完后 `process()` 不会吐残余、
   库里也**没有 `flush()`**。实测 0.720s 的源出 0.630s（**尾巴被静默截掉 12.5%**）。
   另：库内**只注册了 `'lanczos'`**，传 `'linear'` 会抛 `Unknown interpolation strategy id`
   —— d.ts 注释写 `@defaultValue 'linear'` 是错的。

## 7. 复现命令

```bash
# 19 对象 × 41 素材（异常/时长/空转/电平/包络）
node .workbuddy/tmp/libsurvey/probe-all15.mjs robust

# 只跑尾巴标记（几秒，用来核实某个比例下谁在丢内容）
node .workbuddy/tmp/libsurvey/probe-all15.mjs marker 0.6216
node .workbuddy/tmp/libsurvey/probe-all15.mjs marker 0.5

# 单素材全指标（HNR/质心/频带/包络a/增益/耗时）
node .workbuddy/tmp/libsurvey/probe-all15.mjs detail 龙.001 0.6216
node .workbuddy/tmp/libsurvey/probe-all15.mjs detail 高北 -12semi

# 装配面板交互 + 目标解析 + 引擎选择器（91 条）
#   第 6 节靠探针页的 `?eff=p1|none` 把「音符已装配 / 未装配」两种情形分开钉
node scripts/_probe-palette.mjs 5173
```

⚠️ `.workbuddy/tmp/libsurvey/` 下**曾经有一份遮蔽用的 `node_modules`**，
里面是旧版本的 `shift-transient`/`shift-delay` —— 会让实测与 App 实际打包的版本
对不上。已挪成 `node_modules.BAK-*`。**以后别在这个目录里再装包。**
