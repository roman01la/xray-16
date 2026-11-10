import {analyticsEvents} from './analytics-store.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateAnalyticsEvent(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== (['device','performance'].includes(value.event)?4:3) ||
      !analyticsEvents.has(value.event) || typeof value.browserId !== 'string' ||
      typeof value.eventId !== 'string' || !uuid.test(value.browserId) || !uuid.test(value.eventId))
    return null;
  if(['device','performance'].includes(value.event)){
    const data=value.data;
    const deviceKeys='sessionId release userAgent platform browser os mobile cores memoryGB screenWidth screenHeight availableWidth availableHeight dpr colorDepth touchPoints language webgpu crossOriginIsolated connection saveData architecture bitness model osVersion gpuVendor gpuArchitecture gpuDevice gpuDescription gpuFallback gpuFeatures maxTextureDimension2D maxBufferSize'.split(' ');
    const perfKeys='sessionId release width height viewportWidth viewportHeight vsync fpsCap validationErrors frames elapsedMs avgFps p50Ms p95Ms p99Ms maxMs stalls50 stalls100'.split(' ');
    if(!data||typeof data!=='object'||Array.isArray(data)||!uuid.test(data.sessionId)||!/^[a-f0-9]{64}$/.test(data.release))return null;
    const allowed=value.event==='device'?deviceKeys:perfKeys;
    const numeric='cores memoryGB screenWidth screenHeight availableWidth availableHeight dpr colorDepth touchPoints maxTextureDimension2D maxBufferSize width height viewportWidth viewportHeight fpsCap validationErrors frames elapsedMs avgFps p50Ms p95Ms p99Ms maxMs stalls50 stalls100'.split(' ');
    const boolean='mobile webgpu crossOriginIsolated saveData gpuFallback vsync'.split(' ');
    for(const [key,v] of Object.entries(data)){
      if(v!==null&&typeof v!==(numeric.includes(key)?'number':boolean.includes(key)?'boolean':'string'))return null;
      if(!allowed.includes(key)||!['string','number','boolean'].includes(typeof v)&&v!==null)return null;
      if(typeof v==='string'&&v.length>1024||typeof v==='number'&&(!Number.isFinite(v)||v<0||v>2**40))return null;
    }
    if(value.event==='performance'){
      for(const key of ['frames','elapsedMs','avgFps','p50Ms','p95Ms','p99Ms','maxMs','stalls50','stalls100'])if(typeof data[key]!=='number')return null;
      if(!Number.isInteger(data.frames)||data.frames<1||data.frames>1000000||data.elapsedMs<5000||data.elapsedMs>3600000||data.avgFps>2000||
         Math.abs(data.avgFps-data.frames*1000/data.elapsedMs)>.01||data.p50Ms>data.p95Ms||data.p95Ms>data.p99Ms||!Number.isInteger(data.stalls50)||!Number.isInteger(data.stalls100)||data.stalls100>data.stalls50||data.stalls50>data.frames)return null;
    }
    return {event:value.event,browserId:value.browserId,eventId:value.eventId,data};
  }
  const {event,browserId,eventId} = value;
  return {event,browserId,eventId};
}

const labels = {
  visit: 'Visits',
  install: 'First completed game installs',
  start_game: 'Start Game presses',
  new_campaign: 'New campaigns started',
  load_save: 'Successful save loads',
};

export function analyticsDashboard({browsers,events,devices=[],performance=[]}) {
  const counts = new Map(events.map(row => [row.event,row]));
  const number = value => Number(value).toLocaleString('en');
  const rows = Object.entries(labels).map(([event,label]) => {
    const row = counts.get(event);
    return `<tr><th scope="row">${label}</th><td>${number(row?.browsers ?? 0)}</td><td>${number(row?.total ?? 0)}</td></tr>`;
  }).join('\n');
  const escape=v=>String(v??'Unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const perfRows=performance.map(r=>`<tr><td>${escape(r.os)}<br>${escape(r.browser)}</td><td>${escape(r.gpu)}</td><td>${escape(r.cores)}</td><td>${r.vsync?"On":"Off"} / ${Number(r.cap||0).toFixed(0)}</td><td>${escape(r.width)}×${escape(r.height)}</td><td>${number(r.users)}</td><td>${Number(r.minutes).toFixed(1)}</td><td>${Number(r.fps).toFixed(1)}</td><td>${Number(r.p95).toFixed(1)}</td><td>${number(r.stalls)}</td><td>${Number(r.worst).toFixed(1)}</td></tr>`).join('');
  const deviceRows=devices.map(r=>{const d=JSON.parse(r.data);return `<details><summary>${escape(d.os)} · ${escape(d.browser)} · ${escape(d.gpuDescription||d.gpuDevice||d.gpuVendor)} · ${escape(d.cores)} logical cores</summary><dl>${Object.entries(d).filter(([k])=>k!=='sessionId').map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl></details>`}).join('');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>S.T.A.L.K.E.R. Analytics</title>
<style>
html{color-scheme:dark;background:#161812;color:#eee;font:16px/1.5 system-ui,sans-serif}
main{max-width:90rem;margin:3rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}
th,td{padding:.65rem .4rem;border-bottom:1px solid #46483c;text-align:right}
th:first-child{text-align:left}p{color:#bbb}
</style>
<main>
  <h1>Game analytics</h1>
  <p>All time since analytics was enabled.</p>
  <p>Unique browsers <strong>${number(browsers)}</strong></p>
  <table aria-label="Game activity totals">
    <thead><tr><th scope="col">Activity</th><th scope="col">Unique browsers</th><th scope="col">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Gameplay performance — last 30 days</h2>
  <p>FPS is total rendered frames / observed gameplay time. Hidden tabs, loading and engine pauses excluded. P95 is the mean of per-window P95 frame times (1 ms histogram bins, capped at 1000 ms), not a global percentile. Stall counts are frames over 100 ms. Up to 200 device groups shown.</p>
  <div style="overflow:auto"><table><thead><tr><th>OS / browser</th><th>GPU</th><th>CPU threads</th><th>VSync / FPS cap</th><th>Render size</th><th>Browsers</th><th>Minutes</th><th>Avg FPS</th><th>Mean P95 ms</th><th>Stalls &gt;100ms</th><th>Worst ms</th></tr></thead><tbody>${perfRows}</tbody></table></div>
  <h2>Recent device sessions</h2><p>Browser-reported data; missing values are unknown. Latest 200 sessions, retained 30 days.</p>${deviceRows}
  <p>A visit begins when a browser opens the game after 30 minutes without recorded activity.
     Successful save loads are a signal that players continued a campaign.</p>
</main>
</html>`;
}
