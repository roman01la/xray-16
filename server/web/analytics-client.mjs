import {createMovementTracker} from './analytics-movement.mjs';
const browserKey = 'xray-analytics-browser-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function getBrowserId() {
  const readOrCreate = () => {
    const saved = localStorage.getItem(browserKey);
    if (uuid.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(browserKey,id);
    return id;
  };
  return navigator.locks
    ? navigator.locks.request(browserKey,readOrCreate)
    : readOrCreate();
}

export function startCampaignAnalytics(gameId = 'cop') {
  const params = new URLSearchParams(location.search);
  if (!/^\/releases\/[a-f0-9]{64}\/index\.html$/.test(location.pathname) ||
      !params.has('stream') ||
      params.get('storage') === 'manage' || params.get('saves') === 'import' || params.has('save')) return;

  // Keep CoP's existing pending events readable after a release update.
  const suffix = gameId === 'cop' ? '' : ':' + gameId;
  const installKey = 'xray-analytics-pending-install-v1' + suffix;
  const browser = getBrowserId().catch(() => null);
  async function send(event,eventId,data) {
    try {
      const browserId = await browser;
      if (!browserId) return false;
      const response = await fetch('/analytics/event',{
        method:'POST', mode:'same-origin', credentials:'omit', referrerPolicy:'no-referrer',
        keepalive:true, headers:{'Content-Type':'application/json'},
        body:JSON.stringify({event,gameId,browserId,eventId:eventId ?? crypto.randomUUID(),...(data?{data}:{})}),
      });
      return response.status === 204;
    } catch {return false;}
  }

  let sendingInstall = false;
  async function sendInstall(firstInstall = false) {
    if (sendingInstall) return;
    sendingInstall = true;
    try {
      let eventId = localStorage.getItem(installKey);
      if (!uuid.test(eventId)) {
        if (!firstInstall) return;
        eventId = crypto.randomUUID();
        localStorage.setItem(installKey,eventId);
      }
      // Keep a completed first install until the server acknowledges it.
      if (await send('install',eventId) && localStorage.getItem(installKey) === eventId)
        localStorage.removeItem(installKey);
    } catch {} finally {sendingInstall = false;}
  }

  const sessionId=crypto.randomUUID(), release=location.pathname.split('/')[2];
  let movementStorage;
  try { movementStorage=localStorage; } catch {}
  const movement = createMovementTracker({gameId, sessionId, release, send, storage:movementStorage});
  setInterval(() => { void movement.flush(); }, 60000);
  let device={}, lastDevice='', windowStart=performance.now(), totals=null, lastRender={};
  // Persist cumulative checkpoints, not deltas, so retrying cannot inflate totals.
  const playtimePrefix='xray-analytics-playtime-v1'+suffix+':';
  let playtimeMs=0,lastPlaytimeFlush=performance.now();
  async function deliverPlaytime(key,data){
    if(await send('playtime',undefined,data)){
      try{if(localStorage.getItem(key)===JSON.stringify(data))localStorage.removeItem(key);}catch{}
    }
  }
  function flushPlaytime(){
    if(playtimeMs<1)return;
    lastPlaytimeFlush=performance.now();
    const data={sessionId,release,elapsedMs:Math.floor(playtimeMs)},key=playtimePrefix+sessionId;
    try{localStorage.setItem(key,JSON.stringify(data));}catch{}
    void deliverPlaytime(key,data);
  }
  // Failed/offline checkpoints survive reload and are delivered with their original session.
  try{
    const pending=[];
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(playtimePrefix))pending.push(key);}
    for(const key of pending){
      try{const data=JSON.parse(localStorage.getItem(key));
        if(uuid.test(data.sessionId)&&key===playtimePrefix+data.sessionId&&/^[a-f0-9]{64}$/.test(data.release)&&Number.isSafeInteger(data.elapsedMs)&&data.elapsedMs>0&&data.elapsedMs<=31536000000)void deliverPlaytime(key,data);
      }catch{}
    }
  }catch{}

  const ua=navigator.userAgent;
  const match=ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/);
  device={sessionId,release,userAgent:ua,platform:navigator.platform||'',
    browser:match?`${match[1]==='Version'?'Safari':match[1]} ${match[2]}`:'Unknown',
    os:/Windows/.test(ua)?'Windows':/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Mac/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'Unknown',
    mobile:navigator.userAgentData?.mobile??/Mobile|Android|iPhone|iPad/.test(ua),
    cores:navigator.hardwareConcurrency??null,memoryGB:navigator.deviceMemory??null,
    screenWidth:screen.width,screenHeight:screen.height,availableWidth:screen.availWidth,availableHeight:screen.availHeight,
    dpr:devicePixelRatio,colorDepth:screen.colorDepth,touchPoints:navigator.maxTouchPoints,
    language:navigator.language,webgpu:!!navigator.gpu,crossOriginIsolated:globalThis.crossOriginIsolated,
    connection:navigator.connection?.effectiveType??null,saveData:navigator.connection?.saveData??null};
  const reportDevice=()=>{const text=JSON.stringify(device);if(text!==lastDevice){lastDevice=text;void send('device',undefined,device)}};
  reportDevice();
  navigator.userAgentData?.getHighEntropyValues?.(['architecture','bitness','model','platform','platformVersion','fullVersionList']).then(v=>{
    Object.assign(device,{architecture:v.architecture,bitness:v.bitness,model:v.model,os:v.platform||device.os,osVersion:v.platformVersion,
      browser:v.fullVersionList?.filter(x=>!/^Not/.test(x.brand)).map(x=>x.brand+' '+x.version).join(', ')||device.browser});reportDevice();
  }).catch(()=>{});
  function flushPerformance(){
    if(!totals)return;
    const a=totals;totals=null;windowStart=performance.now();
    if(a.elapsedMs<5000)return;
    const percentile=q=>{let count=0;for(const bin of Object.keys(a.hist).map(Number).sort((a,b)=>a-b)){count+=a.hist[bin];if(count>=a.frames*q)return bin}return 1000};
    void send('performance',undefined,{sessionId,release,...lastRender,frames:a.frames,elapsedMs:a.elapsedMs,
      avgFps:1000*a.frames/a.elapsedMs,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),
      maxMs:a.maxMs,stalls50:a.stalls50,stalls100:a.stalls100});
  }
  window.addEventListener('xray-performance',({detail:d})=>{
    if(document.hidden)return;
    if(d.adapter){Object.assign(device,{gpuVendor:d.adapter.vendor||'',gpuArchitecture:d.adapter.architecture||'',gpuDevice:d.adapter.device||'',
      gpuDescription:d.adapter.description||'',gpuFallback:!!d.adapter.fallback,gpuFeatures:d.adapter.features||'',
      maxTextureDimension2D:d.adapter.maxTextureDimension2D,maxBufferSize:d.adapter.maxBufferSize});reportDevice()}
    if(totals&&(lastRender.width!==d.width||lastRender.height!==d.height||lastRender.vsync!==d.pacing?.vsync||lastRender.fpsCap!==(d.pacing?.limitMs?1000/d.pacing.limitMs:0)))flushPerformance();
    lastRender={width:d.width,height:d.height,viewportWidth:innerWidth,viewportHeight:innerHeight,vsync:d.pacing?.vsync,
      fpsCap:d.pacing?.limitMs?1000/d.pacing.limitMs:0,validationErrors:d.validationErrors??0};
    const a=d.gameplayPerformance;if(!a?.frames)return;
    if(Number.isFinite(a.elapsedMs)&&a.elapsedMs>0&&a.elapsedMs<=3600000){playtimeMs+=a.elapsedMs;if(performance.now()-lastPlaytimeFlush>=30000)flushPlaytime();}
    totals??={frames:0,elapsedMs:0,maxMs:0,stalls50:0,stalls100:0,hist:{}};
    for(const k of ['frames','elapsedMs','stalls50','stalls100'])totals[k]+=a[k];
    totals.maxMs=Math.max(totals.maxMs,a.maxMs);
    for(const [bin,n] of Object.entries(a.hist))totals.hist[bin]=(totals.hist[bin]||0)+n;
    if(performance.now()-windowStart>=60000)flushPerformance();
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){flushPerformance();flushPlaytime();void movement.flush();}});
  window.addEventListener('pagehide',()=>{flushPerformance();flushPlaytime();void movement.flush();});
  window.addEventListener('online',()=>{flushPlaytime();void movement.flush();});
  void send('visit');
  void sendInstall();
  window.addEventListener('xray-stream-progress',({detail}) => {
    if (detail.phase === 'install' && detail.ready && detail.firstInstall) void sendInstall(true);
  });
  window.addEventListener('xray-game-start-pressed',() => {void send('start_game');});
  window.addEventListener('xray-engine-log',({detail}) => {
    const position = /^XRAY_ANALYTICS position ([a-zA-Z0-9_]+)[\\/]? ([-\d.]+) ([-\d.]+) ([-\d.]+)$/.exec(detail);
    if (position && !document.hidden) movement.add({map:position[1].toLowerCase(),t:Date.now(),x:Number(position[2]),y:Number(position[3]),z:Number(position[4])});
    if (detail === 'XRAY_ANALYTICS new_campaign') void send('new_campaign');
    if (detail === 'XRAY_ANALYTICS load_save') void send('load_save');
  });
}
