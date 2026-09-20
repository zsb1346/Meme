/**
 * diag-audio.mjs —— 测量主效果链是否有信号通过（挂在真实页面里跑）。
 *
 * 两个必须避开的测量陷阱（都踩过）：
 *  1. 不能另起一份 Tone（import .../deps/tone.js）—— Tone 用模块级 WeakMap
 *     记录节点归属，跨实例 Tone.connect(appNode) 会抛
 *     "A value with the given key could not be found"，看起来像音频链断了。
 *  2. 不能把 ToneAudioNode.input 当原生节点用 —— 其类型不统一
 *     （Gain.input 是原生，Filter.input 是 Tone 包装）。
 *     统一从 chain.input.context.rawContext 取应用那份 AudioContext 造源。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? 5199);
const CDP_PORT = 8300 + Math.floor(Math.random() * 80);
const profile = mkdtempSync(join(tmpdir(), 'audio2-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars',
   '--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+CDP_PORT,
   '--user-data-dir='+profile,'--window-size=1200,800','about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i=0;i<120&&!wsUrl;i++){ try { const l=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  wsUrl=l.find(t=>t.type==='page')?.webSocketDebuggerUrl; } catch {} if(!wsUrl) await sleep(100); }
const ws = new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pending=new Map();
ws.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.id===undefined) return;
  const p=pending.get(m.id); if(!p) return; pending.delete(m.id);
  m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result); });
const send=(me,pa={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,{resolve:res,reject:rej});
  ws.send(JSON.stringify({id:i,method:me,params:pa}));});

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(3500);
const ev = async x => { const r = await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
  return r.exceptionDetails ? 'ERR: '+(r.exceptionDetails.exception?.description ?? '') : r.result.value; };

const HARNESS = `
window.__probeChain = async (flags) => {
  const { getMasterChain } = await import('/src/engine/effects.ts');
  const { useStore } = await import('/src/model/store.ts');
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  ensureAudioStarted();
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const s = structuredClone(useStore.getState().project.effects);
  if (flags) { s.eq.enabled=flags.eq; s.compressor.enabled=flags.comp;
    s.chorus.enabled=flags.chorus; s.reverb.enabled=flags.reverb; }
  const chain = getMasterChain(s);
  const rawCtx = chain.input.context.rawContext;
  const osc = rawCtx.createOscillator(), g = rawCtx.createGain(),
        an = rawCtx.createAnalyser(), sink = rawCtx.createGain();
  an.fftSize = 2048; osc.frequency.value = 440; g.gain.value = 0.5; sink.gain.value = 0;
  osc.connect(g); g.connect(chain.input.input);
  chain.output.output.connect(an); an.connect(sink); sink.connect(rawCtx.destination);
  osc.start();
  await new Promise(r => setTimeout(r, 450));
  const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
  let acc = 0; for (const v of buf) acc += v*v;
  const rms = Math.sqrt(acc / buf.length);
  osc.stop(); osc.disconnect(); g.disconnect(); an.disconnect(); sink.disconnect();
  return JSON.stringify({ ctx: ctx.state, rms: Number(rms.toFixed(5)) });
};
'ok'`;

console.log('① 装测量工具'); console.log(await ev(HARNESS));
console.log('\n② 基线：直达 analyser（不经链路）');
console.log(await ev(`(async () => {
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  ensureAudioStarted(); const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const osc=ctx.createOscillator(), g=ctx.createGain(), an=ctx.createAnalyser();
  an.fftSize=2048; osc.frequency.value=440; g.gain.value=0.5;
  osc.connect(g); g.connect(an); osc.start();
  await new Promise(r=>setTimeout(r,400));
  const buf=new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
  let acc=0; for(const v of buf) acc+=v*v;
  const rms=Math.sqrt(acc/buf.length);
  osc.stop(); osc.disconnect(); g.disconnect(); an.disconnect();
  return JSON.stringify({ ctx: ctx.state, rms: Number(rms.toFixed(5)) });
})()`));

const cases = [
  ['全开 EQ+COMP+CHORUS+VERB', {eq:true,comp:true,chorus:true,reverb:true}],
  ['只开 EQ',    {eq:true, comp:false,chorus:false,reverb:false}],
  ['只开 压缩',  {eq:false,comp:true, chorus:false,reverb:false}],
  ['只开 合唱',  {eq:false,comp:false,chorus:true, reverb:false}],
  ['只开 混响',  {eq:false,comp:false,chorus:false,reverb:true}],
  ['全关（直通）',{eq:false,comp:false,chorus:false,reverb:false}],
];
console.log('\n③ 逐级测量（rms≈0 表示该级吃掉了信号）');
for (const [label,f] of cases) {
  const json = await ev(`window.__probeChain({eq:${f.eq},comp:${f.comp},chorus:${f.chorus},reverb:${f.reverb}})`);
  console.log(label.padEnd(26) + ' ' + json);
}
ws.close(); chrome.kill();
