# REF-kernel —— wasm / 内核硬规矩与音高检测细节

> 从 `MEMORY.md` 迁出（该文件受注入长度限制，只留可执行规则；细节放这里）。
> 这里放的是**「不要重犯」级别的规则 + 为什么**，改 `wasm/src/**`、
> `sample-player.ts` 的合成链路、或音高检测链路前先读本文。

---

## 1. wasm 产物与构建

**⛔ 改完 `wasm/src/**` 必须 `npm run build:wasm`。**

`cargo test` 编的是 **host target**（`.exe`），而 `public/hajimi_audio.wasm` 是
`wasm32-unknown-unknown` 的**另一份产物**。踩过：panic 已修、单测全绿，但产物是旧的，
探针继续崩，看起来像「修了没用」。

**跑探针 / 听感验证前先 `npm run build:wasm`。**

## 2. 合成内核只有一条路

`wasm/src/psola.rs` 是**变调（mode=1）与自动修音（`hajimi_at_run`）共用的唯一内核**，
两者的差别只是「ratio 是常量闭包还是逐帧曲线」。

**不要再给任何一方写第二条实现。** 曾经有过，导致自动修音的音质比变调差一档。

## 3. 阈值常量必须与被比较值同精度

`hajimi_tx_run` 的 pitch 是 **f32**，而 `HN_ENABLE_MAX_RATIO` 曾写成 f64 `0.89`
→ `0.89f32` 小一个 ULP → 契约在 0.89 上**失效**。

**host 单测测不出来**，只有走 wasm ABI 的探针能看见。

通用规矩：**阈值常量的类型必须与 ABI 入口一致，且要有「从 ABI 那一侧取值」的回归测试。**

## 4. Σw 归一的 floor 是「除数下限」，不是「闸门」

只能写：

```rust
padded / env.max(MIN_ENVELOPE)
```

**不能**写：

```rust
if env > 0.3 { padded / env } else { 0 }     // ⛔
```

后者在 −7.02 半音起**每颗粒周期触发一次**，降八度时约 **23% 样点被置零**，
听感是**嗡嗡撕裂**。

- 回归：`envelope_floor_is_a_divisor_not_a_gate` + `scripts/_probe-clickcount.mjs`
- PitchNet 的代码就是后者，但注释写「平滑的幅度凹陷」—— **信注释**（它确实这么想，
  只是实现成了闸门）。

**通用教训**：看到 `if (x > C) { … } else { 0 }` 先问「x 在 C 附近连续吗」；
连续 → 大概是闸门 bug。

## 5. 分离器：禁用「均匀平均做周期同步平均」

13 抽头均匀平均的频响是 **Dirichlet 核**：f0 偏 1% 时第 10 次谐波只剩 **3.6% 增益**
→ 漏过的高次谐波进残差、**不做变调**，加回时同频不同相 → **打拍**。

正确做法：逐谐波**正交相关** + 全局累积相位。

## 6. 降级链靠异常推进

`playSample` 的模式链（PSOLA → SOLA → 原声）靠 `catch` 推进，
**「返回合法音频但没做事」的内核会让它误判成功**。

已有例子：PSOLA 在无周期素材上静默不变调 → `isPsolaSilentNoop` 专门识别它。

**新增 DSP 路径先问：失败时抛异常，还是悄悄返回原样？**

## 7. 相对指标测不出「输出全零」

HNR / 质心 / 包络 a 这类相对指标在「输出全零」时是 **0/0**，什么都测不出来。
判「有没有出声」必须用**绝对量**：长度比 / RMS dB / 峰值 / 非有限数个数。

**已知未修**：输出峰值超满刻度（RMS 匹配 ≠ 峰值匹配；41 素材最大 **1.42×**）。
默认链路 `Compressor(−18dB/3:1) + masterGain(−3dB)` 压到 ≈−12dBFS 故暂不致命。
**要修请加在主总线 ceiling，别在增益匹配里塞限幅。**

---

## 8. 音高检测链路

### 8.1 YIN 只有一份实现

`wasm/src/yin.rs`，两个入口：面板 `hajimi_yin_f32`、导入 `hajimi_detect_pitch`。

`pitch.ts::detectPitchYinCore` **只是 wasm / worker 都不可用时的应急退路**，
**不要再往 JS 版补算法** —— 曾经两份各自演化，真素材 41 个上
**wasm 未检出 2/41、JS 未检出 15/41**，同一个素材「导入时有根音、面板里没有」就是这么来的。

### 8.2 AI（basic-pitch）的参数都在 `pitch-ai-budget.ts`

`AI_SECONDS` / `AI_WINDOW_TRIES` / `AI_NOTES_*` / `PITCH_TIMEOUT_MS` 是
worker 与主线程的**单一事实来源**。改输入长度或重试次数前先看
`pitch-ai-budget.test.ts` 里那条「最坏耗时 ≤ 预算」的算术 ——
旧的单一 15000ms 预算配 4 秒输入（3 批模型）让 AI **每次必超时**，
表现为「AI 检测永远未检出音高」。

### 8.3 AI 弃权先查「门够不够宽」，不要先怀疑模型

模型的 `frames` 概率图**从不为空（41/41）**，弃权基本是 `outputToNotesPoly`
的阈值把音符切掉了。`inferWindow` 的放宽档**只重跑后处理**（微秒级），**不重跑模型**。

### 8.4 三种「AI 不给可信结果」的处置不同

| 情形 | 判据 | 处理 | 缓存？ |
|---|---|---|---|
| 硬失败 | 抛异常（权重没下下来 / 后端不可用 / 超时） | 退 YIN | **不缓存**（条件恢复后应能重试） |
| 弃权 | 正常返回 `null` | 退 YIN | 缓存 |
| 错八度 | 与 YIN 相差 > 1200 音分 | 采用 YIN | 缓存 |
| 正常 | 有值且不冲突 | 直接用 | 缓存 |

「错八度」那档见 `PITCH_CROSSCHECK_REJECT_CENTS`：AI 在 2/35 个真素材上给出
差一个八度的答案（`豆.mp3` 698.5Hz vs YIN 360Hz），而错八度会让自动修音
把素材移调整整一个八度。

### 8.5 ⭐ worker 起不来时的处置（2026-09-20，用户实报后加）

用户贴过来的报错是：

```
[pitch-async] AI 检测硬失败，回退 YIN
Error: 音高 worker 异常退出
```

**而真因写在同一份日志的另一行**：`net::ERR_CONNECTION_REFUSED` ——
本地 dev server 已经退出，而 worker 的脚本正是从它那儿加载的。

> **教训**：旧代码只读 `e.message`（脚本加载失败时它是**空串**），
> 于是所有线索都被丢掉，只剩一句「音高 worker 异常退出」——
> 把「进程没了」说成「算法坏了」，排查方向整个跑偏。
> **报错指错地方比不报错更贵。** 兜底文案必须写成
> 「最可能是什么 + 下一步查哪儿」。

四条不变量（改这块前先读 `src/engine/pitch-worker-health.ts` 的头注释）：

1. **失败要分类**（`classifyWorkerFailure`）：`script_load`（拿不到脚本 → 重生无用，
   先修环境）/ `runtime`（跑起来后抛错 → 重生通常有效）/ `unknown`（没线索，给最可能的原因）。
2. **重生要有冷却窗**（`shouldSpawnWorker`，2s）：否则「已知拿不到」的那段时间里
   **每个请求都 new 一个注定失败的 worker**（用户日志里那四条同样的报错）。
3. **`onerror` 只许摘掉自己那一个实例**：旧实现无条件 `worker?.terminate(); worker = null;`，
   若此刻 `worker` 已指向重生后的新实例，会把好的那个一起干掉（表现为「时好时坏」）。
4. **worker 不可用不许连累 YIN**：YIN 走主线程 JS 应急退路。
   **代价实测单次 ~300ms 主线程同步占用**（1.0s @48k）—— 之所以仍选它，
   是因为没有它故障态下**所有**素材都显示「未检出音高」（自动修音连基准都没了）。
   ⛔ **别把这条退路变成常态路径。**

**UI 侧**：`PitchWorkerStatus` 有第三态 `'unavailable'`。混进 `'loading_model'` 的代价是
worker 死掉时 UI **永远停在「首次加载 AI 模型…」**—— 把一个「这里坏了」显示成「再等等」。
组件挂载时必须用 `getPitchWorkerStatus()` 取初值，否则它会从 `'ready'` 起步（等于谎报）。

**降级不许污染数据**：JS 退路的结果**不写 `store.detectedPitchHz`、也不写内存缓存** ——
把降级值写进工程 = 把一次**暂态故障**永久固化进数据里。
