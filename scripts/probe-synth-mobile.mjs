/**
 * probe-synth-mobile.mjs —— 复现「手机端电子音一卡一卡」，并定位是谁在阻塞主线程。
 *
 * ## 为什么需要这个探针
 *
 * 桌面不卡、手机卡，这个差异**现有测试全部测不到**：
 *   · vitest 没有 Web Audio；
 *   · `probe-synth.mjs` 用 `OfflineAudioContext` —— 离线渲染**不跑定时器**、
 *     也不存在「主线程被占住」，它量的是「出声了没有、干不干净」。
 *
 * 于是退到最贴近真机的做法：**CDP + 手机视口 + CPU 节流**。
 * `Emulation.setCPUThrottlingRate` 只节流渲染进程主线程（音频线程不受影响），
 * 而手机卡顿的本质恰恰是**主线程在音频缓冲截止期前没干完活**，搬砖的全在主线程。
 *
 * ## 三个决定性量法
 *
 * ① **包裹 `window.setInterval`** —— 引擎只有两个定时器，都在主线程：
 *    `MOD_TICK_MS=16`（tickMod）与 `REAPER_INTERVAL_MS=250`（sweepVoices）。
 *    在**创建引擎之前**装好包装，就能拿到每个回调的 count / 总耗时 / 最大耗时。
 *    **一次回调比它自己的周期还长 → 就是每秒固定几次的「一卡一卡」。**
 *
 * ② **包裹 AudioContext 的 create*** —— 量「一次按键到底造了多少个节点」。
 *    这是手机端最贵的动作：每个节点都要跨线程同步到音频线程。桌面看不出来，
 *    手机上一次按键可能就吃掉一整帧。
 *
 * ③ **帧间隔只在「演奏窗口」内统计** —— 否则最大值会被模块加载/首屏渲染
 *    污染成几百毫秒到两秒，看不出演奏时的真实抖动。
 *
 * ## 用法
 *
 *   npx vite --port 5199 --strictPort &        # 先起 dev server
 *   node scripts/probe-synth-mobile.mjs 5199
 *
 * ⛔ 跑之前 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`（本机代理会接走 loopback）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_IMPORT_BOOTSTRAP } from './_app-import.mjs';

const PORT = Number(process.argv[2] ?? 5199);
const ALL_ENGINES = ['classic', 'wavetable', 'additive', 'fm', 'string', 'granular', 'noise'];

const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge 可执行文件');
  process.exit(2);
}

const CDP_PORT = 9500 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'pmo-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=900,500',
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
    /* 等 Chrome 起来 */
  }
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) {
  chrome.kill();
  console.error('Chrome 的 CDP 端口没起来');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const pageExceptions = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    pageExceptions.push(
      m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
    );
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

await send('Page.enable');
await send('Runtime.enable');

/* ── 手机视口：横屏 844×390（用户说的「铺满横屏刚好 21 键」就是这个朝向） ── */
await send('Emulation.setDeviceMetricsOverride', {
  width: 844,
  height: 390,
  deviceScaleFactor: 3,
  mobile: true,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const MEASURE = `(async () => {
  const OUT = { ok: false };
  const ENGINES = ${JSON.stringify(ALL_ENGINES)};
  const FACTORIES = ['createGain','createOscillator','createBiquadFilter','createStereoPanner',
    'createBufferSource','createWaveShaper','createConvolver','createDelay','createConstantSource',
    'createPeriodicWave','createAnalyser','createDynamicsCompressor','createChannelMerger',
    'createChannelSplitter','createIIRFilter'];
  const proto = window.BaseAudioContext ? BaseAudioContext.prototype : AudioContext.prototype;

  /* ① 计数器装在原型上 —— 必须在引擎创建之前。引擎常驻单例，晚了就漏掉首建。 */
  const nodeCounts = Object.create(null);
  let counting = false;
  for (const f of FACTORIES) {
    const orig = proto[f];
    if (typeof orig !== 'function') continue;
    nodeCounts[f] = 0;
    proto[f] = function (...a) {
      if (counting) nodeCounts[f]++;
      return orig.apply(this, a);
    };
  }
  const countsSnapshot = () => ({ ...nodeCounts });
  const diff = (a, b) => {
    const o = {};
    for (const k of Object.keys(a)) if (b[k] - a[k] > 0) o[k] = b[k] - a[k];
    return o;
  };
  const total = (o) => Object.values(o).reduce((p, c) => p + c, 0);

  /* ② 定时器耗时 */
  const timerStats = {};
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = function (fn, ms) {
    const key = String(ms);
    const st = timerStats[key] ?? (timerStats[key] = { count: 0, totalMs: 0, maxMs: 0 });
    const wrapped = function (...a) {
      const t0 = performance.now();
      try {
        return fn.apply(this, a);
      } finally {
        const dt = performance.now() - t0;
        st.count++;
        st.totalMs += dt;
        if (dt > st.maxMs) st.maxMs = dt;
      }
    };
    return realSetInterval(wrapped, ms);
  };

  /* ③ 长任务 */
  const longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {
    OUT.longTaskUnsupported = String(e && e.message);
  }

  /* ④ 帧间隔：先挂上，但**只在演奏窗口内采样** —— 见文件头 ③ */
  let rafOn = false;
  const rafGaps = [];
  let last = performance.now();
  (function loop() {
    const now = performance.now();
    if (rafOn) rafGaps.push(now - last);
    last = now;
    requestAnimationFrame(loop);
  })();

  /* ── 引擎首建 ── */
  const idx = await window.__appImport('/src/engine/synth/index.ts');
  const core = await window.__appImport('/src/engine/core.ts');
  const ctx = core.getAudioContext();
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch (e) {}
  }
  const tA = ctx.currentTime;
  await new Promise((r) => setTimeout(r, 400));
  OUT.ctx = {
    state: ctx.state,
    sampleRate: ctx.sampleRate,
    baseLatency: ctx.baseLatency ?? null,
    clockAdvancedMs: Math.round((ctx.currentTime - tA) * 1000),
  };
  OUT.ok = OUT.ctx.state === 'running' && OUT.ctx.clockAdvancedMs > 200;
  OUT.defaultEngineType = idx.DEFAULT_SYNTH_PATCH.engineType;

  counting = true;
  const c0 = countsSnapshot();
  const tBuild0 = performance.now();
  idx.loadSynthPatch({ ...idx.DEFAULT_SYNTH_PATCH });
  idx.ensureSynthReady();          // 建引擎 + 混响 IR + 主链
  const buildMs = performance.now() - tBuild0;
  const buildNodes = diff(c0, countsSnapshot());

  await new Promise((r) => setTimeout(r, 300));

  /* ── 稳态：16 次单音，每次量「耗时 + 造了多少节点」 ── */
  rafOn = true;
  const noteMs = [];
  const noteNodes = [];
  for (let i = 0; i < 16; i++) {
    const midi = 76 - i * 2;
    const ca = countsSnapshot();
    const t0 = performance.now();
    idx.playSynthNote(midi, { durationSec: 0.35, velocity: 0.85 });
    noteMs.push(performance.now() - t0);
    noteNodes.push(total(diff(ca, countsSnapshot())));
    await new Promise((r) => setTimeout(r, 90));
  }

  /* ── 叠音：6 个音同时按下，手机最能顶穿的场景 ── */
  const chordMidis = [60, 64, 67, 71, 74, 77];
  const chordMs = [];
  for (const midi of chordMidis) {
    const t0 = performance.now();
    idx.playSynthNote(midi, { durationSec: 0.6, velocity: 0.9 });
    chordMs.push(performance.now() - t0);
  }
  OUT.maxLiveDuringChord = idx.getSynthActiveVoices();
  await new Promise((r) => setTimeout(r, 1200));
  rafOn = false;

  /* ── 换音色（面板「切预设 / 换引擎」的那条路） ── */
  const perEngine = [];
  for (const et of ENGINES) {
    const ca = countsSnapshot();
    const t0 = performance.now();
    idx.loadSynthPatch({ ...idx.DEFAULT_SYNTH_PATCH, engineType: et });
    const patchMs = performance.now() - t0;
    const nodes = total(diff(ca, countsSnapshot()));
    const t1 = performance.now();
    idx.playSynthNote(69, { durationSec: 0.3, velocity: 0.85 });
    const firstMs = performance.now() - t1;
    await new Promise((r) => setTimeout(r, 260));
    perEngine.push({ et, patchMs: +patchMs.toFixed(2), patchNodes: nodes, firstNoteMs: +firstMs.toFixed(2) });
    idx.releaseAllSynthNotes();
    await new Promise((r) => setTimeout(r, 420));
  }

  /* ── setPatch 分摊：面板「120ms 尾随落库」与「切预设」到底贵在哪 ──
        预期（也是要证伪的）：setPatch 对全部 117 个键**无条件**调 writeParam，
        没有「值没变就跳过」；而 applyParam（拖动路径）有早退。
        若「全等的一份 patch」也要百毫秒级，那成本就全在这个全量循环上。 */
  const base = { ...idx.getSynthPatch() };
  const tS0 = performance.now();
  idx.setSynthPatch({ ...base });
  const sameMs = performance.now() - tS0;

  const tO0 = performance.now();
  idx.setSynthPatch({ ...base, filterCutoff: Number(base.filterCutoff) * 1.01 });
  const oneMs = performance.now() - tO0;

  const tD0 = performance.now();
  idx.updateSynthParam('filterCutoff', Number(base.filterCutoff) * 1.02);
  const dragMs = performance.now() - tD0;

  /* 再拧一次「同一个值」：拖动路径应当直接早退 */
  const fixed = Number(idx.getSynthPatch().filterCutoff);
  const tD1 = performance.now();
  idx.updateSynthParam('filterCutoff', fixed);
  const noopMs = performance.now() - tD1;

  const setPatchCost = {
    identicalMs: +sameMs.toFixed(2),
    oneParamMs: +oneMs.toFixed(2),
    dragOneParamMs: +dragMs.toFixed(2),
    dragSameValueMs: +noopMs.toFixed(3),
  };
  idx.setSynthPatch({ ...base });

  /* ── 排空：等到 live 归零，顺带当泄漏判据 ── */
  const drainT0 = performance.now();
  let drained = false;
  for (let i = 0; i < 60; i++) {
    const st = idx.getSynthVoiceStats();
    if (st.live === 0 && st.dying === 0) { drained = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  OUT.drainMs = Math.round(performance.now() - drainT0);
  OUT.drained = drained;
  OUT.voiceStats = idx.getSynthVoiceStats();
  counting = false;

  const stat = (a) => {
    if (!a.length) return { n: 0, mean: 0, max: 0, p95: 0 };
    const s = [...a].sort((x, y) => x - y);
    return {
      n: s.length,
      mean: +(s.reduce((p, c) => p + c, 0) / s.length).toFixed(2),
      max: +s[s.length - 1].toFixed(2),
      p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(2),
    };
  };

  const timers = {};
  for (const k of Object.keys(timerStats)) {
    const s = timerStats[k];
    timers[k] = {
      count: s.count,
      totalMs: +s.totalMs.toFixed(2),
      maxMs: +s.maxMs.toFixed(3),
      meanMs: s.count ? +(s.totalMs / s.count).toFixed(3) : 0,
    };
  }

  return {
    ...OUT,
    buildMs: +buildMs.toFixed(2),
    buildNodes,
    buildNodeTotal: total(buildNodes),
    timerMs: timers,
    longTask: { ...stat(longTasks), totalMs: +longTasks.reduce((p, c) => p + c, 0).toFixed(1) },
    rafGapMs: { ...stat(rafGaps), over16: rafGaps.filter((g) => g > 16.7).length, over32: rafGaps.filter((g) => g > 32).length },
    noteCallMs: stat(noteMs),
    noteNodeCount: stat(noteNodes),
    chordCallMs: stat(chordMs),
    perEngine,
    setPatchCost,
  };
})()`;

/* ── 一个倍率跑一轮；每轮重新加载页面，避免上一轮声部与定时器串味 ── */
async function bench(rate) {
  await send('Emulation.setCPUThrottlingRate', { rate });
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  await sleep(3200);
  await ev(APP_IMPORT_BOOTSTRAP);
  pageExceptions.length = 0;
  const r = await ev(MEASURE);
  r.rate = rate;
  r.exceptions = [...pageExceptions];
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return r;
}

const runs = [];
for (const rate of [1, 4, 6, 8]) {
  process.stdout.write(`CPU 节流 ${rate}x … `);
  const r = await bench(rate);
  runs.push(r);
  console.log(r.ok ? 'ok' : '⚠ 音频上下文没起来');
}

ws.close();
chrome.kill();

/* ───────────────────────────── 报告 ───────────────────────────── */

const pad = (s, n) => String(s).padEnd(n);
const ctx0 = runs[0].ctx;

console.log('');
console.log('=== 环境 ===');
console.log(
  `  视口 844×390 @3x · AudioContext ${ctx0.state} · ${ctx0.sampleRate}Hz · ` +
    `baseLatency ${ctx0.baseLatency == null ? 'n/a' : (ctx0.baseLatency * 1000).toFixed(1) + 'ms'}`,
);
console.log(`  默认音色引擎 engineType = ${runs[0].defaultEngineType}`);

console.log('');
console.log('=== 每一次按键：主线程阻塞多久 / 造多少个音频节点 ===');
console.log('  ' + pad('倍率', 6) + pad('单音 耗时 均值/最大', 22) + pad('单音 节点数', 14) + '叠音6个 均值/最大');
for (const r of runs) {
  console.log(
    '  ' +
      pad(r.rate + 'x', 6) +
      pad(`${r.noteCallMs.mean}/${r.noteCallMs.max}ms`, 22) +
      pad(`${r.noteNodeCount.mean} 个`, 14) +
      `${r.chordCallMs.mean}/${r.chordCallMs.max}ms`,
  );
}

console.log('');
console.log('=== 演奏窗口内的帧间隔（「一卡一卡」的直接来源，一帧预算 16.7ms） ===');
console.log('  ' + pad('倍率', 6) + pad('均值', 10) + pad('p95', 10) + pad('最大', 10) + pad('超 1 帧', 10) + '超 2 帧');
for (const r of runs) {
  const f = r.rafGapMs;
  console.log(
    '  ' + pad(r.rate + 'x', 6) + pad(f.mean + 'ms', 10) + pad(f.p95 + 'ms', 10) + pad(f.max + 'ms', 10) +
      pad(f.over16, 10) + f.over32,
  );
}

console.log('');
console.log('=== 引擎定时器回调耗时 ===');
console.log('  ' + pad('倍率', 6) + pad('16ms 节拍', 18) + pad('其中最大', 12) + pad('250ms 清扫', 18) + '其中最大');
for (const r of runs) {
  const a = r.timerMs['16'] ?? { count: 0, totalMs: 0, maxMs: 0 };
  const b = r.timerMs['250'] ?? { count: 0, totalMs: 0, maxMs: 0 };
  console.log(
    '  ' + pad(r.rate + 'x', 6) + pad(`${a.count} 次/${a.totalMs}ms`, 18) + pad(`${a.maxMs}ms`, 12) +
      pad(`${b.count} 次/${b.totalMs}ms`, 18) + `${b.maxMs}ms`,
  );
}

console.log('');
console.log('=== 引擎首建成本（进入「电子音」/ 首次发声那一下） ===');
console.log('  ' + pad('倍率', 6) + pad('建图耗时', 12) + pad('造节点数', 12) + '长任务 次数/总计');
for (const r of runs) {
  console.log(
    '  ' + pad(r.rate + 'x', 6) + pad(r.buildMs + 'ms', 12) + pad(r.buildNodeTotal + ' 个', 12) +
      `${r.longTask.n} 次 / ${r.longTask.totalMs}ms`,
  );
}

console.log('');
console.log('=== 七个引擎：换音色成本 / 换完第一个音的成本 ===');
console.log('  ' + pad('倍率', 6) + pad('引擎', 12) + pad('换音色', 12) + pad('造节点', 10) + '随后第一个音');
for (const r of runs) {
  for (const e of r.perEngine) {
    console.log(
      '  ' + pad(r.rate + 'x', 6) + pad(e.et, 12) + pad(e.patchMs + 'ms', 12) +
        pad(e.patchNodes + ' 个', 10) + e.firstNoteMs + 'ms',
    );
  }
}

console.log('');
console.log('=== setPatch 分摊（面板 120ms 尾随落库 / 切预设走的就是这条路） ===');
console.log('  ' + pad('倍率', 6) + pad('全等 patch', 14) + pad('只改 1 个参数', 16) + pad('拖动 1 个参数', 16) + '拖动同一值');
for (const r of runs) {
  const s = r.setPatchCost;
  console.log(
    '  ' + pad(r.rate + 'x', 6) + pad(s.identicalMs + 'ms', 14) + pad(s.oneParamMs + 'ms', 16) +
      pad(s.dragOneParamMs + 'ms', 16) + s.dragSameValueMs + 'ms',
  );
}

console.log('');
console.log('=== 声部账目（created 应等于 disposed，live/dying 应收敛到 0） ===');
for (const r of runs) {
  const v = r.voiceStats;
  const bad = v.created !== v.disposed || !r.drained;
  console.log(
    `  ${pad(r.rate + 'x', 5)} live=${v.live} dying=${v.dying} created=${v.created} disposed=${v.disposed}` +
      `   排空 ${r.drainMs}ms ${r.drained ? '✓' : '⛔ 没归零'}` +
      `   叠音时同时在响 ${r.maxLiveDuringChord} 个${bad ? '  ⚠' : ''}`,
  );
}

const bad = runs.flatMap((r) => r.exceptions ?? []);
if (bad.length) {
  console.log('');
  console.log('=== 页面异常 ===');
  for (const b of bad.slice(0, 6)) console.log('  ' + String(b).split('\\n')[0]);
}

/* ── 判据：盯「6x（≈中端手机）下的一次按键是否吃掉一帧」 ── */
const mid = runs.find((r) => r.rate === 6) ?? runs[runs.length - 1];
const tick = mid.timerMs['16'] ?? { maxMs: 0 };
const sweep = mid.timerMs['250'] ?? { maxMs: 0 };
const oneFrame = 1000 / 60;
console.log('');
console.log(`=== 判据（以 ${mid.rate}x ≈ 中端手机为准，一帧 ${oneFrame.toFixed(1)}ms） ===`);
const rows = [
  [`单次按键耗时 ${mid.noteCallMs.mean}ms`, mid.noteCallMs.mean < oneFrame, `一帧预算 ${oneFrame.toFixed(1)}ms`],
  [`叠音单次按键 ${mid.chordCallMs.max}ms`, mid.chordCallMs.max < oneFrame, '和弦里第一下最容易爆'],
  [`面板落库 setPatch 全等 ${mid.setPatchCost.identicalMs}ms`, mid.setPatchCost.identicalMs < oneFrame, '值没变也在全量重写'],
  [`帧间隔超 2 帧 ${mid.rafGapMs.over32} 次`, mid.rafGapMs.over32 <= 2, '演奏窗口内'],
  [`16ms 节拍最大 ${tick.maxMs}ms`, tick.maxMs <= 16, '超过周期=每秒 60 次级抖动'],
  [`250ms 清扫最大 ${sweep.maxMs}ms`, sweep.maxMs <= 50, '超过 50ms=每秒 4 次顿挫'],
  [`声部归零 ${mid.voiceStats.created - mid.voiceStats.disposed} 个未回收`, mid.drained, '泄漏判据'],
];
for (const [label, ok, note] of rows) {
  console.log(`  ${ok ? '✓' : '⛔'} ${label}${note ? '   （' + note + '）' : ''}`);
}

process.exit(0);
