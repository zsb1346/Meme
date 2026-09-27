/**
 * probe-synth-lifecycle.mjs —— 合成声部「释放之后」的绝对量验收。
 *
 * ## 为什么单独一个探针
 *
 * `probe-synth.mjs` 管的是「**按下去有没有出声**」；这个管的是
 * 「**松开之后有没有停**」。后者是用户报的两个症状：
 *
 *   · 「有一些预设会一直发声（混响的回音）」
 *   · 「按的多了就会声音卡顿，然后没声」
 *
 * 两者都不是听感问题，而是**可以量成数字**的：
 *
 *   ① **释放之后必须静音** —— 离线渲染，取释放早已结束的窗口量 rms。
 *      注意离线渲染下引擎**刻意不开清扫定时器**（否则会在渲染中途 stop()
 *      掉振荡器），所以这一项**只**检验「静音不依赖回收」。
 *   ② **声部账目必须平衡** —— 建了 60 个声部就得拆掉 60 个。
 *      差多少就是泄漏了多少个节点组。
 *   ③ **颤音必须还在** —— 反向守卫。修①时最容易矫枉过正：
 *      把幅度 LFO 直接 disconnect 掉（看着也能静音），代价是所有带
 *      `lfoAmpAmt` 的预设当场失去颤音。这里用「有/无 LFO 两组在同一时刻
 *      的能量比」把它钉住。
 *
 * ## 用法
 *
 *   npx vite --port 5173 --strictPort &
 *   node scripts/probe-synth-lifecycle.mjs 5173
 *
 * ⛔ 本机挂着环境代理，跑之前 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5173);
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

const CDP_PORT = 9600 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'psynth-life-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=1200,800',
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
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(
      'EXCEPTION: ' +
        (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text),
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

// ---------------------------------------------------------------------------
// 离线渲染实验
// ---------------------------------------------------------------------------

const MEASURE = `(async () => {
  const m = await import('/src/engine/synth/engine.ts');
  const p = await import('/src/engine/synth/patch.ts');
  const SR = 48000;

  /*
    干信号：把效果全部关掉，单独量**声部本身**的释放。
    混响/延迟的尾巴是设计内的（反馈上限 0.92、IR 有界，必然衰减），
    混进来只会让「声部有没有停」这个问题变得不可判定。
    reverbSize 调小纯粹是为了省掉 25 次 6 秒 IR 的生成开销，输出由 reverbMix 决定。
  */
  const dry = (patch) => ({
    ...patch,
    chorusMix: 0,
    delayMix: 0,
    reverbMix: 0,
    reverbSize: 0.05,
  });

  function windowRms(d, fromSec, toSec) {
    const a = Math.max(0, Math.floor(fromSec * SR));
    const b = Math.min(d.length, Math.floor(toSec * SR));
    let sum = 0;
    for (let i = a; i < b; i++) sum += d[i] * d[i];
    return Math.sqrt(sum / Math.max(1, b - a));
  }

  async function render(patch, noteSec, totalSec) {
    const ctx = new OfflineAudioContext(1, Math.floor(SR * totalSec), SR);
    const eng = new m.SynthEngine(ctx, patch);
    eng.noteOn(60, { durationSec: noteSec });
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  const NOTE_SEC = 0.25;
  const RELEASE_PAD = 0.4; // 释放结束之后再等一会儿才量
  const TAIL_WIN = 2.0; // 每次量多久
  const out = { noteSec: NOTE_SEC, presets: [] };

  /*
    ① 每一款预设：**释放结束之后**的窗口必须静音。

    ⚠️ 窗口不能写死。预设的 ampRelease 从 0.14s 到 4s（「管钟 · 教堂」是 4s），
    写死 [2s,4s] 会把一款**正常的 4 秒长释放**判成「还在响」—— 那是假阳性，
    第一版就栽在这儿。窗口按每个预设自己的释放长度推。
  */
  for (const name of p.SYNTH_PRESET_NAMES) {
    const raw = p.patchFromPreset(name);
    const rel = Math.max(raw.ampRelease, raw.fRelease, 0.2);
    const fromSec = NOTE_SEC + rel + RELEASE_PAD;
    const toSec = fromSec + TAIL_WIN;
    const d = await render(dry(raw), NOTE_SEC, toSec + 0.1);
    out.presets.push({
      name,
      ampRelease: raw.ampRelease,
      filterReso: raw.filterReso,
      lfoAmpAmt: raw.lfoAmpAmt,
      lfoFilterAmt: raw.lfoFilterAmt,
      winFrom: +fromSec.toFixed(2),
      winTo: +toSec.toFixed(2),
      bodyRms: +windowRms(d, 0.05, 0.25).toFixed(5),
      tailRms: +windowRms(d, fromSec, toSec).toFixed(7),
    });
  }

  // ② 颤音反向守卫：同一时刻、同一音色，「有幅度 LFO / 无幅度 LFO」的能量比
  const base = dry(p.patchFromPreset('颤音琴 · 流动'));
  const withLfo = await render({ ...base, lfoAmpAmt: 0.22 }, 3, 4);
  const noLfo = await render({ ...base, lfoAmpAmt: 0 }, 3, 4);
  out.tremolo = {
    withLfoRms: +windowRms(withLfo, 1.5, 3.0).toFixed(6),
    noLfoRms: +windowRms(noLfo, 1.5, 3.0).toFixed(6),
  };

  // ③ 声部账目：60 轮「按下 + 松手」，然后一次清扫必须全部拆掉
  const ctx2 = new OfflineAudioContext(1, 1024, SR);
  const eng2 = new m.SynthEngine(ctx2, p.DEFAULT_SYNTH_PATCH);
  for (let i = 0; i < 60; i++) {
    const midi = 40 + i; // 每个音都不同，避免抢占干扰计数
    eng2.noteOn(midi, { durationSec: 30 });
    eng2.noteOff(midi, true);
  }
  out.ledgerBefore = { ...eng2.voiceStats };
  eng2.sweepVoices(1e6);
  out.ledgerAfter = { ...eng2.voiceStats };

  return JSON.stringify(out);
})()`;

let raw;
try {
  raw = await ev(MEASURE);
} catch (e) {
  console.error('离线渲染失败：', e.message);
  chrome.kill();
  process.exit(1);
}
const r = typeof raw === 'string' ? JSON.parse(raw) : raw;

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

const AUDIBLE_FLOOR = 2e-4; // ≈ −74 dBFS：低于它在这台机器上就等于没声
const fails = [];
const w = Math.max(...r.presets.map((x) => x.name.length));

console.log(`\n=== 合成声部 · 释放之后（音长 ${r.noteSec}s；窗口按各预设自己的释放长度推） ===\n`);
console.log('① 释放结束之后必须静音（每款预设，干信号）');
console.log(
  `   ${'预设'.padEnd(w)}  ${'释放s'.padEnd(7)} ${'量测窗口s'.padEnd(14)} 发声期rms   释放后rms`,
);
for (const x of r.presets) {
  const bad = x.tailRms >= AUDIBLE_FLOOR;
  console.log(
    `   ${x.name.padEnd(w)}  ${String(x.ampRelease).padEnd(7)} ${`${x.winFrom}~${x.winTo}`.padEnd(14)} ${String(x.bodyRms).padEnd(11)} ${x.tailRms} ${bad ? '⛔ 还在响' : '✓'}`,
  );
  if (x.bodyRms < AUDIBLE_FLOOR) {
    fails.push(`预设「${x.name}」发声期 rms=${x.bodyRms} 低于可闻下限（按下去就没声）`);
  }
  if (bad) {
    fails.push(
      `预设「${x.name}」释放后 [${x.winFrom}s,${x.winTo}s] 仍有 rms=${x.tailRms}` +
        `（ampRelease=${x.ampRelease} filterReso=${x.filterReso}` +
        ` lfoFilterAmt=${x.lfoFilterAmt} lfoAmpAmt=${x.lfoAmpAmt}）—— 音没停`,
    );
  }
}

console.log('\n② 颤音必须还在（反向守卫：有/无幅度 LFO 的能量比）');
const t = r.tremolo;
const ratio = t.noLfoRms > 0 ? t.withLfoRms / t.noLfoRms : Infinity;
console.log(`   有幅度 LFO rms=${t.withLfoRms}   无幅度 LFO rms=${t.noLfoRms}   比值=${ratio.toFixed(2)}`);
if (!(ratio > 1.5)) {
  fails.push(
    `幅度 LFO 的能量比只有 ${ratio.toFixed(2)}（期望 > 1.5）—— 颤音被「静音修复」误伤了`,
  );
}

console.log('\n③ 声部账目：60 轮按下+松手之后');
const b = r.ledgerBefore;
const a = r.ledgerAfter;
console.log(
  `   清扫前  live=${b.live} dying=${b.dying} created=${b.created} disposed=${b.disposed}`,
);
console.log(
  `   清扫后  live=${a.live} dying=${a.dying} created=${a.created} disposed=${a.disposed}`,
);
if (b.created !== 60) fails.push(`60 轮按键只建了 ${b.created} 个声部（应为 60）`);
if (a.live !== 0 || a.dying !== 0) {
  fails.push(`清扫后仍有 live=${a.live} dying=${a.dying} 个声部挂着 —— 没人负责拆`);
}
if (a.created !== a.disposed) {
  fails.push(
    `声部账目不平：created=${a.created} disposed=${a.disposed}，泄漏 ${a.created - a.disposed} 个（每个约 20 个音频节点，越用越卡）`,
  );
}

if (logs.length) console.log('\n页面异常：\n' + logs.join('\n'));

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 项不通过：`);
  for (const f of fails) console.log('  - ' + f);
  chrome.kill();
  process.exit(1);
}
console.log(
  `✓ 全部通过（${r.presets.length} 款预设释放后静音、颤音仍在、声部账目平）`,
);
chrome.kill();
process.exit(0);
