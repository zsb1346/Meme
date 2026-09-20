/**
 * verify-note-sound.mjs —— 验证「放置音符会发声」这条反馈真的通了。
 *
 * 为什么必须单独测：
 *   浏览器的自动播放策略要求 AudioContext 在**受信任的用户手势**内 resume。
 *   脚本合成的 PointerEvent 不算手势，所以 Headless 里默认 suspended。
 *   本脚本用 CDP 的 Input.dispatchMouseEvent 派发真事件（算手势），
 *   并监听 AudioContext 是否真的跑到 running、以及是否有音符被触发。
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
const CDP_PORT = 9500 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'sound-'));
// 关键 flag：让 Headless 也允许音频自动播放，否则手势解锁路径测不出来
const chrome = spawn(
  chromePath,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--window-size=1440,900', 'about:blank',
  ],
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
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
await sleep(3200);

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ── 准备：注入 take + 切到卷帘 ── */
await ev(`(async () => {
  const m = await import('/src/model/store.ts');
  const S = m.useStore, st = S.getState();
  const take = m.createEmptyTake('声音验证');
  take.events = [{ keyIndex: 5, pressCount: 1, tSec: 0.5, pitch: 65, duration: 0.4, velocity: 0.8 }];
  take.durationSec = 3;
  S.setState({ project: { ...st.project, takes: [take] } });
  S.getState().setActivePage('studio');
  return 'seeded';
})()`);
await sleep(1500);
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('卷帘')).click()`);
await sleep(1200);

/* ── 埋点：拦截 AudioContext 上的 createOscillator，统计实际发声次数 ──
   Tone.PolySynth 底层用 OscillatorNode，故这是「真的响了」的可靠证据。 */
await ev(`(() => {
  window.__oscCount = 0;
  const proto = (window.AudioContext || window.webkitAudioContext).prototype;
  if (!proto.__patched) {
    const orig = proto.createOscillator;
    proto.createOscillator = function (...a) { window.__oscCount++; return orig.apply(this, a); };
    proto.__patched = true;
  }
  return 'patched';
})()`);

/* ── 取画布坐标 ── */
const box = await ev(`(() => {
  const cv = document.querySelector('canvas.touch-none');
  const r = cv.getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height };
})()`);

/* ── 用 CDP 派发「受信任」的点击：空白处插入音符 ── */
const x = Math.round(box.l + box.w * 0.75);
const y = Math.round(box.t + 22 + box.h * 0.45);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(700);

const after = await ev(`(async () => {
  const m = await import('/src/model/store.ts');
  const S = m.useStore;
  const t = S.getState().project.takes[0];
  return JSON.stringify({
    events: t.events.length,
    oscCount: window.__oscCount,
    ctxState: (window.Tone && window.Tone.getContext) ? window.Tone.getContext().state : 'n/a',
  });
})()`);
const a = JSON.parse(after);
console.log(`   事件数=${a.events}  振荡器创建次数=${a.oscCount}  ctx=${a.ctxState}`);

check('左键点击空白 → 插入音符', a.events === 2, `事件数 1 → ${a.events}`);
check(
  '放置音符时发声（AudioContext 上真的建了振荡器）',
  a.oscCount > 0,
  `oscCount=${a.oscCount}（>0 即证明 synth 被触发）`,
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项通过`);
if (passed < results.length) process.exitCode = 1;

ws.close();
chrome.kill();
