/**
 * stress-nav.mjs —— 高频切换页面/标签，复现「切过去画面变黑」。
 *
 * 判定「黑屏」的标准不是截图，而是三件事同时成立：
 *   1. <main> 里没有 <section>（内容被 React 卸载）；
 *   2. 页面文本长度骤降（正常页都有几百字）；
 *   3. 控制台出现渲染异常。
 * 这样即使错误边界生效（显示了错误卡），也能被认出来。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9000 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), 'stress-'));
const chrome = spawn(
  chromePath,
  ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
   '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
   '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
   '--window-size=1440,900', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* wait */ }
  if (!wsUrl) await sleep(100);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (!/DevTools|读取本地存档失败|自动保存失败|Internal error/.test(t)) errors.push('[error] ' + t);
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

const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description ?? '');
  return r.result.value;
};

/* 注入一个 take，让制作台有东西可渲染 */
await ev(`(async () => {
  const m = await import('/src/model/store.ts');
  const S = m.useStore, st = S.getState();
  const take = m.createEmptyTake('压力');
  take.events = Array.from({length: 12}, (_, i) => ({
    keyIndex: 2 + (i % 8), pressCount: 1, tSec: 0.3 + i * 0.4,
    pitch: 62 + (i % 8), duration: 0.3, velocity: 0.8 }));
  take.durationSec = 6;
  S.setState({ project: { ...st.project, takes: [take] } });
  return 'ok';
})()`);
await sleep(800);

/** 探测当前是否「黑屏」 */
const probe = `(() => {
  const main = document.querySelector('main');
  const sec = main && main.querySelector('section');
  const errCard = document.body.innerText.includes('渲染失败');
  return JSON.stringify({
    hasSection: !!sec,
    textLen: (document.body.innerText || '').length,
    errorCard: errCard,
  });
})()`;

const report = [];
let blackouts = 0;

for (let round = 0; round < 3; round++) {
  for (let page = 0; page < 4; page++) {
    await ev(`document.querySelectorAll('aside nav button')[${page}].click()`);
    await sleep(450);
    const raw = await ev(probe);
    const p = JSON.parse(raw);
    // 制作台文本天然较短（127），故阈值取 80
    const black = !p.hasSection || p.textLen < 80;
    if (black || p.errorCard) {
      blackouts++;
      report.push(`round${round} page${page}: ${raw}`);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const out = join(tmpdir(), `blackout-r${round}-p${page}.png`);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      report.push(`  → 截图 ${out}`);
    }
    // 制作台里再点一遍三个 tab
    if (page === 2) {
      for (const tabName of ['录制', '卷帘', '试听']) {
        await ev(`(() => {
          const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('${tabName}'));
          if (b) b.click();
          return !!b;
        })()`);
        await sleep(600);
        const raw2 = await ev(probe);
        const p2 = JSON.parse(raw2);
        if (!p2.hasSection || p2.textLen < 80 || p2.errorCard) {
          blackouts++;
          report.push(`round${round} studio/${tabName}: ${raw2}`);
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          const out = join(tmpdir(), `blackout-r${round}-tab-${tabName}.png`);
          writeFileSync(out, Buffer.from(shot.data, 'base64'));
          report.push(`  → 截图 ${out}`);
        }
      }
    }
  }
}

console.log(`切换轮次完成：3 轮 × 4 页（含制作台 3 个 tab）`);
console.log(`黑屏/错误卡次数：${blackouts}`);
if (report.length) console.log(report.join('\n'));
console.log(`\n渲染异常 ${errors.length} 条：`);
console.log(errors.slice(0, 6).join('\n') || '(无)');

ws.close();
chrome.kill();
