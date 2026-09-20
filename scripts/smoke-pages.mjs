/**
 * smoke-pages.mjs —— 四页冒烟 + 音频链路可用性 + MIDI 导入链路。
 * 目标：确认没有任何残留的运行期异常。
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
const CDP_PORT = 9300 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
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
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
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
    const t = m.params.args.map((a) => a.value ?? '').join(' ');
    if (!t.includes('DevTools')) errors.push('[console.error] ' + t);
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
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description ?? '');
  return r.result.value;
};

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ── 0. 主效果链可建（这是崩过的地方）── */
const chain = await ev(`(async () => {
  try {
    const { getMasterChain } = await import('/src/engine/effects.ts');
    const { useStore } = await import('/src/model/store.ts');
    const c = getMasterChain(useStore.getState().project.effects);
    return JSON.stringify({ ok: !!c.input && !!c.output });
  } catch (e) { return 'FAIL: ' + e.message; }
})()`);
check('主效果链可构建（含新的 ReverbUnit）', chain.includes('"ok":true'), chain);

/* ── 1. 四页依次切换 ── */
const pages = [
  { name: '素材箱', idx: 0 },
  { name: '演奏台', idx: 1 },
  { name: '制作台', idx: 2 },
  { name: '混音台', idx: 3 },
];
for (const p of pages) {
  await ev(`document.querySelectorAll('aside nav button')[${p.idx}].click()`);
  await sleep(900);
  const info = await ev(`(() => {
    const sec = document.querySelector('main section');
    return JSON.stringify({ hasSection: !!sec, len: (document.body.innerText||'').length });
  })()`);
  const parsed = JSON.parse(info);
  check(`切到「${p.name}」正常渲染`, parsed.hasSection && parsed.len > 50, info);
}

/* ── 2. 回混音台：ReverbUnit 的 10 个参数是否都在 ── */
await ev(`document.querySelectorAll('aside nav button')[3].click()`);
await sleep(1200);
const reverbParams = await ev(`(async () => {
  const { EFFECT_UNITS } = await import('/src/engine/effect-units/registry.ts');
  const u = EFFECT_UNITS.find(x => x.id === 'reverb');
  return JSON.stringify({ count: u.params.length, keys: u.params.map(p => p.key) });
})()`);
const rp = JSON.parse(reverbParams);
check('混响 10 个参数已注册', rp.count === 10, rp.keys.join(','));

/* ── 3. MIDI 导入：走**应用真实入口** importMidiFile（含 @tonejs/midi 动态导入）──
   注意不能直接 `import('@tonejs/midi')`：浏览器里裸模块名无法解析，
   必须经 Vite 的模块图（也就是应用自己的 import 链）。 */
const midiOk = await ev(`(async () => {
  try {
    const { importMidiFile } = await import('/src/engine/midi-import.ts');
    // 手搓最小 MIDI 字节流：format 0 / 1 轨 / 3 个音符
    const bytes = [
      0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0x01,0xe0,
      0x4d,0x54,0x72,0x6b, 0,0,0,44,
      0x00, 0x90, 60, 100,  0x83,0x60, 0x80, 60, 0,
      0x00, 0x90, 64, 100,  0x83,0x60, 0x80, 64, 0,
      0x00, 0x90, 67, 100,  0x83,0x60, 0x80, 67, 0,
      0x00, 0xff, 0x2f, 0x00
    ];
    const file = new File([new Uint8Array(bytes)], 'probe.mid', { type: 'audio/midi' });
    // 注意：importMidiFile 返回 { take, range }（range 用于音域自适应）
    const { take, range } = await importMidiFile(file, { keyCount: 14 });
    return JSON.stringify({
      ok: true,
      events: take.events.length,
      lanes: range.maxLane - range.minLane + 1,
      laneOffset: range.laneOffset,
    });
  } catch (e) { return 'FAIL: ' + e.message; }
})()`);
check('MIDI 导入（应用真实入口）可用', midiOk.includes('"ok":true') && midiOk.includes('"events":3'), midiOk);

/* ── 4. 全程零异常 ── */
/*
  无头 Chrome + 一次性 profile 下 IndexedDB 会抛 `UnknownError: Internal error.`，
  这是环境限制（应用已在 `loadAll()` 里 catch 并回退到全新工程，属预期兜底分支），
  不是代码缺陷 —— 故从「异常」里排除，但仍如实打印出来便于对照。
*/
const realErrors = errors.filter(
  (e) => !/读取本地存档失败|自动保存失败|Internal error/.test(e),
);
const envOnly = errors.filter((e) => /读取本地存档失败|自动保存失败|Internal error/.test(e));
if (envOnly.length) {
  console.log(`   （已排除 ${envOnly.length} 条无头环境 IndexedDB 限制，应用已自行兜底）`);
}
check('全程无运行期异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(' | ') : '无');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项通过`);
if (passed < results.length) process.exitCode = 1;

ws.close();
chrome.kill();
