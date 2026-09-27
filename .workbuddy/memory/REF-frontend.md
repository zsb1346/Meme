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

### 5.3 ⛔ 注入状态前先钉住「模块 URL 的 `?t=`」——否则写进影子 store（2026-09-27 加）

**症状**：`roll-verify.mjs` 报 `找不到卷帘 canvas`。看着像「卷帘挂了」。
实测却是：探针 `import('/src/model/store.ts')` 后 `getState().takes` **明明有注入的 take**，
页面却显示空状态（`录骨架 · 卷帘修` + `钢琴卷帘还空着`）；`document.body.innerText`
里**从头到尾没出现过**那个 take 的名字。

**真因**：Vite 在 HMR / 依赖重优化之后会给模块 URL 挂 `?t=<时间戳>` 做缓存击穿，
而**带查询串与不带查询串是两个不同的模块实例**：

| | URL |
|---|---|
| App 用的 | `…/src/model/store.ts?t=1790476600152` |
| 探针 import 的 | `…/src/model/store.ts` |

两者各自 `create()` 一个 zustand store。探针 `setState` 写进**影子 store**，
页面一无所知 → 所有注入失效 → 断言全红。**而探针自己读回来还全是「对」的**，
所以它连报错都指不到真因。

**为什么特别恶**：它**只在「dev server 已经跑过一轮 HMR / 重优化」时出现**。
冷启动的服务器上模块 URL 没有 `?t=`，裸路径恰好就是 App 用的那个 → 探针一路绿灯。
**即探针的可信度取决于服务器的新鲜度，而这件事没人会记得**；
`roll-verify.mjs` 之前「18/18 绿」就是这么来的。

**修法**（`scripts/_app-import.mjs`，两个卷帘探针共用）：

```js
window.__appImport = async (path) => {
  const hits = performance.getEntriesByType('resource').filter((e) => {
    const u = new URL(e.name);
    return u.origin === location.origin && u.pathname === path;
  });
  if (hits.length === 0) throw new Error('找不到 App 请求过的模块 URL：' + path);
  return import(hits[hits.length - 1].name);   // 取最后一次请求 = 当前模块图里那个
};
```

⛔ **找不到就抛，不许退回裸路径** —— 退回等于又去写影子 store，把「静默假红」原样搬回来。
宁可探针炸得响亮，也不要它绿得可疑。

**⭐ 并且加一条「守卫的守卫」**：`storeIdentityCheckSource()` 用 store **自己的 action**
（`setKeyCount`）改一个数，看侧栏那行 `N 键 · M 素材` 有没有跟着变。
侧栏**所有页面都在**（不像制作台的 take 下拉框只在录制 tab 里），所以这条不挑页面、
不挑 tab；用 action 而不是自己拼对象 → 不依赖 `Key` 的形状，store 改 schema 也不会假红。
两个探针都在注入任何状态**之前**先跑它，不过就当场抛。

**通用教训**：**凡是「探针 import 应用模块再改它的状态」，先证明拿到的是同一个实例。**
ES 模块的身份由**完整 URL**（含查询串）决定，不是由路径决定。

- 只影响**往运行中的 App 注入状态**的探针（`roll-verify` / `probe-roll-keys` / `diag-*`）。
- `probe-synth*.mjs` **不受影响**：它们 import 引擎只是为了自建 `OfflineAudioContext`
  离线渲染，不往页面注入状态 —— 拿到副本反而更干净。

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

## 8. 截图 / CDP 探针操作守则（从 `MEMORY.md §G` 迁入）

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
  → 写 store 白写（现象：store 里明明有 take、UI 还是空态）。**别因这种假象改业务代码。**
  **2026-09-27 起有确定性解法**（不是绕路）：用 `scripts/_app-import.mjs` 的
  `APP_IMPORT_BOOTSTRAP` → `window.__appImport(path)`，它按 `performance` 里 App 真正
  请求过的那条 URL（**取最后一次**）去 import，拿到的一定是同一个实例；
  并用 `storeIdentityCheckSource()` 当场验证。**完整成因与守则见 §5.3**。
  旧绕法（仅在不能改脚本时用）：造数据走 IndexedDB + 刷新 ——
  `indexedDB.open('meme-studio',1)` → `meta` 库 `put(project,'project')` → `location.reload()`。
  传长脚本用 `--eval="$(cat /tmp/x.js)"`。
- **⛔ 本地 dev server 会被后台任务生命周期带走**（整页 `ERR_CONNECTION_REFUSED`、动态 import 全失败）
  → **它可消耗，不代表代码坏了**；重启 `npx vite --port 5173 --strictPort`。
- **⛔ 注入 store 数据必须等 `hydrated` 为 true**（2026-09-26）。`App` 的 `hydrate()` 是异步的，
  它 `set({ project: p })` 会**整个覆盖**你刚注入的 take —— 现象是「注入返回成功、页面上什么都没有」，
  极像「注入没生效」。`--wait=1800` 太短（实测要 3.5s 起）；**稳妥做法是在页面里轮询
  `S.getState().hydrated`（最多 6~12s），false 就直接返回诊断而不是硬着头皮继续。**
- **⛔ 改过源码之后（HMR），`import('/src/model/store.ts')` 会拿到另一份模块实例**：
  模块图里带 `?t=<时间戳>`，于是你这份 store `hydrated` **永远是 false**、`setState` 也写不进应用
  （现象：导航按钮点得动、数据死活不出现）。**最快的解法是重启 dev server**（拿干净模块图），
  比重建 IndexedDB + `location.reload()` 那套省事；`roll-verify.mjs` 之所以没踩到，
  是因为它每次都是**新起的 server + 新页面**。
- **⛔ 读 canvas 上的调试快照（`__rollView` / `__rollKeys`）必须等下一帧**：它们由渲染循环在
  `draw()` 里写，而渲染循环**只在 `dirty` / 拖拽 / 播放时**才跑。派发完事件**立刻**读 = 读到
  **上一帧**，于是「按了 X 基准没动」这种结论可能是假的（探针第一版就被自己骗了两轮）。
  正确姿势：`await` 3~6 个 `requestAnimationFrame` 再读。
  **推论**：如果某个状态改动**刻意不重绘**，它在快照里就永远看不见 —— 要么重绘，要么别用它断言。
- **⛔ 探针要留截图时，被观察的状态必须「按住不放」**：截图发生在脚本返回**之后**，
  脚本里松了手就只会拍到一张干净图。
- **⛔ 探针不要自己从「键数」算行高**：用 canvas 上挂的 `__rollView.rowH` / `sy`。
  自己算过一回（61 键域按 24 键算），点到了第 31 行，却看着像「左栏点击落错行」。
- **⛔ 断言「状态变了」之前，先断言「点击真的落在元素矩形内」**（2026-09-26 二次栽）。
  `roll-verify.mjs §9`（右键删除）硬点 `events[0]`，而前面 §4 的纵向缩放把视图滚走了
  （实测 `sy=157 / rowH=35.6`）→ 命中点的 `y=84` 落在 canvas 上边界（94）**之外**，
  **指针事件打进了空气**，删除当然不发生 → 红得像功能坏了，实际是探针在点页面空白。
  修法：**在页面里先筛出「确实落在 `getBoundingClientRect()` 内」的目标**（按 X/Y 双轴过滤），
  一个都没有就返回 `NO-VISIBLE-EVENT` 而不是硬点。
  **推论**：任何「先算坐标再派发指针事件」的探针，都要把坐标回显到断言详情里 ——
  这次的 `y=84` 一眼就定位了。
- **⛔ 永远为假的守卫 = 谎言**（2026-09-26）。`roll-verify.mjs §1` 曾写
  `if (typeof S.getState().setSelectedTakeId === 'function') S.getState().setSelectedTakeId(...)`，
  看着像「兼容两版 API」，**实际永远为假、静默什么都不做** —— 而**store 上压根没有这个动作**
  （「选中的是哪个 take」是 `StagePage` / `StudioPage` 各自的私有 `useState`，从 store 够不着；
  注入到 `takes[0]` 让页面自动落到选中位，才是唯一手段）。
  靠「`takes[0]` 碰巧自动选中」它还能跑，于是没人发现；直到 §10 真的靠它切 take 时，
  探针就**跑在别人的 take 上**、5 项断言里有 3 项是空洞绿。
  **判据：守卫的两个分支都必须可达，否则删掉它、把真实机制写进注释。**
  **同类气味**：`if (x) { … }` 里 `x` 恒假；`catch` 吞掉的异常；`.filter()` 之后没人看的空数组。

## 9. 卷帘：电脑键盘弹奏 + 左侧钢琴栏（2026-09-26 加）

用户三条诉求（原话）：「在钢琴卷帘的时候是不是能按键盘对应的让其播放？但**只播放合成音、不播放素材**」、
「按下某个按键，钢琴卷帘的某一列应该高亮一点点便于观察」、「左边的『钢琴』设计的有点丑，很割裂」。

### 9.1 文件分工

| 文件 | 职责 |
| --- | --- |
| `src/components/roll/keyboard-play.ts` | **纯映射层**：`KEYBOARD_SEMITONES`（`e.code` → 半音）、`keyboardBasePitch()`、`resolveKeyboardNote()`、`isTypingTarget()`。零 React / 零音频，**有单测** |
| `src/components/roll/useRollController.ts` | 接线：window 监听、起音/收声、按下集（`pressedRef`）、左栏指针分支 |
| `src/components/roll/renderer.ts` | 钢琴栏绘制 + `pressedLanes` 高亮 |
| `src/engine/synth/index.ts` | `releaseSynthNote(midi)`（松手只收一个音） |
| `scripts/probe-roll-keys.mjs` | 端到端验收（16 项） |

### 9.2 契约（改这块之前先读）

- **只发合成声**：整条链路只调 `playSynthNote` / `releaseSynthNote`。
  卷帘**从不**触发采样播放 —— 那是播放（`take-player`）与导出（`sample-player`）的职责。
  **这条约束没有运行时症状**：一旦破坏，用户按一个键同时听到「参考音 + 素材」两响，
  音量叠起来像「音色变厚」，很容易被当成调得好。所以有结构守卫
  `src/components/roll/roll-synth-only.test.ts`（读源码断言卷帘一族不许 import
  `sample-player` / `take-player` / `engine/recorder` / `engine/exporter` / `engine/offline`）。
- **左右分职**：左栏 = 键盘（点/按住 → 发声试听 + 点亮该行），时间线 = 编辑。
  左栏分支在**命中测试之前** `return`，**不进**拖拽/框选/插入音符状态机 ——
  否则在左栏横拖会框选、竖拖会平移，一个想弹琴的人会得到一堆意外选区。
- **按住延音**：`durationSec = KEYBOARD_HOLD_SEC`（30s），真正的收声靠 `keyup` →
  `releaseSynthNote`。**`keydown` / `keyup` / `blur` 三件套缺一不可** ——
  切窗口/切标签页时 `keyup` 收不到，缺 `blur` 就留下挂住的长音。
- **守卫**：带 `Ctrl/⌘/Alt` 的组合一律放行给编辑快捷键；`Shift` 也整体让位
  （`Shift+A` 是「打开装配面板」的既有快捷键，同时处理会一次按键既弹一声又弹开面板）；
  焦点在输入类控件里不拦截（否则搜索框打字会出声、还被吞字符）；有 `[role="dialog"]`
  的弹层开着时不弹奏。**键盘监听挂 `window`**（用户不必先点一下画布才能弹）。
- **基准音**：`A` 键 = 基准，基准**始终吸附到键域内的某个 C**。默认键域（24 键 C3–B4）
  下基准 = **C4**；`Z`/`X` 移八度。
  **⛔ 夹取区间只能是键域本身 `[lo, hi]`**：若为了「给上行 16 个半音留空间」收窄到
  `[lo, hi−16]`，默认 C4 会被压到键域下沿，而 `X` 算出的 72 又被同一个夹取压回 60 →
  **按 X 毫无反应**。窄键域里 X 到顶是**安静的空操作**（这是设计行为）。
  **⛔ ref 里必须存「已生效的值」而不是「想要的值」**：否则窄键域里按 X 看似没反应，
  之后用户一加宽键域，音区自己跳一个八度 —— 他没按任何键。
- **没有死键**：`resolveKeyboardNote` 先按音高**精确**匹配，匹配不到就落到**最接近的键**
  （同分取低音）。自然音模式（无黑键行）下 `W/E/T/Y/U` 仍有落点 ——
  若改成「不存在就不发声」，用户只会得到「按了没反应」。
- **⛔ `Z`/`X` 分支必须无条件标脏**：它不改任何行、不起声源，极易漏；漏了画面停在上一帧
  （平时看不出来，一旦有东西依赖重绘就错）。

### 9.3 左侧钢琴栏的画法（用户：「很割裂」）

**根因**：黑键行整格被留成**页面底色**（`ink950`），而背景也是 `ink950` →
**视觉上等于在左栏挖了个洞**；连那圈「黑键描边」也是黑底黑线，根本看不见。
结果整条栏是「灰条（白键行）+ 黑洞（黑键行）+ 一个悬浮蓝框」的斑马纹。

**正确画法**：**每一行都先铺「琴键面」**（`ink800`，C 行用 `ink700`），黑键行也不例外 ——
真钢琴上黑键背后的位置本来就是相邻白键的延续，黑键只是**压在键缝上的一截短键**。
然后再叠黑键方块（宽 `GUTTER_W × 0.58`，右缘 1px 高光当「侧面」、底缘投影），
最后在 `GUTTER_W − 1` 画 1px 分界，把「键盘」与「时间线」分开
（不画分界时白键面 `ink800` 与白键行带 `laneKey` 两片灰直接相接，又糊成一片）。

**半音键收起时**（`blackLanesDisabled`）：黑键画成**凹槽**（`rgba(0,0,0,0.45)` 填充 +
强调色 0.42 细描边）—— 底色有琴键面之后，凹槽读起来才是「关着的键」；
上一版是在纯黑底上描一个空心框，像悬浮 UI。

**判据（可以当回归用）**：**任何一行的左栏都必须有一条连续的面，洞就是 bug。**

**按下高亮**：白键行整条键帽染 `flame400 @ 0.5`；黑键行只在**黑键自己的宽度内**点亮
（保住黑白键的形状差异）；时间线区叠一层 `flame300 @ 0.13`。
`pressedLanes` 传的是 **`Set` 本身**（`Set.has` 是 O(1)，不必每帧转数组）。
与 `editingLane`（「我在编辑这一行」，持久、0.14）语义不同、刻意分色强度。

### 9.4 验收（`node scripts/probe-roll-keys.mjs 5173`）

16 项：卷帘可见 / 初始无挂音 / 基准是域内的 C / `A` → 点亮基准行 / 三键和弦点亮三行且互不相同 /
松一键只熄一行 / 宽键域 `X` 真的 +12 / `Z` 回原位 / **窄键域 `X` 是安静空操作且处理函数确实跑了** /
输入焦点不弹奏 / `Ctrl+A` 放行 / 失焦收声全灭 / **点左栏点亮对应行** / 左栏松手熄灯 /
**点左栏不插入音符** / 全程无异常。

**快照**：canvas 上挂 `__rollKeys = { pressed, base, shifts, held }`。
`shifts` 是 `Z`/`X` 处理函数执行次数的计数 ——
「按了 X 没反应」有两种成因（**没进处理函数** vs **进了被键域边界夹住**），
两者在画面上完全一样，只有计数能分开。

### 9.5 左右键切换音符 → 目标在视口外时自动横向聚焦（2026-09-26 加）

用户原话：「我们不要按左右按键切换音符吗? 那这样 **超出显示区域的 就是 按左键右键的时候
能自己聚焦一下**」。

**为什么必须做**：`←`/`→` 是**按时间顺序**切换音符（`navigateSelection`，按 `tSec` 排序），
目标极可能落在当前时间段之外；只做纵向 `revealLane` 时表现为
**「选中变了、画面就是不动」—— 跟按键失灵长得一模一样**。

**实现**：`src/components/roll/geometry.ts::revealBlockX(view, tSec, durationSec, l)`，
与 `revealLane` 并列的横向版本，纯函数（可单测）：

- **完整可见 → 原样返回同一个对象**（调用方靠 `!==` 判断「动没动」）；否则必出新对象。
- **⭐ 触发条件不含边距，落地位置才留边距**：判「可见」用视口本身（`x >= GUTTER_W && x + bw <= l.w`），
  而滚到位时让块缘离边 `REVEAL_MARGIN_PX`。**判据若也带上边距，音符还在屏幕上视图就自己动。**
- **块比可视区还宽 → 左缘对齐**（保证看得见音头），不试图把整块塞进来。
- **到边界 `clampViewState` 收敛，绝不越界**；视口窄到 `viewW - 2*margin <= 0` 时直接不动。
- **⛔ 只动 `sx`，不许顺手改 `sy`**（纵向是 `revealLane` 的职责）。
  单测里为这条专门要造「纵向确实有余量」的视图（`rowH=40`）—— 否则 `clampViewState`
  会把 `sy` 顺手夹成 0，测的就成了「我构造的视图本来就不合法」。

**接线**（`useRollController.ts::navigateSelection`）：纵向 `revealLane` 包在横向 `revealBlockX`
外面一层，**两个偏移都写回 `viewRef` 并 `dirtyRef = true`**。

**验收**：单测 `src/components/roll/reveal-block-x.test.ts`（8 项，纯数学）＋
端到端 `scripts/roll-verify.mjs` §10（5 项，验接线 —— `__rollView.sx` 到底变没变）。
§10 的素材是**原地改造 `takes[0]`**（两个音符拉开 17.6s），不新塞 take（见 §8 的「永远为假的守卫」）；
并有一项**前置断言「目标不完整可见」**，否则「滚没滚」根本无从判断、五项里三项空洞绿。

---

## 10. 卷帘性能：三层测量法 + A/B 像素（2026-09-27）

**入口**：`node scripts/probe-roll-perf.mjs <port>`（先起 dev server、跑前 `unset HTTP_PROXY …`）。
另需 `--autoplay-policy=no-user-gesture-required`，否则播放场景的 `resume()` 被拒 →
rAF 根本没起 → 采样 99.8% 是 `(idle)`，会被**误读成「播放很轻」**。

### 三层，各管一件事

| 层 | 量什么 | 用途 |
|---|---|---|
| ① `ops/帧` | 只数卷帘 canvas 上的绘图调用（**不是**耗时） | ⭐ **结构指标，与机器/负载无关** → 优化前后用它逐项对拍 |
| ② 重绘帧间隔 | rAF 时间戳的**帧间隔**（不是 `performance.now()`） | 只用「排除」超载，不用「选优」 |
| ③ CDP CPU 采样 | `Profiler.start/stop`，100µs | 点名热点函数 |

⛔ **别用 `performance.now()` 量单帧耗时** —— 分辨率被钳（曾读出 0.05ms/帧 这种不可能的均值）。
⛔ **不要**用 `canvasMs`（打桩计时）选优，只用来排除。

### ⛔⛔ 第 ③ 层有个自伤：探针的插桩会污染采样

①的打桩给每个 canvas 方法包了 **2 次 `performance.now()`**。于是采样里出现
`now` 7.4%、`ctx.<computed>` 17.9%（动态包装函数，V8 给不出名字）——
**这两块是探针自己的账**。判读时只能信非画布条目：
`draw` / `setFill` / `setStroke` / `getGranTexture` / `beginPath` / 以及 React 的函数。

### ⛔ 帧间隔有「地板」，别把它当结论

headless + `--disable-gpu`（软件光栅）下，**稀疏场景也稳定 33.3ms** = 30fps 地板。
⇒ **33.3ms 意味着「没超载」，不是「很慢」**。只有明显高于地板（如 66.7ms）才是真超载。
配合 `ops/帧`：稀疏 531 ops 是地板、高密度 20214 ops 是 66.7ms。

### 这一轮实际改了什么（`renderer.ts` / `geometry.ts` / `getTokens.ts`）

1. **`withAlpha` 记忆化** → 同一个 `(hex,alpha)` 返回**同一字符串实例**，
   `ctx.fillStyle = s` 因此短路掉重复的 CSS 颜色解析（`(program)` 的一大块）。
2. **派生量提到帧首**（`COL` / `fontPlan`）+ **赋值去重**
   （`setFill` / `setStroke` / `setFont`，⛔ **每次 `ctx.restore()` 后必须
   `invalidateStyleCache()`** —— `revert` 会回滚样式，缓存不同步就会「颜色不生效」）。
3. **几何内核拆分**（`blockWidth` / `blockHeight` / `blockTopOfEvent` 按值返回、零分配），
   `hitTest` / `eventsInRect` / `hitResizeHandle` / 块循环全改零分配 + **最便宜判定优先**
   （横向落空即 `continue`，连纵向都不算）。
   风险 = 「两个入口可能不等价」→ 守卫 `geometry-equivalence.test.ts`（见下）。

### ⭐ A/B 像素协议（证明「画面没变」）

```
1) AFTER ：工作区版本 → node .workbuddy/tmp/_roll-shot.mjs 5199 after.png
2) BEFORE：git show HEAD:<file> 覆盖三件套 → 同命令 → before.png
3) 比 MD5（两次同码截图的 MD5 必须相同 = 确定性）
4) ⛔ 反向对照：注入一处极细微差异（`blockTopHi` alpha 0.6→0.61）→ MD5 **必须**变
```

⛔ 第 4 步不能省 —— 「能测出相同」和「测得动差异」是两件事。
本轮结果：before = after = `b4eea609729c583fb72c089171ef8b05`（与上一轮同值，可复现）；
反向对照 `d1fc5387…`。

### `geometry-equivalence.test.ts` 的采样策略（别改回均匀网格）

`hitTest` 那条原来用 17×13 的均匀网格 → **56.8 万次比较、整套负载下超时（5758ms）**。
改成 **粗网格（61×47）+ 逐事件边界采样**（每个事件四条边的外侧/内侧、±`BLOCK_PAD_HIT`；
外加 `GUTTER_W` / `RULER_H` 的内外两侧）→ **195ms**。

理由：两条谓语的不等价**只可能出现在判据边界**上，均匀网格绝大多数点落在安全区，
几十万次比较几乎不碰边界。守卫下界断言 `compared > 80000`（防「网格退化成空循环」的假绿）。

### ⛔ 还能量什么：剩下的必须动画面（**待用户拍板**）

- CPU 采样里 **React 不在热点**（`ReactElement` 0.4%、无 `beginWork`）。
  `useTakePlaybackState` 确实挂在 `StudioPage` **根部**（注释写着「避免整页跟随 rAF
  重渲染」而订阅就在页面上）→ 播放期间整页每帧重渲染是**真的**，
  但**它不贵** → 按「指标只能排除」的规矩，**不修**。
- 唯一的大头是**合批**：把 ~1800 个块各自的 `beginPath + roundRect + fill` 合成几条路径，
  `ops/帧` 20214 → 约 11000（~45%）。
  ⛔ **但它会改同轨重叠块的 z-order**（A 的上下高光线会被画到 B 的块体之上）→
  **属于「动画面」→ 要用户拍板，不许单方面做。**
- 数据密度决定一切：常规 take（几百事件）在**地板**上，只有高密度才会超载。

## 11. 按键动画：多键同按 + 长按（2026-09-27 加）

**契约**：`src/hooks/key-anim-state.ts` 是**纯状态内核**（无 React / 无 DOM，node 里可测）。
`useKeyAnimations` 是它唯一的 React 壳。**按下 = 集合、闪灯 = 映射** —— 每键一份，
粒度错了就会重现「多键同按只有一个有动画 + 不能长按」。

### ⛔ 四条红线

1. **「按下」不许有任何定时器。** 它是持续态，只能由**松开事件**结束。
   旧版用一个共享的 260ms 定时器假装松手 → 按住不动也会自己弹回去。
   `useKeyAnimations.ts` 里 `window.setTimeout` **只许出现一次**（闪灯那条），
   且 `setPressedKeys` 只许出现 3 次（pressKey / releaseKey / clearPressed）。
   这条**由结构守卫钉住**（纯代数测不出定时器 —— 它只是在某个时刻改状态）。
2. **`showPressed = pressed || externalHeld`（取或），不许「外部信号说了算」。**
   旧版 `else setPressed(false)` 让任一个键的外部信号有权清掉别的键的本地按下态。
   ⛔ **三处渲染决策（边框色 / transform / transition）必须全部读 `showPressed`** ——
   只写 `showPressed` 那行但决策点仍读裸 `pressed`，表现是**「键盘路径不亮、指针路径正常」**，
   而 `toContain('showPressed = …')` 这种守卫**完全抓不住**（见 `REF-env.md §8`）。
3. **keydown 与 keyup 的派发语义相反**（`shortcuts.ts`）：
   - keydown：命中即**短路**；keyup：**不短路**（派发给所有匹配者 ——
     短路会吃掉后面那些键的松开事件，它们永远卡在按下态）
   - keydown `guardInput` 默认 **true**（打字保护）；keyup 默认 **false**
   - keyup **不设 `when`**（门禁只该拦「按下」；拦住松开 = 卡死）
   - keyup `keys` 可省略 = **收全部**（绑定表用户随时可改，按 `keys` 过滤会漏收；
     松开的代价不对称：多收一次只是白跑，漏收一次就永久卡住）
4. **让「按下态」驱动的路径不要经过「声音层」的判断。**
   `playNote` 只在**不可演奏**时返回 `null`；`handlePress` 返回 null（KeyMachine 未就绪）
   必须退化成哑结果 —— 否则按了绑定键毫无视觉反馈。
   ⛔ 这个坑**只在键盘路径显形**（指针路径的本地按下态在调 `onPress` 之前就设好了）。

### ⭐ 验收：只能靠实机探针

- `scripts/probe-keys-anim.mjs`（14 项）：S1 鼠标长按 / S2 触摸双指同按 / S3 键盘同按。
  读 `el.style.transform`（React 写下的**目标态**，与「有没有按下」一一对应，
  不受过渡进度影响，不用赌时序）；按下判据是 `/scale\(0\.9[46]\)/`（兼容 reduce-motion 的 0.96）。
- 手指/键盘同时按的场景**单测覆盖不到**：单测能证明「集合里装得下三个键」，
  证明不了「两根手指各自派发了 pointerdown」。**连接处必须实机测。**
- 探针三个坑（焦点 / touchEnd 点语义 / `maxTouchPoints` 1..16）→ `2026-09-27.md §G`。

