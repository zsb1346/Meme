/**
 * probe-synth.mjs —— 合成声部（音色设计面板）的**绝对量**验收。
 *
 * ## 为什么不是 vitest
 *
 * vitest 跑在 node 环境，没有 Web Audio —— `OfflineAudioContext` 不存在，
 * 所以「到底有没有出声」这一类判断在单测里**测不到**。
 * 而项目头号规矩是：**相对指标测不出「输出全零」，判有没有出声必须用绝对量。**
 * 于是这里退到浏览器：把 `SynthEngine` 直接实例化到 `OfflineAudioContext` 上
 * 真渲染一遍，再量 rms / peak / 直流 / 基频。
 *
 * ⚠️ 它测的是**引擎 + 预设表**，不是 DOM。UI 请用 `cdp-shot.mjs` 截图。
 *
 * ## 用法
 *
 *   npx vite --port 5173 --strictPort &        # 先起 dev server
 *   node scripts/probe-synth.mjs 5173
 *
 * 退出码：0 = 全过，1 = 有断言失败（失败项会逐条列出）。
 *
 * ⛔ 本机挂着环境代理（HTTP_PROXY=127.0.0.1:11123），访问 loopback 会被它接走。
 *    跑之前记得 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`。
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

const CDP_PORT = 9400 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'psynth-'));
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
// 离线渲染：直接实例化引擎，量绝对量
// ---------------------------------------------------------------------------

const MEASURE = `(async () => {
  const m = await import('/src/engine/synth/engine.ts');
  const p = await import('/src/engine/synth/patch.ts');
  const SR = 48000;
  const NOTE_SEC = 0.9;          // 与面板「试听」的音长保持一致
  const EVAL_MIDI = 60;          // C4

  async function render(patch, midi) {
    const ctx = new OfflineAudioContext(1, Math.floor(SR * (NOTE_SEC + 0.6)), SR);
    const eng = new m.SynthEngine(ctx, patch);
    eng.noteOn(midi, { durationSec: NOTE_SEC });
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    const from = Math.floor(SR * 0.08);
    let sum = 0, dc = 0, peak = 0, nonFinite = 0;
    for (let i = from; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) nonFinite++;
      sum += v * v; dc += v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const n = Math.max(1, d.length - from);
    return { rms: Math.sqrt(sum / n), dc: dc / n, peak, nonFinite, data: d };
  }

  /** 朴素自相关求基频（够用于「八度有没有错」这个粒度） */
  function pitchOf(d) {
    const x = d.subarray(Math.floor(SR * 0.2), Math.floor(SR * 0.2) + 4096);
    const minLag = Math.floor(SR / 1200), maxLag = Math.floor(SR / 70);
    let bestLag = 0, best = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0; const n = x.length - lag;
      for (let i = 0; i < n; i++) s += x[i] * x[i + lag];
      s /= n;
      if (s > best) { best = s; bestLag = lag; }
    }
    return bestLag ? SR / bestLag : 0;
  }

  const out = { noteSec: NOTE_SEC, presets: [] };

  const def = await render(p.DEFAULT_SYNTH_PATCH, EVAL_MIDI);
  out.defaultPatch = {
    rms: +def.rms.toFixed(6), dc: +def.dc.toFixed(7), peak: +def.peak.toFixed(4),
    pitchHz: +pitchOf(def.data).toFixed(1), nonFinite: def.nonFinite,
  };

  const silent = { ...p.DEFAULT_SYNTH_PATCH, osc1Level: 0, osc2Level: 0, osc3Level: 0, noiseLevel: 0 };
  const s = await render(silent, EVAL_MIDI);
  out.silentPatch = { rms: s.rms, dc: s.dc, peak: s.peak };

  for (const name of p.SYNTH_PRESET_NAMES) {
    const r = await render(p.patchFromPreset(name), 69);
    out.presets.push({
      name, rms: +r.rms.toFixed(6), dc: +r.dc.toFixed(7), peak: +r.peak.toFixed(4),
      nonFinite: r.nonFinite,
    });
  }

  /*
    七个引擎各渲染一遍。

    ⛔ 这一段只能靠**绝对量**判：预设表里全是经典引擎的音色，
    「波表 / FM 加算子 / 加法 / 弦鸣 / 粒子 / 噪声」这六套图
    **没有任何一款预设覆盖它们** —— 图接错了、忘了起振、增益写成 0，
    在预设表上一项都看不出来，用户按下键才发现「这个引擎没声」。

    素材取自出厂 patch（参考音 · 清铃）本身：它已经带齐所有引擎的默认量，
    所以「换引擎就出声」是引擎自己的责任，不是靠这里补参数蒙过去的。
  */
  out.engines = [];
  for (const et of ['classic', 'wavetable', 'fm', 'additive', 'string', 'granular', 'noise']) {
    const r = await render({ ...p.DEFAULT_SYNTH_PATCH, engineType: et }, EVAL_MIDI);
    out.engines.push({
      engineType: et,
      rms: +r.rms.toFixed(6),
      peak: +r.peak.toFixed(4),
      dc: +r.dc.toFixed(7),
      nonFinite: r.nonFinite,
    });
  }

  // 恶意 patch：NaN / undefined / Infinity / 非法枚举 —— 必须被 sanitize 拦下，不许抛
  let threw = null;
  try {
    const bad = { ...p.DEFAULT_SYNTH_PATCH, osc1Level: undefined, osc1Oct: NaN,
      volume: Infinity, bitDepth: 'x', driveType: 'nope', monoMode: 7 };
    const b = await render(bad, EVAL_MIDI);
    out.badPatch = { rms: +b.rms.toFixed(6), nonFinite: b.nonFinite };
  } catch (e) { threw = String((e && e.message) || e); }
  out.threwOnBadPatch = threw;

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
// 判定（全部为绝对量 / 明确不变式）
// ---------------------------------------------------------------------------

const fails = [];
const AUDIBLE_FLOOR = 2e-4; // ≈ −74 dBFS：低于它在这台机器上就等于没声
const EXPECT_C4 = 261.63;

console.log(`\n=== 合成声部离线渲染（音长 ${r.noteSec}s，A4=440 / C4=261.63） ===\n`);

const dp = r.defaultPatch;
console.log(
  `出厂「参考音」  rms=${dp.rms}  peak=${dp.peak}  dc=${dp.dc}  基频=${dp.pitchHz}Hz（期望 ${EXPECT_C4}）`,
);
const pitchErr = Math.abs(dp.pitchHz - EXPECT_C4) / EXPECT_C4;
if (pitchErr > 0.03) {
  fails.push(`出厂参考音基频 ${dp.pitchHz}Hz 偏离 C4(${EXPECT_C4}Hz) ${(pitchErr * 100).toFixed(1)}% —— 参考音必须与按键同音高`);
}
if (dp.rms < AUDIBLE_FLOOR) fails.push(`出厂参考音 rms=${dp.rms} 低于可闻下限`);

console.log(
  `静音 patch      rms=${r.silentPatch.rms}  peak=${r.silentPatch.peak}  dc=${r.silentPatch.dc}`,
);
if (r.silentPatch.rms !== 0 || r.silentPatch.peak !== 0) {
  fails.push(
    `静音 patch（所有振荡器音量=0）渲染出非零输出 rms=${r.silentPatch.rms} —— 绝对量基线必须精确为 0（多半是波形整形曲线的直流偏置，见 engine.ts 的 CURVE_LEN 注释）`,
  );
}

console.log('\n预设表：');
const w = Math.max(...r.presets.map((p) => p.name.length));
for (const p of r.presets) {
  const flag = [];
  if (p.rms < AUDIBLE_FLOOR) flag.push('⛔静音');
  if (p.peak > 1) flag.push('⛔削顶');
  if (Number.isFinite(p.dc) && Math.abs(p.dc) > 0.01) flag.push(`⛔直流${p.dc}`);
  if (p.nonFinite) flag.push('⛔非有限值');
  console.log(
    `  ${p.name.padEnd(w)}  rms=${String(p.rms).padEnd(9)} peak=${String(p.peak).padEnd(7)} dc=${p.dc}  ${flag.join(' ')}`,
  );
  if (p.rms < AUDIBLE_FLOOR) fails.push(`预设「${p.name}」rms=${p.rms} 低于可闻下限（等于没声）`);
  if (p.peak > 1) fails.push(`预设「${p.name}」peak=${p.peak} 超过 1.0（数字削顶）`);
  if (p.nonFinite) fails.push(`预设「${p.name}」出现 ${p.nonFinite} 个非有限样点`);
}

console.log(`\n恶意 patch      ${JSON.stringify(r.badPatch ?? null)}  抛出=${r.threwOnBadPatch}`);
if (r.threwOnBadPatch) fails.push(`恶意 patch 让引擎抛异常：${r.threwOnBadPatch}`);
else if (r.badPatch && r.badPatch.rms < AUDIBLE_FLOOR) {
  fails.push('恶意 patch 被 sanitize 后应当回落到默认音色（可闻），实测近乎无声');
}

console.log('\n七个引擎（同一份出厂参数，只换 engineType）：');
for (const e of r.engines ?? []) {
  const flag = [];
  if (e.rms < AUDIBLE_FLOOR) flag.push('⛔静音');
  if (e.peak > 1) flag.push('⛔削顶');
  if (Math.abs(e.dc) > 0.01) flag.push(`⛔直流${e.dc}`);
  if (e.nonFinite) flag.push('⛔非有限值');
  console.log(
    `  ${e.engineType.padEnd(10)}  rms=${String(e.rms).padEnd(9)} peak=${String(e.peak).padEnd(7)} dc=${e.dc}  ${flag.join(' ')}`,
  );
  if (e.rms < AUDIBLE_FLOOR) {
    fails.push(`引擎「${e.engineType}」rms=${e.rms} 低于可闻下限 —— 选了它等于按下去没声`);
  }
  if (e.peak > 1) fails.push(`引擎「${e.engineType}」peak=${e.peak} 超过 1.0（数字削顶）`);
  if (e.nonFinite) fails.push(`引擎「${e.engineType}」出现 ${e.nonFinite} 个非有限样点`);
}
if (!r.engines || r.engines.length !== 7) {
  fails.push(`引擎清单只有 ${r.engines ? r.engines.length : 0} 项，应为 7 —— 有引擎没被渲染到`);
}

if (logs.length) console.log('\n页面异常：\n' + logs.join('\n'));

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 项不通过：`);
  for (const f of fails) console.log('  - ' + f);
  chrome.kill();
  process.exit(1);
}
console.log(`✓ 全部通过（${r.presets.length} 款预设都出声、静音基线为 0、无削顶、无异常）`);
chrome.kill();
process.exit(0);
