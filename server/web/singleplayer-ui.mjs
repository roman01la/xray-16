const multiplayer=document.documentElement.dataset.gameModes==='unified'&&new URLSearchParams(location.search).get('play')==='multiplayer';
const boot=document.querySelector('#boot'),message=document.querySelector('#boot-status'),retry=document.querySelector('#retry');
const fail=text=>{boot.hidden=false;message.textContent=text;retry.hidden=false;};
retry.addEventListener('click',()=>location.reload());
const status=document.querySelector('#status'),ingest=document.querySelector('#ingest-status'),log=document.querySelector('#log');
const meter=document.querySelector('#load-progress'),detail=document.querySelector('#load-detail');
const diagnostics=document.querySelector('#browser-diagnostics');
if(diagnostics&&new URLSearchParams(location.search).get('diagnostics')==='1'){
 const name='xray-gpu-diagnostics-'+crypto.randomUUID();
 globalThis.__xrayGPUDiagnosticsChannel=name;
 const channel=new BroadcastChannel(name);
 const ms=value=>Number.isFinite(value)?value.toFixed(1)+' ms':'—';
 diagnostics.hidden=false;
 diagnostics.textContent='Waiting for WebGPU frames…';
 channel.onmessage=({data:d})=>{
  const adapter=[d.adapter.vendor,d.adapter.architecture,d.adapter.device].filter(Boolean).join(' ')||'Unknown';
  const vsync=d.pacing?(d.pacing.vsync?'on':'off'):'—';
  diagnostics.textContent=[
   `${d.fps.toFixed(1)} FPS · ${d.width}×${d.height}`,
   `WebGPU ${adapter}${d.adapter.fallback?' (fallback)':''}`,
   `CPU simulation ${ms(d.simulationMs)} · render ${ms(d.renderMs)} · wait ${ms(d.waitMs)}`,
   `GPU ${ms(d.gpuMs)} · VSync ${vsync} · frame budget ${ms(d.pacing?.limitMs)}`,
   `WebGPU validation errors ${d.validationErrors}`,
  ].join('\n');
 };
 window.addEventListener('pagehide',event=>{if(!event.persisted)channel.close();});
}
let startupComplete=false,firstMenuFrame=null,broken=false,installing=false;
const mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
const indeterminate=()=>meter.removeAttribute('value');
const startingEngine=()=>{message.textContent='Starting the engine…';indeterminate();};
const showGame=()=>{startupComplete=true;boot.hidden=true;};
window.addEventListener('xray-engine-progress',({detail:p})=>{
 if(startupComplete||broken)return;
 message.textContent='Preparing game files…';
 meter.max=p.total;meter.value=p.done;
 detail.textContent=`${p.done.toLocaleString()} / ${p.total.toLocaleString()} files checked`;
 if(p.done===p.total)startingEngine();
});
window.addEventListener('xray-stream-progress',({detail:p})=>{
 if(p.phase!=='install'||startupComplete||broken)return;
 if(p.error){broken=true;fail(p.error);indeterminate();return;}
 installing=!p.ready;
 if(p.ready){startingEngine();return;}
 message.textContent=p.active?'Downloading the game…':'Checking installed game data…';
 if(p.packBytes){
  meter.max=p.packBytes;meter.value=p.checkedBytes;
  detail.textContent=`${mb(p.checkedBytes)} / ${mb(p.packBytes)} ready · ${mb(p.downloadedBytes+p.received)} downloaded`;
 }else{indeterminate();detail.textContent='Reading the game manifest…';}
});
window.addEventListener('xray-engine-log',({detail:line})=>{
 if(/Archive (read|stat) failed/.test(line)){broken=true;fail('Installed game data could not be read. Reload to repair it.');}
});
const observe=()=>{
 if(broken)return;
 const text=status.textContent,sync=ingest.textContent;
 const error=/failed|unavailable|needs |lacks |No WebGPU/i;
 if(error.test(text)||error.test(sync)){broken=true;fail(error.test(text)?text:sync);return;}
 if(startupComplete||installing)return;
 if(multiplayer){if(text.startsWith('C++ tick'))showGame();else if(text)message.textContent=text;return;}
 if(text!=='engine running')return;
 const gpu=document.querySelector('#webgpu-stats')?.textContent||'';
 const frames=Number(gpu.match(/([0-9]+) frames/)?.[1]||0);
 if(firstMenuFrame===null&&frames>2&&log.textContent.includes('Loading script: game_registrator.script'))firstMenuFrame=frames;
 if(firstMenuFrame!==null&&frames>firstMenuFrame+2){showGame();return;}
 message.textContent='Loading the game…';indeterminate();
};
const observer=new MutationObserver(observe);observer.observe(status,{childList:true,characterData:true,subtree:true});observer.observe(ingest,{childList:true,characterData:true,subtree:true});observer.observe(log,{childList:true,characterData:true,subtree:true});
if(!isSecureContext||!crossOriginIsolated||!navigator.gpu||!navigator.storage?.getDirectory){fail('This game needs a desktop browser with WebGPU and local file storage. Please use a current Chrome or Edge browser.');retry.hidden=true;}
else {
 try{
 await import(multiplayer?'./public-ui.mjs':'./main.js');const gpu=document.querySelector('#webgpu-stats');if(gpu)observer.observe(gpu,{childList:true,characterData:true,subtree:true});observe();}
 catch(error){fail(error.message||'The game could not start. Check your connection and try again.');}
}
