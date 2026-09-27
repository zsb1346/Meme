/**
 * probe-roll-keys.mjs —— 卷帘「电脑键盘弹奏」的端到端验收。
 *
 * 为什么需要它：`keyboard-play.test.ts` 已经钉住了**换算**（半音偏移 → 落哪一行），
 * 但「换算对」不等于「按键真的会点亮那一行」—— window 监听有没有挂上、
 * 焦点守卫会不会把按键吃掉、按下与松手是不是成对，全都发生在接线层，
 * 纯函数单测看不到。这一层出错的现象又最容易骗人：
 * 没声音时你会先怀疑音色、先怀疑声卡，而不是先怀疑事件没挂上。
 *
 * 判定方式刻意用 **canvas 上挂的 `__rollKeys` 快照**（渲染循环每帧写），
 * 而不是截图配色 —— 高亮是瞬时的，截图要靠时序运气，快照是数字。
 *
 * 用法：先起 dev server（`npx vite --port 5173`），再
 *   `node scripts/probe-roll-keys.mjs 5173`
 * 退出码 0 = 全过，1 = 有失败项（逐条列出）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_IMPORT_BOOTSTRAP, storeIdentityCheckSource } from './_app-import.mjs';

const PORT = Number(process.argv[2] ?? 5173);
const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome');
  process.exit(1);
}

const CDP_PORT = 9600 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(process.cwd(), '.workbuddy', 'tmp', 'probe-roll-keys-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {
    /* not up yet */
  }
  if (!wsUrl) await sleep(100);
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
/** 页面运行期异常：接线层的 bug 常常表现为「静默不生效」，异常是唯一的线索 */
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(
      'EXCEPTION: ' +
        (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text),
    );
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (!txt.includes('[vite]')) errors.push('console.error: ' + txt);
  }
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

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await sleep(3500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  /* ── 0. 装「拿到 App 那个模块实例」的解析器，并当场验证它是同一个 ──
     见 `_app-import.mjs`：HMR 之后模块 URL 带 `?t=`，裸路径 import 会拿到
     另一个 store 实例 —— 注入写进影子 store，失败会伪装成「卷帘按键失灵」。 */
  await ev(APP_IMPORT_BOOTSTRAP);
  {
    const idc = await ev(storeIdentityCheckSource('probe-roll-keys'));
    check('store 实例 = App 正在用的那个', idc.ok, idc.detail);
    if (!idc.ok) throw new Error('store 实例不一致，后续注入都不可信：' + idc.detail);
  }

  /* ── 在页面里跑完全部按键序列，原样带回观测值（断言留在 Node 侧） ── */
  const obs = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /* 等渲染循环写下一帧快照 —— __rollKeys 只在 draw 时刷新，
       派发完按键立刻读会读到**上一帧**的值（探针第一版就是这么骗过自己的） */
    const frames = async (n = 4) => {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
      await sleep(40);
    };
    const snap = () => {
      const cv = document.querySelector('canvas.touch-none');
      return cv && cv.__rollKeys ? JSON.parse(JSON.stringify(cv.__rollKeys)) : null;
    };
    const key = (type, code, target) => {
      (target ?? window).dispatchEvent(
        new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
      );
    };

    const m = await window.__appImport('/src/model/store.ts');
    const S = m.useStore;
    for (let i = 0; i < 80 && !S.getState().hydrated; i++) await sleep(150);
    if (!S.getState().hydrated) return { fatal: 'NOT_HYDRATED' };

    const st = S.getState();
    const keys = st.project.keys;
    const take = m.createEmptyTake('键盘弹奏验收');
    const evs = [];
    let t = 0.3;
    for (let i = 0; i < 12; i++) {
      const ki = 2 + (i % 8);
      evs.push({ keyIndex: ki, pressCount: 1, tSec: +t.toFixed(3),
        pitch: keys[ki] && typeof keys[ki].pitchMidi === 'number' ? keys[ki].pitchMidi : 48 + ki,
        duration: 0.25, velocity: 0.8 });
      t += 0.4;
    }
    take.events = evs;
    take.durationSec = t;
    S.setState({ project: { ...st.project, takes: [take, ...st.project.takes] } });

    const nav = [...document.querySelectorAll('aside nav button')];
    if (nav[2]) nav[2].click();
    await sleep(1000);
    await frames();

    const lanePitches = (S.getState().project.keys || []).map((k) => k.pitchMidi);
    const out = { fatal: null, lanePitches, steps: {}, exceptions: [] };

    /* 诊断：自己也在 window 上挂一个捕获期监听，数「按键到底有没有派发到」。
       接线层的故障常常是「事件根本没到」与「到了但没生效」两种情况，
       只读渲染快照分不出是哪一种。 */
    let seenDown = 0;
    window.addEventListener('keydown', () => { seenDown++; }, true);

    out.steps.before = snap();
    if (!out.steps.before) return { ...out, fatal: 'NO_CANVAS_OR_NO_SNAPSHOT' };

    /* ① 按住 A：应点亮 A 对应的那一行 */
    key('keydown', 'KeyA'); await frames();
    out.steps.afterA = snap();

    /* ② A 仍按住，再叠 D / G（和弦） */
    key('keydown', 'KeyD'); await frames();
    key('keydown', 'KeyG'); await frames();
    out.steps.chord = snap();

    /* ③ 松开 A：只熄掉 A 那一行，其余不动 */
    key('keyup', 'KeyA'); await frames();
    out.steps.releasedA = snap();

    /* ④ 默认键域只有 24 键（C3–B4）→ C4 之上再没有更高的 C，
          X 应当是**安静的空操作**。这是设计行为（有单测钉住），
          探针在这里把它钉一遍：免得日后有人为了「让 X 总能响应」
          把基准挪到键域外，换来的是「按了有反应但落在不存在的行上」。 */
    key('keyup', 'KeyD'); key('keyup', 'KeyG'); await frames();
    key('keydown', 'KeyX'); key('keyup', 'KeyX'); await frames();
    out.steps.xAtCeiling = snap();

    /* ⑤ 加宽键域到 61 键（C3–C8，真实干活时的配置）→ X 必须真的 +12 */
    S.getState().setKeyCount(61);
    await sleep(700);
    await frames();
    const lanes2 = (S.getState().project.keys || []).map((k) => k.pitchMidi);
    out.diag = {
      lanesBefore: { n: lanePitches.length, min: lanePitches[0], max: lanePitches[lanePitches.length - 1] },
      lanesAfter: { n: lanes2.length, min: lanes2[0], max: lanes2[lanes2.length - 1] },
      ascending: lanes2.every((p, i) => i === 0 || p > lanes2[i - 1]),
      seenDownBefore: seenDown,
    };
    out.steps.wideDomain = snap();
    key('keydown', 'KeyX'); key('keyup', 'KeyX'); await frames();
    out.diag.seenDownAfterX = seenDown;
    out.steps.afterX = snap();
    key('keydown', 'KeyZ'); key('keyup', 'KeyZ'); await frames();
    out.steps.afterZ = snap();

    /* 后面的守卫/左栏用例与收尾截图都回到 24 键（默认域）：
       61 行时行高只有几像素，高亮在图上看不出来，左栏点击也不好定位。 */
    S.getState().setKeyCount(24);
    await sleep(600);
    await frames();

    /* ⑥ 焦点在输入框里时不许弹奏（否则搜索框打字会出声、还被吞字符） */
    const probeInput = document.createElement('input');
    probeInput.type = 'text';
    document.body.appendChild(probeInput);
    probeInput.focus();
    key('keydown', 'KeyA', probeInput);
    await frames();
    out.steps.typingInInput = snap();
    key('keyup', 'KeyA', probeInput);
    probeInput.remove();

    /* ⑦ Ctrl+A 组合键必须放行给编辑快捷键（不许被当成弹奏） */
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', ctrlKey: true, bubbles: true }));
    await frames();
    out.steps.ctrlA = snap();

    /* ⑧ 切走焦点（blur）时必须收声 + 全灭：否则会留下挂住的长音 */
    key('keydown', 'KeyA'); await frames();
    out.steps.beforeBlur = snap();
    window.dispatchEvent(new Event('blur'));
    await frames();
    out.steps.afterBlur = snap();

    /* ⑨ 左侧钢琴栏点击：与键盘是**两条不同的路径**（指针分支 → gutterPress），
          必须同样点亮该行、且**不能**掉进「空白处点击 = 插入音符」那条路。
          行高一律从 canvas 上挂的 __rollView 读 —— 自己拿「键数」算行高，
          键域一变就算错（探针第一版就在 61 键域上按 24 键算，点到了第 31 行）。 */
    const cvA = document.querySelector('canvas.touch-none');
    const rc = cvA.getBoundingClientRect();
    const rv = cvA.__rollView;
    const targetLane = 12;
    const gy = rc.top + 22 + targetLane * rv.rowH - rv.sy + rv.rowH / 2;
    const gx = rc.left + 10; // 左栏内部
    const eventsBefore = S.getState().project.takes[0].events.length;
    cvA.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: gx, clientY: gy, bubbles: true, cancelable: true,
    }));
    await frames();
    out.steps.gutterDown = snap();
    cvA.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 7, pointerType: 'mouse', button: 0, buttons: 0,
      clientX: gx, clientY: gy, bubbles: true, cancelable: true,
    }));
    await frames();
    out.steps.gutterUp = snap();
    out.gutter = {
      rowClickLane: targetLane,
      expectedPitch: lanePitches[targetLane],
      eventsBefore,
      eventsAfter: S.getState().project.takes[0].events.length,
    };

    /* 收尾留一张高亮的画面供人眼复核。
       **按住不放**（不派发 keyup）—— 截图发生在脚本返回之后，
       松了手就什么都拍不到（探针第一版正是这么拍出一张「干净」的图的）。 */
    key('keydown', 'KeyA'); key('keydown', 'KeyD'); key('keydown', 'KeyG');
    await frames(6);
    const cv = document.querySelector('canvas.touch-none');
    const r = cv.getBoundingClientRect();
    out.canvasBox = { x: r.left, y: r.top, w: r.width, h: r.height };
    out.steps.highlightShot = snap();
    return out;
  })()`);

  if (obs?.fatal) {
    check('页面就绪并渲染出卷帘', false, obs.fatal);
    throw new Error('前置条件不满足：' + obs.fatal);
  }
  check('页面就绪并渲染出卷帘', true);

  const lanes = obs.lanePitches;
  const laneOfPitch = (p) => lanes.indexOf(p);
  const s = obs.steps;
  if (obs.diag) console.log('  diag → ' + JSON.stringify(obs.diag));

  check('初始无按键、无挂音', eq(s.before.pressed, []) && s.before.held === 0,
    JSON.stringify(s.before));

  check('基准音落在键域内、且是某个 C（A = 八度起点）',
    lanes.includes(s.before.base) && s.before.base % 12 === 0, `base=${s.before.base}`);

  const laneA = laneOfPitch(s.before.base);
  check('按 A → 点亮基准音那一行', eq(s.afterA.pressed, [laneA]) && s.afterA.held === 1,
    `pressed=${JSON.stringify(s.afterA.pressed)} 期望=[${laneA}]`);

  const chord = [...s.chord.pressed].sort((a, b) => a - b);
  check('三键和弦 → 点亮三行且互不相同',
    chord.length === 3 && new Set(chord).size === 3 && s.chord.held === 3,
    `pressed=${JSON.stringify(chord)}`);

  check('松 A → 只熄那一行，其余保留',
    !s.releasedA.pressed.includes(laneA) &&
      s.releasedA.pressed.length === 2 &&
      s.releasedA.held === 2,
    `pressed=${JSON.stringify(s.releasedA.pressed)}`);

  check('X 上移八度 → 基准真的 +12（⛔ 曾被自己的夹取压回原位）',
    s.afterX.base === s.wideDomain.base + 12,
    `base ${s.wideDomain.base}→${s.afterX.base}, shifts ${s.wideDomain.shifts}→${s.afterX.shifts}`);

  check('Z 下移八度 → 回到加宽后的原位',
    s.afterZ.base === s.wideDomain.base, `${s.afterX.base} → ${s.afterZ.base}`);

  check('窄键域（默认 24 键）里 X 是安静的空操作：**处理函数确实跑了**、基准仍是域内的 C',
    s.xAtCeiling.base === s.before.base &&
      s.xAtCeiling.base % 12 === 0 &&
      s.xAtCeiling.shifts === s.before.shifts + 1,
    `base ${s.before.base}→${s.xAtCeiling.base}, shifts ${s.before.shifts}→${s.xAtCeiling.shifts}`);

  check('焦点在输入框里时**不弹奏**（字符才不会被吞）',
    eq(s.typingInInput.pressed, []) && s.typingInInput.held === 0,
    `pressed=${JSON.stringify(s.typingInInput.pressed)}`);

  check('Ctrl+A 放行给编辑快捷键（不被当成弹奏）',
    eq(s.ctrlA.pressed, []), `pressed=${JSON.stringify(s.ctrlA.pressed)}`);

  check('失焦（blur）→ 收声 + 全灭，不留挂住的长音',
    s.beforeBlur.held === 1 && s.afterBlur.held === 0 && eq(s.afterBlur.pressed, []),
    `before=${s.beforeBlur.held} after=${s.afterBlur.held}`);

  const g = obs.gutter;
  check('点击左侧钢琴栏 → 点亮对应行（第 12 行 = C4）',
    g && eq(s.gutterDown.pressed, [12]),
    `pressed=${JSON.stringify(s.gutterDown.pressed)} 期望=[12] pitch=${g?.expectedPitch}`);

  check('左栏松手 → 熄灯',
    g && eq(s.gutterUp.pressed, []), `pressed=${JSON.stringify(s.gutterUp.pressed)}`);

  check('⛔ 点左栏**不会**插入音符（左栏是键盘，不是编辑区）',
    g && g.eventsAfter === g.eventsBefore,
    `事件数 ${g?.eventsBefore} → ${g?.eventsAfter}`);

  check('全程无页面运行期异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  /* 产物：按住三和弦时的画面，供人眼复核高亮 */
  const box = obs.canvasBox;
  if (box) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
    });
    const out = 'outputs/ui-review/roll-keys-highlight.png';
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  （高亮截图 → ${out}）`);
  }
} catch (err) {
  check("探针执行完成", false, err.message);
} finally {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${failed.length === 0 ? '✓ 全部通过' : `✗ ${failed.length}/${results.length} 项失败`}` +
    `（共 ${results.length} 项）`,
);
process.exit(failed.length === 0 ? 0 : 1);
