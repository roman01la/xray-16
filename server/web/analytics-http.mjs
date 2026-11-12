import {validMovementData} from './analytics-movement.mjs';
import {trackViewerScript} from './analytics-tracks.mjs';
import {performanceSortingScript} from './analytics-sort.mjs';
import {analyticsEvents, analyticsGames} from './analytics-events.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateAnalyticsEvent(value) {
  const telemetry = ['device','performance','playtime','movement'].includes(value?.event);
  if (!value || typeof value !== 'object' ||
      Object.keys(value).some(key => !['event','browserId','eventId','gameId', ...(telemetry ? ['data'] : [])].includes(key)) ||
      !analyticsEvents.has(value.event) || typeof value.browserId !== 'string' ||
      typeof value.eventId !== 'string' || !uuid.test(value.browserId) || !uuid.test(value.eventId))
    return null;
  const {event,browserId,eventId,gameId = 'cop'} = value;
  if (!analyticsGames.has(gameId)) return null;
  const record = {event,browserId,eventId,gameId};
  if(telemetry){
    const data=value.data;
    const deviceKeys='sessionId release userAgent platform browser os mobile cores memoryGB screenWidth screenHeight availableWidth availableHeight dpr colorDepth touchPoints language webgpu crossOriginIsolated connection saveData architecture bitness model osVersion gpuVendor gpuArchitecture gpuDevice gpuDescription gpuFallback gpuFeatures maxTextureDimension2D maxBufferSize'.split(' ');
    const perfKeys='sessionId release width height viewportWidth viewportHeight vsync fpsCap validationErrors frames elapsedMs avgFps p50Ms p95Ms p99Ms maxMs stalls50 stalls100'.split(' ');
    if(!data||typeof data!=='object'||Array.isArray(data)||!uuid.test(data.sessionId)||!/^[a-f0-9]{64}$/.test(data.release))return null;
    if(value.event==='movement') return validMovementData(data) ? {...record,data} : null;
    if(value.event==='playtime'){
      if(Object.keys(data).length!==3||!Number.isSafeInteger(data.elapsedMs)||data.elapsedMs<1||data.elapsedMs>31536000000)return null;
      return {...record,data};
    }
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
    return {...record,data};
  }
  return record;
}

const labels = {
  visit: 'Visits',
  install: 'First completed game installs',
  start_game: 'Start Game presses',
  new_campaign: 'New campaigns started',
  load_save: 'Successful save loads',
};

export function analyticsDashboard({browsers,events,devices=[],performance=[],playtime={totalMs:0,players:0},playtimeUsers=[]}, nonce = '', gameId = 'cop') {
  const counts = new Map(events.map(row => [row.event,row]));
  const number = value => Number(value).toLocaleString('en');
  const rows = Object.entries(labels).map(([event,label]) => {
    const row = counts.get(event);
    return `<tr><th scope="row">${label}</th><td>${number(row?.browsers ?? 0)}</td><td>${number(row?.total ?? 0)}</td></tr>`;
  }).join('\n');
  const escape=v=>String(v??'Unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const gameName = escape(analyticsGames.get(gameId));
  const gameLinks = Array.from(analyticsGames, ([id, name]) =>
    `<a href="/analytics?game=${id}"${id === gameId ? ' aria-current="page"' : ''}>${escape(name)}</a>`).join('');
  const duration=ms=>{const seconds=Math.floor(Number(ms||0)/1000);return `${Math.floor(seconds/3600)}h ${Math.floor(seconds/60)%60}m ${seconds%60}s`;};
  const playRows=playtimeUsers.map(r=>`<tr><th scope="row">${escape(r.browser_id)}</th><td>${duration(r.elapsed_ms)}</td><td>${number(r.sessions)}</td></tr>`).join('');
  const numeric = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const cell = (value, key) => `<td data-sort="${escape(JSON.stringify(key))}">${value}</td>`;
  const perfRows = performance.map(r => `<tr>${[
    cell(`${escape(r.os)}<br>${escape(r.browser)}`, [r.os ?? null, r.browser ?? null]),
    cell(escape(r.gpu), [r.gpu ?? null]),
    cell(escape(r.cores), [numeric(r.cores)]),
    cell(`${r.vsync ? 'On' : 'Off'} / ${Number(r.cap || 0).toFixed(0)}`, [Number(Boolean(r.vsync)), numeric(r.cap)]),
    cell(`${escape(r.width)}×${escape(r.height)}`, [r.width == null || r.height == null ? null : r.width * r.height, numeric(r.width), numeric(r.height)]),
    cell(number(r.users), [numeric(r.users)]),
    cell(Number(r.minutes).toFixed(1), [numeric(r.minutes)]),
    cell(Number(r.fps).toFixed(1), [numeric(r.fps)]),
    cell(Number(r.p95).toFixed(1), [numeric(r.p95)]),
    cell(number(r.stalls), [numeric(r.stalls)]),
    cell(Number(r.worst).toFixed(1), [numeric(r.worst)]),
  ].join('')}</tr>`).join('');
  const perfHeaders = ['OS / browser','GPU','CPU threads','VSync / FPS cap','Render size','Browsers','Minutes','Avg FPS','Mean P95 ms','Stalls >100ms','Worst ms']
    .map((label, index) => `<th scope="col"${index === 6 ? ' aria-sort="descending"' : ''}><button type="button">${escape(label)}</button></th>`).join('');
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
th button{font:inherit;font-weight:600;color:inherit;background:none;border:0;padding:.25rem;cursor:pointer;text-align:inherit}
th button::after{content:' ↕';color:#aaa}th[aria-sort="ascending"] button::after{content:' ↑'}th[aria-sort="descending"] button::after{content:' ↓'}
th button:focus-visible{outline:2px solid #c9d6a5;outline-offset:2px}
nav{display:flex;flex-wrap:wrap;gap:.5rem}
nav a{color:inherit;padding:.35rem .6rem;border:1px solid #65684f}
nav a[aria-current="page"]{background:#373c2a;font-weight:600}
.track-controls{display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0}.track-controls label{display:flex;flex-direction:column;gap:.3rem}.track-controls input,.track-controls select{font:inherit;padding:.4rem;max-width:100%}.track-controls [name=user]{width:24rem}.track-map{width:100%;max-height:70vh;overflow:auto;background:#0d100b}.track-map canvas{display:block;margin:auto}.track-output{display:block;min-height:1.5em}
</style>
<main>
  <h1>Game analytics</h1>
  <nav aria-label="Game">${gameLinks}</nav>
  <h2>${gameName}</h2>
  <p>All time since analytics was enabled.</p>
  <p>Unique browsers <strong>${number(browsers)}</strong></p>
  <table aria-label="Game activity totals">
    <thead><tr><th scope="col">Activity</th><th scope="col">Unique browsers</th><th scope="col">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Cumulative playtime</h2>
  <p>Total <strong>${duration(playtime.totalMs)}</strong> · ${number(playtime.players)} browsers played · average ${duration(playtime.players?playtime.totalMs/playtime.players:0)} per playing browser.</p>
  <p>Since playtime tracking was enabled. Active, visible gameplay only; downloading, loading, menus and engine pauses excluded. Totals persist beyond the 30-day performance retention. Anonymous browser identity; clearing site storage creates a new identity. Concurrent visible game sessions count separately. Latest unreported time may be lost on a crash.</p>
  <table aria-label="Cumulative playtime by browser"><thead><tr><th scope="col">Browser ID</th><th scope="col">Total playtime</th><th scope="col">Game sessions</th></tr></thead><tbody>${playRows}</tbody></table>
  <p>Top 200 browsers by total playtime.</p>
  <section id="movement" data-game="${escape(gameId)}">
    <h2>Movement tracks — last 30 days</h2>
    <p>Samples every 10 seconds during active gameplay, uploaded every minute. Select a browser ID, session and map. The list includes the 200 most recently active tracked browsers. You can also paste a browser ID.</p>
    <div class="track-controls">
      <label>User<input name="user" list="track-users" autocomplete="off" placeholder="Browser ID"><datalist id="track-users"></datalist></label>
      <label>Session<select name="session" aria-label="Game session"></select></label>
      <label>Map<select name="map" aria-label="Game map"></select></label>
      <label>Zoom<input name="zoom" type="range" min="1" max="4" step="0.25" value="1"></label>
    </div>
    <p role="status">Loading movement data…</p>
    <output class="track-output" aria-live="polite"></output>
    <div class="track-map"><canvas hidden aria-label="Player path on the original game map"></canvas></div>
  </section>
  <h2>Gameplay performance — last 30 days</h2>
  <p>FPS is total rendered frames / observed gameplay time. Hidden tabs, loading and engine pauses excluded. P95 is the mean of per-window P95 frame times (1 ms histogram bins, capped at 1000 ms), not a global percentile. Stall counts are frames over 100 ms. Up to 200 device groups shown.</p>
  <p>Click a column heading to sort; click again to reverse. Render size sorts by pixel count; VSync / FPS cap by VSync, then cap.</p>
  <div style="overflow:auto"><table id="performance" aria-label="Gameplay performance"><thead><tr>${perfHeaders}</tr></thead><tbody>${perfRows}</tbody></table></div>
  <h2>Recent device sessions</h2><p>Browser-reported data; missing values are unknown. Latest 200 sessions, retained 30 days.</p>${deviceRows}
  <p>A visit begins when a browser first opens this game or returns after 30 minutes without recorded activity in this game.
     Successful save loads are a signal that players continued a campaign.</p>
</main>
<script nonce="${escape(nonce)}">${performanceSortingScript}\n${trackViewerScript}</script>
</html>`;
}
