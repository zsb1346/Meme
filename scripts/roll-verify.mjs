/**
 * roll-verify.mjs —— 在真实页面里验证钢琴卷帘的关键交互。
 *
 * 为什么需要它：卷帘的交互（滚轮缩放锚定、框选、拖拽批量移动、改时长）
 * 靠肉眼看截图无法确认 —— 必须读实际状态。本脚本通过 Vite 开发服务器的
 * 模块图直接 import `/src/model/store.ts` 注入测试数据，然后派发真实
 * 指针/滚轮事件，最后把结果回显到控制台。
 *
 * 用法：先起 dev server，再 `node scripts/roll-verify.mjs [port]`
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const URL = `http://localhost:${PORT}/`;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
];
const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome');
  process.exit(1);
}

const CDP_PORT = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'roll-verify-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
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
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
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
}

let cdp;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  cdp = await CDP.connect(await waitForTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL });
  await sleep(3000);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  /* ── 1. 注入测试 take 并切到制作台 ── */
  await evalJs(`
    (async () => {
      const m = await import('/src/model/store.ts');
      const S = m.useStore;
      const st = S.getState();
      const take = m.createEmptyTake('验证骨架');
      const evs = [];
      let t = 0.3;
      for (let i = 0; i < 18; i++) {
        evs.push({
          keyIndex: 3 + (i % 9),
          pressCount: 1,
          tSec: +t.toFixed(3),
          pitch: 60 + 3 + (i % 9),
          duration: 0.25,
          velocity: 0.8,
        });
        t += 0.45;
      }
      take.events = evs;
      take.durationSec = t;
      S.setState({ project: { ...st.project, takes: [take, ...st.project.takes] } });
      /*
        必须同时选中这个 take —— 只塞进 project.takes 是不够的。
        制作台在「没有选中的 take」时渲染的是空状态（钢琴卷帘还空着 +
        导入 MIDI / 录制演奏 两个引导按钮），**不会挂载 canvas**，
        于是脚本报「找不到卷帘 canvas」。这是测试的疏漏，不是应用的问题。
      */
      if (typeof S.getState().setSelectedTakeId === 'function') {
        S.getState().setSelectedTakeId(take.id);
      }
      /*
        切页要点导航按钮，不要用 store 的 setActivePage：实测后者不生效
        （页面仍停在素材箱）。点按钮与用户真实操作一致。
      */
      const nav = [...document.querySelectorAll('aside nav button')];
      if (nav[2]) nav[2].click();
      return 'seeded';
    })()
  `);
  await sleep(2000);
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => x.textContent.includes('卷帘'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1200);

  /* ── 2. 读初始视图状态（从 canvas 上的 px/s 读数与 DOM 反推） ── */
  const initial = await evalJs(`(() => {
    const cv = document.querySelector('canvas.touch-none');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  })()`);
  if (!initial) throw new Error('找不到卷帘 canvas');
  console.log(`   canvas ${Math.round(initial.w)}×${Math.round(initial.h)}`);

  /* ── 3. Ctrl + 滚轮 → 横向缩放时间轴，锚定指针下的时间点 ──
     测法：读 canvas.__rollView 的 pps（每秒像素）。
     并额外验证「锚定」：指针下的时间点在缩放前后必须一致。 */
  const zoomTest = await evalJs(`(async () => {
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const cx = r.left + r.width * 0.6;
    const cy = r.top + r.height * 0.5;
    const wheel = (o) => cv.dispatchEvent(new WheelEvent('wheel', Object.assign(
      { bubbles: true, cancelable: true, clientX: cx, clientY: cy, deltaY: 0, deltaX: 0 }, o)));
    const read = () => cv.__rollView;
    const timeUnderPointer = () => {
      const v = cv.__rollView;
      // 与 geometry.timeAtX 同一公式：GUTTER_W = 60
      return (cx - r.left - 60 + v.sx) / v.pps;
    };
    await new Promise(r2 => setTimeout(r2, 150));
    const v0 = read();
    const t0 = timeUnderPointer();
    wheel({ deltaY: -320, ctrlKey: true });
    await new Promise(r2 => setTimeout(r2, 250));
    const v1 = read();
    const t1 = timeUnderPointer();
    wheel({ deltaY: 320, ctrlKey: true });
    await new Promise(r2 => setTimeout(r2, 250));
    const v2 = read();
    const t2 = timeUnderPointer();
    return {
      pps0: v0.pps, pps1: v1.pps, pps2: v2.pps,
      t0, t1, t2,
      rowH0: v0.rowH, rowH1: v1.rowH,
    };
  })()`);
  const ctrlZooms = zoomTest.pps1 > zoomTest.pps0 * 1.2;
  const ctrlRestores = Math.abs(zoomTest.pps2 - zoomTest.pps0) < 2;
  const anchorHolds = Math.abs(zoomTest.t1 - zoomTest.t0) < 0.02;
  const rowUntouched = Math.abs(zoomTest.rowH1 - zoomTest.rowH0) < 0.01;
  check(
    'Ctrl + 滚轮 = 横向缩放（pps 变大）',
    ctrlZooms,
    `pps ${zoomTest.pps0.toFixed(1)} → ${zoomTest.pps1.toFixed(1)}`,
  );
  check(
    'Ctrl + 滚轮 锚定指针下的时间点',
    anchorHolds,
    `指针处时间 ${zoomTest.t0.toFixed(3)}s → ${zoomTest.t1.toFixed(3)}s（差 ${Math.abs(zoomTest.t1 - zoomTest.t0).toFixed(4)}s）`,
  );
  check(
    'Ctrl + 滚轮 不影响纵向行高',
    rowUntouched,
    `rowH ${zoomTest.rowH0.toFixed(1)} → ${zoomTest.rowH1.toFixed(1)}`,
  );
  check(
    'Ctrl + 滚轮 反向可还原',
    ctrlRestores,
    `pps 回到 ${zoomTest.pps2.toFixed(1)}`,
  );

  /* ── 4. Alt + 滚轮 → 纵向缩放键道行高，锚定指针下的键道行 ──
     分两种情形验证，缺一不可：
       (a) 指针偏下（60% 高度）→ 缩放后所需的 sy 会超过 maxSy，
           **必然被边界 clamp**。此时正确行为是「锚点允许偏移，但滚动到达边界」，
           不能要求锚点严格不动。
       (b) 指针居中（50% 高度）→ 有足够余量，锚点必须严格不动。 */
  const altZoom = (ratio) => `(async () => {
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const cx = r.left + r.width * 0.5;
    const my = r.height * ${ratio};
    const cy = r.top + my;
    const wheel = (o) => cv.dispatchEvent(new WheelEvent('wheel', Object.assign(
      { bubbles: true, cancelable: true, clientX: cx, clientY: cy, deltaY: 0, deltaX: 0 }, o)));
    const read = () => cv.__rollView;
    const laneAt = (v) => (my - 22 + v.sy) / v.rowH;
    await new Promise(r2 => setTimeout(r2, 150));
    const v0 = read();
    const lane0 = laneAt(v0);
    // 缩放前先按同样公式预判缩放后是否会撞边界
    const wantPps = 1;
    wheel({ deltaY: -320, altKey: true });
    await new Promise(r2 => setTimeout(r2, 280));
    const v1 = read();
    const lane1 = laneAt(v1);
    const wantSy = lane0 * v1.rowH - (my - 22);
    const wouldClamp = wantSy > v1.maxSy + 0.01;
    return {
      rowH0: v0.rowH, rowH1: v1.rowH, pps0: v0.pps, pps1: v1.pps,
      lane0, lane1, wouldClamp, wantSy, maxSy: v1.maxSy, sy1: v1.sy,
    };
  })()`;

  const low = await evalJs(altZoom(0.6));
  check(
    'Alt + 滚轮 = 纵向缩放（rowH 变大）',
    low.rowH1 > low.rowH0 * 1.15,
    `rowH ${low.rowH0.toFixed(1)} → ${low.rowH1.toFixed(1)}`,
  );
  check(
    'Alt + 滚轮 不影响横向 pps',
    Math.abs(low.pps1 - low.pps0) < 0.01,
    `pps ${low.pps0.toFixed(1)} → ${low.pps1.toFixed(1)}`,
  );
  check(
    'Alt + 滚轮 撞边界时正确 clamp（而非放任越界）',
    !low.wouldClamp || Math.abs(low.sy1 - low.maxSy) < 0.5,
    low.wouldClamp
      ? `需要 sy=${low.wantSy.toFixed(1)} > maxSy=${low.maxSy.toFixed(1)} → 已夹到边界 ${low.sy1.toFixed(1)}`
      : '本次未撞边界',
  );

  const mid = await evalJs(altZoom(0.5));
  check(
    'Alt + 滚轮 有余量时锚定指针下的键道行',
    !mid.wouldClamp && Math.abs(mid.lane1 - mid.lane0) < 0.02,
    `行号 ${mid.lane0.toFixed(4)} → ${mid.lane1.toFixed(4)}（clamp=${mid.wouldClamp}）`,
  );

  // 复位到初始行高，避免影响后续用例
  await evalJs(`(async () => {
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const cy = r.top + r.height * 0.5, cx = r.left + r.width * 0.5;
    cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, deltaY: 320, deltaX: 0, altKey: true }));
    await new Promise(r2 => setTimeout(r2, 250));
    return 'reset';
  })()`);

  /* ── 5. 左键点击空白 → 插入音符 ── */
  const addTest = await evalJs(`(async () => {
    const m = await import('/src/model/store.ts');
    const before = m.useStore.getState().project.takes[0].events.length;
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const x = r.left + r.width * 0.82;
    const y = r.top + r.height * 0.55;
    const E = (t, buttons) => new PointerEvent(t, { bubbles: true, cancelable: true,
      composed: true, pointerId: 21, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons, clientX: x, clientY: y });
    cv.dispatchEvent(E('pointerdown', 1));
    await new Promise(r2 => setTimeout(r2, 60));
    cv.dispatchEvent(E('pointerup', 0));
    await new Promise(r2 => setTimeout(r2, 400));
    const after = m.useStore.getState().project.takes[0].events.length;
    return { before, after };
  })()`);
  check(
    '左键点击空白 = 插入音符',
    addTest.after === addTest.before + 1,
    `事件数 ${addTest.before} → ${addTest.after}`,
  );

  /* ── 6. Shift + 拖拽 → 框选 ── */
  const marqueeTest = await evalJs(`(async () => {
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    const x0 = r.left + r.width * 0.08;
    const y0 = r.top + r.height * 0.2;
    const x1 = r.left + r.width * 0.55;
    const y1 = r.top + r.height * 0.85;
    const E = (t, x, y, buttons) => new PointerEvent(t, { bubbles: true, cancelable: true,
      composed: true, pointerId: 31, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons, clientX: x, clientY: y, shiftKey: true });
    cv.dispatchEvent(E('pointerdown', x0, y0, 1));
    await new Promise(r2 => setTimeout(r2, 50));
    cv.dispatchEvent(E('pointermove', (x0 + x1) / 2, (y0 + y1) / 2, 1));
    await new Promise(r2 => setTimeout(r2, 50));
    cv.dispatchEvent(E('pointermove', x1, y1, 1));
    await new Promise(r2 => setTimeout(r2, 80));
    cv.dispatchEvent(E('pointerup', x1, y1, 0));
    await new Promise(r2 => setTimeout(r2, 350));
    // 读信息条上的「已选 N」
    const txt = document.body.innerText;
    const hit = txt.indexOf('已选');
    return hit >= 0 ? txt.slice(hit, hit + 24).replace(/\\s+/g, ' ') : 'NO-INFO-BAR';
  })()`);
  check(
    'Shift + 拖拽 = 框选（信息条出现已选数）',
    typeof marqueeTest === 'string' && marqueeTest.includes('已选') && !marqueeTest.includes('已选 0'),
    marqueeTest,
  );

  /* ── 7. Delete 删除选中 ── */
  const delTest = await evalJs(`(async () => {
    const m = await import('/src/model/store.ts');
    const before = m.useStore.getState().project.takes[0].events.length;
    const host = document.querySelector('div[tabindex="0"]');
    if (!host) return { before, after: before, err: 'no-host' };
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 400));
    const after = m.useStore.getState().project.takes[0].events.length;
    return { before, after };
  })()`);
  check(
    'Delete = 删除选中',
    delTest.after < delTest.before,
    `事件数 ${delTest.before} → ${delTest.after}`,
  );

  /* ── 8. Ctrl+Z 撤销 ── */
  const undoTest = await evalJs(`(async () => {
    const m = await import('/src/model/store.ts');
    const before = m.useStore.getState().project.takes[0].events.length;
    const host = document.querySelector('div[tabindex="0"]');
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 400));
    const after = m.useStore.getState().project.takes[0].events.length;
    return { before, after };
  })()`);
  check(
    'Ctrl+Z = 撤销',
    undoTest.after > undoTest.before,
    `事件数 ${undoTest.before} → ${undoTest.after}`,
  );

  /* ── 9. 右键点击音符 = 删除 ── */
  const rmbTest = await evalJs(`(async () => {
    const m = await import('/src/model/store.ts');
    const cv = document.querySelector('canvas.touch-none');
    if (!cv) return 'NO-CANVAS';
    const before = m.useStore.getState().project.takes[0].events.length;
    const r = cv.getBoundingClientRect();
    const v = cv.__rollView;
    const RULER = 22, GUTTER = 60;
    const ev = m.useStore.getState().project.takes[0].events[0];
    if (!ev) return 'NO-EVENT';
    // 命中该音符块的左端（留 3px 内缩，避开可能的外扩命中区）
    const x = r.left + GUTTER + ev.tSec * v.pps - v.sx + 3;
    const y = r.top + RULER + ev.keyIndex * v.rowH - v.sy + v.rowH / 2;
    cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      composed: true, pointerId: 55, pointerType: 'mouse', isPrimary: true,
      button: 2, buttons: 2, clientX: x, clientY: y }));
    await new Promise(z => setTimeout(z, 400));
    const after = m.useStore.getState().project.takes[0].events.length;
    return JSON.stringify({ before, after });
  })()`);
  if (typeof rmbTest === 'string' && rmbTest.startsWith('{')) {
    const rmb = JSON.parse(rmbTest);
    check('右键点击音符 = 删除', rmb.after === rmb.before - 1, `事件数 ${rmb.before} → ${rmb.after}`);
  } else {
    check('右键点击音符 = 删除', false, String(rmbTest));
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} 项通过`);
  if (passed < results.length) process.exitCode = 1;
} catch (err) {
  console.error('验证失败:', err.message);
  process.exitCode = 1;
} finally {
  try {
    cdp?.ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}