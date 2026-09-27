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
import { APP_IMPORT_BOOTSTRAP, storeIdentityCheckSource } from './_app-import.mjs';

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

  /* ── 0. 先装「拿到 App 那个模块实例」的解析器 ──
     见 `_app-import.mjs`：HMR 之后模块 URL 带 `?t=`，裸路径 import 会拿到
     另一个 store 实例（探针写进影子 store → 页面没反应 → 假红）。 */
  await evalJs(APP_IMPORT_BOOTSTRAP);

  /* ── 0b. 先证明「探针拿到的 store」就是「App 在渲染的那个 store」 ──
     ⛔ 这条必须先过。否则后面所有注入都写进影子 store，失败会伪装成
     「卷帘挂了」这种产品 bug（见 `_app-import.mjs` 的长注释）。 */
  {
    const idc = await evalJs(storeIdentityCheckSource('roll-verify'));
    check('store 实例 = App 正在用的那个', idc.ok, idc.detail);
    if (!idc.ok) throw new Error('store 实例不一致，后续注入都不可信：' + idc.detail);
  }

  /* ── 1. 注入测试 take 并切到制作台 ── */
  await evalJs(`
    (async () => {
      const m = await window.__appImport('/src/model/store.ts');
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
        注入完必须让它真的显示出来：制作台在「没有选中的 take」时渲染的是
        空状态（卷帘还空着 + 导入 MIDI / 录制演奏 两个引导按钮），
        **不会挂载 canvas**，于是脚本报「找不到卷帘 canvas」。

        ⛔ 别在这里找 setSelectedTakeId —— store 上**没有**这个东西。
        「选中的是哪个 take」是各页面自己的 useState（StagePage / StudioPage
        都一样），从 store 够不着；制作台挂载后会把 takes[0] 落到选中位，
        所以**注入到数组头部**就是让新 take 被显示的唯一手段。

        反例档案：这里曾经写着
            if (typeof S.getState().setSelectedTakeId === 'function') { … }
        看着像「兼容两版 API」，实际**永远为假**、静默什么都不做。靠
        「takes[0] 自动选中」碰巧还能跑，于是没人发现；直到 §10 依赖它切换
        take 时，探针就在**别人的 take** 上白测了两项（详见 §10 注释）。
        ⛔ 守卫只有在两种分支都可达时才配存在；永远为假的守卫 = 谎言。

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
    const m = await window.__appImport('/src/model/store.ts');
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
    const m = await window.__appImport('/src/model/store.ts');
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
    const m = await window.__appImport('/src/model/store.ts');
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

  /* ── 9. 右键点击音符 = 删除 ──
     ⛔ 必须挑一个**此刻真的落在画布矩形内**的音符再点。早先版本硬点
     `events[0]`，而第 4 节的纵向缩放会把视图滚走（实测 sy=157、rowH=35.6），
     于是那个音符的行落在画布**上边界之外**（y=84 < 画布 top=94）——
     指针事件打进了空气，删除当然不发生，红得像是功能坏了。
     「点在元素外面却断言状态变化」是探针最常见的假红。 */
  const rmbTest = await evalJs(`(async () => {
    const m = await window.__appImport('/src/model/store.ts');
    const cv = document.querySelector('canvas.touch-none');
    if (!cv) return 'NO-CANVAS';
    const before = m.useStore.getState().project.takes[0].events.length;
    const r = cv.getBoundingClientRect();
    const v = cv.__rollView;
    const RULER = 22, GUTTER = 60;
    const events = m.useStore.getState().project.takes[0].events;
    // 命中点 = 音符块左端内缩 3px / 行中线；与 geometry.laneOf 同一映射（lane = keyIndex）
    const hits = events.map((ev, i) => ({
      i, ev,
      x: r.left + GUTTER + ev.tSec * v.pps - v.sx + 3,
      y: r.top + RULER + ev.keyIndex * v.rowH - v.sy + v.rowH / 2,
    })).filter((h) => h.x > r.left + GUTTER && h.x < r.right - 6
                   && h.y > r.top + RULER && h.y < r.bottom - 4);
    if (hits.length === 0) return 'NO-VISIBLE-EVENT';
    const hit = hits[0];
    cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      composed: true, pointerId: 55, pointerType: 'mouse', isPrimary: true,
      button: 2, buttons: 2, clientX: hit.x, clientY: hit.y }));
    await new Promise(z => setTimeout(z, 400));
    const after = m.useStore.getState().project.takes[0].events.length;
    return JSON.stringify({ before, after, hit: { i: hit.i, keyIndex: hit.ev.keyIndex,
      tSec: hit.ev.tSec, x: Math.round(hit.x), y: Math.round(hit.y) } });
  })()`);
  if (typeof rmbTest === 'string' && rmbTest.startsWith('{')) {
    const rmb = JSON.parse(rmbTest);
    check('右键点击音符 = 删除', rmb.after === rmb.before - 1,
      `事件数 ${rmb.before} → ${rmb.after}（点 keyIndex=${rmb.hit.keyIndex} tSec=${rmb.hit.tSec} @ ${rmb.hit.x},${rmb.hit.y}）`);
  } else {
    check('右键点击音符 = 删除', false, String(rmbTest));
  }

  /* ── 10. 左右键切换音符 → 目标在视口外时自动横向聚焦 ──
     为什么必须测在这一层：`reveal-block-x.test.ts` 只钉住纯数学（滚多少）。
     真正会坏的是**接线** —— 方向键处理器里到底有没有把 sx 写回 viewRef。
     坏掉的现象是「选中变了、画面就是不动」，跟按键失灵长得一模一样，
     而 `__rollView.sx` 有没有变是把这两者分开的唯一数字。

     ⛔ 本节的素材必须**原地改造当前显示的那个 take**（`takes[0]`），
     不能另塞一个新 take 进数组头再指望它被选中：制作台的 `selectedTakeId`
     是页面私有 state，store 上够不着（见 §1 的反例档案）。早先版本正是这么
     写的，于是这一段跑在**上一个 take 的 18 个音符**上 —— 那些音符全在
     视口内，按 → 当然不滚，红得毫无信息量。 */
  const focusTest = await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = await window.__appImport('/src/model/store.ts');
    const S = m.useStore;
    const st = S.getState();
    const cur = st.project.takes[0];
    if (!cur) return 'NO-TAKE';
    // 原地替换（id 不变 → 制作台不会切走）：两个音符拉开 17.6s，
    // 足以制造「目标在视口之外」的场面。
    const T0 = 0.4, T1 = 18;
    const DUR = 0.4;
    const t = {
      ...cur,
      events: [
        { keyIndex: 3, pressCount: 1, tSec: T0, pitch: 63, duration: DUR, velocity: 0.8 },
        { keyIndex: 5, pressCount: 1, tSec: T1, pitch: 65, duration: DUR, velocity: 0.8 },
      ],
      durationSec: T1 + 0.8,
    };
    S.setState({ project: { ...st.project, takes: [t, ...st.project.takes.slice(1)] } });
    await wait(700);

    const cv = document.querySelector('canvas.touch-none');
    if (!cv) return 'NO-CANVAS';
    const host = cv.closest('div[tabindex="0"]') || document.querySelector('div[tabindex="0"]');
    if (!host) return 'NO-HOST';
    host.focus();

    const GUTTER = 60;
    /* 某音符此刻在视口里的位置 —— 与 geometry.timeToX / blockSize 同公式 */
    const posOf = (tSec, dur) => {
      const v = cv.__rollView;
      const r = cv.getBoundingClientRect();
      const x = GUTTER + tSec * v.pps - v.sx;
      const bw = Math.max(8, dur * v.pps);
      return { x, right: x + bw, bw, w: r.width, sx: v.sx, pps: v.pps,
               vis: x >= GUTTER && x + bw <= r.width };
    };

    /* 目标必须**不完整可见**，否则「滚没滚」根本无从判断。
       用工具栏「横向放大」按钮放大它（与用户操作一致）；放大后它只会更靠右，
       所以这个循环一定会退出。 */
    const zoomIn = [...document.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') || '').startsWith('横向放大'));
    if (!zoomIn) return 'NO-ZOOM-BUTTON';
    let clicks = 0;
    while (clicks < 14 && posOf(T1, DUR).vis) {
      zoomIn.click();
      await wait(140);
      clicks++;
    }
    const before = {
      n1: posOf(T0, DUR),
      n2: posOf(T1, DUR),
      zoomClicks: clicks,
    };

    const press = (key) => host.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    }));

    press('Escape');                       // 清选中：第一次按 → 落到最早的音符
    await wait(180);
    press('ArrowRight');
    await wait(320);
    const atN1 = posOf(T0, DUR);

    press('ArrowRight');                   // 跳到 18s 那个（原本在视口外）
    await wait(320);
    const atN2 = posOf(T1, DUR);

    press('ArrowLeft');                    // 往回
    await wait(320);
    const backN1 = posOf(T0, DUR);

    const sxIdleBefore = cv.__rollView.sx; // 已在最早音符上再按 ← ：不许抖
    press('ArrowLeft');
    await wait(320);
    const sxIdleAfter = cv.__rollView.sx;

    return JSON.stringify({ before, atN1, atN2, backN1, sxIdleBefore, sxIdleAfter });
  })()`);
  if (typeof focusTest === 'string' && focusTest.startsWith('{')) {
    const f = JSON.parse(focusTest);
    const rd = (n) => Math.round(n);
    check(
      '前置：第二个音符不完整可见（否则「滚没滚」无从判断）',
      !f.before.n2.vis,
      `放大 ${f.before.zoomClicks} 次，x=${rd(f.before.n2.x)} 宽=${rd(f.before.n2.bw)} 视口宽 ${rd(f.before.n2.w)}`,
    );
    check(
      '按 → 选中最早音符（它本来就在视口里）',
      f.atN1.vis,
      `x=${rd(f.atN1.x)} 右缘=${rd(f.atN1.right)} 视口宽 ${rd(f.atN1.w)}`,
    );
    check(
      '⛔ 目标在视口外时按 → 自动横向滚动（sx 变了）且目标完整可见',
      f.atN2.vis && f.atN2.sx !== f.before.n2.sx,
      `sx ${rd(f.before.n2.sx)} → ${rd(f.atN2.sx)}，x=${rd(f.atN2.x)}`,
    );
    check(
      '按 ← 回到上一个音符，同样聚焦进视口',
      f.backN1.vis,
      `x=${rd(f.backN1.x)} 右缘=${rd(f.backN1.right)}`,
    );
    check(
      '已在最早音符上按 ← 不抖（选中不变 → 视图不动）',
      f.sxIdleBefore === f.sxIdleAfter,
      `sx ${rd(f.sxIdleBefore)} → ${rd(f.sxIdleAfter)}`,
    );
  } else {
    check('左右键横向聚焦', false, String(focusTest));
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