/**
 * 真浏览器跑探针页，把页面 console 与未捕获异常回传到终端。
 *
 *   node scripts/probe-ai/_probe-ai-browser.mjs <url> [--timeout=180000] [--shot=out.png]
 *
 * 为什么需要它：AI 音高检测的失效点在**运行时环境**（worker 里 tfjs 选什么后端、
 * basic-pitch 要多久、模型能不能加载），这些在 Node 里测不出来 —— Node 侧探针
 * 固定走 CPU 后端且没有 worker。之前这条线没闭合，就是因为缺真浏览器证据。
 *
 * 复用项目既有策略（`scripts/cdp-shot.mjs`）：自己拉起 headless Chrome + CDP，
 * 不依赖 puppeteer/playwright。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
if (args.length < 1) {
  console.error('用法: node scripts/probe-ai/_probe-ai-browser.mjs <url> [--timeout=ms] [--shot=out.png]');
  process.exit(2);
}
const url = args[0];
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const TIMEOUT = Number(opt('timeout', 180000));
const SHOT = opt('shot', null);

const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge 可执行文件');
  process.exit(1);
}

const PORT = 9200 + Math.floor(Math.random() * 700);
const profile = mkdtempSync(join(tmpdir(), 'probe-browser-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    // 本机 dev server 走直连：开发机上常配了 http_proxy，
    // Chrome 默认会用它去连 localhost，结果是 502 而不是页面。
    '--no-proxy-server',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const h of this.handlers) h(msg.method, msg.params);
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
  on(fn) {
    this.handlers.push(fn);
  }
}

/** console.log 的实参序列化（页面里 log() 已经扁平化成字符串，这里只做兜底） */
function argText(a) {
  if (a == null) return String(a);
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if ('description' in a) return a.description;
  return JSON.stringify(a);
}

let cdp;
let done = false;
try {
  cdp = await CDP.connect(await targetWs());
  let pageErr = 0;
  cdp.on((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map(argText).join(' ');
      process.stdout.write(text + '\n');
      if (text.includes('=== DONE ===')) done = true;
    } else if (method === 'Runtime.exceptionThrown') {
      pageErr++;
      const d = params.exceptionDetails ?? {};
      process.stdout.write(
        `[未捕获异常] ${d.text} ${d.exception?.description ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}\n`,
      );
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });

  const started = Date.now();
  while (!done && Date.now() - started < TIMEOUT) await sleep(400);

  // 兜底：页面里 __PROBE_LINES__ 是权威结果（console 可能被截断）
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__PROBE_LINES__ ?? null)',
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v && v !== 'null') {
      process.stdout.write('\n=== 页面 __PROBE_LINES__ ===\n');
      for (const line of JSON.parse(v)) process.stdout.write(line + '\n');
    }
  } catch {
    /* 页面可能已经崩了 */
  }

  if (SHOT) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(SHOT), Buffer.from(shot.data, 'base64'));
      process.stdout.write(`\n[截图] ${resolve(SHOT)}\n`);
    } catch (err) {
      process.stdout.write(`[截图失败] ${String(err)}\n`);
    }
  }

  if (!done) process.stdout.write(`\n[警告] ${TIMEOUT}ms 内没等到 === DONE ===，结果可能不完整\n`);
} finally {
  try {
    await cdp?.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  chrome.kill();
  await sleep(200);
}
