/**
 * shot-dialogs.mjs —— 起页面 + 注入测试数据 + 打开指定弹层并截图。
 *
 * 为什么单独写：弹层（装配面板 / 波形编辑器）需要先有素材与 take 才能打开，
 * 而这些只能经页面内模块图注入。内联在命令行里会被 PowerShell 的引号规则
 * 反复咬（嵌套选择器、正则都会破），故固化成脚本。
 *
 * 用法：node scripts/shot-dialogs.mjs [port] [palette|editor|palette-settings]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const MODE = process.argv[3] ?? 'palette';
const OUT = join(tmpdir(), `dsh-dialog-${MODE}.png`);

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome');
  process.exit(1);
}

const CDP_PORT = 9600 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'shotdlg-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--window-size=1180,780', 'about:blank',
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
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(3200);

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

/* ── 1. 注入三个素材 + 一个 take ── */
const seeded = await ev(`(async () => {
  const sr = 44100, dur = 3.2, N = Math.floor(sr * dur);
  const mkFile = (n) => {
    const ab = new ArrayBuffer(44 + N * 2), dv = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + N * 2, true); ws(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, 'data');
    dv.setUint32(40, N * 2, true);
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const env = Math.exp(-Math.pow((t / dur - 0.42) * 2.6, 2));
      const burst = (t % 0.42 < 0.16) ? 1 : 0.22;
      const v = (Math.sin(2*Math.PI*220*t)*0.5 + Math.sin(2*Math.PI*523*t)*0.3
               + Math.sin(2*Math.PI*1180*t)*0.2) * env * burst;
      dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
    }
    return new File([ab], n + '.wav', { type: 'audio/wav' });
  };
  const m = await import('/src/model/store.ts');
  const S = m.useStore;
  for (const n of ['喵叫', '叮·金属', '鼓点·电子']) {
    await S.getState().addSampleFromFile(mkFile(n), n);
  }
  const take = m.createEmptyTake('测试骨架');
  take.events = [
    { keyIndex: 5, pressCount: 1, tSec: 0.5, pitch: 65, duration: 0.4, velocity: 0.8 },
    { keyIndex: 8, pressCount: 2, tSec: 1.2, pitch: 68, duration: 0.3, velocity: 0.7 },
  ];
  take.durationSec = 3;
  S.setState({ project: { ...S.getState().project, takes: [take] } });
  S.getState().setActivePage('studio');
  return 'samples=' + S.getState().project.samples.length;
})()`);
console.log(seeded);
await sleep(2200);

/* ── 2. 切到卷帘 tab ── */
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('卷帘')).click()`);
await sleep(1200);

if (MODE === 'editor') {
  /* 直接打开素材箱里第一张卡的波形编辑器 */
  await ev(`(async () => {
    const S = (await import('/src/model/store.ts')).useStore;
    S.getState().setActivePage('material');
    return 'material';
  })()`);
  await sleep(1200);
  await ev(`(() => {
    const btn = document.querySelector('article button');
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    return 'editor-open';
  })()`);
  await sleep(1600);
} else {
  /* 在卷帘空白处点一下插入音符，再 Shift+A 打开装配面板 */
  await ev(`(async () => {
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const x = r.left + r.width * 0.72, y = r.top + 22 + r.height * 0.32;
    const E = (t, b) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
      pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b,
      clientX: x, clientY: y });
    cv.dispatchEvent(E('pointerdown', 1));
    await new Promise((z) => setTimeout(z, 60));
    cv.dispatchEvent(E('pointerup', 0));
    await new Promise((z) => setTimeout(z, 400));
    const host = document.querySelector('div[tabindex="0"]');
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', shiftKey: true, bubbles: true }));
    await new Promise((z) => setTimeout(z, 900));
    return 'palette-open';
  })()`);

  if (MODE === 'palette-settings') {
    /* 展开右侧音高参数区 */
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.title === '检测参数');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);
  }

  if (MODE === 'palette-settings-bottom') {
    /* 展开参数区并滚到底，验证「所有参数都能看到、没被裁掉」 */
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.title === '检测参数');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(600);
    const info = await ev(`(() => {
      // Modal 的内容区 = 标题下方那个 overflow-y-auto 的 div
      const scrollers = [...document.querySelectorAll('div')].filter(
        (d) => d.scrollHeight > d.clientHeight + 4 && d.clientHeight > 80,
      );
      if (scrollers.length === 0) return 'NO-SCROLLER';
      const s = scrollers[scrollers.length - 1];
      s.scrollTop = s.scrollHeight;
      return JSON.stringify({ count: scrollers.length, scrollH: s.scrollHeight, clientH: s.clientHeight });
    })()`);
    console.log('   scroller → ' + info);
    await sleep(400);
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`OK ${OUT} (${Buffer.from(shot.data, 'base64').length} bytes)`);

ws.close();
chrome.kill();
