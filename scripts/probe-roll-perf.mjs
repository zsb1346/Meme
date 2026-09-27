/**
 * probe-roll-perf.mjs —— 量钢琴卷帘「每一帧到底在画什么、花多久、谁在烧 CPU」。
 *
 * ## 为什么必须有这个探针
 *
 * 卷帘的卡顿在单测里**完全测不到**：vitest 没有 canvas，`draw()` 是纯函数，
 * 谁也没量过它跑多久。用户实报「电脑端有时候都会卡」—— 说明开销已经越过了
 * 一帧预算，只是平时靠余量盖住了。
 *
 * ## 三层测量（从粗到细）
 *
 * 1. **结构指标 `ops`** —— 每帧在 canvas API 上调用了多少次。
 *    ⭐ 它**与 CPU 快慢完全无关**，所以「优化前后」可以直接对比，
 *    不受本机负载干扰。这是回归验收的主判据。
 * 2. **`canvasMs`** —— 花在 canvas API 里的时间（`performance.now()` 打点）。
 *    ⚠️ 分辨率有限：单次 `fillRect` 常常低于计时器粒度 → 会读成 0.00ms。
 *    所以它只用来「排除」，不用来「选优」。
 * 3. **CPU 采样（CDP Profiler）** —— 逐函数自耗时。**这是唯一能点名热点的**。
 *
 * ## 场景
 *
 * 静置重绘 / 播放中 / 拖音符 / 框选。每个场景单独采一份 profile。
 *
 * ## 用法
 *
 *     node scripts/probe-roll-perf.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_IMPORT_BOOTSTRAP } from './_app-import.mjs';

const PORT = Number(process.argv[2] ?? 5199);
const URL = `http://localhost:${PORT}/`;
/** 采样间隔（微秒）：100µs 足够分辨热点，又不至于把 profile 撑爆 */
const SAMPLE_US = 100;

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
const profile = mkdtempSync(join(tmpdir(), 'roll-perf-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    /*
      ⛔ 少了这一条，卷帘的「播放」场景永远测不到：`startPlayback` 的第一句是
      `ensureAudioContextRunning()`，headless 下没有真实用户手势 → resume 被拒
      → `toast('点一下页面解锁音频后再播放')` 后直接 return，**播放头 rAF 根本没起**。
      现象是 CPU 采样里 99.8% 全是 `(idle)` —— 会被误读成「播放很轻」。
    */
    '--autoplay-policy=no-user-gesture-required',
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

/**
 * 页面侧绘图探针安装器。
 *
 * ⛔ 只在 `type === '2d'` 且是**卷帘那块 canvas** 上装：页面里还有别的 canvas，
 * 全装上会把别人的开销算进卷帘的账。判据用 class —— 卷帘 canvas 固定带
 * `touch-none`（见 RollCanvas.tsx）。
 *
 * 同时包一层 `requestAnimationFrame` 量「每帧回调耗时」—— 这是「一帧到底
 * 花了多久」的直接读数，比逐个 canvas 调用求和更接近真相。
 */
const INSTALL_PROFILER = `(() => {
  if (window.__rollProf) return 'already';
  const NAMES = [
    'clearRect','fillRect','strokeRect','rect','roundRect','beginPath','closePath',
    'fill','stroke','moveTo','lineTo','quadraticCurveTo','bezierCurveTo','arc',
    'save','restore','clip','setTransform','translate','scale',
    'fillText','strokeText','measureText','setLineDash',
    'createLinearGradient','createRadialGradient','createPattern',
    'drawImage','putImageData',
  ];
  const prof = {
    frames: 0, ops: 0, ns: 0, frameNs: 0, maxFrameMs: 0, over16: 0,
    byName: Object.create(null),
    /* 只统计**真的画了东西**的帧之间的间隔 —— 见下面 rAF 包装 */
    gaps: [], lastDrawTs: 0, drawFrames: 0,
    reset() {
      this.frames = 0; this.ops = 0; this.ns = 0;
      this.frameNs = 0; this.maxFrameMs = 0; this.over16 = 0;
      this.gaps = []; this.lastDrawTs = 0; this.drawFrames = 0;
      this.byName = Object.create(null);
    },
    mark(name) { this.ops++; this.byName[name] = (this.byName[name] || 0) + 1; },
  };
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGet.call(this, type, ...rest);
    if (type !== '2d' || !ctx || ctx.__rollProfPatched) return ctx;
    if (!this.classList || !this.classList.contains('touch-none')) return ctx;
    ctx.__rollProfPatched = true;
    for (const n of NAMES) {
      const f = ctx[n];
      if (typeof f !== 'function') continue;
      ctx[n] = function (...a) {
        const t0 = performance.now();
        const r = f.apply(this, a);
        prof.ns += performance.now() - t0;
        prof.mark(n);
        if ((n === 'createLinearGradient' || n === 'createRadialGradient') && r && !r.__rollProfPatched) {
          r.__rollProfPatched = true;
          const add = r.addColorStop;
          r.addColorStop = function (...b) {
            const t1 = performance.now();
            const rr = add.apply(this, b);
            prof.ns += performance.now() - t1;
            prof.mark('addColorStop');
            return rr;
          };
        }
        return r;
      };
    }
    return ctx;
  };
  /*
    每帧耗时：⛔ 不能用 performance.now() 前后相减 —— 它的分辨率被钳得很粗
    （单次 fillRect 常常低于粒度），实测会读成 0.05ms 这种明显不可能的均值。
    改用 **rAF 时间戳的帧间隔**（同源、粒度细、且正是「帧率」本身），
    并且**只在真的发生了绘制（ops 增长）的帧之间**测量 —— 否则空闲帧会把均值稀释掉。
  */
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return origRaf(function (ts) {
      const opsBefore = prof.ops;
      cb(ts);
      prof.frames++;
      if (prof.ops > opsBefore) {
        if (prof.lastDrawTs) prof.gaps.push(ts - prof.lastDrawTs);
        prof.lastDrawTs = ts;
        prof.drawFrames++;
      }
    });
  };
  window.__rollProf = prof;
  return 'installed';
})()`;

/** 把 prof 拍成可回传的快照 */
const SNAP_FIELDS = `
  const snap = {
    ops: prof.ops, ns: prof.ns, frames: prof.frames, drawFrames: prof.drawFrames,
    gaps: prof.gaps.slice(), byName: { ...prof.byName },
  };`;

/** 派发 `count` 次滚轮（每次恰好一帧重绘），逐帧等 rAF 跑完 */
const measureSource = (count) => `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.querySelector('canvas.touch-none');
  if (!cv) return { error: '找不到卷帘 canvas' };
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width * 0.55;
  const cy = r.top + r.height * 0.5;
  const prof = window.__rollProf;
  await raf();
  prof.reset();
  for (let i = 0; i < ${count}; i++) {
    cv.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 6, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
    }));
    await raf();
  }
  ${SNAP_FIELDS}
  const view = cv.__rollView || null;
  return { snap, view };
})()`;

/** 换一段 N 个事件的 take（保住 id 以维持页面选中）；spacing 控制密度 */
const seedSource = (n, spacing = 0.03) => `(async () => {
  const m = await window.__appImport('/src/model/store.ts');
  const S = m.useStore;
  const st = S.getState();
  const old = st.project.takes[0];
  const t = m.createEmptyTake('perf-' + ${n});
  t.id = old ? old.id : t.id;
  const evs = [];
  const PITCHES = [60, 62, 64, 65, 67, 69, 71, 72, 74];
  for (let i = 0; i < ${n}; i++) {
    evs.push({
      keyIndex: 3 + (i % 9),
      pressCount: 1 + (i % 3),
      tSec: +(0.3 + i * ${spacing}).toFixed(4),
      pitch: PITCHES[i % PITCHES.length],
      duration: 0.22,
      velocity: 0.5 + 0.5 * ((i % 5) / 4),
    });
  }
  t.events = evs;
  t.durationSec = 0.3 + ${n} * ${spacing} + 0.4;
  S.setState({ project: { ...st.project, takes: [t, ...st.project.takes.slice(1)] } });
  return { id: t.id, n: t.events.length };
})()`;

/** 通用：在页面里跑一段 async 脚本，返回其 resolve 值 */
const scenarioWrapper = (body) => `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cv = document.querySelector('canvas.touch-none');
  if (!cv) return { error: '找不到卷帘 canvas' };
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width * 0.5;
  const cy = r.top + r.height * 0.5;
  const ev = (type, x, y, opts = {}) => new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true, ...opts,
  });
  const prof = window.__rollProf;
  await raf();
  prof.reset();
  ${body}
  ${SNAP_FIELDS}
  return { snap };
})()`;

const SCENARIOS = [
  {
    name: '播放中（60fps 连续重绘）',
    body: `
      const play = document.querySelector('button[aria-label="开始播放"]');
      if (!play) return { error: '找不到「开始播放」按钮' };
      play.click();
      await new Promise((res) => setTimeout(res, 3000));
      const stop = document.querySelector('button[aria-label="停止播放"]');
      if (stop) stop.click();
      await raf();
    `,
  },
  {
    name: '拖音符（每帧重绘 + 命中测试）',
    body: `
      const start = { x: cx - 120, y: cy };
      cv.dispatchEvent(ev('pointerdown', start.x, start.y));
      await raf();
      for (let i = 0; i < 40; i++) {
        cv.dispatchEvent(ev('pointermove', start.x + i * 3, start.y));
        await raf();
      }
      cv.dispatchEvent(ev('pointerup', start.x + 120, start.y));
      await raf();
    `,
  },
  {
    name: '框选（Shift 拖拽，全量扫描事件）',
    body: `
      cv.dispatchEvent(ev('pointerdown', cx - 200, cy - 80, { shiftKey: true }));
      await raf();
      for (let i = 0; i < 30; i++) {
        cv.dispatchEvent(ev('pointermove', cx - 200 + i * 12, cy + 80, { shiftKey: true }));
        await raf();
      }
      cv.dispatchEvent(ev('pointerup', cx + 160, cy + 80, { shiftKey: true, buttons: 0 }));
      await raf();
    `,
  },
];

/**
 * 采一份 CPU profile：跑 `source` 期间采样，按「函数 + 文件」聚合自耗时。
 * @returns {{ snap: object|null, totalSamples: number, windowMs: number, rows: Array }}
 */
async function cupProfile(evalJs, source, label) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
  await cdp.send('Profiler.start');
  const snap = await evalJs(source);
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Profiler.disable');

  const totalSamples = profile.samples ? profile.samples.length : 0;
  const intervalMs = profile.timeDeltas
    ? profile.timeDeltas.reduce((a, b) => a + b, 0) / 1000
    : 0;
  const self = new Map();
  for (const n of profile.nodes) {
    const cf = n.callFrame;
    const fn = cf.functionName || '(anonymous)';
    let url = cf.url || '';
    if (url.startsWith('http://localhost:')) {
      url = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    } else if (url.startsWith('http')) {
      url = 'ext:' + new URL(url).host;
    }
    const key = `${fn}  @${url}`;
    self.set(key, (self.get(key) ?? 0) + (n.hitCount ?? 0));
  }
  const rows = [...self.entries()]
    .map(([name, hits]) => ({
      name,
      ms: (hits * SAMPLE_US) / 1000,
      pct: totalSamples ? (hits / totalSamples) * 100 : 0,
    }))
    .sort((a, b) => b.ms - a.ms);
  console.log(`  [profile] ${label}：采样 ${totalSamples} 点 / 窗口 ${intervalMs.toFixed(0)}ms`);
  if (snap && snap.error) console.log(`      ⚠️ 场景未生效：${snap.error}`);
  if (snap && snap.snap) {
    const g = gapStats(snap.snap.gaps);
    console.log(
      `      绘制帧 ${snap.snap.drawFrames} 个 / 间隔 中位${g.p50.toFixed(1)} p95 ${g.p95.toFixed(1)} 峰 ${g.max.toFixed(1)}ms` +
        `  超一帧 ${g.over16}/${g.n}  ops 合计 ${snap.snap.ops}`,
    );
  }
  for (const r of rows.slice(0, 14)) {
    console.log(`      ${r.ms.toFixed(1).padStart(7)}ms  ${r.pct.toFixed(1).padStart(5)}%  ${r.name}`);
  }
  return { snap: snap && snap.snap ? snap.snap : null, totalSamples, windowMs: intervalMs, rows };
}

/**
 * 绘制帧间隔统计。⭐ 这是「能不能稳住 60fps」的直接读数：
 * 一帧预算 16.7ms，`p95` 一旦越线就是用户能感觉到的顿。
 */
function gapStats(gaps) {
  if (!gaps || gaps.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, over16: 0 };
  const s = [...gaps].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    over16: s.filter((g) => g > 16.7).length,
  };
}

let cdp;
try {
  cdp = await CDP.connect(await waitForTarget());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL });
  await sleep(3200);

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

  await evalJs(APP_IMPORT_BOOTSTRAP);

  /* ── 注入 take 并切到卷帘 tab ── */
  await evalJs(seedSource(400));
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('aside nav button')];
    if (nav[2]) nav[2].click();
    return true;
  })()`);
  await sleep(1800);
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('卷帘'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);

  const inst = await evalJs(INSTALL_PROFILER);
  console.log(`探针安装：${inst}`);
  console.log('');

  /* ═══ 第 1 层：ops / 帧耗时 随「可见事件数」的变化 ═══
     注意：ops 只统计**真的画出来**的调用，所以可见窗口内的事件数才决定 ops。
     密度用 spacing 控制（0.03s ≈ 33 个/秒），视口默认 90px/s ≈ 15s 宽。 */
  console.log('=== 结构指标：ops/帧 与绘制帧间隔（20 帧平均）===');
  const CASES = [
    { n: 18, spacing: 0.9, label: '稀疏小 take' },
    { n: 400, spacing: 0.03, label: '常规密度' },
    { n: 2000, spacing: 0.03, label: '长 take（可见量同上）' },
    { n: 4000, spacing: 0.008, label: '高密度（屏内 ~1800 事件）' },
  ];
  const rows = [];
  for (const c of CASES) {
    await evalJs(seedSource(c.n, c.spacing));
    await sleep(800);
    const res = await evalJs(measureSource(20));
    if (res.error) throw new Error(res.error);
    const g = gapStats(res.snap.gaps);
    const per = {
      ...c,
      ops: res.snap.ops / 20,
      canvasMs: res.snap.ns / 20 / 1000,
      drawFrames: res.snap.drawFrames,
      gap: g,
      roundRect: (res.snap.byName.roundRect || 0) / 20,
      fillRect: (res.snap.byName.fillRect || 0) / 20,
      fillText: (res.snap.byName.fillText || 0) / 20,
      pps: res.view ? Math.round(res.view.pps) : -1,
      rowH: res.view ? +res.view.rowH.toFixed(1) : -1,
    };
    rows.push(per);
    console.log(
      `  ${per.label.padEnd(22)} n=${String(c.n).padStart(4)}  ops/帧=${per.ops.toFixed(0).padStart(6)}` +
        `  帧间隔 中位${g.p50.toFixed(1)}/p95 ${g.p95.toFixed(1)}/峰 ${g.max.toFixed(1)}ms` +
        `  超帧=${g.over16}/${g.n}` +
        `  roundRect=${per.roundRect.toFixed(0).padStart(5)}` +
        `  fillRect=${per.fillRect.toFixed(0).padStart(5)}`,
    );
  }

  /* ═══ 第 2 层：CPU 采样点名热点 ═══ */
  console.log('');
  console.log('=== CPU 采样：谁在烧主线程（自耗时 Top）===');
  for (const sc of SCENARIOS) {
    // 高密度 take，让各场景都处在有压力的状态
    await evalJs(seedSource(4000, 0.008));
    await sleep(800);
    try {
      await cupProfile(evalJs, scenarioWrapper(sc.body), sc.name);
    } catch (e) {
      console.log(`  [profile] ${sc.name}：跳过（${e.message.slice(0, 80)}）`);
    }
    console.log('');
  }

  console.log('=== 判定 ===');
  const dense = rows[rows.length - 1];
  console.log(`  高密度下 ops/帧 = ${dense.ops.toFixed(0)}（一帧预算 16.7ms 内画完这些指令）`);
  console.log(
    `  重绘帧间隔：中位 ${dense.gap.p50.toFixed(1)}ms / p95 ${dense.gap.p95.toFixed(1)}ms` +
      ` / 峰 ${dense.gap.max.toFixed(1)}ms / 超 16.7ms 的占 ${dense.gap.over16}/${dense.gap.n}`,
  );
  console.log('  ⭐ ops 是与机器无关的**结构指标** → 优化前后用它对拍（本机负载不影响）。');
  console.log('  ⭐ 帧间隔只用来「排除」（本机负载会污染它），不用来「选优」。');
  console.log('  ⭐ 判定「有没有改善」看 ops 逐项不变 + 帧间隔中位下降；');
  console.log('     像素是否真的没变，由 .workbuddy/tmp/_roll-shot.mjs 的 A/B MD5 负责。');
} catch (e) {
  console.error('探针失败：', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
