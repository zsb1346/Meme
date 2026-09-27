/**
 * probe-keys-anim.mjs —— 按键动画的**实机**验收（真实 Chrome、真实 React、真实事件）。
 *
 * 用法：
 *   node scripts/probe-keys-anim.mjs <port>            # 默认 5199
 *   node scripts/probe-keys-anim.mjs <port> --headed   # 有头模式（调试用）
 *
 * ══ 为什么必须有这个探针（单测覆盖不到什么）══
 *
 * 用户的诉求是「同时按多个键都要有动画，且支持长按」。这条诉求落在
 * **事件的连接处**：物理事件 → 页面状态 → 组件渲染。三段各自都能过单测，
 * 接起来照样会断：
 *
 *   · 单测（`key-anim-state.test.ts`）能证明「集合里能同时装三个键」，
 *     但证明不了「两根手指真的各自派发了 pointerdown」；
 *   · 单测能证明「按下路径上没有定时器」，但证明不了浏览器里按住 1.2s 之后
 *     DOM 上仍然是按下态。
 *
 * 所以这里用 CDP 真发事件，读**组件真实渲染出来的** `style.transform`：
 *   按下 = `translateY(3px) scale(0.94) rotate(…) scaleY(0.88)`
 *   松开 = `scale(1) rotate(0deg) scaleY(1)`
 * 读 inline style 而不是 computed style —— 那是 React 写下的**目标态**，
 * 与「有没有按下」一一对应，且不受过渡动画进度影响（不用赌时序）。
 *
 * ══ 三个场景各自对应一条需求 ══
 *
 *   S1 长按（鼠标）    —— 按下一个键不放，1.2s 后仍必须是按下态（旧版 260ms 自弹）
 *   S2 多指同按（触摸）—— 两指同时按住，两个键都必须是按下态；抬一指不影响另一指
 *   S3 键盘同按       —— 两个绑定键同时按住，两个键都必须是按下态
 *
 * ══ 三个本机 / CDP 的坑（都踩过）══
 *
 *   ① profile 不能落 C: 盘（长期接近满 → Chrome 写 profile 时 ENOSPC）；
 *      必须 `--no-proxy-server` 绕开环境代理，否则连 localhost 都打不开。
 *   ② headless 新目标**默认没有焦点**。鼠标 / 触摸按坐标命中，不需要焦点；
 *      键盘事件按「聚焦的文档」投递 —— 不开 `setFocusEmulationEnabled` 的话
 *      表现是「指针场景全绿、键盘场景全红」，很容易误判成键盘功能的 bug。
 *   ③ `Input.dispatchTouchEvent` 两个方向的语义**相反**：
 *      `touchStart` 的列表是「全部活跃点」（与上次求差 = 新增）；
 *      `touchEnd` 的列表是「**被抬起的那个点**」。传反了会得到
 *      「松开甲、乙灭了」这种看起来像 bug 的结果。
 *
 * ⚠️ 绑定表通过 store 直接写（`window.__appImport`），不走 UI 绑定流程 ——
 *    我们要验的是**动画**，不是绑定界面。走 UI 只会多一层可能出错的环节。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_IMPORT_BOOTSTRAP } from './_app-import.mjs';

const PORT_WEB = process.argv[2] ?? '5199';
const HEADED = process.argv.includes('--headed');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 结果账本 ───────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}
/** 期望与实际都是升序数组 → 直接比字符串，失败信息可读 */
function reportPressed(actual, expect, label) {
  const want = [...expect].sort((a, b) => a - b);
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(want),
    `实际 [${actual}] 期望 [${want}]`,
  );
}

// ── CDP 最小客户端 ─────────────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 在页面里求值一个函数体，参数按值传入 */
  async eval(fnBody, ...args) {
    const expression = `(${fnBody})(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return this.raw(expression);
  }
  /** 执行一段原始表达式（用于注入 IIFE 源码） */
  async raw(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description ?? ''));
    }
    return r.result.value;
  }
}

const profile = mkdtempSync(join(process.cwd(), '.workbuddy', 'tmp', 'probe-keys-'));
const cdpPort = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(
  chromePath,
  [
    HEADED ? '--window-size=1280,860' : '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-proxy-server',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile,
    '--window-size=1280,860',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('CDP 端点超时');
}

// ── 页面侧小工具 ───────────────────────────────────────────────────────────
/** 当前处于按下态的键下标（升序）。判据是 React 写下的目标 transform。 */
const JS_PRESSED = `() => {
  const re = /scale\\(0\\.9[46]\\)/;
  const out = [];
  for (const el of document.querySelectorAll('button[data-key-index]')) {
    if (re.test(el.style.transform || '')) out.push(Number(el.dataset.keyIndex));
  }
  return out.sort((a, b) => a - b);
}`;

/** 每个键位的中心点（页面坐标） */
const JS_RECTS = `() => {
  const out = {};
  for (const el of document.querySelectorAll('button[data-key-index]')) {
    const r = el.getBoundingClientRect();
    out[Number(el.dataset.keyIndex)] = {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  }
  return out;
}`;

/** 写入绑定表并读回（验证真的落库了） */
const JS_BIND = `async (pairs) => {
  const m = await window.__appImport('/src/model/store.ts');
  const S = m.useStore;
  for (const [ki, key] of pairs) S.getState().setKeyBinding(ki, key);
  return S.getState().project.settings.keyBindings;
}`;

async function waitFor(cdp, jsBody, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cdp.eval(jsBody)) return true;
    } catch {
      /* 上下文还没就绪 */
    }
    await sleep(120);
  }
  return false;
}

/** 发一次真实键盘事件（CDP 要求 keyDown 带 text 才会被当成字符键） */
function keyEvent(cdp, type, key, code, vk) {
  return cdp.send('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    ...(type === 'keyDown' ? { text: key } : {}),
  });
}

async function main() {
  const wsUrl = await waitForTarget();
  const cdp = await CDP.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 坑 ②：headless 默认没有焦点，键盘事件会没人收。必须在 navigate 之前打开。
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.bringToFront');

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT_WEB}/` });

  if (!(await waitFor(cdp, `() => !!document.querySelector('nav button[title="演奏台"]')`, 15000))) {
    throw new Error(`应用没起来（dev server 在 ${PORT_WEB} 吗？）`);
  }
  await cdp.eval(`() => document.querySelector('nav button[title="演奏台"]').click()`);
  if (!(await waitFor(cdp, `() => !!document.querySelector('button[data-key-index="0"]')`, 15000))) {
    throw new Error('演奏台键区没渲染出来（工程可能还在水合）');
  }
  await sleep(400);

  const rects = await cdp.eval(JS_RECTS);
  const keys = Object.keys(rects).map(Number).sort((a, b) => a - b);
  if (keys.length < 2) throw new Error('可见键少于 2 个，无法验证多键');
  const [kA, kB] = keys;
  console.log(`\n键数 ${keys.length}，取 ${kA} / ${kB} 两个键做对照`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S1 长按（鼠标按住不放）══');
  // ═══════════════════════════════════════════════════════════════════════
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rects[kA].x, y: rects[kA].y,
    button: 'left', buttons: 1, clickCount: 1,
  });
  await sleep(60);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], `按下瞬间：键 ${kA} 亮`);

  await sleep(400);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], '按 0.4s：仍亮（旧版 260ms 已自弹）');

  await sleep(800);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], '按 1.2s：仍亮（长按成立）');

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rects[kA].x, y: rects[kA].y,
    button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(120);
  reportPressed(await cdp.eval(JS_PRESSED), [], '松开后灭');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S2 多指同按（触摸屏双指）══');
  // ═══════════════════════════════════════════════════════════════════════
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const ptA = { x: rects[kA].x, y: rects[kA].y, id: 1 };
  const ptB = { x: rects[kB].x, y: rects[kB].y, id: 2 };

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [ptA] });
  await sleep(80);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], `一根手指：只有键 ${kA} 亮`);

  // 第二指落下（坑 ③：touchStart 的列表 = 全部活跃点，与上次求差得「新增」）
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [ptA, ptB] });
  await sleep(80);
  reportPressed(await cdp.eval(JS_PRESSED), [kA, kB], `两根手指：${kA} 与 ${kB} **同时**亮`);

  await sleep(1000);
  reportPressed(await cdp.eval(JS_PRESSED), [kA, kB], '双指按住 1.0s：两个都仍亮');

  // 坑 ③：touchEnd 的列表 = 被抬起的那个点
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [ptB] });
  await sleep(120);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], `抬起 ${kB}：${kA} 不受影响（旧版会一起灭）`);

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
  reportPressed(await cdp.eval(JS_PRESSED), [], '全部抬起');

  // ⛔ maxTouchPoints 必须落在 1..16；写 0 会被协议拒掉，
  //    而报错文案是 "Touch points must be between 1 and 16"（看起来像上一条 touchEnd 出错）。
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S3 键盘同按（两个绑定键按住不放）══');
  // ═══════════════════════════════════════════════════════════════════════
  await cdp.raw(APP_IMPORT_BOOTSTRAP);
  const bindings = await cdp.eval(JS_BIND, [[kA, 'a'], [kB, 's']]);
  console.log(`  绑定表：${JSON.stringify(bindings)}`);
  await sleep(300); // 等 registerShortcut 的 effect 用新绑定重注册

  await keyEvent(cdp, 'keyDown', 'a', 'KeyA', 65);
  await sleep(80);
  reportPressed(await cdp.eval(JS_PRESSED), [kA], `按下 a：键 ${kA} 亮`);

  await keyEvent(cdp, 'keyDown', 's', 'KeyS', 83);
  await sleep(80);
  reportPressed(await cdp.eval(JS_PRESSED), [kA, kB], `再按下 s：${kA} 与 ${kB} 同时亮`);

  await sleep(1000);
  reportPressed(await cdp.eval(JS_PRESSED), [kA, kB], '键盘按住 1.0s：两个都仍亮');

  await keyEvent(cdp, 'keyUp', 'a', 'KeyA', 65);
  await sleep(120);
  reportPressed(await cdp.eval(JS_PRESSED), [kB], `松开 a：${kB} 不受影响（keyup 不短路）`);

  await keyEvent(cdp, 'keyUp', 's', 'KeyS', 83);
  await sleep(120);
  reportPressed(await cdp.eval(JS_PRESSED), [], '全部松开');

  // ── 判定 ────────────────────────────────────────────────────────────────
  console.log(`\n══ 判定 ══\n  通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('   · ' + f);
  return fails.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('\n探针异常：', err.message);
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
}
process.exit(ok ? 0 : 1);
