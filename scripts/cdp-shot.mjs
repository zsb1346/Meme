/**
 * cdp-shot.mjs —— 用本机 Chrome 的 DevTools Protocol 截「指定区域」的图。
 *
 * 为什么不用 `chrome --screenshot`：那条路只能截视口顶部，无法滚动到
 * 页面中部，也无法截某个元素的精确区域。做 UI 校准时必须能「把某个
 * 组件单独放大拍下来」。
 *
 * 用法：
 *   node scripts/cdp-shot.mjs <url> <out.png> [options]
 *
 * options（均可省略）
 *   --w=1400 --h=900        视口尺寸，默认 1440x900
 *   --sel=.selector         截图前滚动到该元素（居中）
 *   --clip                  截该元素的精确包围盒（配合 --sel）
 *   --dsf=2                 缩放因子，默认 2（高清）
 *   --wait=800              页面加载后额外等待毫秒，默认 600
 *   --full                  整页截图（忽略 --sel / --clip）
 *   --eval='js'             页面加载后、截图前执行的 JS（可重复，按序执行）
 *   --click=.selector       截图前点击该选择器（可重复）
 *   --mobile                真机视口模拟（Emulation.setDeviceMetricsOverride）
 *   --ua='...'              覆盖 User-Agent（常与 --mobile 连用）
 *
 * ⚠️ 想做手机端验收**必须加 `--mobile`**。
 *    只写 `--w=390 --h=844` 是**不够的**：那是 `--window-size`，而 Windows 上
 *    Chrome 有最小窗口宽度（实测被钳到 **491px**），于是你以为在测 390 宽的
 *    手机竖屏，实际测的是 491×692 的横屏小窗 —— **布局判断全错**。
 *    修法就是走 CDP 的设备度量覆盖，绕过窗口尺寸限制（并顺带打开触摸模拟）。
 *
 * 例：
 *   node scripts/cdp-shot.mjs "file:///F:/x/preview.html" out.png --sel="#rack" --clip
 *   node scripts/cdp-shot.mjs "http://localhost:5199" mix.png --click='[data-nav="mix"]'
 *   node scripts/cdp-shot.mjs "http://localhost:5173" phone.png --w=390 --h=844 --mobile
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error(
    '用法: node scripts/cdp-shot.mjs <url> <out.png> [--w=] [--h=] [--sel=] [--clip] [--dsf=] [--wait=] [--full] [--profile-dir=]',
  );
  process.exit(2);
}
const url = args[0];
const outPath = resolve(args[1]);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name) => args.includes(`--${name}`);
const W = Number(opt('w', 1440));
const H = Number(opt('h', 900));
const DSF = Number(opt('dsf', 2));
const WAIT = Number(opt('wait', 600));
const SEL = opt('sel', null);
const CLIP = has('clip');
const FULL = has('full');
/** 真机视口模拟：绕开 Chrome 最小窗口宽度限制（见文件头 ⚠️） */
const MOBILE = has('mobile');
const UA = opt('ua', null);
/** 跨运行复用的 Chrome profile（保留 IndexedDB / localStorage）；缺省每次新建 */
const PROFILE_DIR = opt('profile-dir', null);
/** 收集所有 --eval='…'（按出现顺序执行） */
const EVALS = args
  .filter((a) => a.startsWith('--eval='))
  .map((a) => a.slice('--eval='.length));
/** 收集所有 --click=…（按出现顺序点击） */
const CLICKS = args
  .filter((a) => a.startsWith('--click='))
  .map((a) => a.slice('--click='.length));

const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge 可执行文件');
  process.exit(1);
}

const PORT = 9200 + Math.floor(Math.random() * 700);
/*
  ⚠️ 两个本机坑（都曾让截图在**中途**失败，报错却指向别处）：
  ① profile 绝不能落 tmpdir() —— 那在 C: 盘，而 C: 长期接近满（实测 625MB），
     Chrome 写 profile / localStorage 会 ENOSPC。统一放项目盘。
  ② 本机挂着环境代理（HTTP_PROXY=127.0.0.1:11123，随时可能已死），
     必须 --no-proxy-server 显式绕开，否则连 localhost 都打不开。

  默认每次跑用一个**全新** profile（互不污染）。需要跨多次运行保留
  IndexedDB / localStorage 时传 `--profile-dir=<绝对路径>`：一个很常见的
  场景是「先播种存档 + 重载，再在另一次运行里截图」—— reload 会销毁
  执行上下文，同一个进程里没法接着探 DOM，只能分两次跑、共用 profile。
*/
const profile = PROFILE_DIR
  ? (mkdirSync(PROFILE_DIR, { recursive: true }), PROFILE_DIR)
  : mkdtempSync(join(process.cwd(), '.workbuddy', 'tmp', 'cdp-shot') + '-');

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-proxy-server',
    '--force-device-scale-factor=' + DSF,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP HTTP 端点就绪，返回 webSocketDebuggerUrl */
async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('CDP 端点超时');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        const hs = this.events.get(msg.method);
        if (hs) hs.forEach((h) => h(msg.params));
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
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
  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }
  once(method) {
    return new Promise((resolve) => this.on(method, resolve));
  }
}

let cdp;
try {
  const wsUrl = await waitForTarget();
  cdp = await CDP.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /*
    真机视口模拟。必须在 Page.navigate **之前**下发，页面首帧才拿到正确的
    视口尺寸 —— 否则会先按窗口宽度（Windows 上最小 ~491px）布局一次、
    再被覆盖，媒体查询驱动的界面会闪一下、甚至留下错误的首屏状态。
  */
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: DSF,
      mobile: true,
      screenWidth: W,
      screenHeight: H,
    });
    // 打开触摸模拟：pointerType 才会是 'touch'，也才会真的触发触摸事件
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
  }
  if (UA) await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(8000)]);
  await sleep(WAIT);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面脚本异常');
    return r.result.value;
  };

  // 截图前的交互脚本：先点选择器（等一拍让 UI 反应），再跑任意 JS
  for (const sel of CLICKS) {
    const ok = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`点击目标未命中：${sel}`);
    await sleep(320);
  }
  for (const expr of EVALS) {
    const value = await evalJs(expr);
    // 回显 eval 结果 —— 调试时不必靠截图猜，尤其是探测 DOM/状态的场景
    if (value !== undefined && value !== null) {
      console.log(`  eval → ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    await sleep(180);
  }
  if (CLICKS.length > 0 || EVALS.length > 0) await sleep(WAIT);

  let clip;
  if (FULL) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const cs = m.cssContentSize ?? m.contentSize;
    clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale: 1 };
  } else if (SEL) {
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(SEL)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()`);
    if (!box) throw new Error(`选择器未命中：${SEL}`);
    await sleep(350);
    if (CLIP) {
      const b2 = await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(SEL)});
        const r = el.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
      })()`);
      clip = { ...b2, scale: 1 };
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    ...(clip ? { clip } : {}),
  });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`OK ${outPath} (${Buffer.from(shot.data, 'base64').length} bytes)`);
} catch (err) {
  console.error('截图失败:', err.message);
  process.exitCode = 1;
} finally {
  try {
    cdp?.ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}
