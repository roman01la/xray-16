const multiplayer=document.documentElement.dataset.gameModes==='unified'&&new URLSearchParams(location.search).get('play')==='multiplayer';
const boot=document.querySelector('#boot'),message=document.querySelector('#boot-status'),retry=document.querySelector('#retry');
const start=document.querySelector('#start-game');
const backupButton=document.querySelector('#boot-backup');
const backupStatus=document.querySelector('#backup-status');
const canvas=document.querySelector('#canvas');
let startupReady=false,enteredGame=false,firstMenuFrame=null,broken=false,installing=false,backingUp=false;
const updateStart=()=>{
 if(start)start.disabled=!startupReady||broken||backingUp;
};
const fail=text=>{
 broken=true;
 boot.hidden=false;
 message.textContent=text;
 retry.hidden=false;
 updateStart();
};
retry.addEventListener('click',()=>location.reload());
const status=document.querySelector('#status'),ingest=document.querySelector('#ingest-status'),log=document.querySelector('#log');
const meter=document.querySelector('#load-progress'),detail=document.querySelector('#load-detail');
const diagnostics=document.querySelector('#browser-diagnostics');
const fpsCounter=document.querySelector('#fps-counter');
const deleteButton=document.querySelector('#delete-game-data');
const enabledDiagnostics=search=>new URLSearchParams(search).get('diagnostics')==='1';
const showDiagnostics=diagnostics&&(enabledDiagnostics(location.search)||
 (window.frameElement&&enabledDiagnostics(window.parent.location.search)));

function createDiagnosticsHistory(panel) {
 const samples=[];
 const historyMs=60000;
 const width=420, height=152, left=46, right=width-4;
 const pixelRatio=Math.min(2,window.devicePixelRatio||1);
 const graph=document.createElement('canvas');
 graph.width=width*pixelRatio;
 graph.height=height*pixelRatio;
 graph.style.cssText='display:block;width:420px;max-width:100%;height:auto;margin-top:6px';
 graph.setAttribute('role','img');
 graph.setAttribute('aria-label','Last 60 seconds of FPS, slowest frame, CPU, GPU, and wait times');
 const summary=document.createTextNode('Waiting for WebGPU frames…');
 panel.replaceChildren(summary,graph);
 const ctx=graph.getContext('2d');
 const fps={key:'fps',color:'#91d9fc'};
 const timings=[
  {key:'peak',label:'Slowest frame',color:'#ffb77d',x:46},
  {key:'cpu',label:'CPU',color:'#8ee2b6',x:156},
  {key:'gpu',label:'GPU',color:'#d4aaff',x:208},
  {key:'wait',label:'Wait',color:'#c2c8bf',x:260}
 ];
 const ms=value=>Number.isFinite(value)?value.toFixed(1)+' ms':'—';

 function drawPlot(top,bottom,unit,series,step,time){
  let maximum=step;
  for(const sample of samples)
   for(const {key} of series)
    if(Number.isFinite(sample[key]))maximum=Math.max(maximum,sample[key]);
  maximum=Math.ceil(maximum/step)*step;
  ctx.strokeStyle='#ffffff26';
  ctx.lineWidth=1;
  ctx.beginPath();
  for(const y of [top,(top+bottom)/2,bottom]){
   ctx.moveTo(left,y);ctx.lineTo(right,y);
  }
  for(const x of [left,(left+right)/2,right]){
   ctx.moveTo(x,top);ctx.lineTo(x,bottom);
  }
  ctx.stroke();
  ctx.fillStyle='#c1c5bb';
  ctx.fillText(maximum+' '+unit,0,top+9);
  ctx.fillText('0',0,bottom);
  for(const {key,color} of series){
   let previous;
   ctx.strokeStyle=ctx.fillStyle=color;
   ctx.lineWidth=1.5;
   ctx.beginPath();
   for(const sample of samples){
    if(!Number.isFinite(sample[key])){previous=undefined;continue;}
    const x=right+(sample.time-time)/historyMs*(right-left);
    const y=bottom-sample[key]/maximum*(bottom-top);
    if(previous!==undefined&&sample.time-previous<3000)ctx.lineTo(x,y);
    else {ctx.moveTo(x,y);ctx.fillRect(x-1,y-1,2,2);}
    previous=sample.time;
   }
   ctx.stroke();
  }
 }

 return d=>{
  if(!Number.isFinite(d.fps))return;
  const time=d.timeMs??(performance.timeOrigin+performance.now());
  // The first present can publish a report before it has a frame interval.
  if(d.maxFrameMs>0)samples.push({time,fps:d.fps,peak:d.maxFrameMs,cpu:d.simulationMs+d.renderMs,gpu:d.gpuMs,wait:d.waitMs});
  while(samples.length&&samples[0].time<time-historyMs)samples.shift();
  const adapter=[d.adapter.vendor,d.adapter.architecture,d.adapter.device].filter(Boolean).join(' ')||'Unknown';
  const vsync=d.pacing?(d.pacing.vsync?'on':'off'):'—';
  summary.data=[
   `${d.fps.toFixed(1)} FPS · ${d.width}×${d.height} · WebGPU ${adapter}${d.adapter.fallback?' (fallback)':''}`,
   `CPU simulation ${ms(d.simulationMs)} · render ${ms(d.renderMs)} · GPU ${ms(d.gpuMs)}`,
   `Slowest frame ${ms(d.maxFrameMs)} · wait ${ms(d.waitMs)} · budget ${ms(d.pacing?.limitMs)}`,
   `VSync ${vsync} · WebGPU validation errors ${d.validationErrors}`,
  ].join('\n');
  if(!ctx)return;
  ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);
  ctx.clearRect(0,0,width,height);
  ctx.font='10px ui-monospace, monospace';
  drawPlot(4,47,'FPS',[fps],30,time);
  drawPlot(57,115,'ms',timings,20,time);
  ctx.fillStyle='#c1c5bb';
  ctx.fillText('−60 s',left,128);
  ctx.fillText('−30 s',(left+right)/2-14,128);
  ctx.fillText('Now',right-18,128);
  for(const {label,color,x} of timings){
   ctx.fillStyle=color;
   ctx.fillText(label,x,146);
  }
 };
}

if(fpsCounter||showDiagnostics){
 const name='xray-gpu-telemetry-'+crypto.randomUUID();
 globalThis.__xrayGPUDiagnosticsChannel={name,detailed:showDiagnostics};
 const channel=new BroadcastChannel(name);
 const record=showDiagnostics?createDiagnosticsHistory(diagnostics):null;
 if(showDiagnostics){
  diagnostics.hidden=false;
 }
 channel.onmessage=({data:d})=>{
  if(fpsCounter&&Number.isFinite(d.fps)){
   fpsCounter.textContent=`${Math.round(d.fps)} FPS`;
   fpsCounter.hidden=false;
  }
  record?.(d);
 };
 window.addEventListener('pagehide',event=>{if(!event.persisted)channel.close();});
}
const mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
const indeterminate=()=>meter.removeAttribute('value');
const startingEngine=()=>{message.textContent='Starting the engine…';indeterminate();};
const confirmLeavingGame=event=>event.preventDefault();
window.addEventListener('xray-browser-navigation',()=>{
 window.removeEventListener('beforeunload',confirmLeavingGame);
});
const enterGame=()=>{
 enteredGame=true;
 boot.hidden=true;
 window.addEventListener('beforeunload',confirmLeavingGame);
 canvas.inert=false;
 canvas.focus({preventScroll:true});
};
const gameReady=()=>{
 startupReady=true;
 if(!start||start.hidden){enterGame();return;}
 meter.value=meter.max;
 detail.textContent='Game data loaded.';
 message.textContent='Ready to play.';
 updateStart();
};
start?.addEventListener('click',event=>{
 if(start.disabled||enteredGame)return;
 if(event.isTrusted)window.dispatchEvent(new Event('xray-game-start-pressed'));
 enterGame();
 // The Start Game click also supplies the browser gesture for mouse capture.
 canvas.requestPointerLock?.()?.catch(()=>{});
});

if(backupButton && !backupButton.hidden && navigator.storage?.getDirectory){
 backupButton.disabled=false;
 backupButton.addEventListener('click',async()=>{
  backingUp=true;
  backupButton.disabled=true;
  const deleteWasDisabled=deleteButton?.disabled;
  if(deleteButton)deleteButton.disabled=true;
  backupStatus.textContent='Preparing save backup…';
  updateStart();
  try{
   const {openSaveDirectory,prepareSaveBackup}=await import('./save-format.js');
   const root=new URLSearchParams(location.search).has('stream')?'stream-cop':document.querySelector('#game').value;
   const backup=await prepareSaveBackup(await openSaveDirectory(root));
   const url=URL.createObjectURL(backup.blob);
   const link=document.createElement('a');
   link.href=url;
   link.download=backup.filename;
   boot.append(link);
   link.click();
   link.remove();
   setTimeout(()=>URL.revokeObjectURL(url),30000);
   backupStatus.textContent='Backup download started.';
  }catch(error){
   backupStatus.textContent=error.name==='NotFoundError'?'There are no single-player saves to download yet.':error.message;
  }finally{
   backingUp=false;
   backupButton.disabled=false;
   if(deleteButton)deleteButton.disabled=deleteWasDisabled;
   updateStart();
  }
 });
}
window.addEventListener('xray-engine-progress',({detail:p})=>{
 if(startupReady||broken)return;
 message.textContent='Preparing game files…';
 meter.max=p.total;meter.value=p.done;
 detail.textContent=`${p.done.toLocaleString()} / ${p.total.toLocaleString()} files checked`;
 if(p.done===p.total)startingEngine();
});
window.addEventListener('xray-stream-progress',({detail:p})=>{
 if(p.phase!=='install'||startupReady||broken)return;
 if(p.error){fail(p.error);indeterminate();return;}
 installing=!p.ready;
 if(p.ready){startingEngine();return;}
 message.textContent=p.active?'Downloading the game…':'Checking installed game data…';
 if(p.packBytes){
  meter.max=p.packBytes;meter.value=p.checkedBytes;
  detail.textContent=`${mb(p.checkedBytes)} / ${mb(p.packBytes)} ready · ${mb(p.downloadedBytes+p.received)} downloaded`;
 }else{indeterminate();detail.textContent='Reading the game manifest…';}
});
window.addEventListener('xray-engine-log',({detail:line})=>{
 if(/Archive (read|stat) failed/.test(line))fail('Installed game data could not be read. Reload to repair it.');
});
const observe=()=>{
 if(broken)return;
 const text=status.textContent,sync=ingest.textContent;
 const error=/failed|unavailable|needs |lacks |No WebGPU/i;
 if(error.test(text)||error.test(sync)){fail(error.test(text)?text:sync);return;}
 if(startupReady||installing)return;
 if(multiplayer){if(text.startsWith('C++ tick'))gameReady();else if(text)message.textContent=text;return;}
 if(text!=='engine running')return;
 const gpu=document.querySelector('#webgpu-stats')?.textContent||'';
 const frames=Number(gpu.match(/([0-9]+) frames/)?.[1]||0);
 if(firstMenuFrame===null&&frames>2&&log.textContent.includes('Loading script: game_registrator.script'))firstMenuFrame=frames;
 if(firstMenuFrame!==null&&frames>firstMenuFrame+2){gameReady();return;}
 message.textContent='Loading the game…';indeterminate();
};
const observer=new MutationObserver(observe);observer.observe(status,{childList:true,characterData:true,subtree:true});observer.observe(ingest,{childList:true,characterData:true,subtree:true});observer.observe(log,{childList:true,characterData:true,subtree:true});
if(!isSecureContext||!crossOriginIsolated||!navigator.gpu||!navigator.storage?.getDirectory){fail('This game needs a desktop browser with WebGPU and local file storage. Please use a current Chrome or Edge browser.');retry.hidden=true;}
else {
 try{
 await import(multiplayer?'./public-ui.mjs':'./main.js');const gpu=document.querySelector('#webgpu-stats');if(gpu)observer.observe(gpu,{childList:true,characterData:true,subtree:true});observe();}
 catch(error){fail(error.message||'The game could not start. Check your connection and try again.');}
}
