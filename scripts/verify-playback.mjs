/**
 * verify-playback.mjs —— 验证「装配试听 / 演奏发声」这条真实播放路径。
 * 模拟 NotePalette.previewWith：playSample({ destination: chain.input })
 * 然后在 chain 输出端量电平。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PORT = Number(process.argv[2] ?? 5199);
const CDP_PORT = 8200 + Math.floor(Math.random()*80);
const profile = mkdtempSync(join(tmpdir(),'play-'));
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
await send('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(3500);
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
 return r.exceptionDetails?'ERR: '+(r.exceptionDetails.exception?.description??''):r.result.value;};

console.log('=== 真实播放路径：playSample → chain.input → 量 chain.output ===');
console.log(await ev(`(async () => {
  const { getMasterChain } = await import('/src/engine/effects.ts');
  const { useStore } = await import('/src/model/store.ts');
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  const { playSample } = await import('/src/engine/sample-player.ts');
  ensureAudioStarted();
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();

  const s = structuredClone(useStore.getState().project.effects);
  s.eq.enabled = true; s.compressor.enabled = true; s.chorus.enabled = false; s.reverb.enabled = true;
  const chain = getMasterChain(s);

  // 计量点挂在 chain 输出
  const rawCtx = chain.input.context.rawContext;
  const an = rawCtx.createAnalyser(); an.fftSize = 4096;
  const sink = rawCtx.createGain(); sink.gain.value = 0;
  chain.output.output.connect(an); an.connect(sink); sink.connect(rawCtx.destination);

  // 造一段 0.5s 正弦缓冲当作"采样"
  const buf = rawCtx.createBuffer(1, Math.floor(rawCtx.sampleRate * 0.5), rawCtx.sampleRate);
  const cd = buf.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = Math.sin(2 * Math.PI * 440 * i / rawCtx.sampleRate) * 0.6;

  // ★ 关键：和 NotePalette 一样，destination = chain.input
  const handle = playSample({ buffer: buf, destination: chain.input });

  // 播放中采几帧取最大值
  let peakRms = 0;
  for (let k = 0; k < 8; k++) {
    await new Promise(r => setTimeout(r, 45));
    const arr = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(arr);
    let acc = 0; for (const v of arr) acc += v * v;
    peakRms = Math.max(peakRms, Math.sqrt(acc / arr.length));
  }
  handle.stop(0.01);
  an.disconnect(); sink.disconnect();
  return JSON.stringify({ ctx: ctx.state, peakRms: Number(peakRms.toFixed(5)) });
})()`));

console.log('\n=== 对照：同一段采样直接接 analyser（不经链路）===');
console.log(await ev(`(async () => {
  const { ensureAudioStarted, getAudioContext } = await import('/src/engine/core.ts');
  ensureAudioStarted(); const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const an = ctx.createAnalyser(); an.fftSize = 4096;
  const sink = ctx.createGain(); sink.gain.value = 0;
  an.connect(sink); sink.connect(ctx.destination);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate*0.5), ctx.sampleRate);
  const cd = buf.getChannelData(0);
  for (let i=0;i<cd.length;i++) cd[i] = Math.sin(2*Math.PI*440*i/ctx.sampleRate)*0.6;
  src.buffer = buf; src.connect(an); src.start();
  let peakRms = 0;
  for (let k=0;k<8;k++){ await new Promise(r=>setTimeout(r,45));
    const arr=new Float32Array(an.fftSize); an.getFloatTimeDomainData(arr);
    let acc=0; for(const v of arr) acc+=v*v; peakRms=Math.max(peakRms, Math.sqrt(acc/arr.length)); }
  src.stop(); src.disconnect(); an.disconnect(); sink.disconnect();
  return JSON.stringify({ ctx: ctx.state, peakRms: Number(peakRms.toFixed(5)) });
})()`));
ws.close(); chrome.kill();
