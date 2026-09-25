# 鬼畜哈吉米 —— 项目长期约定

> **只放可执行规则**，细节按需读：
> DSP 推导 / 实测 / 否决路 → `REF-dsp.md`；内核 & 音高链路细节 → `REF-kernel.md`；
> 引擎清单 / 实测表 / 判据 → `REF-engines.md`；面板 / UI 契约 / Vite / 探针 → `REF-frontend.md`；
> 音高模型 / 音名 / 键位矩阵 / 可视验收 → `REF-pitch.md`；
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
  **不要再往 JS 版补算法**）。AI 参数全在 `pitch-ai-budget.ts`；
  **AI 弃权先查「门够不够宽」**，不要先怀疑模型。
- **⭐ worker 起不来时** 五条不变量：① 报错要**指向真因 + 下一步**（脚本加载失败时
  `e.message` 是**空串**，只读它会把「dev server 没了」说成「算法坏了」——
  **指错地方比不报错更贵**）；② **重生必须有冷却窗**；③ `onerror` **只许摘掉自己那一个实例**；
  ④ **不许连累 YIN**（主线程 JS 退路**实测单次 ~300ms**，⛔ 别让它变常态路径）；
  ⑤ UI 有第三态 `'unavailable'`（混进 `'loading_model'` 会**永远**停在「首次加载 AI 模型…」）。
  **降级值不许写进 `store.detectedPitchHz`**（= 把暂态故障永久固化）。
  回归：`pitch-worker-health.test.ts` + 探针 §16（靠 `?npw=1` 复现）。

## E. 第三方变调引擎（分支 `feat/lib-engines`，细节 → `REF-engines.md`）

- **接入点只有一处** = `sample-player.ts::playSample`（试听与导出同源）；偏好默认 `'wasm'`。
- **加/删引擎同时改三处**：`external-shift.ts` 的 `LOADERS`（**字面量** import）+
  `vite.config.ts` 的 `optimizeDeps.include` + `_probe-palette.mjs` 第 7 节 id 清单。
- **`shift-*` 的 `ratio` 只改音高，`stretch-*` 的 `factor` 只改时长**；串联 = 先 shift 再 stretch
  （τ=1 跳过第二步）。改后重跑 `probe-chain.mjs`（25/25）。
- **⛔「选中了谁」≠「库能用了吗」**：`getActiveShift()` 为 null 时 `playSample` **静默**跳过
  → 面板高亮第三方、耳朵里是 wasm。**引擎本身没问题时先查这条状态机。**
- **变调量夹 ±24**（`pitch-limits.ts` 单一来源，预览与提交用**同一个夹取后的值**）；
  外部分支**必须**有结果缓存 + 空变换短路（曾 578ms → 0.2ms）；
  **绝对量验收闸门** `shift-output-guard.ts`（⛔ **闸门不许补救**）。
- **试听时序四条**（`REF-frontend.md §6`）：起播时刻在**变换之后**落定
  （`startAt = max(when, ctx.currentTime)`）；上一段只在**新一段即将出声**时停
  （`replacePrevious`）；**按键重复只改数值、不试听**；调 `playSample` 前 `await yieldToPaint()`。
- 我们是最慢的之一（中位 179ms vs 多数 10~50ms）——选型要计入点击延迟。

## F. 音高模型 / 音名 / 键位矩阵（细节 + 2026-09-25 交互审计 → `REF-pitch.md`）

- **`src/model/pitch-map.ts` 是「键 → 音高」的单一事实来源**。
  **键的身份是音高（`Key.pitchMidi`），不是下标** —— 增删/截断其他的键**不改幸存键的音**。
  起点 **C3=48**、上限 **C8=108**；音名一律科学音高 **C4=60**（与 `.mid` 一致）。
- **⛔ 只有这一个锚点。** `legacyPitchOfLane`（C4 锚）只准两处用：旧存档迁移 + 缺 `pitchMidi` 的兜底。
  新增任何「下标 → 音高」换算都必须落到 `pitch-map`，**第二个锚点 = 静默差一个八度**
  （卷帘曾因漏传 `lanePitches` 而整套钢琴栏比键盘高八度，且**所有行都被当白键** →
  「开着半音也不出现黑键行」）。
- **⛔ 布局由音高决定，与半音开关无关**：一个键是黑键就永远摆黑键位置。
  开关只决定**新增键取哪条序列**。（曾按开关切两套几何 → 关掉开关后 C#3 变成白键格子、
  挤掉 D3 的位置。）切换开关**绝不动任何已存在的键** —— 用户定稿「保音」。
- **⛔ 键数上限与模式无关**（`KEY_DOMAIN_MAX_COUNT` = 61）。曾用 `maxKeyCount(chromatic)`
  夹取 → 关掉半音后点一下键数**静默截断 25 个键（连装配）**。
  真正的「到顶」判定靠 `nextSequencePitch(...) === null`（C8），⛔ 绝不绕回低音区。
- **音名只有一份**：`pitch-map.midiNoteName`。⛔ 不许再出现唱名（`do′/do'/第1度` 已删，
  连 `midi-import.ts` 尾部三份零引用的重复实现也已删除）。
- **⛔ 键位矩阵恒定 7 列 + 空列占位**；白键**按音级落列**（C→0…B→6），
  **不能按数组顺序填格**（尾组只有一个 D 时会摆到 C 的位置）。
- **⛔ 键数预设的口径是「八度数」，不是「键数」**：1/2/3 个八度 = 自然音 7/14/21、
  半音 12/24/36，**同一档在两种模式下音域完全相同**（最高音 `48+12n−1`）。
  ⛔ UI 不许写死 7/14/21（单一来源 = `pitch-map.keyCountPresets`）；
  判定「这个键数是第几档」**必须带模式**（14 键自然音下是 2 档，半音下不成档）。
- **⛔ `setKeyCount`（数量）与 `realignKeys`（音域）是两条路，不许合并**：
  前者增删末尾、**不动任何已有键的音高**（步进器 ± 走这条）；后者按 `sequencePitchAt(i)`
  重排、**保留装配**（音域档位走这条）。合并任一边都出事：档位走数量 → 音域漂移
  （点「3 个八度」得到 C3–A6，且前两段没黑键）；「＋」走音域 → 只加一个键却重排整个键盘。
  重排会移动已有键的音高 → **必须 toast 告知**（>0 才弹）。
  回归：`src/model/key-range.test.ts`。
- **⛔ 选择器的预设回弹**：`prev === 'custom'` 时必须保持 custom（旧写法键数一到 21 就
  跳回预设、步进器被卸载 → 用户以为「到头了」）。
- **`--fs-micro` = 11px 是字号下限**，不要再回退 9px。改字号只动 `tokens.css`。
- **⛔ `tailwind.config.js` 里不许写死像素值** —— fontSize / height / minHeight **必须引用
  `var(--fs-*)` / `var(--h-*)`**。曾经 tailwind 写死 `micro: '9px'` 而 `tokens.css` 已把
  `--fs-micro` 调到 11px → **变量从未被消费，改字号「一点效果都没有」**，看代码却完全正常。
  这是**静默失效**：改了、编译过、测试过，界面上什么都没变。改字号/控件高度只动 `tokens.css`。
- **UI 文案必须描述「实际内容」，不能照开关写**（提示语写「每排七个键」而黑键仍在 = 假话）。

## G. 环境 / 构建红线

- **⛔ `worker: { format: 'es' }` 必须留着**（worker 依赖图有动态 import；iife 不支持代码分割）。
- **⛔ `optimizeDeps.entries` 必须显式列出**且**必须含 `scripts/probe-*/**/*.html`**
  （根目录 `OpenDWA/` 288MB 会中断优化；探针页不在预构建里会中途整页 reload）。
- **⛔ 沙箱 safe-delete shim 拦「单轮 >50 条目」删除** → **不删，`mv` 挪走**。
- **⛔ 探针 WAV 绝不放 `public/`**（会拷进 dist）→ 写 `outputs/_ab/`。
- **⛔ C: 盘长期满**（625MB/100%）→ 临时目录一律指项目盘（`.workbuddy/tmp`、`outputs/probe`）。
- **⛔ 本机挂着环境代理**（`HTTP_PROXY=127.0.0.1:11123`，可能已死）→ 访问 loopback 必须绕开
  （`--no-proxy-server`、curl `--noproxy '*'`）。**vite 只绑 IPv6 `localhost`**，探 `127.0.0.1` 必拒。
- **⭐ 改完 UI 必须自己截图看一眼**（`node scripts/cdp-shot.mjs <url> outputs/ui-review/x.png`）。
  **纯模型层重构对用户不可见** —— 用户为此明确不满过（「看不到变化，积分先少了1200」）。
- **⛔⛔ 验收手机端必须带 `--mobile`**：`--w=390 --h=844` 是 `--window-size`，
  而 **Windows 上 Chrome 最小窗口宽度实测 491px** → 你以为在测 390 宽手机竖屏，
  实际是 **491×692 的横屏小窗，布局判断全错**（2026-09-25 栽过一次，7 张图全废）。
  `--mobile` 走 `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled`，
  **必须在 `Page.navigate` 之前下发**（否则首帧仍按窗口宽度布局）。
  **自检**：`--eval` 回读 `window.innerWidth`，别靠眼睛猜。
- **⛔ 同一条 `--eval` 里连点多个控件只会生效最后一个**（React 18 批处理 setState，闭包是旧值：
  `for(i<8)click()` 实测只 +1）。**拆多条 eval**，或 `async` + 每击后 `await sleep(70~90ms)`。
  **点导航与点页内控件也必须分开。**
  ⭐ 但 `cdp-shot.mjs` 的 `--click=` **本身已经是分步的**（每击后固定 `sleep(320)`）→
  「点导航 → 点页内控件 → 再点第二个」可以放心连写多条 `--click=`，不必拆进程。
  `--eval` 在**所有 `--click` 之后**跑，且 `awaitPromise: true`、返回值原样回显到 stdout
  → **优先用 `--eval` 读 DOM/状态来断言，比截图快也比截图准。**
- **⛔ 探针坑：`[data-key-index]` 的 DOM 顺序 ≠ 键序**。`PianoLayout` 是按「白键组 +
  绝对定位的黑键组」铺的，直接 `querySelectorAll` 读到的是 `C3 D3 E3 … B3 C#3 D#3 …`
  （7 白 + 5 黑）→ **会把一个完全正确的键盘误判成「顺序全乱」**。必须按 `data-key-index`
  排序后再读。
- **⛔ `--eval` 里 `import('/src/model/store.ts')` 常常不是应用那份模块实例**（HMR 后带 `?t=`）
  → 写 store 白写（现象：store 里明明有 take、UI 还是空态）。**造数据走 IndexedDB + 刷新**：
  `indexedDB.open('meme-studio',1)` → `meta` 库 `put(project,'project')` → `location.reload()`。
  **别因这种假象改业务代码。** 传长脚本用 `--eval="$(cat /tmp/x.js)"`。
- **⛔ 本地 dev server 会被后台任务生命周期带走**（整页 `ERR_CONNECTION_REFUSED`、动态 import 全失败）
  → **它可消耗，不代表代码坏了**；重启 `npx vite --port 5173 --strictPort`。
- node 用托管版 `...\binaries\node\versions\22.22.2-3\node.exe`；npm 调 `.../npm/bin/npm-cli.js`。
  **bash 必须 `export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Windows:$PATH"`**；git 在 `D:\Git\cmd\git.exe`。
- **既有失败测试（与本项目改动无关，别去修）**：`src/engine/effect-units/prototype-reverb.test.ts`。
- **⛔ 本机没有 LibreOffice、也没有 Python `formulas` 引擎** → 写进 xlsx 的公式**算不出缓存值**
  （微信/邮件附件、`pandas(data_only=True)` 里会显示空白）。**生成表格时一律写「算好的静态值」**，
  不要用 `COUNTIF`/`SUM`/除法做占比。快照数据本来就不会变，公式零收益、纯风险。
  校验入口：`.../sheetagent/.../skills/excel-generation/scripts/recalc.py <xlsx> 60`，
  只看 JSON 的 `status` 与 `total_errors`（**不能凭退出码判断**）。

## H. MIDI 导入（细节 + 实测 → `REF-pitch.md`，测试 → `src/model/midi-import.test.ts`）

- **⛔ 「解析」与「落盘」必须两段**：`engine/midi-import.parseMidiFile(file)`（只读文件 + 逐轨体检，
  **零工程写入**，可安全取消）→ 弹窗预览/选轨 → `buildMidiTake(parsed, opts)`（用户确认后才写 take）。
  ⛔ 不许把两者合并回一个 `importMidiFile`——预览过的数字与最终落盘的数字必须是同一份。
- **⭐ 摘要必须与落盘走同一个函数**：`MidiImportModal` 预览的统计和 `buildMidiTake` 的产出
  都经过 `midiToTakeEvents`。**两份统计 = 迟早不一致**，而导入不可撤销、用户无法自查。
- **⛔ 静默丢弃是导入的头号病**：旧版只报「已导入 N 个音符」，「太短被丢 / 超出上限被截断 /
  超域丢了多少 / 多轨合并」全是静默的。**每一类丢弃都必须在 `MidiImportSummary` 里有独立计数**
  （`tooShort` / `belowRange` / `aboveRange` / `truncated` / `keptEvents` / `blackKeyEvents`），
  并在 UI 里显示为「会有 N 个音进不来」+ 原因拆分。
- **音域/时长的统计口径按「截断前」的全量算**（先统计再截断，否则用户看到的是被改造过的事实）。
- **⛔ 含黑键的 MIDI 导入后必须自动 `setSemitoneMode(true)`** —— 否则约 1/5 的音在键盘上
  **没有可点的位置**（用户会以为导入丢了音）。
- **⭐ 两件连带动作的顺序固定**：**先 `setSemitoneMode(true)`、再 `setKeyCount(neededLanes)`**。
  反了会出错 —— 收起黑键时 `setKeyCount` 会把目标格数对齐到白键格。
- **`minDurationSec` 判空写 `!(note.duration >= min)` 而不是 `duration < min`**：
  前者让 `NaN`（`@tonejs/midi` 的 `duration` 是**原型 getter**，`{...note}` 展开拿不到，
  会变 `undefined`）也走丢弃分支。**这个坑先在分析脚本里崩过一次。**
- **测试用鸭子类型造 `Midi`**（`mkMidi`/`mkSingle` 辅助函数，不真编码二进制）——
  测的是**映射逻辑**不是解析器。核心回归：真实素材 G4–D6 → 48 格、48 个黑键音符。
- **导入前的预览弹窗**（`components/stage/MidiImportModal.tsx`）：轨道勾选实时重算摘要、
  音域条（当前键盘 / 自动扩容段 / 歌曲实际音域）、空轨禁用 + tooltip 说明原因。

## I. 手机端（设计已定稿待落地 → `原型/手机端设计.md`）

**四条理念**（所有手机端设计都是它们的推论，改设计先回来对一遍）：

1. **修饰键 → 看得见的模式**。桌面「手势 × 修饰键」的二维直接塌缩成一维会撞车，
   唯一出路是把修饰键提升为屏幕上的模式开关。
   ⛔ 两条硬规矩：**模式必须常驻可见**（托盘那格一直亮）+ **点画布绝不进模式**
   —— 模式是隐形状态，用户会忘记自己在哪，于是在「加音模式」里想选中却插进去一个音。
2. **一块屏装不下三块面板 → 切层，不挤压**。挤压的尽头是单字竖排，那不是界面。
3. **⭐ 手机上「弹」比「编」重要 → 键盘必须常驻**。手机强项是多指拍屏 + 随身，不是精细编曲。
   核心循环「拍 → 听 → 改一个音 → 再拍」要求**键盘与卷帘同时在场**（桌面免费，手机得画进布局）。
   → **演奏台是手机端主角，制作台是配角**。
4. **手指没有 hover → 预判让位给显式**。⛔ 手机上**点空白永远是平移**，
   加音必须走显式「＋ 加音」模式（桌面那种「点即插入、拖动则平移」靠 hover 预判，手指做不到）。

- **⛔ 交互分支用能力探测，不是宽度断点**：布局可以用 `md:`，但 hover / 修饰键 / 物理键盘的差异
  必须按 `(hover: hover)` / `(pointer: fine)` 分支。**两者不是一回事。**
- **⛔ 手机端尺寸下限**：可点热区 **44×44**、琴键高 **64**、正文 **11px**（`--fs-micro`，别再回退 9px）。
  ⛔ 不要为了塞进 390px 把控件压到 44px 以下 —— **宁可切层、宁可收进 ⋯**。
- **长按 vs 拖动的裁决必须写死**：按下后 500ms 内移动 >8px → 取消长按计时转拖拽；
  500ms 内没动 → 弹菜单并丢弃这次拖拽。
- **⛔ 不许用 hover 承载任何必要信息**（全站 85 处 `hover:`，手机上一个都不成立）。
- **文案要按设备分支**：「拖到这里」在手机上不存在；「滚轮 Q / 右键 / 双击 / Alt 精调」
  这类提示行在触屏上一条都不成立。
- **落地顺序已排好**：P0 顶栏溢出（4 页全在裁切，最刺眼）→ P1 尺寸规范 → P2 常驻键盘 →
  P3 工具托盘 + 长按菜单 → P4 分段切换 → P5 演奏台铺满 → P6 混音台 → P7 手势打磨。
  **每步都能单独上线。**

## J. 许可与合规（详细核查 → `原型/合规-PitchNet与模型许可.md`）

- **⭐ 「仓库代码的许可」≠「模型权重的许可」，必须分开判。** 铁证：`openvpi/vocoders`
  仓库是 **AGPL-3.0**，但权重单独声明 **CC BY-NC-SA 4.0（禁商用）**。
  「仓库是 AGPL 那我按 AGPL 遵守就行」是错的 —— **权重那层更严**。
- **⛔ 我们的变调内核不许再引入任何神经权重**：
  `pc_nsf_hifigan` = CC BY-NC-SA（禁商用）；`rmvpe.onnx` 上游**无 LICENSE**；
  `hnsep_VR.onnx` 来源不明且 PitchNet 自己都没列入第三方声明。
  **体积约束（99MB）与法务约束指向同一结论 —— 这是双重理由，别再提引入声码器。**
- **✅ 允许用的**：FCPE（MIT）、GAME（MIT）、**Basic Pitch（Apache-2.0，覆盖模型，我们现在用的就是它）**。
  Basic Pitch 的义务比 MIT 多一条：**保留上游 NOTICE**（我们仓库根目前没有 LICENSE / NOTICE）。
- **⛔ 区分「算法」和「表达」**：TD-PSOLA 是 1990 年教科书算法，**思想不受保护**，
  但**代码结构 / 步骤编排 / 常量取值 / 符号命名 / 注释**是受保护的表达。
  判断只看**是否接触过原代码** —— **所以「照搬 PitchNet kXxx」这类注释本身就是书面证据，别写。**
- **⚠️ `wasm/src/psola.rs` 目前是 PitchNet（AGPL-3.0）的衍生作品**：文件头自述「逐行对照」，
  正文十余处「照搬 / 逐字抄」。**AGPL §13 网络条款** → 对外发布即须**全站 AGPL + 向网络用户提供源码**。
  WASM 与 JS 同进程互调 = 单一程序，**不适用「单纯聚合」抗辩，挪 Worker 也没用**。
  待用户拍板：A 接受 AGPL 全站开源 / **B 净室重写（推荐）** / C 维持现状（仅当永不发布）。
- **净室纪律**（若走 B）：写的人**不读** PitchNet `Source/`；只参考论文（Moulines & Charpentier 1990）、
  Praat 的算法描述、以及我们自己的 `REF-dsp.md`；**不沿用**上游符号名；留存净室过程记录。
- **⛔ `原型/` `dist/` `OpenDWA/` 必须留在 `.gitignore`** —— `原型/PitchNet-master/` 里有
  56MB 非商业声码器 + 无许可的 RMVPE，**一旦入库或打进产物就是再分发**。
- **⛔ 用户可见文案里不许出现第三方产品名**（`EnginePicker.tsx:78` 曾点名 PitchNet，
  且描述与 `REF-dsp.md §1` 实测矛盾）。

## K. 静态部署（详细清单 → `部署说明.md`；本轮实测 → `2026-09-25.md`）

- **⭐ 子目录部署是最强的探针**：`npx vite build --outDir dist-sub --base=/meme-studio/`，
  再把产物挂到真实子路径跑探针。**硬编码的绝对路径一变 base 就全部现形**——
  「dev server 在根路径下一切正常」会掩盖全部这类问题。
- **⛔ 资源路径不许硬编码绝对路径**：`rush/loader.ts` 的 wasm URL、`pitch-worker.ts` 的模型 URL
  曾经都是 `'/hajimi_audio.wasm'` / `'/model.json'` → 子目录部署 404 → **全站没声音 / AI 全废**。
  正解 `import.meta.env.BASE_URL`（worker 里 `new URL(..., import.meta.url)`）。
  worker 用 `import.meta.env` 需在 `tsconfig.worker.json` 的 `types` 里加 `vite/client`。
- **⛔ 依赖必须显式声明**：`@tensorflow/tfjs` 曾**不在 `package.json`**，靠 `@spotify/basic-pitch`
  提升到 `node_modules` 根才解析成功 → 换机器/重装就炸。**用到的包一律进 dependencies。**
- **⛔ 旧 `dist` 可能是残缺品**：safe-delete 拦「单轮 >50 条目」时，Vite 会在**清空输出目录的中途**
  被打断 → `index.html`/`assets/` 已删、只剩删不动的子目录。**构建前先确认 dist 完整**，
  残缺就 `mv` 挪走（别原地删）。`dist/_ab` = 探针 WAV 的旧产物残留（**2.8MB 会跟着产物上线**）。
- **⭐ 起服务器与验证必须同一条命令**：`vite preview` / `python -m http.server` **会被后台任务
  生命周期带走**（`curl` 返回 `000`、页面变 `chrome-error://`），
  而探针会把「服务器没了」误报成「代码坏了」。**同命令内：起 → sleep → curl 健康检查 → 跑探针。**
- **⛔ 部署验收不许只验「页面能开」**，最小闭环：
  ① wasm 导出数 + `alloc` 往返；② 素材解码（页面内现造 WAV → 音高检测）；
  ③ AI worker（绕开 UI **直接压 worker 消息协议**最快）；④ 出声
  （`AudioBufferSourceNode.start()` 次数 + **送入的采样帧数要能对上源文件长度**）；
  ⑤ 导出（时长/大小/事件数）；⑥ 空状态下**必须给警告而不是静默出静音**。
- **⛔ 手机端验收必须带 `--mobile`**（`cdp-shot.mjs`）：Windows 上 Chrome 有最小窗口宽度，
  `--w=390` 实测被钳成 **491**，不给 `--mobile` 就是在**横屏小窗**里验收竖屏。
  该参数走 CDP 设备度量覆盖 + 触摸模拟，且必须在 `Page.navigate` **之前**下发。
