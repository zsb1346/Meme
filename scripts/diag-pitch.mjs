import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CDP_PORT = 8100 + Math.floor(Math.random()*80);
const profile = mkdtempSync(join(tmpdir(),'pitch-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+CDP_PORT,
  '--user-data-dir='+profile,'--window-size=1200,800','about:blank'], { stdio: 'ignore' });
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let wsUrl; for(let i=0;i<120&&!wsUrl;i++){try{const l=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  wsUrl=l.find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{} if(!wsUrl)await sleep(100);}
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pend=new Map(); const logs=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
 if(m.method==='Runtime.consoleAPICalled'){const t=m.params.args.map(a=>a.value??a.description??'').join(' ');
   if(/pitch|Pitch|音高|worker|Worker|basic|Basic/.test(t)) logs.push(m.params.type+': '+t.slice(0,180));}
 if(m.method==='Runtime.exceptionThrown'){const t=m.params.exceptionDetails.exception?.description??'';
   if(/pitch|Pitch|worker|Basic/i.test(t)) logs.push('EXC: '+t.slice(0,200));}
 if(m.id===undefined)return; const p=pend.get(m.id); if(!p)return; pend.delete(m.id);
 m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);});
const send=(me,pa={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});
 ws.send(JSON.stringify({id:i,method:me,params:pa}));});
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{url:'http://localhost:5199/'}); await sleep(3500);
const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
 return r.exceptionDetails?'ERR: '+(r.exceptionDetails.exception?.description??''):r.result.value;};

console.log('=== 1. 生成一段 440Hz 正弦并入库 ===');
console.log(await ev(`(async () => {
  const { useStore } = await import('/src/model/store.ts');
  const sr = 44100, dur = 1.5, N = Math.floor(sr*dur);
  const ab = new ArrayBuffer(44 + N*2), dv = new DataView(ab);
  const ws = (o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF'); dv.setUint32(4,36+N*2,true); ws(8,'WAVEfmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true);
  dv.setUint16(32,2,true); dv.setUint16(34,16,true); ws(36,'data'); dv.setUint32(40,N*2,true);
  for (let i=0;i<N;i++){ const v = Math.sin(2*Math.PI*440*i/sr)*0.7; dv.setInt16(44+i*2, v*32767, true); }
  const file = new File([ab],'sine440.wav',{type:'audio/wav'});
  const r = await useStore.getState().addSampleFromFile(file,'sine440');
  return JSON.stringify({ ok: r.ok, id: r.sampleId ? r.sampleId.slice(0,8) : null, err: r.error });
})()`));

console.log('\n=== 2. YIN 检测 ===');
console.log(await ev(`(async () => {
  const { useStore } = await import('/src/model/store.ts');
  const { getSamplePitchHz } = await import('/src/engine/pitch-async.ts');
  const id = useStore.getState().project.samples[0].id;
  try {
    const hz = await Promise.race([
      getSamplePitchHz(id, 'yin'),
      new Promise(r => setTimeout(() => r('TIMEOUT'), 12000)),
    ]);
    return JSON.stringify({ hz: typeof hz === 'number' ? Number(hz.toFixed(1)) : hz });
  } catch (e) { return 'THROW: ' + e.message; }
})()`));

console.log('\n=== 3. AI 检测（Spotify Basic Pitch）===');
console.log(await ev(`(async () => {
  const { useStore } = await import('/src/model/store.ts');
  const { getSamplePitchHz } = await import('/src/engine/pitch-async.ts');
  const id = useStore.getState().project.samples[0].id;
  try {
    const hz = await Promise.race([
      getSamplePitchHz(id, 'ai'),
      new Promise(r => setTimeout(() => r('TIMEOUT-20s'), 20000)),
    ]);
    return JSON.stringify({ hz: typeof hz === 'number' ? Number(hz.toFixed(1)) : hz });
  } catch (e) { return 'THROW: ' + e.message; }
})()`));

console.log('\n=== 相关日志 ===');
console.log(logs.slice(0,10).join('\n') || '(无)');
ws.close(); chrome.kill();
