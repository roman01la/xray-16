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
let started=false,loadingLevel=false,broken=false,phase='Starting the engine…',transfer=null,lastFrames=0,settledFrames=0;
const mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
const indeterminate=()=>meter.removeAttribute('value');
window.addEventListener('xray-engine-progress',({detail:p})=>{
 phase='Preparing game files…';message.textContent=phase;
 meter.max=p.total;meter.value=p.done;
 detail.textContent=`${p.done.toLocaleString()} / ${p.total.toLocaleString()} files checked`;
 if(p.done===p.total){phase='Starting the engine…';indeterminate();}
});
window.addEventListener('xray-stream-progress',({detail:p})=>{
 if(p.phase!=='install')return;
 if(p.error){broken=true;fail(p.error);indeterminate();return;}
 if(broken)return;
 transfer=p.ready?null:p;
 if(p.ready){phase='Starting the engine…';message.textContent=phase;indeterminate();return;}
 boot.hidden=false;
 message.textContent=p.active?'Downloading the game…':'Checking installed game data…';
 if(p.packBytes){
  meter.max=p.packBytes;meter.value=p.checkedBytes;
  detail.textContent=`${mb(p.checkedBytes)} / ${mb(p.packBytes)} ready · ${mb(p.downloadedBytes+p.received)} downloaded`;
 }else{indeterminate();detail.textContent='Reading the game manifest…';}
});
window.addEventListener('xray-engine-log',({detail:line})=>{
 if(/Loading objects|Creating new game|Loading saved game/.test(line)){loadingLevel=true;boot.hidden=false;phase='Loading the world…';}
 if(line.includes('Loading models'))phase='Loading models…';
 if(line.includes('Loading textures'))phase='Loading textures…';
 if(line.includes('Loading spawn registry'))phase='Preparing the world…';
 if(line.includes('Loading VB'))phase='Preparing level geometry…';
 if(line.includes('End of synchronization')){loadingLevel=false;settledFrames=lastFrames;phase='Finishing loading…';}
 if(/Archive (read|stat) failed/.test(line)){broken=true;fail('Installed game data could not be read. Reload to repair it.');}
 if(!broken&&!transfer)message.textContent=phase;
});
const observe=()=>{
 if(broken)return;
 const text=status.textContent,sync=ingest.textContent;
 const error=/failed|unavailable|needs |lacks |No WebGPU/i;
 if(error.test(text)||error.test(sync)){broken=true;fail(error.test(text)?text:sync);return;}
 if(transfer)return;
 if(multiplayer){if(text.startsWith('C++ tick'))boot.hidden=true;else message.textContent=text||phase;return;}
 const gpu=document.querySelector('#webgpu-stats')?.textContent||'';
 const frames=Number(gpu.match(/([0-9]+) frames/)?.[1]||0);lastFrames=frames;
 if(!started&&text==='engine running'&&log.textContent.includes('Loading script: game_registrator.script')&&frames>2){started=true;settledFrames=frames;}
 if(started&&!loadingLevel&&frames>settledFrames+2){boot.hidden=true;return;}
 if(text==='engine running'&&!started){message.textContent='Loading the game…';indeterminate();}
};
const observer=new MutationObserver(observe);observer.observe(status,{childList:true,characterData:true,subtree:true});observer.observe(ingest,{childList:true,characterData:true,subtree:true});observer.observe(log,{childList:true,characterData:true,subtree:true});
if(!isSecureContext||!crossOriginIsolated||!navigator.gpu||!navigator.storage?.getDirectory){fail('This game needs a desktop browser with WebGPU and local file storage. Please use a current Chrome or Edge browser.');retry.hidden=true;}
else {
 try{
 // Seed the engine's built-in medium preset only for a fresh profile.
 // Existing user.ltx belongs to the player and must survive site updates.
 await navigator.locks.request('singleplayer-default-settings',async()=>{
  const root=await navigator.storage.getDirectory();
  const game=await root.getDirectoryHandle('stream-cop',{create:true});
  const app=await game.getDirectoryHandle('_appdata_',{create:true});
  try{await app.getFileHandle('user.ltx');}
  catch(error){
   if(error.name!=='NotFoundError')throw error;
   const file=await app.getFileHandle('user.ltx',{create:true});
   const writer=await file.createWritable();
   await writer.write('_preset default\n');await writer.close();
  }
 });
 await import(multiplayer?'./public-ui.mjs':'./main.js');const gpu=document.querySelector('#webgpu-stats');if(gpu)observer.observe(gpu,{childList:true,characterData:true,subtree:true});observe();}
 catch(error){fail(error.message||'The game could not start. Check your connection and try again.');}
}
