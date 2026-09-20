---
name: browser-probe-driven-tuning
description: 用真浏览器探针驱动调优前端音频/DSP/AI 参数（音高检测、basic-pitch 阈值、worker 超时与降级链），以及验证 React 交互接线与「计算样式」（Tailwind 静默失效的类名、悬停 vs 选中是否真不同色）。当需要「量出」某个运行时行为而不是靠读代码猜（AI 检测为什么未检出、YIN 两份实现是否一致、某个阈值档改坏了几个素材、某个高亮样式为什么看不见、回车到底 dispatch 了什么）时使用。含探针页写法、CDP 驱动脚本、UI 计算样式探针、DOM 结构（分组归属/激活态）断言、以及 12 个会浪费整轮时间的坑（含「上一步把元素卸载了，下一步误判成没渲染」「同一帧连点两次会越过 state 互斥锁」「注入的 JS 是模板字符串，注释里写反引号会把字符串截断」「别用截图判断布局，量 getBoundingClientRect」「钩子读属性的层级读错了，Number(null)===0 伪装成功能没实现」）。
agent_created: true
---

# 真浏览器探针驱动调优

本项目有大量「只在运行时才知道」的行为：tfjs 在 worker 里选哪个后端、basic-pitch
一次推理多久、生产 worker 实际收到几秒 PCM、降级链最后停在哪个模式。
**读代码推测过一次就翻车**（把 AI 检测失效归因到别处，实际是 4 秒输入 15076ms > 15000ms 预算）。
需要下结论时，先写探针页拿数字。

## 一条命令跑探针

```bash
# 1. 起 dev server（探针页是 ESM，必须由 vite 服务，不能 file:// 打开）
npm run dev -- --port 5199 --strictPort        # 后台跑

# 2. 拉 headless Chrome 跑探针页，输出落盘
node scripts/probe-ai/_run-probe.mjs "/scripts/probe-ai/probe-ai-sweep.html" \
     "--timeout=600000" "--out=.probe-ai-sweep.txt"
```

`_run-probe.mjs` = 「等 dev server 就绪」+ `_probe-ai-browser.mjs`（自拉 Chrome + CDP，
不依赖 puppeteer/playwright，复用 `scripts/cdp-shot.mjs` 的策略）。

## 探针页怎么写

- 顶部 `import` **生产模块本体**，不抄一份常量。抄一份就会和线上漂移 ——
  当年 15000ms 与 4 秒输入不一致正是这种漂移造成的。
- 需要真 worker 时 `new Worker(new URL('../../src/engine/pitch-worker.ts', import.meta.url), { type: 'module' })`，
  跑的就是上线那一份；探针副本通过 ≠ 线上通过。
- 结果双通道：`console.log('[probe]', ...)` 和 `window.__PROBE_LINES__ = lines`。
  驱动脚本会先收 console，再用 `Runtime.evaluate` 兜一次 `__PROBE_LINES__`
  （console 可能被截断）。
- 结尾必须 `log('=== DONE ===')` —— 驱动脚本靠这个字符串判断跑完了。

## 轻量变体：自包含的单页探针（`scripts/_probe-palette.mjs`）

`_run-probe.mjs` 那条链是给「跑生产 worker + 长任务」用的。验 **React 交互 / 样式**
这类快问题，用自包含写法更省事 —— 参照 `scripts/_probe-palette.mjs`：

- 驱动脚本**自己** `spawn('npx.cmd', ['vite', ...])` 起 dev server、自己拉 Chrome、
  自己连 CDP，跑完 `chrome.kill()` + `vite.kill()`。不用先手动起 server，一条命令闭环。
- 键盘事件用 `Input.dispatchKeyEvent`（`key` / `code` / `windowsVirtualKeyCode` 三个都要给，
  只给 key 时 React 拿到的 `e.key` 可能是空）；鼠标用 `Input.dispatchMouseEvent`
  的 `mouseMoved` / `mousePressed` / `mouseReleased`，**双击要 `clickCount: 2`**。
- 探针页把观测口挂到 `window`（`__rows()` / `__footerText()` / `__commits`），
  驱动侧 `Runtime.evaluate` + `JSON.stringify` 取回。
- 断言用 `check(name, pass, detail)` 攒数组，末尾打印 `N/N 通过` 并 `process.exit(failed?1:0)`。

## UI 探针：`getComputedStyle` 是唯一可信口 —— 样式会**静默失效**

「某个高亮看不见」这类问题，**读 JSX 永远查不出来**：类名写得对、`tailwind.config`
里颜色也在、`tsc` 也不报错，但生成物里根本没有那条 CSS 规则。

真实案例：`bg-flame-600/28` 的 `28` **不在 Tailwind 默认 opacity 刻度内**
（刻度是 0/5/10/15/20/25/30/…）→ 类名被**静默丢弃**、无警告无报错 →
`getComputedStyle(el).backgroundColor` 实测 `rgba(0, 0, 0, 0)`。
结果是一个「光标高亮」长期不可见，而它恰恰是核心交互反馈。

判据：探针里对每一档状态取 `getComputedStyle(row).backgroundColor`，
断言 ① 互不相同、② 该有底的**不是** `rgba(0,0,0,0)`。

排查全项目用一次性审计脚本：扫所有源文件的 `(?:bg|text|border|shadow|from|to|via)-<color>/(\d+)`，
把 `/N` 里 N 不在刻度内的揪出来（**假阳性**：类名前缀还有 `!` 或变体 `[&::-webkit-…]:`
的会被正则截断，要按完整类名再核一遍）。命中后有两种修法：
落到刻度内（`/28`→`/25`），或用方括号任意值 `/[0.28]`。

**约定**：需要刻度外的透明度一律写 `bg-x/[0.28]`。

## 十三个会白费一整轮的坑

### 0. 本会话首跑 Bash 时 PATH 可能是坏的

症状：命令**静默 `exit 0` 却零输出**，stderr 只有
`shell-runtime-bash-env.sh: line 3: dirname: command not found`，
连 PowerShell 也收不到任何回显。别急着以为「命令没输出 / 文件不存在」——
在命令前显式补一条 PATH 就好：

```bash
export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Windows:\
/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3:\
/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:\
/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"
```

（连 `date` 都拿不到时，用 `ls -la --time-style=full-iso <file>` 的 mtime 判断「今天」，
不要相信注入的 `current_time` —— 它可能整体偏一天。）

### 1. 一次推理，多档后处理

要扫 N 组参数时，**只跑一次模型**，然后拿同一份输出跑 N 次后处理。
`basic-pitch` 的 `evaluateModel` 吐出 frames/onsets/contours 三份概率图，
而 `outputToNotesPoly` 的阈值只是**切音符**（纯 JS、微秒级）。
不这么做的话 41 个素材 × 4 档 = 4 倍推理时间（每档 ~4 秒 → 白等 8 分钟）。

### 2. PowerShell 的 stdout 在本会话里可能完全收不到

直接把结果 `>` 到文件会拿到 UTF-16LE（Read 报「binary file」）。
用 `... 2>&1 | Out-File -Encoding utf8 <file>`，然后 Read 那个文件。
**别依赖终端回显**判断成功与否。

**但这条只适用于纯 ASCII 输出。** `Out-File -Encoding utf8` / `Set-Content -Encoding utf8`
会把**中文**写坏：原生命令的 stdout 先按控制台代码页解码、再重编码成 UTF-8，
于是 `git diff` 里的中文全变成 `鍣０瀹氭爣` 这类乱码（实测一条 `git diff` 落盘后 377 行乱码）。
**探针输出里带中文（几乎必然带）时，让脚本自己 `writeFileSync(path, text, 'utf8')` 落盘，
不要经过 PowerShell 管道。**

这个坑还有第二重伤害：验收编码时会把这些临时文件当成「项目里的乱码」。
（详细版见 skill `repo-encoding-and-emoji-hygiene`。）

### 3. `_run-probe.mjs` 里别用会覆盖输出的 `note()`

`note()` 只写驱动自己的几行日志；在拼好「驱动日志 + 探针输出」落盘之后再调一次
`note()`，会把探针输出整个盖掉 —— 症状是拿到一份只有 4 行的「空报告」，
看起来像探针没跑，其实是驱动自己写的。

### 4. vite 只听 `localhost`，而 node 的 fetch 可能解析到 `::1`

用字面 `http://127.0.0.1:PORT` 探活会 `ERR_CONNECTION_REFUSED`，
看起来像「dev server 没起来」。两个主机名都要试。

另外：Chrome 偶发起不来（CDP 端点超时）。跑之前
`Get-Process chrome | Stop-Process -Force` 清残留，或直接重跑一次。

### 5. 上一个断言把元素**卸载**了，下一个断言量到的就不是「没渲染」

同一个探针脚本里的状态是**累积**的：某一步点了「应用」/「取消」把 Modal 关掉之后，
后面的断言再 `document.querySelector('[data-xxx]')` 只会拿到 `null` ——
**报告出来是「这个控件没渲染」，实际是「它已经不在了」**，方向完全不同，会带着你去改错的文件。

规矩：**断言新区域之前先重新 `load()`**（重新 navigate + 等 `window.__ready`），
别指望前一段的 UI 状态还在。实测踩过：新增的「变调引擎选择器」7 条断言第一次全挂在
`引擎选择器已渲染`，因为上一节点完「应用」面板就关了。

### 6. 验「分组/层级」要量**结构**，不是量文案

要证明「两组东西被分开了」，别只断言 `textContent.includes('@audio/shift')` ——
文案可能来自 `title` 或注释，而用户看到的是**结构**。

**弱做法**（只在「分组=一根分隔线」时成立）：数分组标签节点数、数
`span[aria-hidden="true"]`。分组方式一改（比如换成带标签列的成组行）就全废。

**强做法：按 DOM 层级读「每一组里到底有哪些成员」**，然后**逐组核对归属**：

```js
window.__engineGroups = () => {
  const box = document.querySelector('[data-engine-groups]');
  return [...box.children].map((row) => ({
    label: row.children[0]?.textContent?.trim() ?? '',
    ids: [...row.querySelectorAll('[data-engine-id]')].map((b) => b.getAttribute('data-engine-id')),
  }));
};
```

断言写成「期望的 4 组 × 每组期望的 id 列表，与实测逐组全等」。
这样**任何一个成员被挪错组**都会红，而「只渲染了几个标签」更是当场被抓。

配套：**给每个可选项加 `data-*id`，探针按 id 找元素、不按可见文字找** ——
改文案不会让探针假失败，也让「少接了一个」变得可断言（id 清单列死在探针里，
没人会去数 chip 个数，漏一个从界面上根本看不出来）。

### 7. 分两次 `eval` 读「相关状态」→ 假失败

要断言「界面上显示的 X 与内部状态 Y 一致」时，**必须一次 `eval` 把两者一起取回来**：

```js
// ✗ 两次读之间状态可能已经变了 → 随机 FAIL，而且看起来像产品 bug
const y = await ev('window.__state()');
const x = await ev('window.__domHook()');

// ✓ 同一次同步求值里取快照，两个值必然属于同一时刻
const snap = await ev('JSON.stringify({ y: window.__state(), x: window.__domHook() })');
```

尤其当被测的东西是**异步加载**的（引擎、模型、worker），两次读之间恰好加载完成，
就会量到「界面说 A、状态说 B」。实测踩过：刷新后引擎正在自动加载，
分两次读得到一个说 `wasm`、一个说 `已加载`。

### 8. 轮询等错了条件 → 立刻跳出循环，读到**切换前**的值

等一个异步操作完成时，轮询条件必须是**这个操作真正会改变的那个量**。
拿一个「本来就成立」的量当条件，循环第一次就退出。

实测踩过：点 chip 切换引擎后我轮询 `shiftReady`（引擎就绪），
但**上一个引擎本来就是就绪的** → 条件立刻为真 → 读到的还是切换前的 `choice`，
报出「切换没生效」。实际是探针的锅，产品没问题。
正确条件：`choice !== '<新引擎 id>'`，即等**目标值**出现。

### 9. 注入的 JS 是**模板字符串** —— 里面写反引号会把字符串截断

`await ev(\`JSON.stringify(...)\`)` 里的内容活在模板字符串中。
在该 JS 里写注释时，若注释里出现反引号，模板字符串会**当场结束**，
后续内容变成顶层代码 → Node 报 `SyntaxError: missing ) after argument list`，
指向的却是模板字符串开头，极难看懂。

```js
// ✗ 注释里的反引号提前结束了外层模板字符串
await ev(`JSON.stringify((() => {
  /* 注意：\`data-engine-groups\` 挂在内部容器上 */
  ...
})())`);

// ✓ 注释里不要出现反引号（用普通引号或直接不加引号）
```

同类：注入的 JS 里要写反引号本身时，记得转义。

### 10. 布局别只看截图，但也**别只量一个视口** —— 必须跨断点量

截图会骗人：视口宽度、`--force-device-scale-factor`、`--sel/--clip` 的组合
会让元素在一个**比真实窄**的布局里渲染。所以：**先量尺寸判断布局，再看截图确认观感**。

```js
const r = el.getBoundingClientRect();
// 还要看 box.scrollHeight vs box.clientHeight —— 才能知道「有没有被裁 / 要不要滚」
```

⚠️ **但「只量一次」同样会骗人，而且更危险 —— 会把真 bug 判成假象。**
2026-09-20 踩过：截图看起来「最后一组被裁掉」，量了一次（900px 视口）得到
宽 476px / 总高 77px / 不溢出，于是**结案为「截图假象」**。
可那个宽度恰好是**唯一正常的一档**：`<1024px` 是单列，元素满宽；
`≥1024px`（`lg:`）布局切成两列，元素只剩 **244px**，内容需要 **157px**，
**容器 `max-h-[7.5rem]`（120px）真的把最后一组裁掉了** —— 用户据此报「功能被删了」。

```js
// 量布局时循环跨断点（Tailwind：sm 640 / md 768 / lg 1024 / xl 1280）
for (const w of [1500, 1280, 1100, 900, 768, 420]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false });
  const g = await ev(`(() => {
    const b = document.querySelector('[data-the-box]');
    return { w: window.innerWidth, clientH: b.clientHeight, scrollH: b.scrollHeight };
  })()`);
  // scrollH > clientH + 1 → 有内容在视野外
}
```

**断点处布局常常会「跳变」（单列↔多列），所以任何一个断点都可能与相邻的结论相反。**
断言要写「所有断点都不许溢出」，而不是「某处量着没问题」。

### 11. 「DOM 里在」≠「看得见」≠「点得动」—— 三件事要三条断言

容易被当作一回事，但它们是三个独立层次，失败时长得**一模一样**：

| 层次 | 断言方式 | 没测到会怎样 |
|---|---|---|
| 在 DOM 里 | `querySelectorAll(...).length === N` | — |
| **看得见** | `scrollH <= clientH + 1`；逐组量 `top + height <= clientH` | 选项被 `max-height` 裁到视野外，用户以为功能被删 |
| **点得动** | 逐个触发后断言 `ready && !failed && effective === id` | 动态 `import()` 抛错（包没装／默认导出不是函数），界面与正常项毫无区别 |

**第 3 条尤其值钱**：18 个「引擎」在界面上长得一样，只有逐个真加载才能发现
其中某个的 `LOADERS[id]()` 是坏的。「数量对」完全覆盖不到它。

```js
// 逐个点选 + 用同一个快照同时等「模块状态」与「界面声明」——
// 模块状态是同步写入的、立刻翻；data-* 属性要等重渲染才跟上。
// 只等前者会在两帧之间读出「新/旧」混合，报出假失败。
await ev(`window.__pick('${id}')`);
let s = await snapshot();
for (let i = 0; i < 40 && !(s.state === id && s.ui.effective === id); i++) { await sleep(100); s = await snapshot(); }
```

### 12. 钩子读属性的**层级**要对

`root.getAttribute('data-x')` 只在属性真挂在 `root` 上时才返回字符串，
否则返回 `null` —— 而 `Number(null) === 0`，于是一个「读了但读到 0」
会被误读成「功能没实现」。实测踩过：`data-engine-groups` 挂在**内部滚动容器**上，
却从外层 `[data-engine-picker]` 读，断言红了而产品是对的。

**规矩**：加 `data-*` 钩子时，同一次改动里就把「谁是它的宿主元素」写进探针注释；
探针里一律从**确切的那个元素**取（`document.querySelector('[data-engine-groups]')`），
不要图省事从外层 `root` 取。

## 判据

- 用**同名对照组**：改前先落一份基线（`.probe-*-before.txt`），否则只能说
  「现在是这样」，说不出「之前差在哪、这次修没修到」。
- 全量真素材是 41 个（`素材/*.mp3`）。抽样会让「弃权 4 个」这类小数字变得不可信。
- 报数要报**分子分母**（`2/41` 而不是 `5%`），并且把清单打出来
  （哪几个素材、差多少音分）—— 清单才是能复查的东西。
