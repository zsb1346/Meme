/**
 * probe-play-perf.mjs —— 「弹奏时」的**实机**验收：有没有声、卡不卡、时间花在哪。
 *
 * 用法：
 *   node scripts/probe-play-perf.mjs [port] [--headed]
 *
 * ══ 为什么必须有这个探针 ══
 *
 * 用户原话：「弹奏时候声音性能问题 …… 会在某些情况下导致无声、导致卡顿、
 * 性能利用不充分」。这三条全部落在**真实浏览器 + 真实事件 + 真实 Web Audio**
 * 的接缝上，单测一条都够不着：
 *
 *   · vitest 没有 Web Audio —— `playSample` / `transformBuffer` 在 node 里是
 *     盲区，能"过"只能说明 import 没写错；
 *   · 无声不是异常，是一条**正常的返回值**（`triggered: false` → toast 一句
 *     「素材还没加载好」）。没有任何地方会报错，日志里也看不到。
 *   · 卡顿是**主线程阻塞**，只有 `longtask`（>50ms 的任务）才看得见。
 *
 * ══ 三条绝对量判据（不是相对比较，也不需要"改前"基线）══
 *
 *   ① **每次按下都必须起一个 buffer source**。按键数 N → `createBufferSource`
 *      的计数增量必须 == N。这条是**绝对量**：输出的零点就是"完全没声"，
 *      不需要跟任何版本比。用户报的「某些情况下无声」正落在这里。
 *   ② **每次按下的「事件 → 排进缓冲」耗时**（`pointerdown` 捕获相 → 第一个
 *      `start()` 返回）。这是**同步占住主线程**的那一段，也就是用户感觉到的
 *      「按下去半天才响」。p95 超阈值说明又有人在按键路径上算东西。
 *   ③ **弹奏全过程不得出现长任务**（>50ms）。预热（`prewarmKeyTransforms`）
 *      的全部意义就是把整段变调挪到用户动手之前；预热真的生效的话，弹奏期间
 *      主线程应该只有零碎的小任务。
 *
 * ══ 判据②为什么是绝对量而不是"改前 vs 改后" ══
 *
 * 改前每次按键都要**同步**跑完整段变调（实测单次约 300ms），所以判据②在旧代码
 * 上必然爆表 —— 它自带区分度，不需要另跑一份旧版本来对比。Rust 层逐样本的
 * 改前/改后对照在 `scripts/_probe-psola-cache.mjs`（bit-exact，3.6×~70.9×），
 * 这里只管"用户按键那一刻的体感"。
 *
 * ══ 四个本机 / CDP 的坑（都踩过）══
 *
 *   ① profile 绝不落 C:（长期接近满 → Chrome 写 profile 时 ENOSPC）；
 *      必须 `--no-proxy-server`，否则连着环境代理连 localhost 都打不开。
 *   ② 事件必须在**新文档脚本**里埋点（`Page.addScriptToEvaluateOnNewDocument`），
 *      不能在导航后注入 —— 导航后才注入，第一帧的 `createBufferSource`
 *      就已经漏掉了。
 *   ③ 造素材必须走 **store 自己的 `addSampleFromFile`**，不能自己拼
 *      `project.samples` —— 后者绕过解码与 `detectedPitchHz` 回填，探针会变成
 *      在测一个应用里不存在的状态。
 *   ④ 探针 import 模块必须用 `window.__appImport`（见 `_app-import.mjs`）：
 *      裸路径在 HMR 之后会拿到**另一个模块实例**，写进影子 store 还不报错。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_IMPORT_BOOTSTRAP } from './_app-import.mjs';

const PORT = Number(process.argv[2] ?? 5199);
const HEADED = process.argv.includes('--headed');
const URL_BASE = `http://127.0.0.1:${PORT}/`;

/** 预热后单次按键的同步耗时上限（ms）。超了说明主线程上又有人在算东西。 */
const PRESS_LATENCY_BUDGET_MS = 50;
/** 弹奏过程中允许出现的长任务条数（>50ms 的任务）。 */
const LONG_TASK_BUDGET = 0;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 结果账本 ───────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

/** 分位数（输入未排序，不改原数组） */
function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const r1 = (x) => Math.round(x * 10) / 10;

// ── CDP 最小客户端 ─────────────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** CDP 事件订阅（`Runtime.exceptionThrown` 等），与请求应答分开走 */
    this.onEvent = () => {};
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) {
        if (msg.method) this.onEvent(msg);
        return;
      }
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
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
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
  async eval(fnBody, ...args) {
    const expression = `(${fnBody})(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return this.raw(expression);
  }
  async raw(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description ?? ''));
    }
    return r.result.value;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 新文档脚本：必须在**任何应用代码之前**装上埋点
// ═══════════════════════════════════════════════════════════════════════════
const INSTRUMENT = `(() => {
  const S = { creates: 0, starts: 0, startsAt: [], pressAt: [], longTasks: [], lastPress: null, wasmTx: 0, wasmTxLog: [] };

  /* ⓪ wasm 变换调用计数 —— **精确**的"到底算了几次"。
     变换结果缓存在 transformBuffer 里命中就直接返回，**不会调到 wasm**，
     所以这个计数 == 真正跑过的整段 PSOLA 次数。
     ⛔ 不要用「耗时短」来推断缓存命中：prewarmKeyTransforms 每条之间都有一次
        yieldToMain（setTimeout 0），12 条光是让出主线程就几十毫秒，
        就算全部命中也会量出几十毫秒 —— 拿它当判据必然误判。 */
  /*
    ⛔ 不能直接给 instance.exports.hajimi_tx_run 赋值。
      WebAssembly 的 exports 属性是**只读**的，而 ESM 是严格模式，
      赋值会抛 TypeError（而不是静默失败），于是被下面的 catch 吞掉 ——
      计数恒为 0，所有「wasm 调用 == 0」的断言**全部假绿**。
      （这正是"永远为假的守卫 = 谎言"那一类坑：探针绿得可疑，比红更危险。）
    所以这里**换掉整个 exports 对象**：复制一份、把要计数的那个键包一层，
    再把 instance 换成持有新 exports 的普通对象交回调用方。
  */
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...a) {
    return Promise.resolve(origInstantiate.apply(this, a)).then((res) => {
      try {
        const ex = res && res.instance ? res.instance.exports : res && res.exports;
        if (!ex || typeof ex.hajimi_tx_run !== 'function') {
          S.wasmPatchError = 'exports 里没有 hajimi_tx_run';
          return res;
        }
        const orig = ex.hajimi_tx_run;
        const wrapped = {};
        for (const k of Object.keys(ex)) wrapped[k] = ex[k];
        wrapped.hajimi_tx_run = function (...b) {
          /* ABI：hajimi_tx_run(ptr, frames, ch, pitch, time, mode, sampleRate) */
          S.wasmTx++;
          S.wasmTxLog.push({ t: performance.now(), mode: b[5], pitch: b[3] });
          return orig.apply(null, b);
        };
        if (res && res.instance) {
          return { instance: { exports: wrapped }, module: res.module };
        }
        return { exports: wrapped, module: res.module };
      } catch (err) {
        S.wasmPatchError = String(err && err.message);
        return res;
      }
    });
  };

  /* ① 发声计数：createBufferSource().start()。
     走原生原型（不是 Tone 的封装）—— 无论上层怎么调度，真正排进输出缓冲的
     只有这一个入口。计数 == 0 就是用户说的「完全没声」。 */
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const proto = AC.prototype;
    const origCreate = proto.createBufferSource;
    proto.createBufferSource = function (...a) {
      const node = origCreate.apply(this, a);
      S.creates++;
      const origStart = node.start;
      node.start = function (...b) {
        S.starts++;
        /* ⭐ 带上「这次 start 是哪次按下引起的」。
           不带 key 的话，只要有一键没发声，按下序列与 start 序列就会**错位**：
           后面每一条的耗时都算给了别人，readout 变成一串看着像"偶发卡顿"的
           87ms，实际是错位后的垃圾。 */
        S.startsAt.push({
          t: performance.now(),
          when: typeof b[0] === 'number' ? b[0] : null,
          key: S.lastPress ? S.lastPress.i : null,
        });
        return origStart.apply(this, b);
      };
      return node;
    };
  }

  /* ② 按下时刻：window 捕获相 → 早于 React 的 onPointerDown */
  window.addEventListener(
    'pointerdown',
    (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-key-index]') : null;
      if (el) {
        S.lastPress = { i: Number(el.dataset.keyIndex), t: performance.now() };
        S.pressAt.push(S.lastPress);
      }
    },
    true,
  );

  /* ③ 长任务：>50ms 的主线程占用 */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        S.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration), n: e.name });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (err) {
    S.longTaskUnsupported = String(err && err.message);
  }

  window.__playPerf = S;
  /** 复位计数器：每个场景单独统计 */
  window.__playPerfReset = () => {
    S.creates = 0; S.starts = 0; S.startsAt = []; S.pressAt = []; S.longTasks = [];
    S.lastPress = null; S.wasmTx = 0; S.wasmTxLog = [];
  };
  return true;
})()`;

/** 页面侧 WAV 编码：造一段指定基频的谐波音（16-bit PCM） */
const JS_MAKE_WAV = `(sec, f0, nHarm) => {
  const sr = 48000;
  const n = Math.round(sec * sr);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= nHarm; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / sr) / h;
    v = Math.tanh(v * 0.8) * 0.7;
    /* 首尾各 5ms 淡入淡出，免得素材本身带爆音 —— 探针要量的是引擎，不是波形 */
    const edge = Math.min(i, n - 1 - i) / (0.005 * sr);
    v *= Math.min(1, edge);
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}`;

/**
 * 造素材 + 造一个 Take 铺到 12 个键上。
 *
 * ⛔ 必须落到 **Take 事件**上，不能落到 `project.keys[i].sequence`。
 *    演奏台的键是 `buildTakeKeys(project, selectedTake)` —— 一声源规则下
 *    **Take.events 才是唯一声源**，全局 `Key.sequence` 早已退役为纯展示镜像。
 *    写进 keys 的探针会得到一个「键看起来装满了、按下去一点声都没有」的现场，
 *    然后把它当成产品 bug。
 *
 * @param events [{ keyIndex, pitch, sampleKey, tSec }]
 * @param tones  [{ f0, sec }] —— sampleKey 指向其中一条
 */
const JS_SEED = `async (plan) => {
  const sm = await window.__appImport('/src/model/store.ts');
  const S = sm.useStore;

  /* ① 造素材。同一 f0 只造一份 —— 这正是「一条素材装到多个键」的真实用法，
        也是分析结果复用（Rust 侧按内容指纹缓存）真正要覆盖的形态。 */
  const ids = {};
  for (const t of plan.tones) {
    const blob = (${JS_MAKE_WAV})(t.sec, t.f0, 6);
    const file = new File([blob], 'probe-' + t.f0 + '.wav', { type: 'audio/wav' });
    const res = await S.getState().addSampleFromFile(file);
    /* 返回的是 AddSampleResult（{ ok, sampleId, error? }），不是素材对象本身 */
    if (!res || !res.ok || !res.sampleId) {
      throw new Error('addSampleFromFile 失败：' + JSON.stringify(res));
    }
    /* ⛔ detectedPitchHz 一律显式写死。
       交给 YIN 自动检测的话，检测值随波形而变 → 变调量不确定 → 探针变成在测
       另一个东西。这里写死成造波时的基频，于是「目标音高 - 基频」就是精确的变调量。 */
    S.getState().updateSample(res.sampleId, {
      detectedPitchHz: t.f0,
      manualSemitoneOffset: 0,
    });
    ids[t.key] = res.sampleId;
  }

  /* ② 造 Take 并替换 takes —— StagePage 的 effect 会把 selectedTakeId
        自动切到 takes[0]（无需探针去够页面私有 state）。 */
  const take = sm.createEmptyTake('弹奏性能');
  take.events = plan.events.map((e) => ({
    keyIndex: e.keyIndex,
    pressCount: 1,
    tSec: e.tSec,
    pitch: e.pitch,
    duration: 0.35,
    velocity: 0.9,
    sampleId: ids[e.sampleKey],
  }));
  take.durationSec = plan.events.length + 1;
  const st0 = S.getState();
  S.setState({ project: { ...st0.project, takes: [take] } });

  const st = S.getState().project;
  return {
    samples: st.samples.length,
    takes: st.takes.length,
    events: st.takes[0] ? st.takes[0].events.length : 0,
    sampleIds: Object.keys(ids).length,
  };
}`;

/**
 * 诊断：指示灯说「就绪」的那一刻，到底还剩多少变换没算。
 *
 * 这是唯一能证伪「就绪」这个说法的东西。为了不污染后面几轮的读数，
 * 这一诊断放在 S1 之前**只跑一次**，跑完就等于把所有键都热好了。
 *
 * ⚠️ 它数的是「**第二次**预热还需要跑到 wasm 几次」。
 *    如果预热是**确定性地**漏掉一部分（比如"只预热一半"那种 bug），
 *    第二次照样漏 → 这条读到 0，看起来没问题。
 *    真正的守卫是 S1 的判据④（弹 12 个键引起几次 wasm 调用）——
 *    它测的是「用户按下那一刻到底重算了几次」，漏掉多少就报多少。
 *    这条只当辅助信号，别单独信它。
 */
const JS_DIAG_PREWARM = `async () => {
  const km = await window.__appImport('/src/engine/key-machine-singleton.ts');
  const bc = await window.__appImport('/src/model/buffer-cache-service.ts');
  const rs = await window.__appImport('/src/engine/rush/transform.ts');
  const ex = await window.__appImport('/src/engine/external-shift.ts');
  const kmach = km.getKeyMachine();
  const keys = kmach && kmach.cfg ? kmach.cfg.keys : null;
  if (!keys) return { error: '拿不到 KeyMachine.cfg.keys（私有字段被改名了？）' };
  const refs = keys.reduce((n, k) => n + (k.sequence ? k.sequence.length : 0), 0);
  /* 只数 wasm 调用：缓存命中的那些**不会**调到 wasm，所以这个数就是
     "指示灯亮着的时候还剩几条真没算"。 */
  window.__playPerf.wasmTx = 0;
  window.__playPerf.wasmTxLog = [];
  const t0 = performance.now();
  const rep = await bc.prewarmKeyTransforms(keys, { budgetMs: 30000 });
  return {
    keys: keys.length,
    refs,
    rushReady: rs.isRushReady(),
    activeShift: ex.getActiveShift() ? String(ex.getActiveShift()) : null,
    ms: Math.round(performance.now() - t0),
    warmed: rep.warmed,
    skipped: rep.skipped,
    total: rep.total,
    timedOut: rep.timedOut,
    stillUncomputed: window.__playPerf.wasmTx,
  };
}`;

/**
 * 埋点自检：用**一个必定没被算过**的音高比跑一次 `transformBuffer`，
 * 看计数会不会动。
 *
 * ⛔ 为什么必须有：这套埋点是整个探针里唯一能"精确说有没有重算"的东西，
 *    而它一旦失效，所有 `wasm 调用 == 0` 的断言都会**静默变成永远为真**。
 *    实测就栽过一次 —— 给 `instance.exports.hajimi_tx_run` 赋值在严格模式下
 *    抛异常被吞掉，计数恒 0，13 项全绿而实际上什么都没测到。
 *    自检不过就直接判失败，绝不让探针绿得可疑。
 */
const JS_WASM_PROBE = `async (ratio) => {
  const rs = await window.__appImport('/src/engine/rush/transform.ts');
  /* ⛔ 必须先等 WASM 加载完。这一步早于应用自己的预热，直接调会拿到
     「WASM 未加载即调用 transformBuffer」，计数当然是 0 ——
     自检会把自己的时序问题报成"埋点坏了"。 */
  await rs.ensureRushLoaded();
  const octx = new OfflineAudioContext(1, 48000, 48000);
  const buf = octx.createBuffer(1, 24000, 48000);
  const d = buf.getChannelData(0);
  /* 周期信号：PSOLA 有东西可同步，不会触发"静默空转"那条降级路径 */
  for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  window.__playPerf.wasmTx = 0;
  let err = null;
  try { rs.transformBuffer(octx, buf, ratio, 1.0, 1); } catch (e) { err = String(e && e.message); }
  return { calls: window.__playPerf.wasmTx, err, patchError: window.__playPerf.wasmPatchError ?? null };
}`;

/** 读一次埋点账本（时间四舍五入到 10µs，够分辨又不会被浮点噪声撑爆） */
const JS_READ = `() => {
  const S = window.__playPerf;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    creates: S.creates,
    starts: S.starts,
    wasmTx: S.wasmTx,
    wasmPatchError: S.wasmPatchError ?? null,
    startsAt: S.startsAt.map((x) => ({ t: r2(x.t), key: x.key })),
    pressAt: S.pressAt.map((x) => ({ i: x.i, t: r2(x.t) })),
    longTasks: S.longTasks.slice(),
    longTaskUnsupported: S.longTaskUnsupported ?? null,
  };
}`;

/** 预热指示灯：「就绪」= prewarmReady；文案在 StagePage 的 PageBar status 里 */
const JS_READY = `() => document.body.innerText.includes('音色已就绪')`;
/** 预热中 —— 新一轮预热开始后指示灯必须先回到这个状态 */
const JS_WARMING = `() => document.body.innerText.includes('音色预热中')`;

/** 指示灯当前状态：'ready' | 'warming' | 'none'（没装声音时整块不渲染） */
const JS_INDICATOR = `() => {
  const t = document.body.innerText;
  if (t.includes('音色已就绪')) return 'ready';
  if (t.includes('音色预热中')) return 'warming';
  return 'none';
}`;

/**
 * 连续采样指示灯，返回状态切换序列 `[{t, s}]`。
 * 状态切换之间没有任何 await 之外的间隙 —— 预热往往只有几十毫秒，
 * 靠「等一会儿再问一次」是采不到的，而采不到就会误判成「指示灯没复位」。
 */
async function trackIndicator(cdp, prev, timeoutMs) {
  const t0 = Date.now();
  let last = prev ?? null;
  const seq = [];
  while (Date.now() - t0 < timeoutMs) {
    let s = null;
    try { s = await cdp.eval(JS_INDICATOR); } catch { /* 上下文切换 */ }
    if (s && s !== last) {
      seq.push({ t: Date.now() - t0, s });
      last = s;
      if (s === 'ready' && seq.some((x) => x.s === 'warming')) break;
      if (s === 'ready' && seq.length > 2) break;
    }
    await sleep(25);
  }
  return seq;
}

async function waitFor(cdp, jsBody, timeoutMs = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cdp.eval(jsBody)) return true;
    } catch {
      /* 上下文还没就绪 */
    }
    await sleep(step);
  }
  return false;
}

/** 按一下某个键（按下 → 停留 → 抬起），返回本次账本 */
async function pressKey(cdp, rect, holdMs = 60) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await sleep(holdMs);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

/**
 * 按 **keyIndex** 把按下与 start 配对 → 每次按键的同步耗时（ms）。
 *
 * ⛔ 不许按下标顺序配（`pressAt[i] ↔ startsAt[i]`）。只要有一个键没发声，
 *    后面全体错位，读出来是一串看着很合理的数字，实际全部张冠李戴。
 *    归因靠埋点里记下的 `lastPress.i`。
 *
 * @returns 每次按下一条：`{ key, ms|null }`；`ms === null` = 这一按没有发声
 */
function pairLatencies(snap) {
  const byKey = new Map();
  for (const s of snap.startsAt) {
    if (s.key === null) continue;
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s.t);
  }
  return snap.pressAt.map((p) => {
    const q = byKey.get(p.i);
    return { key: p.i, ms: q && q.length ? r1(q.shift() - p.t) : null };
  });
}

/** 安静键（按下但没发声） */
const silentKeys = (pairs) => pairs.filter((p) => p.ms === null).map((p) => p.key);
/** 有效耗时数组 */
const latencies = (pairs) => pairs.filter((p) => p.ms !== null).map((p) => p.ms);

async function main() {
  const profile = mkdtempSync(join(process.cwd(), '.workbuddy', 'tmp', 'probe-play-'));
  const cdpPort = 9800 + Math.floor(Math.random() * 150);
  const chrome = spawn(
    chromePath,
    [
      HEADED ? '--window-size=1440,900' : '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-proxy-server',
      /* 没有这条 headless 里 AudioContext 永远 suspended → 「无声」全是假的 */
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try { chrome.kill(); } catch { /* ignore */ }
  };

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) throw new Error('CDP 端点超时');

  const cdp = await CDP.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  /* 坑 ②：埋点必须在导航之前 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /* 页面里的异常/警告全部收起来。
     ⛔ 少了这个，「某个键就是不出声」会表现为一条纯数字的读数 —— 而真相
        （`playSample` 抛了、`resolveBuffer` 返回 null、降级链报警）全在页面的
        console 里，看不到就只能靠猜。 */
  const pageLog = [];
  cdp.onEvent = (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageLog.push('EXC ' + (d.exception?.description ?? d.text ?? '').split('\n')[0]);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const kind = msg.params.type;
      if (kind === 'error' || kind === 'warning') {
        pageLog.push(
          kind.toUpperCase() + ' ' +
            msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0],
        );
      }
    }
  };

  const tNav = Date.now();
  await cdp.send('Page.navigate', { url: URL_BASE });

  if (!(await waitFor(cdp, `() => !!document.querySelector('nav button[title="演奏台"]')`, 25000))) {
    throw new Error(`应用没起来（dev server 在 ${PORT} 吗？）`);
  }
  await cdp.raw(APP_IMPORT_BOOTSTRAP);
  await cdp.eval(`() => document.querySelector('nav button[title="演奏台"]').click()`);
  if (!(await waitFor(cdp, `() => document.querySelectorAll('button[data-key-index]').length >= 12`, 25000))) {
    throw new Error('演奏台键区没渲染出 12 个键（工程可能还在水合）');
  }

  const rects = await cdp.eval(`() => {
    const out = {};
    for (const el of document.querySelectorAll('button[data-key-index]')) {
      const r = el.getBoundingClientRect();
      out[Number(el.dataset.keyIndex)] = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return out;
  }`);

  /* ⛔ 目标键必须取自**页面上真实渲染出来的** `data-key-index`，不能自己写 0..11。
     关闭半音键时键区是**白键布局**，下标跳黑键（0,2,4,5,7,9,11,12,14,16,17,19…），
     照 0..11 播种的话 12 个键里只有 7 个真装上了事件 —— 剩下 5 个"没声"是探针
     自己造出来的，却长得跟用户报的 bug 一模一样。 */
  const order = Object.keys(rects).map(Number).sort((a, b) => a - b).slice(0, 12);
  console.log(`\n键区渲染出的前 12 个键下标：${order.join(',')}`);

  /* 播种：3 条素材铺到 12 个键上（每条素材服务 4 个键 = 分析复用的真实形态）。
     ⛔ 变调量偏移里**不许出现 0** —— 0 半音会命中恒等短路（直接逐样本拷贝），
     那一段就变成在量 memcpy，测不出任何东西。 */
  const tones = [
    { key: 'a', f0: 130.81, root: 48, sec: 0.4 },  // C3
    { key: 'b', f0: 174.61, root: 53, sec: 0.4 },  // F3
    { key: 'c', f0: 220.0, root: 57, sec: 0.5 },   // A3
  ];
  const offsets = [2, 3, 4, 5, 7, 9, 11, 12, -2, -3, -5, -7];
  const events = order.map((lane, k) => {
    const t = tones[Math.floor(k / 4) % tones.length];
    return { keyIndex: lane, pitch: t.root + offsets[k], sampleKey: t.key, tSec: 0.1 * k };
  });
  /* ⭐ 先证明埋点活着，再让它去判断别的东西。顺序不能反。 */
  const wire = await cdp.eval(JS_WASM_PROBE, 1.4242);
  console.log(
    `\n埋点自检：强制造一次未缓存变换 → wasm 计数 ${wire.calls}` +
      `${wire.err ? `（变换抛了：${wire.err}）` : ''}${wire.patchError ? `（埋点错误：${wire.patchError}）` : ''}`,
  );
  check(
    'wasm 变换计数埋点是活的（否则后面所有「0 次」都是假绿）',
    wire.calls >= 1,
    `强制造一次变换后计数仍是 ${wire.calls}${wire.patchError ? `：${wire.patchError}` : ''} —— 埋点没接上，读数不可信`,
  );

  const seeded = await cdp.eval(JS_SEED, { tones, events });
  console.log(
    `播种：${seeded.sampleIds} 条素材 / ${seeded.takes} 个 Take / ${seeded.events} 个事件 → 12 个键`,
  );

  /*
    ⛔ 播完种必须**让演奏台重新挂载**，不能在原地等预热自己重跑。

    预热 effect 的依赖是 `[hydrated, blobs]`：只换 Take（不动 blobs）不会让它重跑，
    于是「探针以为在等预热、其实一个 effect 都没触发」，读数会指着"指示灯说谎"，
    而真实原因在探针这一侧。走一次导航（素材箱 → 演奏台）得到的是**用户真实的
    路径**：在别的页面配好，再切到演奏台开弹 —— 挂载即预热。
  */
  await cdp.eval(`() => document.querySelector('nav button[title="混音台"]').click()`);
  await sleep(300);
  await cdp.eval(`() => document.querySelector('nav button[title="演奏台"]').click()`);
  if (!(await waitFor(cdp, `() => document.querySelectorAll('button[data-key-index]').length >= 12`, 25000))) {
    throw new Error('重新挂载演奏台后键区没渲染出来');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S0 预热时序 ══');
  // ═══════════════════════════════════════════════════════════════════════
  /* 播种会新增素材 → blobs 变化 → 预热 effect 重跑。指示灯必须**先回到「预热」**。
     这条不是在挑刺：旧写法从不在开头复位，于是新素材还在同步变调时灯就已经写着
     「就绪」，用户照着它按下去撞上的正是那一轮预热本身。
     采样间隔 25ms —— 预热可能只有几十毫秒，粗采样会把它整个跨过去，然后被误读成
     「灯没复位」。 */
  const seq = await trackIndicator(cdp, null, 20000);
  console.log(`  指示灯序列：${seq.map((x) => `${x.t}ms:${x.s}`).join(' → ') || '(无切换)'}`);
  const sawWarming = seq.some((x) => x.s === 'warming');
  const ready = seq.some((x) => x.s === 'ready');
  check('新一轮预热开始时指示灯先回到「预热」（不说假话）', sawWarming, `序列 ${JSON.stringify(seq)}`);
  check('预热指示灯最终会亮（预热不会卡死在半路）', ready, '20s 内没等到「音色已就绪」');

  /* ⭐ 直接问引擎：灯亮着的时候还剩多少活没干。
     这是"指示灯是不是在说假话"的唯一硬证据 —— 读数是 warmed，不是推测。 */
  const diag = await cdp.eval(JS_DIAG_PREWARM);
  console.log(
    `  诊断：键 ${diag.keys} 个 / 槽位 ${diag.refs} 个 / wasm就绪=${diag.rushReady} / 第三方引擎=${diag.activeShift ?? '无'}`,
  );
  console.log(
    `  指示灯写「就绪」时，手动补一次预热：共 ${diag.total} 条，` +
      `其中**真跑到 wasm** 的 ${diag.stillUncomputed} 条（跳过 ${diag.skipped}，耗时 ${diag.ms}ms${diag.timedOut ? '，超预算' : ''}）`,
  );
  check(
    '① 指示灯说「就绪」时确实没有未算的变换（不说假话）',
    diag.stillUncomputed === 0,
    `还有 ${diag.stillUncomputed} 条没算出来 —— 用户照着「就绪」按下去，撞上的就是它们`,
  );

  /** 弹一遍（每个键按下→抬起→留点间隙让上一次起播），返回读数 */
  async function playRound(label, keys) {
    await cdp.eval(`() => window.__playPerfReset()`);
    await sleep(200);
    for (const k of keys) {
      await pressKey(cdp, rects[k], 60);
      await sleep(90);
    }
    await sleep(400);
    const snap = await cdp.eval(JS_READ);
    const pairs = pairLatencies(snap);
    const silent = silentKeys(pairs);
    const lats = latencies(pairs);
    console.log(`  ${label}：发声 ${snap.starts}/${snap.pressAt.length} 次` + (silent.length ? `  安静键 [${silent}]` : ''));
    console.log(`  逐键(ms)：${pairs.map((p) => (p.ms === null ? `${p.key}:无声` : `${p.key}:${p.ms}`)).join('  ')}`);
    console.log(
      `  p50=${r1(pct(lats, 50))}  p95=${r1(pct(lats, 95))}  max=${r1(lats.length ? Math.max(...lats) : 0)}` +
        `  wasm变换 ${snap.wasmTx} 次` +
        `  长任务 ${snap.longTasks.length} 条${snap.longTasks.length ? '（' + snap.longTasks.map((t) => t.d + 'ms').join(', ') + '）' : ''}`,
    );
    return { snap, pairs, silent, lats };
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S1 预热完成后顺序弹 12 个键 ══');
  // ═══════════════════════════════════════════════════════════════════════
  const warm = await playRound('S1', order);

  check(
    '① 每个键都真的发了声（start 次数 == 按键次数）',
    warm.pairs.every((p) => p.ms !== null) && warm.snap.starts === order.length,
    `start=${warm.snap.starts} 按下=${warm.snap.pressAt.length} 期望=${order.length} 安静键=[${warm.silent}]`,
  );
  check(
    `② 每次按下的同步耗时 p95 < ${PRESS_LATENCY_BUDGET_MS}ms`,
    pct(warm.lats, 95) < PRESS_LATENCY_BUDGET_MS,
    `p95=${r1(pct(warm.lats, 95))}ms  max=${r1(warm.lats.length ? Math.max(...warm.lats) : 0)}ms`,
  );
  check(
    '③ 弹奏期间没有长任务（>50ms）',
    warm.snap.longTasks.length <= LONG_TASK_BUDGET,
    `${warm.snap.longTasks.length} 条：${warm.snap.longTasks.map((t) => t.d + 'ms').join(', ')}`,
  );
  check(
    '④ 弹这 12 个键没有引起任何一次 wasm 变换（预热真的覆盖了它们）',
    warm.snap.wasmTx === 0,
    `wasm 调了 ${warm.snap.wasmTx} 次${warm.snap.wasmPatchError ? `（埋点失败：${warm.snap.wasmPatchError}）` : ''}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S2 同一批键再弹一遍（缓存全热）══');
  // ═══════════════════════════════════════════════════════════════════════
  const hot = await playRound('S2', order);
  check(
    '缓存全热时仍然每个键都发声',
    hot.pairs.every((p) => p.ms !== null),
    `安静键=[${hot.silent}] start=${hot.snap.starts} 期望=${order.length}`,
  );
  check(
    '缓存全热时按键同步耗时 p95 不超过首次那一轮',
    pct(hot.lats, 95) <= Math.max(PRESS_LATENCY_BUDGET_MS, pct(warm.lats, 95)),
    `热 p95=${r1(pct(hot.lats, 95))} / 首次 p95=${r1(pct(warm.lats, 95))}`,
  );
  check(
    '重复弹同一批键，wasm 变换次数为 0（变换缓存命中）',
    hot.snap.wasmTx === 0,
    `wasm 调了 ${hot.snap.wasmTx} 次`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n══ S3 同一个键连击 20 次（0 间隔，最容易丢声）══');
  // ═══════════════════════════════════════════════════════════════════════
  await cdp.eval(`() => window.__playPerfReset()`);
  await sleep(200);
  const clickKey = rects[order[4]];
  for (let i = 0; i < 20; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: clickKey.x, y: clickKey.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: clickKey.x, y: clickKey.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }
  await sleep(600);
  const rapid = await cdp.eval(JS_READ);
  console.log(`  按下 ${rapid.pressAt.length} 次 → 发声 ${rapid.starts} 次`);
  console.log(`  长任务 ${rapid.longTasks.length} 条${rapid.longTasks.length ? '：' + rapid.longTasks.map((t) => t.d + 'ms').join(', ') : ''}`);
  check(
    '连击 20 次每次都发声（不丢声）',
    rapid.starts === rapid.pressAt.length,
    `start=${rapid.starts} 按下=${rapid.pressAt.length}`,
  );
  check(
    '连击期间没有长任务',
    rapid.longTasks.length <= LONG_TASK_BUDGET,
    `${rapid.longTasks.length} 条：${rapid.longTasks.map((t) => t.d + 'ms').join(', ')}`,
  );
  check(
    '连击 20 次没有引起任何一次 wasm 变换',
    rapid.wasmTx === 0,
    `wasm 调了 ${rapid.wasmTx} 次`,
  );

  // ── 页面侧日志（异常/警告）────────────────────────────────────────────────
  if (pageLog.length) {
    console.log(`\n══ 页面侧异常/警告（${pageLog.length} 条）══`);
    for (const l of [...new Set(pageLog)].slice(0, 20)) console.log('   ' + l);
  } else {
    console.log('\n页面侧没有异常与警告');
  }

  // ── 判定 ────────────────────────────────────────────────────────────────
  console.log(`\n══ 判定 ══\n  通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('   · ' + f);
  cleanup();
  return fails.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('\n探针异常：', err.message);
}
process.exit(ok ? 0 : 1);
