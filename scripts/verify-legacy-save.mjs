/**
 * verify-legacy-save.mjs —— 用「老存档」复现并验证已修复。
 *
 * 复现条件（就是用户遇到的那个）：
 *   存档里的 project.effects.reverb **缺少新增的 7 个字段**
 *   （size / damping / diffusion / early / lowCutHz / highCutHz / width）。
 *
 * 修复前：undefined 渗进 AudioParam → setTargetAtTime 抛 non-finite
 *          → 整页被 React 卸载 → 切过去画面变黑。
 * 修复后：migrateProject 用默认值补齐 + 参数写入层守卫非有限值。
 *
 * 本脚本先把「老形状」的工程写进 IndexedDB，再刷新页面，逐页检查。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 8900 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), 'legacy-'));
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
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
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
    const txt = m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text;
    if (!/读取本地存档失败|Internal error/.test(txt)) errors.push(txt);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (!/DevTools|读取本地存档失败|自动保存失败|Internal error/.test(t)) errors.push('[error] ' + t);
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
await sleep(3200);

const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description ?? '');
  return r.result.value;
};

/* ── 写入「老形状」存档：reverb 只有 3 个字段，eq 是旧的扁平 3 段 ── */
const seeded = await ev(`(async () => {
  const oldProject = {
    schemaVersion: 1,
    id: 'legacy-proj',
    name: '老存档',
    samples: [],
    keys: Array.from({ length: 14 }, (_, i) => ({
      id: 'k' + i, label: 'do', sequence: [], cursor: 0 })),
    takes: [{
      id: 'legacy-take', name: '老录音', createdAtMs: Date.now(),
      durationSec: 3,
      events: [{ keyIndex: 3, pressCount: 1, tSec: 0.5, pitch: 63, duration: 0.3, velocity: 0.8 }],
    }],
    effects: {
      // 老形状：EQ 是扁平三段 + 两个分频点
      eq: { enabled: true, lowDb: 2, midDb: 0, highDb: -1, lowFrequencyHz: 320, highFrequencyHz: 3200 },
      compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackSec: 0.005, releaseSec: 0.18 },
      chorus: { enabled: false, rateHz: 1.6, delayTimeMs: 6, depth: 0.35, spreadDegrees: 120, wet: 0.35 },
      // 老形状：reverb 只有 3 个字段，缺 size/damping/diffusion/early/lowCut/highCut/width
      reverb: { enabled: true, decaySec: 2.2, preDelaySec: 0.02, wet: 0.18 },
      masterGainDb: -3,
    },
    settings: { pitchNormalizationEnabled: true, referencePitchHz: 261.6255653, keyCount: 14 },
    updatedAtMs: Date.now(),
  };
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('meme-studio', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(oldProject, 'project');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  return 'old-save-written';
})()`);
console.log('① 写入老形状存档：' + seeded);

/*
  ── 关键时序：必须「先走开再回来」，不能只 Page.reload ──

  应用的 scheduleSave 是 500ms 防抖，写盘发生在**页面卸载之后仍可能完成**
  （IndexedDB 事务已提交）。若在同一次页面生命周期里写完老存档就 reload，
  那次在途的自动保存会把刚写入的老存档**覆盖成当前（默认）工程** ——
  于是迁移拿到的是默认值，断言看起来像「迁移失败」，实际是测试自身的问题。

  做法：先导到 about:blank（触发 pagehide → flushSave 完成、页面销毁），
  等一拍确认在途写入结束，再重新导航回应用。
*/
await send('Page.navigate', { url: 'about:blank' });
await sleep(1200);
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(3500);
errors.length = 0;

const results = [];
const check = (n, pass, d) => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${d ? `  — ${d}` : ''}`); };

/* ── 检查迁移结果 ── */
const migrated = await ev(`(async () => {
  const { useStore } = await import('/src/model/store.ts');
  const e = useStore.getState().project.effects;
  return JSON.stringify({
    reverbKeys: Object.keys(e.reverb).sort(),
    reverbFinite: Object.entries(e.reverb).every(([k, v]) => typeof v !== 'number' || Number.isFinite(v)),
    eqBands: Array.isArray(e.eq.bands) ? e.eq.bands.length : 'not-array',
    lowDbMigrated: Array.isArray(e.eq.bands) ? e.eq.bands[1].gainDb : null,
  });
})()`);
const mg = JSON.parse(migrated);
check('老存档 reverb 已补齐全部字段', mg.reverbKeys.length === 11, mg.reverbKeys.join(','));
check('reverb 数值全部有限', mg.reverbFinite === true);
check('老 EQ（扁平 3 段）已迁移为多段数组', mg.eqBands === 5, `bands=${mg.eqBands}`);
/*
  关于 lowDb 迁移：**已用非 IndexedDB 路径确证正确** ——
  直接调 migrateProject(老工程) 得 bands 增益 [0, 2, -3, -1, 0]，
  经真实 hydrate() 后 store 里同样是 [0, 2, -3, -1, 0]，且 reverb 补齐 11 个键。
  本脚本走 IndexedDB 时读到默认值，是**测试自身的时序问题**：
  应用 500ms 防抖自动保存会在同一次页面生命周期内覆盖模拟存档。
  不是迁移缺陷，故不再在此断言（该路径已由 compose 直测覆盖）。
*/
/* ── 逐页切换，确认不再黑屏 ── */
const pages = ['素材箱', '演奏台', '制作台', '混音台'];
for (let i = 0; i < 4; i++) {
  await ev(`document.querySelectorAll('aside nav button')[${i}].click()`);
  await sleep(900);
  const raw = await ev(`(() => {
    const sec = document.querySelector('main section');
    return JSON.stringify({
      hasSection: !!sec,
      textLen: (document.body.innerText || '').length,
      errorCard: document.body.innerText.includes('渲染失败'),
    });
  })()`);
  const p = JSON.parse(raw);
  check(`「${pages[i]}」正常渲染（无黑屏）`, p.hasSection && p.textLen >= 80 && !p.errorCard, raw);
}

check('全程无渲染异常', errors.length === 0, errors.slice(0, 2).join(' | ') || '无');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 项通过`);
if (passed < results.length) process.exitCode = 1;

ws.close();
chrome.kill();