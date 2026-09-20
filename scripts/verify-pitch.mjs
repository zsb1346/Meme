import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CDP_PORT = 7500 + Math.floor(Math.random()*70);
const profile = mkdtempSync(join(tmpdir(),'pv-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+CDP_PORT,
  '--user-data-dir='+profile,'--window-size=1200,800','about:blank'], { stdio: 'ignore' });
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl; for(let i=0;i<120&&!wsUrl;i++){try{const l=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  wsUrl=l.find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{} if(!wsUrl)await sleep(100);}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map(); const errs=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
 if(m.method==='Runtime.exceptionThrown'){errs.push(m.params.exceptionDetails.exception?.description??'');}
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='warning'){const t=m.params.args.map(a=>a.value??'').join(' ');
   if(/变调|transform|rush/.test(t))errs.push('warn: '+t);}
 if(m.id===undefined)return; const p=pend.get(m.id); if(!p)return; pend.delete(m.id);
 m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
const send=(me,pa={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});
 ws.send(JSON.stringify({id:i,method:me,params:pa}));});
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:'http://localhost:5199/'}); await sleep(4000);
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
 return r.exceptionDetails?'ERR: '+(r.exceptionDetails.exception?.description??''):r.result.value;};

console.log('=== 模拟装配试听：playSample(semitones=+5, timeFactor=1) 走 PSOLA ===');
console.log(await ev(`(async () => {
  const { getMasterChain } = await import('/src/engine/effects.ts');
  const { useStore } = await import('/src/model/store.ts');
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  const { cacheBuffer, playSample } = await import('/src/engine/sample-player.ts');
  const { ensureRushLoaded, isRushReady, transformBuffer } = await import('/src/engine/rush/transform.ts');
  ensureAudioStarted(); await ensureRushLoaded();
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();

  // 造一段人声似素材
  const sr = 48000, N = sr;
  const buf = ctx.createBuffer(1, N, sr);
  const cd = buf.getChannelData(0);
  for (let i = 0; i < N; i++) { const t = i/sr; const f0 = 180*(1+0.03*Math.sin(2*Math.PI*4*t));
    cd[i] = 0.5*Math.sin(2*Math.PI*f0*t)+0.25*Math.sin(2*Math.PI*2*f0*t)+0.12*Math.sin(2*Math.PI*3*f0*t); }

  const chain = getMasterChain(useStore.getState().project.effects);
  const rawCtx = chain.input.context.rawContext;
  const an = rawCtx.createAnalyser(); an.fftSize = 4096;
  const sink = rawCtx.createGain(); sink.gain.value = 0;
  chain.output.output.connect(an); an.connect(sink); sink.connect(rawCtx.destination);

  const res = {};
  for (const [name, semi, tau] of [['原样', 0, 1], ['+5半音', 5, 1], ['-7半音', -7, 1], ['+5且变速1.3', 5, 1.3]]) {
    const pitch = Math.pow(2, semi/12);
    let tb = 'n/a';
    try { const out = transformBuffer(ctx, buf, pitch, tau, 1);
      let acc=0; const d=out.getChannelData(0); for(let i=0;i<d.length;i++)acc+=d[i]*d[i];
      tb = 'rms=' + Math.sqrt(acc/d.length).toFixed(4) + ' len=' + out.length; } catch(e){ tb='THROW:'+e.message; }
    const h = playSample({ buffer: buf, destination: chain.input, semitones: semi, timeFactor: tau, gainLinear: 1, transformMode: 'psola' });
    let peak = 0;
    for (let k=0;k<10;k++){ await new Promise(r=>setTimeout(r,40));
      const arr=new Float32Array(an.fftSize); an.getFloatTimeDomainData(arr);
      let a2=0; for(const v of arr)a2+=v*v; peak=Math.max(peak,Math.sqrt(a2/arr.length)); }
    h.stop(0.01);
    res[name] = { psola: tb, played: Number(peak.toFixed(5)) };
  }
  an.disconnect(); sink.disconnect();
  return JSON.stringify(res, null, 1);
})()`));
console.log('异常/降级日志:', errs.slice(0,4).join(' | ') || '无');
ws.close(); chrome.kill();
