/**
 * _probe-palette.mjs —— NotePalette 交互探针的驱动脚本（CDP + headless Chrome）。
 *
 * 验的是**纯逻辑测不到**的两件事：
 *   ① React 接线是否正确 —— 回车/单击/双击真的 dispatch 了该 dispatch 的动作；
 *   ② 四种行状态的「计算样式」是否真的互不相同（用户的核心诉求是「一眼看出
 *      哪个是已选中的、哪个只是光标路过」）。
 *
 * 用法：node scripts/_probe-palette.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.argv[2] ?? 5199);
const URL = `http://localhost:${PORT}/scripts/probe-palette/probe-palette.html`;

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome，无法跑探针');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dev server ──
// 端口上已经有服务就直接复用（开发时常驻一个），省掉每次拉起 + 冷启动预构建的等待。
// 没有才自己起；自己起的才负责关。
let vite = null;
let up = false;
try {
  up = (await fetch(`http://localhost:${PORT}/`)).ok;
} catch {
  /* 没起来 */
}
if (!up) {
  vite = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', shell: process.platform === 'win32' },
  );
  for (let i = 0; i < 120 && !up; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      up = r.ok;
    } catch {
      /* wait */
    }
    if (!up) await sleep(250);
  }
}
if (!up) {
  console.error('dev server 起不来');
  vite?.kill();
  process.exit(2);
}

// ── chrome + CDP ──
const CDP_PORT = 9500 + Math.floor(Math.random() * 300);
/*
  ⚠️ Chrome 的 profile 与截图**不要**落在系统 `tmpdir()`（= C: 盘）。

  为什么专门改这一处：C: 盘常年接近满（实测 2026-09-20：剩余 718MB / 100% 占用），
  而 `%TEMP%` 就在 C: 上 —— 探针跑到写截图那一步直接
  `ENOSPC: no space left on device`，**挂在中间**，报错还出现在一个和音频
  毫无关系的位置，看起来像探针脚本坏了。项目盘另有 30GB 空闲。
  临时产物属于「这个项目的东西」，放项目自己的 tmp 目录既躲开 C: 满盘，
  也顺便让残留物可被 `.workbuddy/` 一起清理。
*/
const probeTmpRoot = join(here, '..', '.workbuddy', 'tmp');
mkdirSync(probeTmpRoot, { recursive: true });
const profile = mkdtempSync(join(probeTmpRoot, 'probe-palette-'));
const chrome = spawn(
  chromePath,
  ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
   '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
   /*
     ⛔ `--no-proxy-server` 必须留着 —— 探针只访问 `localhost`，而本机常年挂着
     系统/环境代理（实测 `HTTP_PROXY=http://127.0.0.1:11123`，且该端口随时可能已经死了）。
     Chrome 默认跟随系统代理 → 对 `http://localhost:5199/...` 的请求被转发给代理
     → 代理回 502「upstream connect failed」→ 页面白屏、模块从未执行
     → `window.__ready` 永远不是 true，`load()` 空等 12s 后继续，
     第一个断言就炸在 `window.__rows is not a function`。
     **表象是「探针脚本坏了」，真因是代理把 loopback 也劫走了。**
     本机的 loopback 绝不走代理，so 直接给 Chrome 关掉代理。
   */
   '--no-proxy-server',
   '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
   '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* wait */ }
  if (!wsUrl) await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const pageErrors = [];
/**
 * 页面控制台（warn/error）也收进来。
 *
 * 为什么需要：`sample-player` 的降级链**只在 console 里留痕**
 * （「第三方引擎「x」变换失败…回退 wasm PSOLA」/「变调失败（mode=1）…」）。
 * 只看渲染结果分不清「出口验收拦下了」和「引擎悄悄返回了一段很小的音频」——
 * 两者都表现为「声音不对」，但一个是设计好的回退、另一个是没发现的 bug。
 */
const pageConsole = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const p = m.params;
    if (p.type === 'warning' || p.type === 'error') {
      const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
      pageConsole.push(`[${p.type}] ${text}`.slice(0, 300));
    }
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  /*
    `Log.entryAdded` 收的是**模块加载失败**这类「网络层」错误。
    为什么必须单独收：`Runtime.exceptionThrown` / `consoleAPICalled` 只覆盖
    **脚本已经跑起来之后**的失败。如果某个 `import` 返回 404/500（例如 Vite
    转换报错、预构建产物缺失），模块图根本不执行 —— 既没有异常、也没有 console，
    探针只能看到「页面白屏」，且白屏的原因一个字都收不到（实测为此白查过一轮）。
  */
  if (m.method === 'Log.entryAdded') {
    const en = m.params.entry;
    /*
      `favicon.ico` 的 404 是**已知无害噪声**：探针页面没有放图标，浏览器每次都必然去讨一次，
      Vite 没有这个文件 → 404。不排掉它，「页面无运行期异常」这条断言会长期假红；
      **假红比不检查更坏** —— 它会训练人忽略这条断言（实测为此白红过一轮）。
    */
    const benign = /\/favicon\.ico(\?|$)/.test(en.url ?? '');
    if (!benign && (en.level === 'error' || en.level === 'warning')) {
      pageErrors.push(`[log:${en.source}] ${en.text}${en.url ? ' @ ' + en.url : ''}`.slice(0, 400));
    }
  }
  if (m.id === undefined) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description ?? '');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * 页面就绪的等待上限（毫秒）。
 *
 * 为什么不是 12s：vite **冷启动**时首次请求页面会触发 `optimizeDeps` 预构建
 * （15 个 `@audio/shift-*` + tfjs/basic-pitch，tfjs 那个 chunk 就有 1.8MB），
 * 期间 Vite 发现新依赖还会**整页 reload**。实测冷启动首次导航 12s 内到不了 ready，
 * 探针会在断言 1 就炸 —— 而那看起来像「探针脚本坏了」，真因只是「等太短」。
 * 给足 45s：热启动仍然瞬间返回，只有冷启动会真正用掉这段等待。
 */
const READY_TIMEOUT_MS = 45000;

async function load(query = '') {
  await send('Page.navigate', { url: URL + query });
  let ready = false;
  const tries = Math.ceil(READY_TIMEOUT_MS / 150);
  for (let i = 0; i < tries; i++) {
    if (await ev('window.__ready === true')) {
      ready = true;
      break;
    }
    await sleep(150);
  }
  /*
    页面没起来就**当场报出真正的原因**，不要静默往下走。
    否则下一个断言会炸在 `window.__rows is not a function` —— 那个报错指向探针
    自己的取数函数，跟真因（代理劫走 loopback / 模块加载失败 / 编译错误）毫无关系，
    实测为此白花了一轮排查（见 Chrome 启动参数里 `--no-proxy-server` 的注释）。
  */
  if (!ready) {
    throw new Error(
      [
        `页面 ${READY_TIMEOUT_MS / 1000}s 内没有就绪（window.__ready !== true）——探针无法继续。`,
        `  导航目标：${URL}`,
        `  页面异常：${pageErrors.join(' | ') || '(无)'}`,
        `  页面控制台：${pageConsole.join(' | ') || '(无)'}`,
      ].join('\n'),
    );
  }
  await sleep(350); // 等 Modal 的入场动画与 useEffect 落定
}

async function type(text) {
  await ev(`document.querySelector('input[aria-label="搜索素材"]').focus()`);
  await send('Input.insertText', { text });
  await sleep(200);
}

/** CDP 修饰键位：1=Alt 2=Ctrl 4=Meta **8=Shift** */
const MOD_SHIFT = 8;

async function key(k, code, vk, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
    });
  }
  await sleep(200);
}

const pressEnter = () => key('Enter', 'Enter', 13);
const pressArrowDown = () => key('ArrowDown', 'ArrowDown', 40);
const pressShiftUp = () => key('ArrowUp', 'ArrowUp', 38, MOD_SHIFT);
const pressShiftDown = () => key('ArrowDown', 'ArrowDown', 40, MOD_SHIFT);
const pressShiftRight = () => key('ArrowRight', 'ArrowRight', 39, MOD_SHIFT);

async function mouse(type, x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
  await sleep(120);
}

async function clickRow(i, clickCount = 1) {
  const rows = await ev('JSON.stringify(window.__rows())');
  const row = JSON.parse(rows)[i];
  await mouse('mouseMoved', row.cx, row.cy);
  await mouse('mousePressed', row.cx, row.cy, clickCount);
  await mouse('mouseReleased', row.cx, row.cy, clickCount);
  await sleep(150);
}

const rows = async () => JSON.parse(await ev('JSON.stringify(window.__rows())'));
const commits = async () => JSON.parse(await ev('JSON.stringify(window.__commits)'));
const byName = (rs, name) => rs.find((r) => r.name === name);
const transform = async () => JSON.parse(await ev('JSON.stringify(window.__transform())'));
const toasts = async () => JSON.parse(await ev('JSON.stringify(window.__toasts())'));
const clearToasts = () => ev('window.__clearToasts()');
/** 页面 warn/error 日志（降级链只在这里留痕，见 pageConsole 的注释） */
const consoleLog = () => pageConsole.slice();
const clearConsole = () => {
  pageConsole.length = 0;
};

// ===========================================================================
// 1. 拼音 / 首字母搜索
// ===========================================================================
console.log('\n── 1. 搜索：张三.mp3 的四种输入 ──');
for (const q of ['张三', 'zhang', 'zs', 'zhangsan']) {
  await load();
  await type(q);
  const rs = await rows();
  const hit = rs[0]?.name === '张三.mp3';
  check(`搜索「${q}」→ 首位是 张三.mp3`, hit, rs.map((r) => r.name).join(' , '));
}

await load();
await type('lisi');
let rs = await rows();
check('搜索「lisi」→ 只有 李四.mp3', rs.length === 1 && rs[0].name === '李四.mp3', rs.map((r) => r.name).join(','));
await load();
await type('cq');
rs = await rows();
check('搜索「cq」（多音字 重庆）→ 命中 重庆.002.mp3', rs.some((r) => r.name === '重庆.002.mp3'), rs.map((r) => r.name).join(','));

// ===========================================================================
// 2. 双保险：键盘
// ===========================================================================
console.log('\n── 2. 双保险（键盘）：回车两下才提交 ──');
await load();
let before = await rows();
check('初始：无任何行处于「已选中」', before.every((r) => r.selected === 'false'), JSON.stringify(before.map((r) => r.selected)));

// 四种行状态的样色（plain / 光标 / 已选中 / 已选中+光标）
const plainBg = byName(before, '李四.mp3').bg;
const cursorOnlyBg = before[0].bg; // 初始光标在首行
check('「光标高亮」真的渲染出了底色（非 transparent）',
  !/rgba?\(0, 0, 0, 0\)/.test(cursorOnlyBg), `cursor=${cursorOnlyBg}`);

await pressEnter();
let after1 = await rows();
let cm = await commits();
check('第一次回车 → 只选中（不提交）', after1[0].selected === 'true' && cm.length === 0,
  `selected=${after1[0].selected} commits=${cm.length}`);

const armedActiveBg = after1[0].bg; // 光标与选中同一行

await pressArrowDown();
let afterMove = await rows();
check('↓ 移动光标：选中项不动（仍是 张三.mp3）', afterMove[0].selected === 'true' && afterMove[1].selected === 'false',
  `row0.selected=${afterMove[0].selected} row1.selected=${afterMove[1].selected}`);
const cursorBg = afterMove[1].bg;
const armedBg = afterMove[0].bg;
check('光标行与已选中行**不同色**', armedBg !== cursorBg,
  `armed=${armedBg}  cursor=${cursorBg}`);

const tones = { plainBg, cursorBg, armedBg, armedActiveBg };
const uniq = new Set(Object.values(tones));
check('四种状态样色两两不同', uniq.size === 4, JSON.stringify(tones));

await send('Page.captureScreenshot', {}).then(async (r) => {
  const { writeFileSync } = await import('node:fs');
  // 同样避开 C:（见 profile 那段注释）
  const outDir = join(here, '..', 'outputs', 'probe');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'probe-palette.png');
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`  （截图：${out}）`);
});

await pressEnter();
let after2 = await rows();
cm = await commits();
check('光标切到别的素材后回车 → 视为「选中」而非提交', cm.length === 0 && after2[1].selected === 'true',
  `commits=${cm.length} row1.selected=${after2[1].selected}`);

await pressEnter();
cm = await commits();
check('在已选中项上回车 → 真正确认（提交 李四.mp3）',
  cm.length === 1 && cm[0][1] === 'p2', JSON.stringify(cm));

// ===========================================================================
// 3. 双保险：鼠标
// ===========================================================================
console.log('\n── 3. 双保险（鼠标）：单击选中、悬停不改目标 ──');
await load();
await clickRow(2); // 张三丰.mp3
let r3 = await rows();
cm = await commits();
check('鼠标单击 → 整行变色且是「已选中」（不提交）',
  r3[2].selected === 'true' && cm.length === 0, `selected=${r3[2].selected} commits=${cm.length}`);
check('「已选中」与「光标高亮」样色不同，且已选中为不透明实色',
  r3[2].bg !== cursorBg && !/rgba?\(.*,\s*0\.\d+\)/.test(r3[2].bg),
  `armed=${r3[2].bg}  hover=${cursorBg}`);

// 悬停到另一行：光标动，选中不动
const r4rect = (await rows())[4];
await mouse('mouseMoved', r4rect.cx, r4rect.cy);
await sleep(200);
let rHover = await rows();
check('悬停别的行使光标移动，但不改变选中项',
  rHover[4].cursor === 'true' && rHover[2].selected === 'true' && rHover[4].selected === 'false',
  `row4.cursor=${rHover[4].cursor} row2.selected=${rHover[2].selected}`);

// 点「应用」：目标应为「已选中」的张三丰，而不是光标所在的重庆
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '应用').click()`);
await sleep(250);
cm = await commits();
check('点「应用」→ 提交**已选中**的 张三丰.mp3（悬停没有改变目标）',
  cm.length === 1 && cm[0][1] === 'p3', JSON.stringify(cm));

console.log('\n── 4. 鼠标双击 = 选中 + 确认 ──');
await load();
await clickRow(1, 1);
await mouse('mousePressed', (await rows())[1].cx, (await rows())[1].cy, 2);
await mouse('mouseReleased', (await rows())[1].cx, (await rows())[1].cy, 2);
await sleep(250);
cm = await commits();
check('双击素材行 → 直接确认（提交 李四.mp3）', cm.length === 1 && cm[0][1] === 'p2', JSON.stringify(cm));

// ===========================================================================
// 5. 界面文案是否随状态变化
// ===========================================================================
console.log('\n── 5. 状态化提示文案（三种状态）──');
/*
  页脚提示现在有**三态**（2026-09-20 起）：
    ① 没有可调目标（音符没装素材、也没选中）→ 教用户怎么开始；
    ② 音符已装配、尚未改选 → 必须写出「调音作用在 <哪一个素材>」，
       否则用户按 Shift+↑ 改了东西却不知道改的是谁；
    ③ 明确选中后 → 「已选中 <名称> · 回车应用」。
  三态都要钉住：只测 ① 和 ③ 会让 ② 变成「界面上没有这句话」的静默缺失。
*/
await load('?eff=none');
const hint0 = await ev(`document.body.innerText.includes('回车选中 · 再回车应用')`);
check('无可调目标时：提示「回车选中 · 再回车应用」', hint0 === true, String(hint0));

await load('?eff=p1');
const hasPlacedHint = await ev(`document.body.innerText.includes('调音作用在')`);
const namesPlaced = await ev(`document.body.innerText.includes('张三.mp3')`);
check(
  '已装配且未改选时：提示「调音作用在 <当前装配>」（说清 Shift+↑ 改的是谁）',
  hasPlacedHint === true && namesPlaced === true,
  `含「调音作用在」=${hasPlacedHint} 含素材名=${namesPlaced}`,
);

await pressEnter();
const hint1 = await ev(`document.body.innerText.includes('已选中')`);
check('已选中后：提示改为「已选中 <名称> · 回车应用」', hint1 === true, String(hint1));

// ===========================================================================
// 6. 调音 / 变速 / 试听的目标（2026-09-20 用户实报后重写）
//
// 旧契约：目标 = 已选中行（`armedId`），没按过 Enter 就拦下并提示
// 「还没有选择素材 请按Enter选择素材」。
//
// 用户原话：「当 Shift+A 的是已经有装配素材的音符块，那就不应该视为没有选择素材 ——
// 正常调音调的是当前音符的素材；除非按下 Enter 选其他的素材了，那就走正常的链路。」
//
// 新契约：目标 = 已选中行 ?? **这条音符本来就装着的素材**（`placedId`）。
// 所以本节必须把两种情形**分开**钉住（靠探针页的 `?eff=` 切换）：
//   A/D：eff=p1   音符已装配 → 调音**直接可用**，不必先 Enter；目标指向那条素材；
//   B  ：回车改选别的素材 → 目标切到选中项（正常链路）；
//   C  ：光标停在已装配素材上时，首次回车仍然只「选中」（双保险不能破功）；
//   E  ：eff=none 音符**没**装配 → 这才是真的「没有选择素材」，必须拦下且数值不动。
//
// 少测 A 就会漏掉用户报的这个 bug；少测 E 则会把「没素材也别拦」这种过度宽松
// 当成正确 —— 两种都必须有。
// ===========================================================================
console.log('\n── 6. 调音 / 变速 / 试听的目标（已装配 vs 未装配）──');

const HINT = '还没有选择素材 请按Enter选择素材';
const hintCount = (log) => log.filter((t) => t === HINT).length;

// ───────────── A. 音符**已经装配了素材**（用户报的正是这一种）─────────────
await load('?eff=p1');
await clearToasts();

const a0 = await transform();
check(
  'A 已装配：调音 / 变速两组**不再**禁用',
  a0.pitchDisabled === null && a0.stretchDisabled === null,
  `pitch=${a0.pitchDisabled} stretch=${a0.stretchDisabled}`,
);
check(
  'A 已装配：± 按钮真的可点（不是只解禁了容器）',
  a0.minusBtnDisabled === false && a0.plusBtnDisabled === false && a0.stretchPlusDisabled === false,
  `minus=${a0.minusBtnDisabled} plus=${a0.plusBtnDisabled} stretch+ =${a0.stretchPlusDisabled}`,
);
check('A 已装配：不要出现「还没有选择素材」的就地提示', a0.armRequired === false);
check(
  'A 已装配：快捷键提示可用，且调音目标 = 这条音符自己的素材 p1',
  a0.shortcutsTunable === 'true' && a0.tuneTarget === 'p1',
  `tunable=${a0.shortcutsTunable} target=${a0.tuneTarget}`,
);

/*
  ⚠️ 下面两条的 toast 日志里会出现「试听失败：该素材的音频数据已丢失」——
  那是**夹具的正常现象**（假素材没有在 store 里注册 blob，解码不出缓冲，
  试听当然失败），与被测的「目标解析」无关。
  所以断言只数「还没有选择素材」这一条，而**不是**「日志为空」；
  后者会因为夹具的这个缺陷长期假红 —— 假红比不检查更坏。
*/
await pressShiftUp(); // 注意：**没有**先按 Enter
const a1 = await transform();
const aLog1 = await toasts();
check('A 已装配：不按 Enter 直接 Shift+↑ → 音高 +1', a1.pitchValue === '+1 半音', String(a1.pitchValue));
check('A 已装配：Shift+↑ **不弹**「还没有选择素材」', hintCount(aLog1) === 0, JSON.stringify(aLog1));

await pressShiftRight(); // 变速同样不需要 Enter
const a2 = await transform();
check(
  'A 已装配：不按 Enter 直接 Shift+→ → 时长变化（步进基准取自已装配素材的时长）',
  a2.tauValue !== a0.tauValue && a2.tauValue !== null,
  `${a0.tauValue} → ${a2.tauValue}`,
);

/*
  ⛔ 这一节最关键的一条：把光标移到**别的行**之后再调音。
  如果目标退化成光标行，这里就会改到「鼠标刚好停的那一行」——
  而两种情形的界面几乎一模一样，只有读 `data-tune-target` 才看得出来。
*/
await pressArrowDown();
await pressShiftUp();
const a3 = await transform();
check(
  'A 已装配：光标移到第 2 行后，调音目标**仍是 p1**（光标不能改变目标）',
  a3.tuneTarget === 'p1' && a3.pitchValue === '+2 半音',
  `target=${a3.tuneTarget} pitch=${a3.pitchValue}`,
);

await ev(
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '应用').click()`,
);
await sleep(250);
const aCm = await commits();
check(
  'A 已装配：不按 Enter 点「应用」→ 提交的就是 p1 + 刚设的 Δ（调的是谁就提交谁）',
  aCm.length === 1 && aCm[0][1] === 'p1' && aCm[0][3] === 2,
  JSON.stringify(aCm),
);

// ───────────── B. 回车改选别的素材 → 走正常链路 ─────────────
await load('?eff=p1');
await pressArrowDown(); // 光标 → p2（李四.mp3）
await pressEnter(); // 第一次回车：只「选中」，不提交
const b0 = await transform();
check('B 回车改选：目标切到 p2（用户明确选的那一个）', b0.tuneTarget === 'p2', `target=${b0.tuneTarget}`);
await clearToasts();
await pressShiftUp();
const b1 = await transform();
const bLog = await toasts();
check(
  'B 回车改选：Shift+↑ → 音高 +1，且不弹提示',
  b1.pitchValue === '+1 半音' && hintCount(bLog) === 0,
  `${b1.pitchValue} / ${JSON.stringify(bLog)}`,
);
await pressEnter(); // 第二次回车：确认
await sleep(250);
const bCm = await commits();
check(
  'B 回车改选：二次回车提交的是**新选中项 p2**',
  bCm.length === 1 && bCm[0][1] === 'p2' && bCm[0][3] === 1,
  JSON.stringify(bCm),
);

// ───────────── C. 双保险不因 placedId 破功 ─────────────
await load('?eff=p1');
await pressEnter();
const cc0 = await transform();
const cCm = await commits();
check(
  'C 双保险：光标停在已装配素材上时，首次回车仍只「选中」不提交',
  cCm.length === 0 && cc0.tuneTarget === 'p1',
  `commits=${JSON.stringify(cCm)} target=${cc0.tuneTarget}`,
);

// ───────────── D. 音符**还没装配素材** —— 这才是真的「没有选择素材」─────────────
await load('?eff=none');
await clearToasts();

const d0 = await transform();
check(
  'D 未装配：调音 / 变速两组是禁用态',
  d0.pitchDisabled === 'true' && d0.stretchDisabled === 'true',
  `pitch=${d0.pitchDisabled} stretch=${d0.stretchDisabled}`,
);
check(
  'D 未装配：± 按钮真的 disabled（不是只变灰）',
  d0.minusBtnDisabled === true && d0.plusBtnDisabled === true && d0.stretchPlusDisabled === true,
  `minus=${d0.minusBtnDisabled} plus=${d0.plusBtnDisabled} stretch+ =${d0.stretchPlusDisabled}`,
);
check('D 未装配：就地提示可见', d0.armRequired === true);
check(
  'D 未装配：快捷键提示整条置灰，且确实没有调音目标',
  d0.shortcutsTunable === 'false' && (d0.tuneTarget === '' || d0.tuneTarget === null),
  `tunable=${d0.shortcutsTunable} target=${JSON.stringify(d0.tuneTarget)}`,
);

await pressShiftUp();
const d1 = await transform();
const dLog1 = await toasts();
check('D 未装配 Shift+↑ → 弹出指定提示', hintCount(dLog1) === 1, JSON.stringify(dLog1));
check(
  'D 未装配 Shift+↑ → 音高数值**不动**（被拦下，不是改了没说）',
  d1.pitchValue === d0.pitchValue,
  `${d0.pitchValue} → ${d1.pitchValue}`,
);

/*
  ⚠️ toast store 有 500ms 的同文案去重窗口。要断言「第二次也弹」，
  必须等过窗口，否则测的是去重而不是我们的守卫。
*/
await sleep(600);
await pressShiftRight();
const d2 = await transform();
const dLog2 = await toasts();
check('D 未装配 Shift+→ → 同样弹出提示', hintCount(dLog2) === 2, JSON.stringify(dLog2));
check(
  'D 未装配 Shift+→ → 时长数值**不动**',
  d2.tauValue === d0.tauValue,
  `${d0.tauValue} → ${d2.tauValue}`,
);

// 回车选中首行（张三.mp3）→ 三个动作解禁
await pressEnter();
const d3 = await transform();
const rs6 = await rows();
check(
  'D 未装配：回车选中后两组控件解禁',
  d3.pitchDisabled === null && d3.stretchDisabled === null,
  `pitch=${d3.pitchDisabled} stretch=${d3.stretchDisabled}`,
);
check(
  'D 未装配：回车选中后就地提示消失、快捷键提示转为可用',
  d3.armRequired === false && d3.shortcutsTunable === 'true',
  `armRequired=${d3.armRequired} tunable=${d3.shortcutsTunable}`,
);
check(
  'D 未装配：回车选中的确实是首行 张三.mp3',
  rs6[0].selected === 'true',
  JSON.stringify(rs6.map((r) => r.selected)),
);

await clearToasts();
await pressShiftUp();
const d4 = await transform();
const dLog4 = await toasts();
check('D 未装配：已选中后 Shift+↑ → 音高 +1 半音', d4.pitchValue === '+1 半音', String(d4.pitchValue));
check(
  'D 未装配：已选中后 Shift+↑ → **不再**弹「还没有选择素材」',
  hintCount(dLog4) === 0,
  JSON.stringify(dLog4),
);

await ev(
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '应用').click()`,
);
await sleep(250);
const dCm = await commits();
check(
  'D 未装配：点「应用」→ 提交选中的 p1 + 刚设的 Δ',
  dCm.length === 1 && dCm[0][1] === 'p1' && dCm[0][3] === 1,
  JSON.stringify(dCm),
);

// ===========================================================================
console.log('\n── 7. 变调引擎选择器（@audio/shift 15 个算法全在，且按域分组）──');

/*
  为什么值得钉住：
  ① 数量。用户的要求是「`@audio/shift` 号称 15 种算法，都接入选项看看」——
     少一个就等于没做到，而少一个从界面上**看不出来**（没人会去数）。
     所以这里把 15 个 id 逐个列出比对，宁可改引擎清单时同步改这里。
  ② 分组归属。18 个 chip 平铺会糊成一片，必须按算法域分组渲染；
     「有没有真的分组」只能按 DOM 层级验 —— 读 textContent 分不出归属。
  ③ 不能混进 `pitchShift`（那个 meta 包的自动选择器）：它静态 re-export 全部
     15 个子包，import 它会把按需加载毁掉。

  注意：上一节点完「应用」后面板就关了，引擎选择器随之卸载 ——
  所以这里必须先重新 load 一次，否则量到的是「元素不存在」，不是「没分组」。
*/
await load();

/** 15 个算法，按域分组（与 `external-shift.ts` 的 EXTERNAL_ENGINES 一一对应） */
const EXPECT_GROUPS = [
  {
    label: '频域',
    ids: [
      'lib-vocoder',
      'lib-phaselock',
      'lib-transient',
      'lib-formant',
      'lib-hpss',
      'lib-sms',
      'lib-paulstretch',
    ],
  },
  { label: '时域', ids: ['lib-psola', 'lib-wsola', 'lib-ola', 'lib-delay', 'lib-granular', 'lib-sample'] },
  { label: '源-滤波', ids: ['lib-lpc', 'lib-hybrid'] },
  { label: 'SoundTouchJS', ids: ['st-wsola', 'st-long', 'st-pvoc'] },
];

const picker = JSON.parse(
  await ev(`JSON.stringify((() => {
    const root = document.querySelector('[data-engine-picker]');
    if (!root) return null;
    const chips = [...root.querySelectorAll('button')];
    return {
      chipCount: chips.length,
      ids: chips.map((c) => c.getAttribute('data-engine-id')),
      active: chips.filter((c) => c.className.includes('bg-flame-400'))
        .map((c) => c.getAttribute('data-engine-id')),
      groups: window.__engineGroups(),
      /*
        注意：data-engine-groups 挂在内部滚动容器上，不是挂在 root 上 ——
        从 root 取会拿到 null（这条第一次跑就 FAIL 在这里，纯探针写错，不是 UI 错）。
      */
      groupCount: Number(
        document.querySelector('[data-engine-groups]')?.getAttribute('data-engine-groups'),
      ),
      noteLen: (root.querySelector('p')?.textContent ?? '').trim().length,
    };
  })())`),
);

check('引擎选择器已渲染', picker !== null);
if (picker) {
  const expectIds = EXPECT_GROUPS.flatMap((g) => g.ids);
  check(
    '19 个 chip：默认内核 1 + @audio/shift 15 + SoundTouchJS 3',
    picker.chipCount === 19 && expectIds.length === 18,
    `${picker.chipCount} 个（期望 19）：${picker.ids.join(' | ')}`,
  );
  const missing = expectIds.filter((id) => !picker.ids.includes(id));
  check(
    '@audio/shift 的 15 个算法一个不少',
    missing.length === 0,
    missing.length ? `缺少 ${missing.join(', ')}` : '15/15 齐',
  );
  check(
    '没有混进 pitchShift（import 它会把 15 个子包打进同一个 chunk，毁掉按需加载）',
    picker.ids.filter((id) => id.includes('pitchshift') || id.includes('auto')).length === 0,
    picker.ids.join(' | '),
  );
  check(
    '按域分组渲染成 4 组',
    picker.groupCount === 4 && (picker.groups?.length ?? 0) === 4,
    `data-engine-groups=${picker.groupCount} 实际行数=${picker.groups?.length}`,
  );
  /*
    逐组核对归属 —— 这条才是「真的分组了」而不是「碰巧渲染了几个标签」。
    只要某个引擎被挪错了组（比如 time 组里混进 vocoder），这里立刻红。
  */
  const groupOk = EXPECT_GROUPS.every((g) => {
    const row = picker.groups?.find((r) => r.label === g.label);
    if (!row) return false;
    return g.ids.length === row.ids.length && g.ids.every((id) => row.ids.includes(id));
  });
  check(
    '每组的成员与算法域归属完全一致（逐组核对，不是只看有没有标签）',
    groupOk,
    JSON.stringify(picker.groups),
  );
  check(
    '默认停在「我们的 PSOLA」（零行为变化）',
    picker.active.length === 1 && picker.active[0] === 'wasm',
    JSON.stringify(picker.active),
  );
  check(
    '说明行有实质内容（用户听差别前先知道算法类别）',
    picker.noteLen > 20,
    `说明 ${picker.noteLen} 字`,
  );
}

// ===========================================================================
console.log('\n── 8. 引擎切换的稳健性：刷新后必须自愈，且界面不许骗人 ──');

/*
  为什么单独一节：切换引擎最坏的失败不是「切不过去」，而是**切过去了但没生效却不说**。
  `playSample` 只用 `getActiveShift()` 判断走不走外部路径 —— 只要那个库没加载好，
  整个分支被跳过、静默走 wasm，而 chip 依然高亮着用户选的那个。
  用户听到的是「有时生效有时不生效」，从界面上完全看不出来。

  最容易撞上、也最该钉住的场景：**刷新页面**。
  偏好存在 localStorage 里能活下来，但模块级的 `loadedShift` 会清空 ——
  于是「已选中」与「已加载」当场分家。
*/

/**
 * 一次性把「模块状态」与「界面声称」读到同一个快照里。
 * 分两次读会漏掉中间状态变化，产生假失败（实测踩过）。
 */
const engineSnap = async () =>
  JSON.parse(await ev('JSON.stringify({ s: window.__engine(), c: window.__engineChip() })'));

await ev(`window.__setEnginePref('st-long')`);
await load(); // 刷新：模块级状态全部重置，只剩 localStorage

const snap0 = await engineSnap();
check(
  '刷新后 chip 仍高亮「ST-长窗」（偏好确实持久化了）',
  snap0.c?.activeLabel?.[0] === 'ST-长窗' && snap0.s.choice === 'st-long',
  `choice=${snap0.s.choice} chip=${JSON.stringify(snap0.c?.activeLabel)}`,
);
/*
  界面必须**明说**此刻实际生效的是谁。未就绪时 `data-engine-effective` 应当是
  `'wasm'`（那是耳朵里正在发生的事），而不是跟着 chip 高亮一起说 `'st-long'`。
*/
check(
  '刷新后界面声明的「实际生效引擎」与播放路径一致（不会嘴上说 ST、耳朵里是 wasm）',
  snap0.c?.effective === (snap0.s.willUseExternal ? 'st-long' : 'wasm'),
  `界面声明=${snap0.c?.effective} 实际走外部=${snap0.s.willUseExternal}`,
);

/*
  ⚠️ 必须等到**两个**内核都就绪，不能只等 `shiftReady`。

  `restoreEngine()` 是两段顺序 await：先 `ensureEngine`（变调），它 resolve 之后
  才 `ensureStretch`（变速）。于是 `shiftReady` 变 true 的那一刻，变速那一支
  **才刚开始加载** —— 在那里取样必然可能读到 `stretchReady=false`。
  实测踩过：同一次会话里这条断言时红时绿，而红的时候紧接着的
  「点选 ST-WSOLA」立刻就是 ready —— 说明红的是**取样时机**，不是功能坏了。

  等满预算（40×150ms = 6s）足够两段动态 import 跑完；真出问题（库加载失败）
  仍会在预算内保持 false 并报红，所以这不削弱断言。
*/
let after = snap0.s;
for (let i = 0; i < 40 && !(after.shiftReady && after.stretchReady); i++) {
  await sleep(150);
  after = (await engineSnap()).s;
}
check(
  '刷新后引擎会被重新加载回来（不是停在「已选中但没加载」）',
  after.shiftReady === true,
  `shiftReady=${after.shiftReady} loading=${JSON.stringify(after.loading)}`,
);
check(
  '刷新后播放**真的**会走第三方引擎（不会静默退回我们的 PSOLA）',
  after.willUseExternal === true,
  `willUseExternal=${after.willUseExternal}`,
);
/*
  变速内核必须一起就绪：τ≠1 时它是串联的第二级，
  缺了它 `playSample` 会整体回退 wasm，而用户只是「把时长拉了一下」而已。
*/
check(
  '刷新后变速内核也已就绪（τ≠1 时不会悄悄退回旧引擎）',
  after.stretchReady === true,
  `stretchReady=${after.stretchReady} stretchFailed=${after.stretchFailed}`,
);

const snap1 = await engineSnap();
check(
  '就绪后 chip 声明的实际生效引擎 == 用户选的那个',
  snap1.c?.effective === 'st-long' && snap1.c?.status === 'ready',
  `effective=${snap1.c?.effective} status=${snap1.c?.status}`,
);

/*
  再验一次「点选」这条路径，而且是**点一个和当前高亮不同的**引擎：
  切换完成后必须立刻是就绪状态（含变速内核），
  否则切完的第一声还是旧引擎 —— 这是「时好时坏」的另一个来源。
*/
await ev(`window.__pickEngine('st-wsola')`);
/*
  等「切换完成」要等 **choice 变成新引擎**，不能等 `shiftReady` ——
  上一个引擎本来就是就绪的，拿它当条件会立刻跳出循环，
  读到的还是切换前的 choice（这就是这条第一次跑 FAIL 的原因，纯探针竞态）。
  之所以还要连着断言 `stretchReady`：`pick` 是先 await 变速内核、
  再写偏好的，所以 choice 翻过去的那一刻变速必定已经就绪 ——
  「切完的第一声就是新引擎」这条不变量正是这么保证的。
*/
let picked = (await engineSnap()).s;
for (let i = 0; i < 40 && picked.choice !== 'st-wsola'; i++) {
  await sleep(150);
  picked = (await engineSnap()).s;
}
check(
  '点选「ST-WSOLA」后切换真的落到了新引擎上',
  picked.choice === 'st-wsola' && picked.shiftReady === true,
  `choice=${picked.choice} shiftReady=${picked.shiftReady}`,
);
check(
  '切换完成的同一时刻，变速内核也已就绪（切完的第一声就是新引擎）',
  picked.willUseExternal === true && picked.stretchReady === true,
  `willUseExternal=${picked.willUseExternal} stretchReady=${picked.stretchReady}`,
);
const snap2 = await engineSnap();
check(
  '切换后界面声明的实际生效引擎 == 新选的那个',
  snap2.c?.effective === 'st-wsola',
  `effective=${snap2.c?.effective} chip=${JSON.stringify(snap2.c?.activeLabel)}`,
);
check(
  '切换完成后 chip 全部恢复可点（不会卡死在「载入中」）',
  (snap2.c?.disabled?.length ?? -1) === 0 && snap2.c?.status === 'ready',
  `disabled=${JSON.stringify(snap2.c?.disabled)} status=${snap2.c?.status}`,
);

// ===========================================================================
console.log('\n── 9. 不保时长的引擎必须当场警告（`lib-sample`）──');

/*
  为什么单独一节：`@audio/shift-sample` 是这 15 个里唯一「常规指标全绿但东西是坏的」。
  它是播放速率式纯重采样：输出**数组长度**与输入完全相等、电平对、f0 也确实降了,
  唯独内容时间轴被压过 ratio 倍 —— 降调时只读到源的前 ratio 比例，尾巴整段丢掉。
  实测（`probe-all15.mjs` 的标记实验）：尾巴能量 0.000，其余 17 个都在 0.95~1.0。
  换句话说**没有任何一个常规判据能发现它**，所以警告只能靠 UI 显式说出。

  这一节钉两件事：
  ① 选中它时，面板必须把「不保时长」写在明面上（不是只藏在 tooltip 里）；
  ② 它**不许**污染别的引擎 —— 切走之后警告必须消失（否则用户会以为所有引擎都这样）。
*/
const pickAndWait = async (id) => {
  await ev(`window.__pickEngine('${id}')`);
  let snap = await engineSnap();
  for (let i = 0; i < 40 && snap.s.choice !== id; i++) {
    await sleep(150);
    snap = await engineSnap();
  }
  return snap;
};

const snapSample = await pickAndWait('lib-sample');
check(
  '「lib-sample」确实被选中且已就绪',
  snapSample.s.choice === 'lib-sample' && snapSample.s.shiftReady === true,
  `choice=${snapSample.s.choice} shiftReady=${snapSample.s.shiftReady}`,
);
check(
  '选中它时界面标出「不保时长」（data-engine-duration=unsafe）',
  snapSample.c?.duration === 'unsafe',
  `duration=${snapSample.c?.duration}`,
);
check(
  '说明行把它坏在哪讲清楚了（而不是只给个标记）',
  /不保时长/.test(snapSample.c?.note ?? '') && /尾巴/.test(snapSample.c?.note ?? ''),
  `note=${(snapSample.c?.note ?? '').slice(0, 60)}…`,
);

/*
  换成这 15 个里在 −12 半音最干净的那个（实测 HNR 10.40，我们 2.02），
  顺带验「警告不会黏在别的引擎上」。
*/
const snapDelay = await pickAndWait('lib-delay');
check(
  '换到「lib-delay」后时长警告消失（不会让用户以为所有引擎都这样）',
  snapDelay.s.choice === 'lib-delay' && snapDelay.c?.duration === 'safe',
  `choice=${snapDelay.s.choice} duration=${snapDelay.c?.duration}`,
);
check(
  '切到新引擎后说明行确实换成了它的（实际生效引擎与界面一致）',
  snapDelay.c?.effective === 'lib-delay' && (snapDelay.c?.note ?? '').length > 20,
  `effective=${snapDelay.c?.effective}`,
);

// 复位，别把偏好留给下一次跑（否则下一轮一开局就是外部引擎）
await ev(`window.__setEnginePref('wasm')`);
await load();

// ===========================================================================
console.log('\n── 10. 18 个第三方引擎逐个「真加载」（chip 画出来 ≠ 点得动）──');

/*
  为什么单独一节：第 7 节只能证明 18 个 chip **画出来了**、id 一个不缺。
  但「少了一个引擎」还有另一种形态，而且更坏：**chip 在，点了却加载不起来** ——
  `LOADERS[id]()` 抛错（子包没装 / 版本对不上 / 默认导出不是函数）。
  那种情况下界面上完全看不出来：chip 照样高亮，只是耳朵里听不到任何差别。

  这一节把 18 个 id 逐个点一遍，要求同时满足：
    ① `shiftReady === true`      —— 那个库真的进内存了；
    ② `failed === false`         —— 没落进「加载失败」（失败与「还没开始」必须分得开）；
    ③ `willUseExternal === true` —— `playSample` 那次判断真的会走外部路径；
    ④ `data-engine-effective === eid` —— 界面宣称的与①一致，不许嘴上说 A 实际走 wasm。
  单个引擎失败不中断整轮：全部过完再一起报，一眼能看出是哪几个。
*/
const ALL_ENGINE_IDS = EXPECT_GROUPS.flatMap((g) => g.ids);
const notReady = [];
for (const eid of ALL_ENGINE_IDS) {
  /*
    等「切换完成」必须**同时**等模块状态与界面声明：
    `choice` 是模块级同步写入的，点下去立刻翻；而 `data-engine-effective`
    要等 `emit()` → React 重渲染才跟上。只等 `choice` 会在两帧之间读到
    「choice 已是新的、effective 还是旧的」，报出假失败
    （2026-09-20 实测咬到过：lib-hpss 报 eff=lib-formant）。
    两次读也会漏掉中间变化，所以用同一个快照判两个值。
  */
  await ev(`window.__pickEngine('${eid}')`);
  let s = await engineSnap();
  for (let i = 0; i < 40 && !(s.s.choice === eid && s.c?.effective === eid); i++) {
    await sleep(100);
    s = await engineSnap();
  }
  const ok =
    s.s.choice === eid &&
    s.s.shiftReady === true &&
    s.s.failed === false &&
    s.s.willUseExternal === true &&
    s.c?.effective === eid;
  console.log(
    `     ${ok ? '·' : '✗'} ${eid.padEnd(16)} ready=${s.s.shiftReady} failed=${s.s.failed} eff=${s.c?.effective}`,
  );
  if (!ok) {
    notReady.push(
      `${eid}(ready=${s.s.shiftReady} failed=${s.s.failed} eff=${s.c?.effective})`,
    );
  }
}
check(
  '18 个第三方引擎逐个点选后都真的加载了就绪（不是只有 chip 而已）',
  notReady.length === 0,
  notReady.length ? `未就绪 ${notReady.length} 个：${notReady.join(' / ')}` : '18/18 全部就绪',
);

// ===========================================================================
console.log('\n── 11. 选择器不许把任何一组藏起来（「看着少了一组」就是这么来的）──');

/*
  为什么单独一节：第 7 节验的是「18 个 chip 都在 DOM 里」。**DOM 里在 ≠ 看得见**。
  选择器容器曾经写死 `max-h-[7.5rem]`（120px），而装配面板在 ≥lg 时是两列
  （`NotePalette` 的 `flex-col lg:flex-row`），选择器那一列只有 244px 宽 ——
  四组换行后实际需要 157px，于是最后整组（SoundTouchJS 三个）被推到滚动区之外。
  界面上看起来就是「那几个引擎被删掉了」（2026-09-20 的实测：scrollH 157 / clientH 120）。

  所以「都在 DOM 里」这条不够，必须再钉一条**几何**断言：
  逐组量 `top + height`，任何一组越过容器底边就算 FAIL。
*/
const geom = JSON.parse(
  await ev(`JSON.stringify((() => {
    const box = document.querySelector('[data-engine-groups]');
    const root = document.querySelector('[data-engine-picker]');
    if (!box || !root) return null;
    const bb = box.getBoundingClientRect();
    return {
      clientH: box.clientHeight,
      scrollH: box.scrollHeight,
      pickerW: Math.round(root.getBoundingClientRect().width),
      rows: [...box.children].map((r) => {
        const rr = r.getBoundingClientRect();
        return {
          label: r.children[0]?.textContent?.trim() ?? '',
          top: Math.round(rr.top - bb.top),
          h: Math.round(rr.height),
        };
      }),
    };
  })())`),
);
check(
  '选择器没有滚动裁剪（scrollHeight == clientHeight，没有任何内容被藏起来）',
  geom !== null && geom.scrollH <= geom.clientH + 1,
  geom ? `选择器宽 ${geom.pickerW}px  clientH=${geom.clientH} scrollH=${geom.scrollH}` : '读不到几何',
);
const hiddenRows = (geom?.rows ?? []).filter((r) => r.top + r.h > (geom?.clientH ?? 0) + 1);
check(
  '四组**全部**落在可视区内（逐组量 top+height，不是只看最后一行）',
  geom !== null && geom.rows.length === 4 && hiddenRows.length === 0,
  hiddenRows.length
    ? `被藏起来：${hiddenRows.map((r) => r.label).join(' / ')}`
    : (geom?.rows ?? []).map((r) => `${r.label}@${r.top}+${r.h}`).join('  '),
);

// ===========================================================================
console.log('\n── 12. 移调增量夹取在 ±24（按住 Shift+↑ 不能一路跑到 ±60）──');

/*
  为什么单开一节（2026-09-20 用户实报「有些时候素材无声 / 变调后无声」）：

  `Shift+↑` 是**按住连发**的 —— `NotePalette` 把 `e.repeat` 当 `silent` 一路传到
  `nudgePitch` → `AdjustPitch`。而 `AdjustPitch` 早先**没有上限**（τ 有 clampTau，
  半音没有；注释还写着「pitch 无夹取」）。按住两三秒就能把增量推到 ±60，
  那个档位上（`probe-silence-lag.mjs` 实测，龙.001 / 立体声）：

    −60 半音（ratio 1/32）：`@audio/shift-sample` 输出 **−46.3dB** → 听不见
    +36 半音（ratio 8）  ：`ST-声码器` 长度 0.704×、电平 +16.3dB、峰值 **31.96**
    +60 半音（ratio 32）  ：`ST-声码器` 长度 0.176×、峰值 11.48

  更糟的是这个坏值会随 Apply 写进事件并持久化 —— 之后每次回放/导出都是坏的，
  用户看到的就是「这条素材没声音了」，而且**看不出为什么**。

  ⚠️ 这条断言量的是 **UI 上真正显示的数值**（`aria-valuenow`），不是内部状态：
  「内部夹了但界面还显示 60」和「界面夹了但内部还是 60」都会让用户拿到坏值。
*/
await ev(`window.__setEnginePref('wasm')`);
await load();
/*
  写这行时 Enter 还是必需的一步（目标只认「已选中行」）；
  现在音符**已装配素材**就直接可调了（见第 6 节 A 组）。
  这里保留 Enter 是刻意的：本节只测「夹取」这一件事，
  让它的成败不受目标解析逻辑影响 —— 否则一处回归会同时点亮两节，难定位。
*/
await pressEnter();

const c0 = await transform();
check('起点：移调增量 0', c0.pitchNow === 0, `pitchNow=${c0.pitchNow}`);

const NUDGE_UP = 30; // 远超 24
for (let i = 0; i < NUDGE_UP; i++) await pressShiftUp();
const cUp = await transform();
check(
  `连按 ${NUDGE_UP} 次 Shift+↑ → 停在 +24（不是 +${NUDGE_UP}）`,
  cUp.pitchNow === 24,
  `pitchNow=${cUp.pitchNow}`,
);

const NUDGE_DOWN = 60; // 从 +24 按到底还要 48 次，留足余量
for (let i = 0; i < NUDGE_DOWN; i++) await pressShiftDown();
const cDown = await transform();
check(
  `反向连按 ${NUDGE_DOWN} 次 Shift+↓ → 停在 −24（不是 −36 更不是 −60）`,
  cDown.pitchNow === -24,
  `pitchNow=${cDown.pitchNow}`,
);

// 夹取之内必须照常走 —— 「一路夹到 0」也能让上面两条通过，所以必须再钉这一条
await pressShiftUp();
await pressShiftUp();
await pressShiftUp();
const cMid = await transform();
check(
  '夹取之内逐半音照常（−24 + 3 = −21，没有被夹过头）',
  cMid.pitchNow === -21,
  `pitchNow=${cMid.pitchNow}`,
);

// ===========================================================================
console.log('\n── 13. 同一段素材重复变换必须近乎免费（「变的很卡」的回归）──');

/*
  为什么量「第二次调用」而不是「某引擎多少毫秒」：

  机器不同、素材不同，绝对耗时没法当断言。但**同一段素材 + 同一个参数的第二次
  调用应当近乎免费**是一条与机器无关的性质 —— 它检验的正是「缓存到底在不在」。

  实测背景（`probe-silence-lag.mjs`，41 素材立体声、中位耗时）：
    我们的 mode1 **283ms**，第三方 hybrid 246 / ST-声码器 278 / psola 266 /
    hpss 165 / lpc 116 / wsola 104 —— **我们自己也不快**。区别不在谁快，而在
    `rush/transform.ts` 有 WeakMap 缓存、第三方路径原先**一个缓存都没有**：
    每个音符、每次试听、导出循环的每个事件都要把整段素材重算一遍，
    而且是**同步跑在主线程上** → 连「浏览素材」（移动光标、滚列表）都跟着顿。

  这条断言在加缓存之前**必然是红的**（第二次和第一次一样慢），所以它是
  真回归而不是「描述现状」。另外附带钉一条**空变换短路**：音高 ×1 且 τ×1 时
  不该进引擎（ratio=1 是 App 里最常见的档）。
*/
const perf = async (semitones, repeats = 3, fresh = true) =>
  JSON.parse(
    await ev(`JSON.stringify(window.__perfShift(${semitones}, ${repeats}, ${fresh}))`),
  );

const snapPerfEngine = await pickAndWait('lib-hpss');
check(
  '计时用的引擎已就绪（lib-hpss：实测中位 165ms，够慢到能量出差别）',
  snapPerfEngine.s.choice === 'lib-hpss' && snapPerfEngine.s.shiftReady === true,
  `choice=${snapPerfEngine.s.choice} ready=${snapPerfEngine.s.shiftReady}`,
);

const extTimes = await perf(-12, 3);
check(
  '第三方引擎：同一 (素材, 半音) 第一次要全量计算、第二次几乎免费（缓存生效）',
  extTimes[0] > 10 && extTimes[1] >= 0 && extTimes[1] < Math.max(3, extTimes[0] * 0.2),
  `逐次耗时 ${extTimes.map((t) => t.toFixed(1)).join(' / ')} ms`,
);

// 换一个半音值 → 必须重算（缓存不能把不同参数的产物串起来）
const extOther = await perf(-7, 2);
check(
  '换半音值必须重算（缓存按参数分键，不会拿 −12 的结果冒充 −7）',
  extOther[0] > extTimes[1],
  `−7 首次 ${extOther[0].toFixed(1)}ms vs −12 命中 ${extTimes[1].toFixed(1)}ms`,
);

const extNoop = await perf(0, 3);
check(
  '选了第三方引擎但「不调不改」（0 半音 / τ×1）→ 不进引擎（耗时≈0）',
  extNoop.every((t) => t >= 0 && t < 5),
  `逐次耗时 ${extNoop.map((t) => t.toFixed(1)).join(' / ')} ms`,
);

/*
  对照：wasm 那一侧本来就有缓存（`rush/transform.ts` 的 WeakMap）。
  必须同样用 fresh buffer 才比得公平 —— 否则我们这边「首次」也会是命中，
  看起来像「两侧一样」而其实压根没量到首次。

  ⚠️ 还要先把 wasm **真的装起来**（探针页按需装载，见 `__ensureWasm` 的注释）：
  没装时 `isRushReady()` 为 false，`playSample` 会跳过整个 wasm 分支、
  直接原样播源 —— 那时量到的 0.1ms 是「什么都没做」，是一条假对照。
*/
await pickAndWait('wasm');
const wasmLoaded = await ev('window.__ensureWasm()');
check('wasm 内核装载成功（否则下面量的是「原样播源」而不是真变换）', wasmLoaded === true, `isRushReady=${wasmLoaded}`);
const wasmTimes = await perf(-12, 3);
check(
  '对照：我们的 PSOLA 也是「首次要算、之后免费」（两侧行为现在是同一套约定）',
  wasmTimes[0] > 10 && wasmTimes[1] < Math.max(3, wasmTimes[0] * 0.2),
  `逐次耗时 ${wasmTimes.map((t) => t.toFixed(1)).join(' / ')} ms`,
);

// ===========================================================================
console.log('\n── 14. 极端档位下「仍然有声音、且不爆表」（出口验收 + 回退的端到端验证）──');

/*
  这一节直对用户那句「有些时候素材无声 / 变调后无声」，而且**真渲染**离线上下文
  来看样点 —— 不看代码路径、不看耗时，只看「放出来有没有声音」。

  要造的是「事件里存着一个旧年代的极端值」这个场景：夹取（第 12 节）管的是
  *新输入*，管不了已经写进工程文件里的旧值。所以这里**绕过 UI 直接调
  `playSample`**。

  ⚠️ 档位取 +48，不取 +60：**+48 才是真正可达的上限**
  （base 受 `sampleSemitonesAtPitch` 的 ±24 约束、delta 受新的夹取约束）。
  测一个用户永远到不了的档位，等于没测。

  为什么用 `st-pvoc` 当样本：node 侧实测它就是在这些档位坏掉的那一个
  （`probe-silence-lag.mjs`，龙.001）——
    ratio 8  (+36 半音)：长度 0.704×、电平 +16.3dB、**峰值 31.96**
    ratio 16 (+48 半音)：长度 0.352×、电平 +14.3dB、峰值 23.11
  验收之前，这串样点会被原样播出去：响一下、爆表 20~30 倍、后面全静音。
*/
const render = async (semitones, tau = 1) =>
  JSON.parse(
    await ev(`(async () => JSON.stringify(await window.__renderShift(${semitones}, ${tau})))()`),
  );

await pickAndWait('st-pvoc');
clearConsole();
const rNormal = await render(-12);
check(
  '基准：st-pvoc @ −12 半音正常出声（RMS > 0.02、峰值 ≤ 1）',
  !rNormal.error && rNormal.rms > 0.02 && rNormal.peak <= 1,
  rNormal.error ?? `rms=${rNormal.rms?.toFixed(3)} peak=${rNormal.peak?.toFixed(2)}`,
);
const cNormal = consoleLog();
check(
  '基准档位不走降级（不该出现「变换失败…回退 wasm」）',
  !cNormal.some((l) => l.includes('回退 wasm PSOLA')),
  cNormal.length ? cNormal.join(' | ') : '（无 warn）',
);

clearConsole();
const rExtreme = await render(48);
check(
  '+48 半音：不爆表（st-pvoc 原生输出峰值 23.11，必须被拦下）',
  !rExtreme.error && rExtreme.peak <= 1,
  rExtreme.error ?? `peak=${rExtreme.peak?.toFixed(2)}`,
);
const cExtreme = consoleLog();
check(
  '+48 半音：控制台确实留下「出口验收拦下 → 回退 wasm」的痕迹（说明是设计好的回退，不是碰巧）',
  cExtreme.some((l) => l.includes('回退 wasm PSOLA')),
  cExtreme.length ? cExtreme.join(' | ') : '（无 warn）',
);

/*
  ⚠️ 这里踩过一次「把两件事混成一条断言」：

  最初写的是「+48 半音仍然出声（RMS > 0.02）」，它红了 —— 但红得**不对**：
  它把「第三方产物没被用上」（已由上一行证明）和「回退落到的 wasm 自己在这个
  档位有多响」（另一件事）绑在了一起。单看那个绝对值会得出
  「回退了还是没声音」的错结论。

  正确的拆法：**回退是否生效**用「与 wasm 直跑逐点一致」来判（这才是我们
  设计并保证的东西）；「回退落点够不够响」是内核的能力问题，归听感与后续
  决策（下面把它如实印出来，不做断言）。
*/
await pickAndWait('wasm');
const rWasmExtreme = await render(48);
check(
  '回退确实落到了 wasm 上（+48 的输出与 wasm 单独跑 +48 一致，而不是保留引擎的产物）',
  !rWasmExtreme.error &&
    rWasmExtreme.nonFinite === 0 &&
    Math.abs(rExtreme.rms - rWasmExtreme.rms) < Math.max(0.002, rWasmExtreme.rms * 0.1),
  `走引擎=${rExtreme.rms?.toFixed(4)}  wasm 直跑=${rWasmExtreme.rms?.toFixed(4)}`,
);

/*
  如实铺出「我们自己的内核在各档位有多响」—— 源 RMS ≈ 0.128（−18dBFS）。

  ⚠️⚠️ 这些数字**不能**读成「我们的内核升调坏了」，原因是测试信号：
  这里喂的是**纯正弦**（180Hz + 3Hz 幅度调制）。对任何「按目标周期排放 + 窗叠加」
  的变调器（TD-PSOLA / WSOLA / OLA 都是），纯正弦是**病态**输入 ——
  全部能量落在一个频率上、相位关系完全确定，颗粒重叠时的相消是系统性的、
  不会像真实人声那样被气声/辅音/微抖动打散。
  真实素材上的实测是另一回事（`probe-silence-lag.mjs one 龙.001 <ratio>`，立体声）：
     +12 半音（ratio 2）→ 1.000× / **0.0dB** / 峰值 0.598
     +24 半音（ratio 4）→ 1.000× / **−0.2dB** / 峰值 0.623
   升调侧完全正常，本项目的既有结论也是「升调侧用户认可」。

  所以这一段只用来**排除**一件事：「+48 的轻度输出不是『回退没生效』造成的」
  —— 因为同一信号 under wasm 直跑也是同一个数。它不构成任何「哪个档位好听」
  或「内核该不该改」的结论；那是耳朵的事（见 MEMORY.md 的头号规矩）。

  `+24` 与 `+48` 数字完全相同是纯正弦下的饱和迹象，真实素材上不复现，
  真要认真查得用带噪声的素材单独开一轮。
*/
console.log('     我们自己的内核在各档位的输出（纯正弦测试信号，源 RMS≈0.128；见上方注释）：');
for (const s of [-24, -12, 12, 24, 48]) {
  const r = await render(s);
  console.log(
    `       ${String(s).padStart(4)} 半音 → rms=${r.rms?.toFixed(4)}  末段=${r.tailRms?.toFixed(4)}  峰值=${r.peak?.toFixed(3)}`,
  );
}

// ===========================================================================
// 15. 调音试听的时序（2026-09-20 用户实报「只响一点点」+「手感粘滞」）
// ===========================================================================
console.log('\n── 15. 按 Shift+↑ 试听的时序：每一次都响完 + 手感 ──');

/*
  为什么这一节必须存在、而且必须在**浏览器里**量：

  用户的两句话——
    「我在调音的时候 声音响了 但只响一点点」
    「调音会有一点点粘滞的手感，调查一下是调音生成的真实时间还是性能问题」

  都不是「代码对不对」的问题，而是**时序**的问题：
  · 「响多少」= `AudioBufferSourceNode.start(when)` 与 `stop(当)` 的调度差，
    再被包络那一刻的增益值截断；
  · 「粘滞」= 主线程被同步变换占住多久。

  两者都只有从 Web Audio 原型与长任务观测上才看得到（页面里的记录器见
  `probe-palette.html` 的「预览时序记录器」一段）。纯逻辑单测完全测不到：
  reducer 里那些数字全是对的，坏的是「什么时候算、什么时候响」。

  三个不许退化的判据（都是用户诉求的直接翻译）：
    ① 起播那一刻包络必须是开着的 —— 否则「调度全对但没声音」（只响一点点）；
    ② 一次试听不许被掐在「下一段还没开始响」之前 —— 否则就是 blip；
    ③ 按键处理本身不许占住主线程几百毫秒 —— 否则手感粘滞。
*/

const tuneHold = (n = 5, intervalMs = 30) => ev(`window.__tune(${n}, ${intervalMs}, true)`);

/**
 * 把记录器结果翻译成「每一段试听实际响了多久」。
 *
 * `expectDur` 用来把**试听**跟别的声音分开：记录器抓的是**所有**
 * `AudioBufferSourceNode`，实测跑一遍会混进 2 个 3ms 的小源（主效果链首次构建
 * 时的内部节点，`when 落后 ctx=351ms`、源长 3ms）。不滤掉的话，
 * 「起播时包络是开着的」这条会被它们顶成假红 —— 而假红比不检查更坏。
 */
const analysePreviews = (rec, expectDur) => {
  const isPreview = (e) => e.bufDur != null && Math.abs(e.bufDur - expectDur) < expectDur * 0.05 + 0.01;
  return {
    others: rec.srcs.filter((e) => !isPreview(e)).length,
    rows: rec.srcs.filter(isPreview).map((e) => {
      const startEff = Math.max(e.when, e.ctxT);
      const playDur = e.schedDur ?? (e.bufDur != null ? e.bufDur / e.rate : 0);
      const naturalEnd = startEff + playDur;
      const endEff = Math.min(e.stopWhen ?? Infinity, naturalEnd);
      return {
        pastMs: (e.ctxT - e.when) * 1000,
        gain: e.gainAtStart,
        bufDur: e.bufDur,
        startEff,
        naturalEnd,
        endEff,
        audibleMs: (endEff - startEff) * 1000,
        fullMs: (naturalEnd - startEff) * 1000,
      };
    }),
  };
};

const reportPreviews = (label, rows, others) => {
  console.log(`     ${label}（试听 ${rows.length} 段${others ? `，另有 ${others} 个非试听源已滤掉` : ''}）：`);
  rows.forEach((r, i) => {
    console.log(
      `       #${i}  起播时包络=${String(r.gain).slice(0, 6).padStart(8)}` +
        `  when 落后 ctx=${r.pastMs.toFixed(0).padStart(4)}ms` +
        `  实际响=${r.audibleMs.toFixed(0).padStart(4)}ms / 满长=${r.fullMs.toFixed(0)}ms` +
        `  源长=${((r.bufDur ?? 0) * 1000).toFixed(0)}ms`,
    );
  });
};

await ev(`window.__setEnginePref('wasm')`);
await load('?eff=p1');

const clockA = JSON.parse(await ev(`JSON.stringify(window.__audioState())`));
await sleep(300);
const clockB = JSON.parse(await ev(`JSON.stringify(window.__audioState())`));
/*
  ⚠️ 前提检查，必须先过。
  实时 AudioContext 若停在 `suspended`（无用户手势 / 无声卡），`currentTime` 是**冻结**的：
  变换耗时再长也不会把 `when` 甩到过去，于是第 15 节会「全绿」——
  但那是环境测不出来，不是代码没问题。所以先把时钟推进这件事本身钉住。
*/
check(
  '实时音频时钟在推进（否则本节全部测不出来，而不是「没问题」）',
  clockA.state === 'running' && clockB.t - clockA.t > 0.05,
  `state=${clockA.state} Δt=${(clockB.t - clockA.t).toFixed(3)}s`,
);

const seeded = await ev(`window.__seedPreview('p1', 1.0)`);
const wasmOk = await ev(`window.__ensureWasm()`);
check('wasm 内核已装载（本节的正对照必须真的在跑变换）', wasmOk === true && seeded.bufDur > 0.9, `bufDur=${seeded.bufDur}`);

/*
  ── 先钉住「包络排在过去 = 无声」这个机制本身 ──
  这是「无声 / 只响一点点」的另一半解释：`playSample` 原先在**变换之前**取
  `when`，而变换是同步的，于是排包络时时钟已经走过去一大截，整条包络被排到过去。
  直接渲出来量 RMS —— 机制成立才谈得上「真实路径上会不会撞到」。
*/
for (const [pastMs, durSec] of [
  [100, 1.0],
  [600, 1.0],
  [1200, 1.0],
]) {
  const r = await ev(`window.__envStale(${pastMs}, ${durSec})`);
  if (!r || typeof r.rms !== 'number') {
    console.log(`     when 落后 ${String(pastMs).padStart(4)}ms → 取数失败：${JSON.stringify(r)}`);
    continue;
  }
  console.log(
    `     when 落后 ${String(pastMs).padStart(4)}ms（源长 ${durSec}s）→ 实测 RMS=${r.rms.toFixed(4)}` +
      `  包络当前值=${r.gainNow.toFixed(5)}`,
  );
  if (pastMs === 100) {
    check(
      '①-b 对照：`when` 只落后 100ms 时信号正常（说明下面那个 0 不是测量本身的问题）',
      r.rms > 0.2,
      `RMS=${r.rms.toFixed(4)}`,
    );
  }
  if (pastMs === 1200) {
    check(
      '①-b 机制确认：`when` 落后量超过素材长度时，渲出来的信号 RMS≈0（不是「小声」而是没有）',
      r.rms < 0.01,
      `RMS=${r.rms.toFixed(5)} 包络=${r.gainNow.toFixed(5)}`,
    );
  }
}

// ── 15a. 长素材（1.0s）—— 按住 Shift+↑ 不放的现场 ──
await ev(`window.__recStart()`);
const keysLong = await tuneHold(5, 30);
await sleep(1400);
const recLong = JSON.parse(await ev(`JSON.stringify(window.__recStop())`));
const { rows: rowsLong, others: othersLong } = analysePreviews(recLong, 1.0);
reportPreviews('长素材 1.0s', rowsLong, othersLong);

const keyMsMax = Math.max(...keysLong.map((k) => k.ms));
console.log(
  `     按键处理耗时：${keysLong.map((k) => k.ms.toFixed(0)).join(' / ')} ms` +
    `   长任务 ${recLong.longTasks.length} 个` +
    (recLong.longTasks.length ? `（最长 ${Math.max(...recLong.longTasks.map((t) => t.dur)).toFixed(0)}ms）` : '') +
    `   帧 ${recLong.frames.length} 帧`,
);
const pitchFinal = (await transform()).pitchNow;
check(
  '按住 Shift+↑ 时数值确实一路在涨（不是「按了没反应」）',
  pitchFinal === 5,
  `末值 ${pitchFinal}`,
);

check(
  '① 起播时包络都是开着的（没有「调度全对但不出声」的试听）',
  rowsLong.length > 0 && rowsLong.every((r) => (r.gain ?? 0) >= 0.9),
  rowsLong.map((r) => (r.gain ?? -1).toFixed(3)).join(' , '),
);

{
  /*
    ② 「掐在下一段还没响之前」的判据：
    第 k 段的可闻终点必须 ≥ min(它自己的满长终点, 第 k+1 段的起播时刻)。
    左边 = 我们真的让它响到了哪；右边 = 它「本来能响到哪」。
    两者相等 = 要么响满、要么无缝接给下一段；差一大截 = 中间那段空档里
    用户听到的就是「响一点点就没了」。
  */
  const gaps = [];
  for (let k = 0; k + 1 < rowsLong.length; k++) {
    const limit = Math.min(rowsLong[k].naturalEnd, rowsLong[k + 1].startEff);
    gaps.push((limit - rowsLong[k].endEff) * 1000);
  }
  check(
    '② 没有一段试听被掐在「下一段还没开始响」之前（不留下空档）',
    rowsLong.length >= 2 && Math.max(...gaps) < 10,
    `空隙 ${gaps.map((g) => g.toFixed(0)).join(' / ')} ms（段数 ${rowsLong.length}）`,
  );
}

{
  /*
    ③ 手感：按键处理本身（dispatch + React 提交）必须是**快的**。
    试听那一次整段变换该不该占用主线程是另一件事，但它不能在**按键处理里**发生 ——
    否则用户按下键的一瞬间，界面连数字都还没画出来就冻住了。
  */
  check(
    '③ 按键处理不占用主线程（数值先画出来，变换在后面跑）',
    keyMsMax < 60,
    `最大 ${keyMsMax.toFixed(0)}ms`,
  );
}

{
  /*
    ④ 一次「按住不放」= 一次调音，不该把整套变换跑 N 遍。
    5 个重复事件 + 1 次松手，至多 2 段试听（初次按下那一次 + 落定那一次）。
  */
  check(
    '④ 按住不放不会把整套变换跑 5 遍（最多「按下」与「落定」两次试听）',
    rowsLong.length >= 1 && rowsLong.length <= 2,
    `试听段数 ${rowsLong.length}`,
  );
}

// ── 15b. 短素材（0.15s）—— 素材比变换耗时还短的那一档 ──
await ev(`window.__seedPreview('p1', 0.15)`);
await sleep(120);
await ev(`window.__recStart()`);
await tuneHold(3, 30);
await sleep(700);
const recShort = JSON.parse(await ev(`JSON.stringify(window.__recStop())`));
const { rows: rowsShort, others: othersShort } = analysePreviews(recShort, 0.15);
reportPreviews('短素材 0.15s', rowsShort, othersShort);
check(
  '短素材（比一次变换还短）起播时包络也必须是开着的',
  rowsShort.length > 0 && rowsShort.every((r) => (r.gain ?? 0) >= 0.9),
  rowsShort.map((r) => (r.gain ?? -1).toFixed(3)).join(' , '),
);

/*
  ── 15c. 「是调音生成的真实时间，还是性能问题？」──
  用户问的原话就是这个。分开两者的判据不是绝对毫秒（随机器变），而是**增长阶**：
  耗时随素材长度线性增长 = 实打实的计算量；超线性 = 算法里有问题。
  这一节只**如实印出**，不做「该多快」的断言 —— 那样会把机器差异算成回归。
*/
console.log('     变换耗时 vs 素材长度（每次都是全新 buffer，−12 半音，我们的 PSOLA）：');
const scale = await ev(`window.__scaleShift([0.25, 0.5, 1, 2], -12)`);
let perSec = [];
for (const s of scale) {
  if (s.ms < 0) {
    console.log(`       ${s.d}s → 失败：${s.err}`);
    continue;
  }
  const ratio = s.ms / s.d;
  perSec.push(ratio);
  console.log(
    `       ${String(s.d).padStart(4)}s → ${s.ms.toFixed(0).padStart(5)}ms` +
      `（${ratio.toFixed(0)} ms / 秒素材）`,
  );
}
if (perSec.length >= 2) {
  const growth = perSec.at(-1) / perSec[0];
  console.log(
    `       长素材每秒钟的耗时是短素材的 ${growth.toFixed(2)}×` +
      `（≈1 = 线性增长；明显 >1 = 超线性，算法里有问题）`,
  );
}
check(
  '15c 变换耗时对素材长度不超线性（超线性就是算法问题，不是「真实时间」）',
  perSec.length >= 2 && perSec.at(-1) / perSec[0] < 2,
  `比值 ${perSec.length >= 2 ? (perSec.at(-1) / perSec[0]).toFixed(2) : 'n/a'}`,
);
{
  /*
    顺手把「一次调音到底要等多久」这个用户能感知的数说清楚：
    按下 → 数值更新（应≈0，因为先画后算）→ 声音出来（= 一次变换）。
  */
  const firstStart = rowsLong[0]?.startEff;
  if (rowsLong.length > 0) {
    console.log(
      `     一次调音的等待：按下 → 数值更新 ≈ ${keyMsMax.toFixed(0)}ms；` +
        `按下 → 出声 ≈ 一次变换的耗时（上面那行）`,
    );
  }
  check(
    '15d 数值更新不等变换（按下到读数变化的耗时 < 60ms）',
    keyMsMax < 60,
    `最大 ${keyMsMax.toFixed(0)}ms`,
  );
}

// ===========================================================================
// 16. 音高 worker 起不来时的降级（用户实报：ERR_CONNECTION_REFUSED 之后的那一片报错）
// ===========================================================================
console.log('\n── 16. 音高 worker 起不来时的降级（报错要指对地方 / 不许重生风暴 / YIN 不许跟着死）──');

/*
  用户贴过来的日志里，与音高有关的那一句是：

      [pitch-async] AI 检测硬失败，回退 YIN
      Error: 音高 worker 异常退出

  而真因写在**同一份日志的另一行**：`net::ERR_CONNECTION_REFUSED` ——
  本地 dev server 已经退出，而 worker 的脚本正是从它那儿加载的。
  也就是说那句报错把「进程没了」说成了「音高算法坏了」，排查方向整个跑偏。

  这一幕**只能靠桩复现**：把 dev server 关掉的话，探针连页面都打不开
  （页面也是它发的）。所以页面里有 `__breakWorker`，把全局 `Worker`
  换成会 fire 一个**零字段 ErrorEvent** 的桩 —— 与「脚本拿不到」时浏览器
  给的形态一致。

  四条判据，逐条对应上面的症状：
    ① 报错必须**指向真因**（出现「dev server」这类可执行线索），而不是一句
       不含信息的「异常退出」—— 报错指错地方比不报错更贵；
    ② **不许重生风暴**：连续 4 个请求最多只 new 一次 worker（冷却窗），
       否则每个请求都要等一次网络失败，日志刷成一片；
    ③ **YIN 不许跟着死**：worker 没了的时候音高读数仍要有值
       （主线程 JS 应急退路），而不是对**所有**素材显示「未检出音高」；
    ④ **能自愈**：worker 回来后过冷却窗自动重生，状态回到正常。
*/

const fmtHz = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}Hz` : String(v));

const FIXTURE = 'pitch-probe';
const seedFix = () => ev(`window.__seedPreview(${JSON.stringify(FIXTURE)}, 1.0)`);
const is180 = (r) => r?.ok === true && typeof r.hz === 'number' && r.hz > 150 && r.hz < 215;

// ── ① 正对照：worker 正常时这条路本来就是通的 ──
const seeded16 = await seedFix();
check(
  '16a 人造素材已进解码缓存（否则下面测的是「音频已丢失」那一支，白测）',
  !!seeded16 && seeded16.bufDur > 0.9,
  `bufDur=${seeded16?.bufDur}`,
);
const ok0 = await ev(`window.__detectPitch(${JSON.stringify(FIXTURE)}, 'yin')`);
const diag0 = await ev(`window.__pitchDiag()`);
check(
  '16b 正对照：worker 正常时测出 ~180Hz（先证明桩之外的路径本来能 work）',
  is180(ok0),
  `hz=${fmtHz(ok0?.hz)} ms=${ok0?.ms?.toFixed(0)} spawns=${diag0?.spawnCount}`,
);

/*
  ── ② 重新加载页面，且**在 render 之前**就把 Worker 换成桩（`?npw=1`）──

  为什么必须重新加载页面，而不是在同一个页面上事后打桩：

  `pitch-async` 的 worker 是**单例**，而且「活着」不依赖 dev server ——
  它加载过的模块早就在内存里了，server 之后退出也不会让它死。
  所以在同一个页面上事后 `__breakWorker(true)`，后续请求仍然全部命中那个
  **活着的真 worker**（连 AI 都能照跑），「worker 起不来」这一幕压根没被测到，
  三项接口却全绿 —— 实测第一次就是这么拿到一次**假绿**的
  （`spawns=0 / status=ready / kind=undefined`）。

  重新加载 = 全新的模块状态 = 全新的「还没建过 worker」，
  与用户那次（server 先没了，之后才打开面板）完全同形。
*/
await load('?eff=p1&npw=1');
await clearConsole();

const spawnsOnLoad = await ev(`window.__workerSpawns()`);
console.log(`     带 ?npw=1 重新加载：挂载期的 spawns=${spawnsOnLoad}（面板挂载时不建 worker —— 试听缓存里还没有音频）`);

await seedFix();
const down1 = await ev(`window.__detectPitch(${JSON.stringify(FIXTURE)}, 'yin')`);
const diag1 = await ev(`window.__pitchDiag()`);
const spawns1 = await ev(`window.__workerSpawns()`);
const downLog = consoleLog().filter((l) => l.includes('音高 worker 不可用'));
console.log(`     桩生效后：spawns=${spawns1}  status=${diag1?.status}  kind=${diag1?.lastFailure?.kind}`);
console.log(`     日志：${downLog[0] ?? '(无)'}`);

check(
  '16c 报错指向真因：文案里必须带出可执行线索（dev server），且不再是「异常退出」',
  downLog.some((l) => l.includes('dev server')) && !downLog.some((l) => l.includes('异常退出')),
  downLog[0] ?? '(无日志)',
);
check(
  '16d 分类不乱断：零字段 ErrorEvent → unknown，并明说「浏览器未给出位置信息」',
  diag1?.lastFailure?.kind === 'unknown' &&
    (diag1?.lastFailure?.reason ?? '').includes('未给出任何位置信息'),
  `kind=${diag1?.lastFailure?.kind}`,
);
check(
  '16e UI 状态切到 unavailable（不再永远停在「首次加载 AI 模型…」）',
  diag1?.status === 'unavailable',
  `status=${diag1?.status}`,
);
check(
  '16f YIN 不跟着死：worker 没了仍给出音高值（主线程 JS 应急退路）',
  is180(down1),
  `ok=${down1?.ok} hz=${fmtHz(down1?.hz)} err=${down1?.err ?? '-'}`,
);

// 用户日志里那一句就是 AI 请求 —— 它也要走同一条降级，且不谎报来源
const aiDown = await ev(`window.__detectPitch(${JSON.stringify(FIXTURE)}, 'ai')`);
check(
  '16f-2 AI 请求同样降级成功，且如实报告检测器是 yin（不谎报成 AI）',
  aiDown?.ok === true && aiDown.detector === 'yin',
  `detector=${aiDown?.detector} hz=${fmtHz(aiDown?.hz)}`,
);

// ── ③ 重生风暴 ──
const spawnsBefore = await ev(`window.__workerSpawns()`);
const burst0 = Date.now();
for (let i = 0; i < 4; i++) {
  await ev(`window.__detectPitch(${JSON.stringify(FIXTURE)}, 'yin')`);
}
const spawnsAfter = await ev(`window.__workerSpawns()`);
const burstMs = Date.now() - burst0;
check(
  '16g 没有重生风暴：冷却窗内 4 个连续请求最多只 new 一次 worker',
  spawnsAfter - spawnsBefore <= 1,
  `spawns ${spawnsBefore} → ${spawnsAfter}（4 次请求共 ${burstMs}ms）`,
);

/*
  ── ③-b 这条退路本身要多久（量出来，不许推断）──

  它是**在主线程**上跑的，所以耗时直接决定「worker 掉了之后卡不卡」。
  第 15 节正是因为同类的主线程占用被用户报成「手感粘滞」，所以这里必须有个实数。
  上界给得松（单次 < 600ms）——这一节要抓的是**数量级失控**，
  不是把毫秒级别死；真实期望值打印在下面。
*/
const yinCost = await ev(`window.__yinCost(${JSON.stringify(FIXTURE)}, 3)`);
const yinMs = yinCost ? Math.max(...yinCost.runs.map((r) => r.ms)) : -1;
console.log(
  `     主线程 JS YIN 应急退路的单次耗时：${yinCost ? yinCost.runs.map((r) => r.ms.toFixed(0)).join(' / ') : '(测不到)'} ms` +
    `  （源长 ${yinCost?.sec?.toFixed(2)}s @ ${yinCost?.sr}Hz，结果 ${fmtHz(yinCost?.runs?.[0]?.hz)}）`,
);
check(
  '16g-2 应急退路耗时在可接受量级内（它是主线程同步跑的，必须有实数而不是「应该很快」）',
  yinMs > 0 && yinMs < 600,
  `单次 ${yinMs.toFixed(0)}ms`,
);

// ── ④ 自愈 ──
await ev(`window.__breakWorker(false)`);
await sleep(2300); // 过冷却窗
const back = await ev(`window.__detectPitch(${JSON.stringify(FIXTURE)}, 'yin')`);
const diag2 = await ev(`window.__pitchDiag()`);
check(
  '16h 自愈：桩撤掉 + 过冷却窗 → 自动重生，failedAt 清空、状态回 ready',
  is180(back) && diag2?.failedAt === null && diag2?.status === 'ready',
  `hz=${fmtHz(back?.hz)} status=${diag2?.status} failedAt=${diag2?.failedAt} spawns=${diag2?.spawnCount}`,
);

// 复位，别把偏好留给下一次跑（否则下一轮一开局就是外部引擎）
await ev(`window.__setEnginePref('wasm')`);
// 不带 ?npw=1 重新加载 —— 收尾的「页面无运行期异常」必须在**没有被桩污染**的页面上量
await load();

check('页面无运行期异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' / '));

// ===========================================================================
const failed = results.filter((r) => !r).length;
console.log(`\n探针结果：${results.length - failed}/${results.length} 通过`);
console.log(`样例色值：已选中=${armedBg}  光标=${cursorBg}`);

try { chrome.kill(); } catch { /* noop */ }
try { vite?.kill(); } catch { /* noop */ }
await sleep(300);
process.exit(failed ? 1 : 0);
