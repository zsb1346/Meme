# 鬼畜哈吉米 —— 项目长期约定

> **只放可执行规则**，细节按需读：
> DSP 推导 / 实测 / 否决路 → `REF-dsp.md`；内核 & 音高链路细节 → `REF-kernel.md`；
> 引擎清单 / 实测表 / 判据 → `REF-engines.md`；面板 / UI 契约 / Vite / 探针 → `REF-frontend.md`；
> 逐日经过 → `YYYY-MM-DD.md`。

**头号规矩**：DSP 改动不许只用客观指标验收 —— **指标只能「排除」，不能「选优」**。
「哪个更好听」必须由耳朵定。理由：HNR 这类指标**对「净化」的奖励是单调的**（纯正弦 = +∞），
拿它当目标函数，最优点必然是把人声做成合成器。

## A. 对比 PitchNet 前先钉死它跑的引擎

**只有 Linux 默认 `Psola`，其余平台默认 `Vocoder`**（`Source/Audio/SynthesisEngineType.h:19-26`）
→ Windows 上「导入 mp3 → 拖到音符 → 听到的」是神经声码器重合成，**源的毛刺进不来**；
我们只有 PSOLA（重排源的**真实样本**）→ **算法类别差异，不是端口 bug**。
**读它自己的日志判断，不要靠代码推测**（实测 152/152 次 Vocoder → 用户**从没听过**它的 PSOLA）。
详见 `REF-dsp.md §1`。

## B. 降调沙沙：结论 + 两条**已被否决**的路

- 拐点约 **−5 半音**，更深单调加噪；恶化**全部来自 `A = 1/ratio ≠ 1`**；
  **沙沙来自源里的非周期成分被颗粒重排**，不是重叠相加本身。
  正确方向 = **源-滤波器**（WORLD / D4C 的频带非周期性）。推导见 `REF-dsp.md §3`。
  **⚠️ 我们已经是 TD-PSOLA → 「改用 TD-PSOLA」不是可选项。**
- **⛔ 否决路 A（mode 3 = PSOLA + 谐波/噪声分离）**：指标全变「干净」，用户实听
  「**这个结果很糟糕，噪音变成另一种形式了**」。已撤出默认链路（回 `[1,2]`），**不要重新接回**。
- **⛔ 否决路 B（两段式 = TSM + 重采样）**：用户当面确认代价不可接受（重采样把**共振峰一起搬走**，
  而那正是他要的听感核心）→ 撤回，**别再当新方案提出来**。

## C. wasm / 内核（细节 → `REF-kernel.md §1–7`）

- **改完 `wasm/src/**` 必须 `npm run build:wasm`**：`cargo test` 编的是 host target，
  `public/hajimi_audio.wasm` 是 `wasm32-unknown-unknown` 的另一份 → 否则「修了没用」是假象。
- **`wasm/src/psola.rs` 是变调与自动修音共用的唯一内核**，**不要再给任何一方写第二条实现**。
- **阈值常量的类型必须与 ABI 入口一致**（f32 vs f64 差一个 ULP，**host 单测看不见**）。
- **⛔ Σw 归一的 floor 是「除数下限」不是「闸门」**：只能 `padded / env.max(MIN_ENVELOPE)`，
  不能 `if env > C { … } else { 0 }`（降八度时 ~23% 样点被置零 → 嗡嗡撕裂）。
  **通用教训**：`if (x > C) { … } else { 0 }` 且 x 在 C 附近连续 → 大概是闸门 bug。
- **新增 DSP 路径先问**：失败时抛异常，还是悄悄返回原样？（降级链靠 `catch` 推进）
- **相对指标测不出「输出全零」**（0/0）→ 判「有没有出声」必须用**绝对量**。

## D. 音高检测（细节 → `REF-kernel.md §8`）

- **YIN 只有一份**：`wasm/src/yin.rs`（`pitch.ts::detectPitchYinCore` 只是应急退路，
  **不要再往 JS 版补算法**）。AI 参数全在 `src/engine/pitch-ai-budget.ts`；
  **AI 弃权先查「门够不够宽」**，不要先怀疑模型。
- **⭐ worker 起不来时（2026-09-20 用户实报「音高 worker 异常退出」）** —— 五条不变量：
  ① 报错必须**指向真因 + 下一步**：脚本加载失败时 `e.message` 是**空串**，只读它就会把
  「dev server 没了」说成「算法坏了」——**报错指错地方比不报错更贵**；
  ② **重生必须有冷却窗**（否则每个请求都 `new` 一个注定失败的 worker）；
  ③ `onerror` **只许摘掉自己那一个实例**（无条件 `worker = null` 会误杀重生后的好实例）；
  ④ **不许连累 YIN**（走主线程 JS 退路，**实测单次 ~300ms**，⛔ **别让它变常态路径**）；
  ⑤ UI 状态有第三态 `'unavailable'`（混进 `'loading_model'` 会**永远**停在「首次加载 AI 模型…」）。
  **降级值不许写进 `store.detectedPitchHz`**（= 把暂态故障永久固化）。
  回归：`pitch-worker-health.test.ts` + 探针 §16（靠探针页 `?npw=1` 复现）。

## E. 第三方变调引擎（分支 `feat/lib-engines`）

清单 / 实测表 / 两个判据 / ST 三条坑 / 复现命令 → **`REF-engines.md`**。

- **默认零行为变化**：偏好默认 `'wasm'`；**接入点只有一处** = `sample-player.ts::playSample`
  → 试听与导出同源。
- **加/删引擎要同时改三处**：`external-shift.ts` 的 `LOADERS`（**字面量** import）+
  `vite.config.ts` 的 `optimizeDeps.include` + `_probe-palette.mjs` 第 7 节 id 清单。
- **语义拆包（最容易接错）**：`shift-*` 的 `ratio` **只改音高**，`stretch-*` 的 `factor` **只改时长**；
  串联 = 先 shift 再 stretch，τ=1 时跳过第二步。改后重跑 `probe-chain.mjs`（25/25）。
- **⛔「选中了谁」≠「库能用了吗」**：`getActiveShift()` 为 null 时 `playSample` **静默**跳过 →
  面板高亮第三方、耳朵里是 wasm。**引擎本身没问题时，先查这条状态机。**
- **变调量夹 ±24**（`src/model/pitch-limits.ts` 单一来源；预览与提交必须用**同一个夹取后的值**）；
  **外部分支必须有结果缓存 + 空变换短路**（曾 578ms → 0.2ms）；
  **绝对量验收闸门** `src/engine/shift-output-guard.ts`（⛔ **闸门不许补救**）。
- **试听时序四条**（细节 `REF-frontend.md §6`）：起播时刻必须在**变换之后**落定
  （`startAt = max(when, ctx.currentTime)`，否则整条包络排到过去 = 一点声音都没有）；
  上一段只能在**新一段即将出声**时停（`playSample({ replacePrevious })`）；
  **按键重复只改数值、不试听**；调 `playSample` 前 `await yieldToPaint()`（先画后算）。
- 我们是最慢的之一（中位 179ms vs 多数 10~50ms）——选型要计入点击延迟。
  回退：`git checkout master`（存档点 `bb2fc05`）。

## F. 环境 / 构建红线

- **⛔ `worker: { format: 'es' }` 必须留着**（worker 依赖图有动态 import；iife 不支持代码分割）。
- **⛔ `optimizeDeps.entries` 必须显式列出**，且**必须含 `scripts/probe-*/**/*.html`**
  （根目录 `OpenDWA/` 288MB 会让 dev server 中断优化；探针页不在预构建里会中途整页 reload）。
- **⛔ 沙箱 safe-delete shim 拦「单轮 >50 条目」删除**（`SAFE_DELETE_BULK_*`，整轮缓存复用）
  → **不删，`mv` 挪走**。
- **⛔ 探针 WAV 绝不放 `public/`**（会被拷进 dist）→ 统一写 `outputs/_ab/`。
- **⛔ C: 盘长期接近满**（实测 **625MB / 100%**）→ `tmpdir()` 在 C:，写 Chrome profile/截图/
  localStorage 会中途 `ENOSPC`；**探针临时目录一律指项目盘**（`.workbuddy/tmp`、`outputs/probe`）。
- **⛔ 本机挂着环境代理**（`HTTP_PROXY=http://127.0.0.1:11123`，该端口随时可能已死）
  → 任何**访问 loopback 的工具都要显式绕开代理**（Chrome `--no-proxy-server`、curl `--noproxy '*'`）。
- **⛔ 本地 dev server 会被后台任务的生命周期带走**（症状：整页 `ERR_CONNECTION_REFUSED`、
  动态 import 全失败、worker 起不来）。**它是可消耗的，不代表代码坏了**；
  重启：`npx vite --port 5173 --strictPort`。
- node 用托管版 `...\binaries\node\versions\22.22.2-3\node.exe`；npm 直接调 `.../npm/bin/npm-cli.js`。
  **bash 必须 `export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Windows:$PATH"`**；git 在 `D:\Git\cmd\git.exe`。
- **既有失败测试（与本项目改动无关，别去修）**：`src/engine/effect-units/prototype-reverb.test.ts`。
