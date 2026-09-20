import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CDP_PORT = 8000 + Math.floor(Math.random()*80);
const profile = mkdtempSync(join(tmpdir(),'eqfn-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+CDP_PORT,
  '--user-data-dir='+profile,'--window-size=1200,800','about:blank'], { stdio: 'ignore' });
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl; for(let i=0;i<120&&!wsUrl;i++){try{const l=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  wsUrl=l.find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{} if(!wsUrl)await sleep(100);}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id===undefined)return;
 const p=pend.get(m.id); if(!p)return; pend.delete(m.id);
 m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
const send=(me,pa={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});
 ws.send(JSON.stringify({id:i,method:me,params:pa}));});
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:'http://localhost:5199/'}); await sleep(3500);
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
 return r.exceptionDetails?'ERR: '+(r.exceptionDetails.exception?.description??''):r.result.value;};

console.log('=== EQ 功能验证：把 1kHz 峰值段拉到 -24dB，量 1kHz 与 100Hz 的电平 ===');
console.log(await ev(`(async () => {
  const { getMasterChain } = await import('/src/engine/effects.ts');
  const { useStore } = await import('/src/model/store.ts');
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  ensureAudioStarted(); const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();

  const measureAt = async (freqHz, bandGainDb) => {
    const s = structuredClone(useStore.getState().project.effects);
    s.eq.enabled = true; s.compressor.enabled = false; s.chorus.enabled = false; s.reverb.enabled = false;
    s.masterGainDb = 0;
    // bands: [highpass20, lowshelf120, peaking1000, highshelf8000, lowpass20000]
    s.eq.bands[2].gainDb = bandGainDb;
    s.eq.bands[2].frequencyHz = 1000;
    s.eq.bands[2].q = 1;
    const chain = getMasterChain(s);
    const rawCtx = chain.input.context.rawContext;
    const osc = rawCtx.createOscillator(), an = rawCtx.createAnalyser(), sink = rawCtx.createGain();
    an.fftSize = 4096; osc.frequency.value = freqHz; sink.gain.value = 0;
    osc.connect(chain.input.input);
    chain.output.output.connect(an); an.connect(sink); sink.connect(rawCtx.destination);
    osc.start();
    await new Promise(r => setTimeout(r, 350));
    const arr = new Float32Array(an.fftSize); an.getFloatTimeDomainData(arr);
    let acc = 0; for (const v of arr) acc += v*v;
    const rms = Math.sqrt(acc / arr.length);
    osc.stop(); osc.disconnect(); an.disconnect(); sink.disconnect();
    return rms;
  };

  const flat1k   = await measureAt(1000, 0);
  const cut1k    = await measureAt(1000, -24);
  const flat100  = await measureAt(100, 0);
  const cut100   = await measureAt(100, -24);
  return JSON.stringify({
    '1kHz 平坦': Number(flat1k.toFixed(5)),
    '1kHz 拉-24dB': Number(cut1k.toFixed(5)),
    '100Hz 平坦': Number(flat100.toFixed(5)),
    '100Hz（不该受影响）': Number(cut100.toFixed(5)),
    '1kHz 衰减倍数': Number((flat1k / Math.max(cut1k, 1e-9)).toFixed(2)),
  });
})()`));
ws.close(); chrome.kill();
