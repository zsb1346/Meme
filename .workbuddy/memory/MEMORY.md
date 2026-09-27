# 鬼畜哈吉米 —— 项目长期约定

> **只放红线与指针**，细节按需读：DSP → `REF-dsp.md`；内核/音高检测 → `REF-kernel.md`；
> 第三方引擎 → `REF-engines.md`；面板/UI/Vite/探针/卷帘 → `REF-frontend.md`；
> 音高模型/MIDI → `REF-pitch.md`；**合成声部 → `REF-synth.md`**；手机端/许可/部署 → `REF-ship.md`；
> 环境/构建 → `REF-env.md`；逐日经过 → `YYYY-MM-DD.md`。

**头号规矩**：DSP 改动不许只用客观指标验收 —— **指标只能「排除」，不能「选优」**，「哪个更好听」由耳朵定。
**推论**：相对指标测不出「输出全零」→ 判「有没有出声」必须用**绝对量**。

## A. 对比 PitchNet 先钉死它跑的引擎 → `REF-dsp.md §1`
**只有 Linux 默认 `Psola`，其余平台默认 `Vocoder`**（`SynthesisEngineType.h:19-26`）→ Windows 上听到的是
神经声码器重合成，我们只有 PSOLA（重排源的真实样本）→ **算法类别差异，不是端口 bug**。**读它自己的日志
判断**，别靠代码推测（实测 152/152 次 Vocoder → 用户**从没听过**它的 PSOLA）。

## B. 降调沙沙 → `REF-dsp.md §3`
拐点 **−5 半音**；恶化全部来自 `A = 1/ratio ≠ 1`；沙沙 = 源里**非周期成分被颗粒重排**。正确方向 =
**源-滤波器**（WORLD/D4C）。**⚠️ 我们已是 TD-PSOLA → 「改用 TD-PSOLA」不是可选项。**
**⛔ 否决路 A**（谐波/噪声分离）**与 B**（TSM + 重采样）**都已撤回，别再当新方案提**。

## C. wasm / 内核 → `REF-kernel.md §1–7`
- **改完 `wasm/src/**` 必须 `npm run build:wasm`**（`cargo test` 编的是 host target，
  `public/hajimi_audio.wasm` 是另一份 → 否则「修了没用」是假象）。
- **`psola.rs` 是变调与自动修音共用的唯一内核** → 别写第二条；**阈值常量类型必须与 ABI 入口一致**
  （f32 vs f64 差一个 ULP，host 单测看不见）。
- **⛔ Σw 归一的 floor 是「除数下限」不是「闸门」**（`if env > C {…} else {0}` → 降八度时 ~23% 样点被
  置零 → 嗡嗡撕裂）。**通用教训**：`if (x > C) {…} else {0}` 且 x 在 C 附近连续 → 大概是闸门 bug。
- **新增 DSP 路径先问**：失败时抛异常，还是悄悄返回原样？（降级链靠 `catch` 推进）

## D. 音高检测 → `REF-kernel.md §8`（复现 → `REF-frontend.md §7`）
**YIN 只有一份**：`wasm/src/yin.rs`（`pitch.ts::detectPitchYinCore` 只是应急退路，别补 JS 版）。AI 参数
全在 `pitch-ai-budget.ts`；**AI 弃权先查「门够不够宽」**。**降级值不许写进 `store.detectedPitchHz`**。
**⭐ worker 起不来五条**：① 报错指向真因（脚本加载失败 `e.message` 是**空串** → 会把「dev server 没了」
说成「算法坏了」）；② 重生有冷却窗；③ `onerror` 只摘自己的实例；④ 不许连累 YIN（退路 ~300ms）；
⑤ UI 第三态 `'unavailable'`。回归 `pitch-worker-health.test.ts`。

## E. 第三方变调引擎（分支 `feat/lib-engines`）→ `REF-engines.md`
- **加/删引擎同时改三处**：`external-shift.ts::LOADERS`（**字面量** import）+ `vite.config.ts` 的
  `optimizeDeps.include` + `_probe-palette.mjs` 第 7 节 id 清单。接入点只有一处 = `sample-player.ts`
  `::playSample`。`shift-*` 的 `ratio` 只改音高，`stretch-*` 的 `factor` 只改时长。
- **⛔「选中了谁」≠「库能用了吗」**：`getActiveShift()` 为 null 时 `playSample` **静默**跳过 → 面板高亮
  第三方、耳朵里是 wasm。**引擎本身没问题时先查这条状态机。**
- 变调量夹 ±24（`pitch-limits.ts` 单一来源）；外部分支必须有结果缓存 + 空变换短路；**绝对量闸门**
  `shift-output-guard.ts`（⛔ 闸门不许补救）。试听时序四条 → `REF-frontend.md §6`。

## F. 音高模型 / 键位矩阵 → `REF-pitch.md`
- **`src/model/pitch-map.ts` 是「键 → 音高」单一事实来源**：**键的身份是音高（`Key.pitchMidi`）不是
  下标**；起点 C3=48、上限 C8=108；音名一律 C4=60。**⛔ 只有这一个锚点**（`legacyPitchOfLane` 的 C4 锚
  只准旧存档迁移 + 缺 `pitchMidi` 兜底）—— 第二个锚点 = 静默差一个八度。
- **⛔ 布局由音高决定，与半音开关无关**；开关只决定**新增键取哪条序列**，切换绝不动已有键。
- **⛔ 音域三条**：上限与模式无关（`KEY_DOMAIN_MAX_COUNT`=61）；预设口径是「**八度数**」不是键数；
  `setKeyCount`（数量）与 `realignKeys`（音域）**两条路不许合并**（重排会移动已有键 → **必须 toast**）；
  ⛔ UI 不许写死 7/14/21，判「第几档」**必须带模式**。
- **⛔ 键位矩阵恒定 7 列 + 空列占位**；白键**按音级落列**，不能按数组顺序填格。
- **⛔ `tailwind.config.js` 不许写死像素值**（引用 `var(--fs-*)`/`var(--h-*)`）—— 曾写死 `micro:'9px'` 而
  tokens 已是 11px → **变量从未被消费，改字号「一点效果都没有」**。`--fs-micro`=11px 是下限；⛔ **UI
  文案必须描述「实际内容」，不能照开关写**。反例档案 → `REF-pitch.md §11–12`。

## G. 环境 / 构建红线 → `REF-env.md`
- **⛔ `worker: { format: 'es' }` 必须留着**；**⛔ `optimizeDeps.entries` 必须显式列出**且含
  `scripts/probe-*/**/*.html`。**⛔ 沙箱 safe-delete shim 拦「单轮 >50 条目」删除** → **不删，`mv` 挪走**
  （`node_modules/.vite` 被拦会让 vite 在 listen 阶段崩，报错却像 Vite 自己的问题）。
- **⛔ C: 盘长期满** → 临时目录指项目盘；**⛔ 探针 WAV 绝不放 `public/`** → 写 `outputs/_ab/`。
- **⛔ 本机挂环境代理** → 访问 loopback 必须绕开（跑探针前 `unset HTTP_PROXY …`）。**⛔ dev server 必须
  双栈监听**（`server.host='::'`）：本机对无人监听的端口**不回 RST、要干等 ~2s**（「网页迟迟打不开」的
  真凶）→ `REF-env.md §4`。dev server 会被后台任务生命周期带走。
- **⭐ 改完 UI 必须自己截图看一眼**（`node scripts/cdp-shot.mjs`）—— **纯模型层重构对用户不可见**，用户
  为此明确不满过。**⛔ 探针 / 截图守则 → `REF-frontend.md §5.3 / §8`**：漏 `--mobile` 会在 491px 横屏小窗里判
竖屏布局；**探针往运行中的 App 注入状态前必须先证明拿到的是同一个模块实例（HMR 的 `?t=` →
影子 store，症状伪装成「卷帘挂了」）** → 用 `scripts/_app-import.mjs`。node/npm/bash/git 绝对路径、**既有失败测试**（`prototype-reverb.test.ts`，别去修）→ `REF-env.md`。

## H. MIDI 导入 → `REF-pitch.md`；测试 `src/model/midi-import.test.ts`
- **⛔「解析」与「落盘」必须两段**：`parseMidiFile(file)`（只读 + 逐轨体检，零工程写入，可安全取消）
  → 预览/选轨 → `buildMidiTake(parsed, opts)`；⛔ 不许合并回一个 `importMidiFile`。**⭐ 摘要与落盘走同一
  个函数**（都过 `midiToTakeEvents`）：**两份统计 = 迟早不一致**。
- **⛔ 静默丢弃是导入头号病**：每类丢弃独立计数（`tooShort`/`belowRange`/`aboveRange`/`truncated`/
  `keptEvents`/`blackKeyEvents`），UI 显示「会有 N 个音进不来」+ 原因拆分（**口径按「截断前」全量算**）。
- **⛔ 含黑键的 MIDI 导入后自动 `setSemitoneMode(true)`，顺序固定：先切半音、再 `setKeyCount`**（反了会被
  对齐到白键格数）。不切半音 → 约 1/5 的音**没有可点的位置**。
- **`minDurationSec` 判空写 `!(note.duration >= min)`**（`@tonejs/midi` 的 `duration` 是原型 getter，
  `{...note}` 拿不到）。测试用鸭子类型造 `Midi`。

## I. 合成声部 / 音色面板 → `REF-synth.md`
- **⛔ 只有一份实现**：`src/engine/synth/engine.ts`（VFX.html 的 TS 移植）。旧 `synth-preview.ts` +
  `recorder.ts::FeedbackPiano` 已删。服务：试听 / 按键反馈 / **采样哑时的兜底声**。**⛔ 不进导出。**
- **⛔ 唯一入口 `playSynthNote(midi, opts)`**：第一参是**音高**，其余全具名；松手用 `releaseSynthNote
  (midi)`（`releaseAllSynthNotes` 是「全停」，另一回事）。**位置参数 = 「按下 C3 响 C7」那个 bug 的可复现
  形式**（MIDI 号被当键下标）。
- **⛔ 参数范围单一来源 = `patch.ts::SYNTH_NUMERIC_SPECS`**，面板一律 `specOf(p)`，⛔ 不许在 UI 写死
  min/max（`synth-params.test.ts` 断言全覆盖）。**八度范围 −3…+4**（以数据实际用到为准）。
- **⛔ 引擎入口必须 `sanitizeSynthPatch`**（非有限值 → 渲染期抛 → React 卸载整树 → **整片黑屏**）；构造参数
  收 `BaseAudioContext`（可塞 `OfflineAudioContext`）；**清扫定时器只在 `ctx instanceof AudioContext` 时开**
  （离线 `stop()` 会剪断音尾），**只负责回收**（发声全预排在 ctx 时钟上）、**单个** 250ms 统管。面板：拖动走
  引擎、落库 120ms 尾随防抖（IR 180ms、套预设即重建），关面板/换预设/试听前 flush。
- **⛔ 三条「整款预设等于没声」的坑 → `REF-synth.md §3`**：① 出厂参考音 `osc1Oct` 必须 0；② **起音必须
  `linearRamp`**（指数起音 → 整个 Pad/Riser 家族静音）；③ **整形曲线长度必须奇数**（偶数 → **直流偏置**，
  指纹 `rms ≈ peak`）。回归 `curve.test.ts`。
- **⛔ 释放与回收是两条独立不变式**（「些预设一直响（回音）」+「按多了卡顿 → 没声」**同一根因**）。
  **细节只读 `REF-synth.md §6`**，三条红线：① 释放一律走 `retire()`，`voices`（在响）/`dying`（等拆）
  分开存（老写法只遍历 `voices` → 声部不可达：**一直响 + 每次按键漏 ~20 个节点**）；② 静音靠排程而非
  `disconnect` → 幅度/滤波各走**声部私有深度级** + `setValueAtTime(0, at)`，**⛔ 不许直连 `AudioParam`**；
  ③ 释放**必须以精确 0 收尾**（`MIN_GAIN=1e-4` 会被高 Q 共振抬回可闻 —— 滤波器在包络**之前**）。
- **⭐ 改音色表 / 改引擎后必须重跑两个探针**（先起 dev server、跑前 `unset HTTP_PROXY`）：`probe-synth.mjs`
  （**按下去**有没有声）+ `probe-synth-lifecycle.mjs`（**松开后**有没有停）—— **vitest 没有 Web Audio** →
  用 `OfflineAudioContext` 真渲染量 rms 绝对量。**⭐ 写完守卫必须回退修复、证明它会红**（曾红 15 项）。
- **⛔ 起振清单一份只能背一种语义**：`triggerStarts`（`trigger` 负责 start）与 `extraStarts`
  （**只登记回收**，源自己在别处 start）必须分开 —— 共用一份时弦鸣的 `burst` 被 start 两次
  → 真机 `InvalidStateError`，**整条声部静默**（2026-09-27）。
- **⛔ 假实现比真实现「宽容」的地方 = mock 的盲区**：`MockSource.start()` 曾幂等，于是
  「同一源 start 两次」在单测里完全隐形（`voice-lifecycle` 当时 29 条全绿）。**加保真度后
  必须回退修复、证明它会红**。⭐ 而且**「七引擎逐个离线渲染」必须留在探针里** —— 预设表全是
  经典引擎，六个新引擎只有探针铺开才覆盖得到。

## J. 卷帘：电脑键盘弹奏 + 左侧钢琴栏 → `REF-frontend.md §9`（契约与画法全在那儿）
- **⛔ 卷帘只发合成声**（用户定稿）。映射在 `roll/keyboard-play.ts`；**结构守卫 `roll/roll-synth-only
  .test.ts`** 禁止 import 采样/导出链路 —— **这条约束没有运行时症状**（破坏后只是「音色变厚了」，会被当成
  调得好而收下），必须做成测试期红。
- **⛔ 左栏 = 键盘（发声试听）、时间线 = 编辑**：左栏分支在命中测试**之前** `return`，**不许插入音符**；
  **⛔ 基准吸附到键域内的某个 C，夹取区间只能是键域本身**（收窄会让 `X` **毫无反应**）；**⛔ 不许有死键**；
  **⛔ `Z`/`X` 必须无条件标脏**（极易漏 → 画面停在上一帧）。
- **⛔ 钢琴栏每一行都必须先铺「琴键面」**，黑键行也不例外 —— 留成页面底色 = 在左栏挖洞（用户实报
  「左边的钢琴很割裂」）。**判据：任何一行的左栏都必须有连续的面。**
- **⭐ 高亮是瞬时态 → 验收靠 canvas 上的 `__rollKeys` 快照**（`pressed`/`base`/`shifts`/`held`），截图
  只能靠时序运气。探针 `scripts/probe-roll-keys.mjs`（16 项）。
- **`←`/`→` 是按时间顺序切换音符 → 必须自己「横向聚焦」**（`geometry.ts::revealBlockX`）：
  只做纵向 `revealLane` 时表现为**「选中变了、画面不动」= 像按键失灵**。**⛔ 触发条件不含边距、
  落地位置才留边距**（带上边距 → 音符还在屏上视图就自己动）；完整可见就原样返回同一对象；
  ⛔ 只动 `sx` 不许动 `sy`。单测 `reveal-block-x.test.ts`（8）+ `roll-verify.mjs §10`（5）→
  `REF-frontend.md §9.5`。
- **⛔ 探针两条通用病（都在 `roll-verify.mjs` 栽过）→ `REF-frontend.md §8`**：① 断言「状态变了」之前
  **先断言点击真的落在元素矩形内**（算出的 `y` 跑出 canvas 之外 = 事件打进空气 → 红得像功能坏了）；
  ② **永远为假的守卫 = 谎言**（`typeof store.setSelectedTakeId === 'function'` 恒假且该动作不存在 →
  静默跳过 → 探针在**别人的 take** 上白测）。**take 的选中是页面私有 `useState`，从 store 够不着；
  注入 `takes[0]` 才是唯一手段。**

## K–M. 手机端 / 许可 / 部署 → `REF-ship.md`
- **手机端**：设计已定稿待落地（`原型/手机端设计.md`）。**四条理念**（修饰键→可见模式、切层不挤压、
  **键盘常驻**、「弹」比「编」重要、手指没有 hover → 显式优先）+ **能力探测而非宽度断点** + **热区
  44×44 / 琴键 64 / 正文 11px**。
- **许可**：**「仓库代码许可」≠「模型权重许可」必须分开判**；⛔ 不许再引入神经权重。⚠️ `wasm/src/psola.rs`
  是 AGPL 衍生作品 → 待拍板「接受 AGPL / **净室重写（推荐）** / 维持现状」。
- **部署**：⛔ 资源路径不许硬编码（用 `import.meta.env.BASE_URL`）；⛔ 依赖必须显式进 `package.json`；
  ⭐ 子目录部署是最强探针；⭐ 起服务器与验证**必须同一条命令**；⛔ 验收不许只验「页面能开」。
