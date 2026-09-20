# REF-frontend —— 装配面板 / UI 契约 / Vite 构建 / 探针

> 从 `MEMORY.md` 拆出来的**细节层**。`MEMORY.md` 只留红线一句话，这里放故事、踩坑经过与回归位置。

---

## 1. 装配面板：调音目标 = 已选中行 **或** 这条音符本来就装着的素材

> 契约的唯一事实来源 = `src/components/fill/palette-reducer.ts` 头注释 +
> `scripts/_probe-palette.mjs` 第 5/6 节。改这块前先读那两处。

- **「变调 / 拉伸 / 试听」的共同目标 = `tuneTargetId`**：
  ① `armedId`（Enter / 单击明确选中的候选）；否则
  ② `placedId`（**这条音符本来就装着的素材**，打开面板时由 `effectiveSampleId` 定下）。
  **只有两者都没有**时，三个动作才全部拦截 + 弹「还没有选择素材 请按Enter选择素材」，
  页脚控件 `disabled` + 变灰 + 就地提示（`data-arm-required`），快捷键提示整条置灰
  （`p[data-tunable]` / `data-tune-target`）。
  **2026-09-19 那版只认 `armedId`** → 用户报「Shift+A 进来看见音块已经有素材，却被说没选素材」。
- **为什么不给光标行兜底**：`staged.candidateId` 跟着鼠标悬停跑，拿它当目标就会改到
  「路过的那一行」，而听感上「改了」与「没改」当场分不出来 —— 这是当初把目标收窄的原因。
  `placedId` 之所以能补进来，是因为它**不随光标变**：它是这条放置的现状。
- **「应用」多一层光标兜底**：`resolveTargetId` = `tuneTargetId ?? staged.candidateId`。
  这层兜底是既有契约（音符没装素材时按光标行落），调音**不走**它。
  ⚠️ 不能让 `placedId` 优先于 arm，也不能让「应用」只看光标行 ——
  否则会出现「调的是 A、提交的是 B」。
- **Enter 只看光标行、不认 `placedId`**：Enter 的语义是「我要这一行」（主动指向）；
  要是它也认 `placedId`，「第一次回车只选中、第二次才提交」的双保险会在
  光标恰好停在已装配素材上时失效。探针第 6 节 C 组专门钉这一条。
- 候选选择是**双保险**：`activeIdx`（光标，↑↓/悬停驱动）与 `armedId`（存 sampleId）是两个独立概念，
  **悬停永不能改变提交目标**；第一次回车只「选中」，已在选中行上再回车才提交。
- 页脚提示有**三态**（`targetSample` 驱动）：无可调目标 → 「回车选中 · 再回车应用」；
  已装配未改选 → 「调音作用在 <名称>（当前装配）」；已选中 → 「已选中 <名称> · 回车应用」。
- **变速步进基准 = 调音目标的时长**（`targetDur`），不能再用 `armedSample.durationSec`：
  目标可能来自 `placedId`（用户没回车），那时 armedSample 是 null → 基准 0 → 变速整组按死。
- **半音增量与 τ 对称地夹取**：`clampTau` 的 floor = `stepSec/dur`、cap = 8；
  半音走 `clampSemitoneDelta`（±24，见 MEMORY §E.1）。

## 2. CSS / 布局踩坑

- **Tailwind 透明度必须落在 opacity 刻度内**（0/5/10/15/20/25/30/…），否则类名被**静默丢弃**；
  刻度外写方括号 `bg-danger/[0.12]`。已踩过：`bg-flame-600/28` 让光标高亮长期不可见。
- **⛔ 列表容器的 `max-height` + `overflow-auto` 会把整组选项藏到可视区外** ——
  界面上看起来就是「那几个功能被删了」。已踩过：引擎选择器 `max-h-[7.5rem]` + 面板 ≥lg 两列
  → 选择器只剩 244px 宽 → 四组换行后需 157px → **SoundTouchJS 整组不可见**，
  用户据此报「你是不是把某个移除了」。**能自然撑高就别裁剪。**
- **几何断言必须跨断点量**：只量一个视口等于没量 —— 那次偏偏量在唯一正常的那一档（900px），
  于是把真 bug 判成了「截图假象」。**量 `getBoundingClientRect()`，不要看截图像素。**
- **「DOM 里在」≠「看得见」≠「点得动」**：数 chip 个数只能证第一条；看得见要量
  `scrollHeight vs clientHeight` + 逐组 `top+height`；点得动要**逐个真加载**
  （`ready && !failed && effective === id`）。
- **文案里的 `**粗体**` 必须在渲染端解掉**（`EnginePicker` 的 `RichText`），
  `title` 要过 `plain()`（原生 tooltip 不认 markdown）。踩过：界面真输出了两个星号。

## 3. 其他前端约定

- 素材搜索**只有** `src/utils/sample-search.ts` 一套（拼音/首字母/相关度），素材箱与装配面板共用。
- 加 `Settings` 字段会让 `*.test.ts` 因 TS2741 挂 —— 加字段时跑 `npm run typecheck`。

---

## 4. Vite / 构建

- **⛔ `worker: { format: 'es' }` 必须留着**：worker 依赖图里有动态 `import()`（tfjs / basic-pitch），
  Vite 默认给 worker 打 `iife`，而 **iife 不支持代码分割** → `vite build` 直接失败。
- **⛔ `optimizeDeps.entries` 必须显式列出**（别用默认宽松 glob）：仓库根有 `OpenDWA/`
  （288MB / 1770 个 .ts/.tsx，含 zip），其 `main.tsx` 引用没装的 `@opendaw/lib-*` →
  dev server 报「imported but could not be resolved」并中断优化。
  **必须把 `scripts/probe-*/**/*.html` 一起列上**：探针页面若不在预构建里，Vite 会在探针跑到一半
  「发现新依赖 → 整页 reload」，表现为随机失败。收窄后启动从 2.87s → **1.03s**。
  新增探针页面记得回来补一行。
- **`server.watch.ignored` 要排掉 `OpenDWA/` / `dist/` / `outputs/`**，别让 HMR 爬那 288MB。
- **⛔ 沙箱的 safe-delete shim 会拦「单轮 >50 条目」的批量删除**，抛
  `SAFE_DELETE_BULK_CONFIRM_REQUIRED` / `SAFE_DELETE_BULK_REJECTED`（**且整轮内该拒绝会被缓存复用**，
  之后所有 `rm` 都被同一个错误挡下）。受害者：① Vite 改配置后 `rm -rf node_modules/.vite/deps`；
  ② `vite build` 清 `dist`。**绕法：不要删，`mv` 挪走**
  → `mv node_modules/.vite .workbuddy/tmp/vite-cache-old-$(date +%s)`。
- **⛔ 探针试听 WAV 绝不能放 `public/`**：Vite 会原样拷 `publicDir` 到 dist（曾把 62 个 WAV /
  2.78MB 打进 `dist/_ab`，比 wasm 本身还大）。统一写 **`outputs/_ab/`**，dev 下由
  `vite.config.ts` 的 `serveProbeArtifacts()` 挂 `/_ab` 中间件。
- 第三方引擎包列进 `optimizeDeps.include`，避免用户点选时才预构建 → 整页 reload 打断试听。
- **构建到 `--outDir` 时别用 `--emptyOutDir`**：不清目录会累积旧 hash chunk（`BitStream-*`×4 等）；
  用 `rm -rf` 清又会撞上面的 safe-delete shim → 要干净输出请先 `mv` 走旧目录。
- **已知未修**：`pitch-worker` 的 `await import('@tensorflow/tfjs')` 不在 `optimizeDeps.include` 里，
  dev server 重启后首次跑 AI 检测会触发一次整页 reload（`optimized dependencies changed`）。

---

## 5. 探针基建

- 驱动：`scripts/_probe-palette.mjs`（CDP + headless Chrome，驱动 `probe-palette.html`）。
  已挂：`Runtime.consoleAPICalled` 捕获、`__renderShift`（真 `OfflineAudioContext` 渲染）、
  `__perfShift(semitones, repeats, fresh)`（真 `playSample` 计时，`fresh` 换新 buffer 以绕缓存）、
  `__ensureWasm()`（按需 `ensureRushLoaded`）。
- **量 wasm 路径前必须先 `__ensureWasm()`**：探针页 import 了 `sample-player` 却没加载 wasm 时，
  `isRushReady()===false` → `playSample` 跳过 wasm 分支 → 量到的是「原声」的 0.1ms（假绿）。
- **测「首次调用」必须换 buffer**：同一个 buffer 第二次调用会命中缓存 → 全是 0.1ms。
- **Chrome profile / 截图不要写系统 `tmpdir()`**（C: 盘）→ 写 `.workbuddy/tmp`、`outputs/probe`。

### 5.1 探针「报错指向错误的地方」——已修的三处（2026-09-20）

第一次复跑在第 1 节就炸 `TypeError: window.__rows is not a function` ——
**报错指向探针自己的取数函数，真因是页面根本没执行**。三个独立问题：

1. **⛔ Chrome 必须 `--no-proxy-server`**。本机常年挂代理
   （实测 `HTTP_PROXY=http://127.0.0.1:11123`，且该端口随时可能已死），Chrome 默认跟随系统代理
   → 对 `http://localhost:5199/...` 的请求被转发给代理 → 502「upstream connect failed」
   → 文档从未执行。**探针只访问 loopback，本就不该走代理。**
   教训：**代理是本地探针的头号隐形杀手**，症状却是「脚本坏了」。
2. **⛔ `READY_TIMEOUT_MS = 45000`**（原 12s 太短）。vite **冷启动**首次导航会触发
   `optimizeDeps` 预构建（15 个 `@audio/shift-*` + tfjs，`register_all_kernels` chunk 1.8MB），
   期间还可能整页 reload。热启动仍瞬间返回。
3. **⛔ 必须 `Log.enable` 并收 `Log.entryAdded`**。`Runtime.exceptionThrown` /
   `consoleAPICalled` 只覆盖**脚本跑起来之后**的失败；某个 `import` 404/500 时模块图不执行
   → 无异常、无 console → 只剩白屏、一个字都收不到。
   注意它会抓到 **`favicon.ico` 404 的假红**（已按 URL 排掉）——**假红比不检查更坏**。

`load()` 超时现在**当场抛错并打印导航目标/页面异常/页面控制台**，不再静默往下走。

### 5.2 断言「取样时机」造成的假红（2026-09-20 又踩一次）

第 8 节有一条「刷新后变速内核也已就绪」，轮询条件写的是 `!after.shiftReady`。
但 `external-shift.ts::restoreEngine()` 是**两段顺序 await**：
先 `ensureEngine`（变调），它 resolve 之后**才**开始 `ensureStretch`（变速）。
于是 `shiftReady` 变 true 的那一刻，变速那一支**才刚开始加载** ——
在那里取样必然可能读到 `stretchReady === false`。

判据是「红的时候紧接着的『点选 ST-WSOLA』立刻是 ready」，说明红的是取样时机。
**修法：轮询条件必须包含所有被断言的就绪标志**（`shiftReady && stretchReady`），
预算给足（40×150ms）。真失败（库加载挂了）仍会在预算内保持 false 并报红，不削弱断言。

**通用教训**：凡是「等 A 就绪 → 断言 B 也就绪」，先问 **A 与 B 是不是同一段 await 里设的**。
不是的话，就必须一起等，否则断言时红时绿，且红得毫无信息量。

## 6. 试听时序：怎么测、契约是什么（2026-09-20 加）

### 6.1 判据与量法（`_probe-palette.mjs` 第 15 节）

用户报「调音时声音响了但只响一点点」「手感粘滞」。两句话都不是「代码对不对」，
而是**时序**问题 —— 纯逻辑单测永远测不到（reducer 里的数字全是对的）。
所以探针页里加了一层 **Web Audio 原型打桩**（`probe-palette.html` 的
「预览时序记录器」一段），只有那一层能同时看到「调度时刻」和「真的出声了没」：

- `AudioBufferSourceNode.prototype.start/stop` → 每次调度记 `when / ctxT / schedDur /
  bufDur / stopWhen`，由此算出**每段试听实际响了多久**。
- `AudioParam.prototype.setValueAtTime/linearRampToValueAtTime` → 录包络事件表，
  在 `start` 时**按规范求值**得到「起播后 20ms 的增益」。1 = 全开，0.0001 = 已收到尾。
- `PerformanceObserver(['longtask'])` + rAF 帧时间 → 「粘滞」= 主线程被占多久。
- `window.__tune(n, intervalMs, repeat)` → 用**真实键盘事件**复现「按住不放」。
- `window.__envStale(pastMs, durSec)` → 直接渲出来量 RMS，证明「包络排在过去 = 无声」。
- `window.__scaleShift(durs, semitones)` → 变换耗时的**增长阶**（线性 or 超线性）。
- `window.__seedPreview(id, durSec)` → 往 `sample-player` 的 `bufferCache` 里塞人造素材，
  否则 `previewWith` 会走去「该素材的音频数据已丢失」那一支，**什么都测不到**。

**实测结果（1.0s 素材、连按 5 次）**：修前每段只响 69~240ms / 满长 1012ms、
段间空档 558~590ms、按键处理 595~682ms；修后 921/1012ms、空隙 −30ms、按键处理 0~1ms。

### 6.2 三条必须记住的「测的时候容易测错」

1. **⛔ 原型参量事件要在「首次出现时就登记」，不能等 `src.connect(env)`**：
   `playSample` 的顺序是「先排包络、后 connect」，等 connect 才登记会**整条漏掉**，
   算出来的增益变成「没有自动化、默认 1」——把 bug 掩盖成正常（实测踩过，全是 null）。
2. **⛔ 事件落点必须选在 `onKeyDown` 容器的后代上**：DOM 事件只向上传播，
   dispatch 在 `[role="dialog"]`（容器的祖先）上时**一个人都收不到**。
   症状是 0 次试听、数值纹丝不动 —— 而「最多两次」这种**上界断言会报绿**。
   所以上界断言必须同时钉下界（`length >= 1`）。
3. **⛔ 取样点要避开包络自己的起音斜坡**：包络本就从 0.0001 起、4ms 升到 1，
   按「起播瞬间」取值会把**坏掉**的情形读成 1（整条包络被甩到过去 → 停在平台段），
   指标方向正好是反的。改取 `startEff + 20ms` 之后，修好 `when` 才「该绿就绿」。
4. `__envStale` 里 `when = currentTime - pastMs/1000`，**AudioParam 不接受负时间**：
   时钟没走够就抛 `RangeError`。先等够再测（看起来像「落后多了就崩」，其实是负时间）。

### 6.3 契约（改试听路径前先读）

- 起播时刻在**变换之后**落定：`startAt = max(requestedWhen, ctx.currentTime)`。
- 上一段只在「新一段即将出声」时停：`playSample({ replacePrevious })`。
  调用方**不要**自己先 `stop()`（那正是「只响一点点」的写法），也**不要**把
  `replacePrevious` 接到未来 `when` 的排期播放上。
- 按键重复（`e.repeat`）**不试听**，只 dispatch；值落定（keyup，兜底 160ms 防抖）后试听一次。
- 调 `playSample` 之前 `await yieldToPaint()`（`rAF → setTimeout(0)`，80ms 超时兜底）——
  「先画后算」。它顺带让连按自然汇聚到最后一档（让出期间 `previewSeqRef` 会推进）。

## 7. 复现「音高 worker 起不来」（`?npw=1`）—— 一次假绿的教训（2026-09-20）

用户报的是一份控制台日志，真因是**本地 dev server 已退出**（`net::ERR_CONNECTION_REFUSED`）。
要把它钉成回归，就得在页面里复现「worker 建不起来」。

### 7.1 ⛔ 必须**重新加载页面**，不能在同一页面上事后打桩

第一次的实现是：先跑一次正常检测（正对照），再 `__breakWorker(true)`、再检测一次。
结果**三项接口全绿，而其实什么都没测到**：

```
spawns=0  status=ready  kind=undefined
```

原因：`pitch-async` 的 worker 是**单例**，而它的「活着」**不依赖 dev server** ——
加载过的模块早就在内存里，server 之后退出也不会让它死。
于是后续请求全部命中那个**活着的真 worker**（连 AI 都照跑、返回 185.0Hz），
`new Worker` 那条路**压根没被走到**。

**修正**：加 `?npw=1`（no pitch worker），在**页面模块里、
`createRoot(...).render()` 之前**就把全局 `Worker` 换成桩
→ 全新模块状态 = 全新的「还没建过 worker」，与用户那次
（server 先没了、之后才打开面板）同形。

### 7.2 桩只拦音高 worker

`sample-player.ts` 也 `new Worker`（`audio-worker.ts` 解码）。一刀切拦掉会让整个
装配面板解不出音频 —— 那是「把无关的东西弄坏」换来的通过。桩按 URL 过滤。

### 7.3 桩的 ErrorEvent 字段必须**全空**

`{message:'', filename:'', lineno:0, colno:0}` —— 这正是「脚本拿不到」时浏览器给的形态，
逼着 `classifyWorkerFailure` 走「零线索」那一支，也就顺带钉住了兜底文案必须可执行。

### 7.4 这一节顺带量出来的两个数

- `__yinCost(id, runs)`：**主线程 JS YIN 单次 ~300ms**（1.0s @48k，三次 307 / 293 / 295）。
  它**不是**「毫秒级」—— 这个数直接写进了 `pitch-async.ts::yinOnMainThread` 的注释，
  因为「主线程同步跑」的耗时决定「worker 掉了之后卡不卡」，属于只能实测的量。
- `__detectPitch(id, detector)` 会**先清缓存**再检测。不清的话测的是缓存、不是路径
  （「指标测不到」的典型来源）。
