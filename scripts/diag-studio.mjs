/**
 * diag-studio.mjs —— 抓制作台（StudioPage）与 MIDI 导入的运行期报错。
 * 只打印事实，不做判断。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));
const CDP_PORT = 9400 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'dstudio-'));
const chrome = spawn(
  chromePath,
  ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
   '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
   '--window-size=1440,900', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* wait */ }
  if (!wsUrl) await sleep(100);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (!txt.includes('[vite]') && !txt.includes('DevTools')) logs.push(`[${m.params.type}] ${txt}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  }
  if (m.id === undefined) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});
const send = (method, params = {}) =>
  new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(3500);

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

console.log('=== 1. 注入一个 take，再进制作台 ===');
console.log(await ev(`(async () => {
  const m = await import('/src/model/store.ts');
  const S = m.useStore, st = S.getState();
  const take = m.createEmptyTake('诊断');
  take.events = [{ keyIndex: 3, pressCount: 1, tSec: 0.5, pitch: 63, duration: 0.3, velocity: 0.8 }];
  take.durationSec = 3;
  S.setState({ project: { ...st.project, takes: [take] } });
  S.getState().setActivePage('studio');
  return 'seeded';
})()`));

await sleep(1500);
console.log('=== 2. 制作台 DOM 是否渲染出来 ===');
console.log(await ev(`(() => {
  const sec = document.querySelector('section[aria-label="制作台"]');
  const canvas = document.querySelector('canvas.touch-none');
  const tabs = [...document.querySelectorAll('button')].filter(b => /录制|卷帘|试听/.test(b.textContent)).map(b => b.textContent.trim());
  return JSON.stringify({
    sectionExists: !!sec,
    canvasExists: !!canvas,
    tabCount: tabs.length,
    tabs,
    bodyText: (document.body.innerText || '').slice(0, 160).replace(/\\s+/g, ' '),
  });
})()`));

console.log('=== 3. 点「卷帘 + 填词」tab ===');
console.log(await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('卷帘'));
  if (!b) return 'NO-TAB';
  b.click();
  return 'clicked';
})()`));
await sleep(1200);
console.log(await ev(`(() => {
  const canvas = document.querySelector('canvas.touch-none');
  if (!canvas) return 'NO-CANVAS-AFTER-CLICK';
  const r = canvas.getBoundingClientRect();
  return JSON.stringify({ canvas: [Math.round(r.width), Math.round(r.height)], text: (document.body.innerText||'').slice(0,200).replace(/\\s+/g,' ') });
})()`));

console.log('=== 4. MIDI 导入链路是否可调用 ===');
console.log(await ev(`(async () => {
  try {
    const mod = await import('/src/engine/midi-import.ts');
    return 'import ok, exports=' + Object.keys(mod).join(',');
  } catch (e) { return 'IMPORT FAIL: ' + e.message; }
})()`));

console.log('=== 5. 页面日志/异常 ===');
console.log(logs.slice(-30).join('\n') || '(无)');

ws.close();
chrome.kill();
