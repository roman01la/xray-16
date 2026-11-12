import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openAnalytics} from './analytics-store.mjs';

const event = (kind,browserId) => ({event:kind,browserId,eventId:randomUUID()});

test('visits roll after inactivity, installs are unique and repeated gameplay is counted',() => {
  const db = openAnalytics(':memory:');
  try {
    const a = randomUUID(), b = randomUUID(), minute = 60000;
    const start = event('start_game',a);
    db.record(event('visit',a),0);
    db.record(event('visit',a),minute);
    db.record(start,20*minute);
    db.record(start,21*minute);
    db.record(event('visit',a),40*minute);
    db.record(event('visit',a),70*minute);
    db.record(event('install',a),71*minute);
    db.record(event('install',a),72*minute);
    db.record(event('load_save',a),73*minute);
    db.record(event('load_save',a),74*minute);
    db.record(event('load_save',b),74*minute);
    db.record(event('visit',b),75*minute);
    db.record(event('new_campaign',b),76*minute);
    const {browsers,events} = db.summary();
    assert.equal(browsers,2);
    assert.deepEqual(Object.fromEntries(events.map(row=>[row.event,[row.browsers,row.total]])),{
      visit:[2,3], install:[1,1], start_game:[1,1], new_campaign:[1,1], load_save:[2,3],
    });
  } finally {db.close();}
});

test('device/performance validation, deduplication, weighted FPS and escaped dashboard',async()=>{
 const {validateAnalyticsEvent,analyticsDashboard}=await import('./analytics-http.mjs');
 const db=openAnalytics(':memory:'),browserId=randomUUID(),sessionId=randomUUID(),release='a'.repeat(64);
 const device={...event('device',browserId),data:{sessionId,release,os:'Test OS',browser:'Browser',gpuDescription:'<script>bad</script>',cores:8}};
 const sample=(frames,elapsedMs)=>({...event('performance',browserId),data:{sessionId,release,frames,elapsedMs,avgFps:frames*1000/elapsedMs,p50Ms:16,p95Ms:32,p99Ms:100,maxMs:200,stalls50:2,stalls100:1,width:1920,height:1080}});
 try{
  assert.ok(validateAnalyticsEvent(device));db.record(device);
  const a=sample(600,10000),b=sample(600,20000);assert.ok(validateAnalyticsEvent(a));db.record(a);db.record(a);db.record(b);
  const summary=db.summary();assert.equal(summary.performance[0].samples,2);assert.equal(summary.performance[0].fps,40);
  assert.equal(summary.events.length,0,'telemetry does not inflate visits');
  const page=analyticsDashboard(summary);assert.ok(page.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!page.includes('<script>bad'));
  assert.equal(validateAnalyticsEvent({...a,data:{...a.data,avgFps:900}}),null);
  assert.equal(validateAnalyticsEvent({...device,data:{...device.data,privateSave:'no'}}),null);
  assert.equal(validateAnalyticsEvent({...a,data:{...a.data,p95Ms:Infinity}}),null);
 }finally{db.close()}
});

test('browser client sends device info and gameplay summary without hidden-tab frames',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:1700000000000});
 const saved=new Map(),keys=['window','document','navigator','screen','location','localStorage','fetch','innerWidth','innerHeight','devicePixelRatio','crossOriginIsolated'];
 for(const key of keys)saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 const posts=[],storage=new Map(),window=new EventTarget(),document=new EventTarget();document.hidden=false;
 const priorSession=randomUUID();storage.set('xray-analytics-playtime-v1:'+priorSession,JSON.stringify({sessionId:priorSession,release:'a'.repeat(64),elapsedMs:3000}));
 const values={window,document,navigator:{userAgent:'Mozilla Windows Chrome/140.0',platform:'Win32',hardwareConcurrency:8,deviceMemory:8,language:'en',maxTouchPoints:0,gpu:{}},screen:{width:2560,height:1440,availWidth:2560,availHeight:1400,colorDepth:24},location:{pathname:'/releases/'+'a'.repeat(64)+'/index.html',search:'?stream=/pack'},localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},innerWidth:1280,innerHeight:720,devicePixelRatio:2,crossOriginIsolated:true,fetch:async(_url,options)=>{posts.push(JSON.parse(options.body));return {status:204}}};
 try{
  for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {startCampaignAnalytics}=await import('./analytics-client.mjs');startCampaignAnalytics();
  for(let i=0;i<5;i++) {
   t.mock.timers.tick(10000);
   window.dispatchEvent(new CustomEvent('xray-engine-log',{detail:'XRAY_ANALYTICS position l01_escape\\ 30.000 2.000 -100.000'}));
  }
  await new Promise(setImmediate);
  assert.equal(posts.filter(p=>p.event==='movement').length,0,'positions wait for the minute batch');
  t.mock.timers.tick(10000);await new Promise(setImmediate);
  assert.equal(posts.find(p=>p.event==='movement').data.points.length,5);
  assert.equal(posts.find(p=>p.event==='movement').data.points[0].map,'l01_escape');
  const detail={width:1280,height:720,pacing:{vsync:true,limitMs:1000/60},adapter:{vendor:'TestGPU'},gameplayPerformance:{frames:360,elapsedMs:6000,maxMs:30,stalls50:0,stalls100:0,hist:{17:360}}};
  document.hidden=true;window.dispatchEvent(new CustomEvent('xray-performance',{detail}));
  document.hidden=false;window.dispatchEvent(new CustomEvent('xray-performance',{detail}));window.dispatchEvent(new Event('pagehide'));
  await new Promise(setImmediate);
  const sample=posts.find(p=>p.event==='performance');assert.equal(sample.data.frames,360);assert.equal(sample.data.avgFps,60);assert.equal(sample.data.p95Ms,17);assert.equal(sample.data.width,1280);
  assert.ok(posts.every(post=>post.gameId==='cop'));
  assert.ok(posts.some(p=>p.event==='device'&&p.data.cores===8));
  assert.ok(posts.some(p=>p.event==='playtime'&&p.data.sessionId===priorSession&&p.data.elapsedMs===3000),'pending prior-session checkpoint retried on startup');
  assert.equal(posts.find(p=>p.event==='playtime'&&p.data.sessionId===sample.data.sessionId).data.elapsedMs,6000,'hidden gameplay is excluded');
  const previousPerformanceCount=posts.filter(p=>p.event==='performance').length;
  window.dispatchEvent(new CustomEvent('xray-performance',{detail:{...detail,gameplayPerformance:{...detail.gameplayPerformance,frames:120,elapsedMs:2000,hist:{17:120}}}}));
  let offline=true;globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);posts.push(body);return {status:body.event==='playtime'&&offline?503:204};};
  window.dispatchEvent(new Event('pagehide'));await new Promise(setImmediate);
  assert.equal(posts.filter(p=>p.event==='performance').length,previousPerformanceCount,'short performance windows are omitted');
  assert.equal(posts.filter(p=>p.event==='playtime').at(-1).data.elapsedMs,8000,'short gameplay still contributes to playtime');
  assert.ok([...storage.keys()].some(k=>k.startsWith('xray-analytics-playtime-v1:')),'failed checkpoint survives');
  offline=false;window.dispatchEvent(new Event('online'));await new Promise(setImmediate);
  assert.equal(posts.filter(p=>p.event==='playtime').at(-1).data.elapsedMs,8000,'retry sends cumulative total');
  assert.equal([...storage.keys()].filter(k=>k.startsWith('xray-analytics-playtime-v1:')).length,0,'acknowledged checkpoint removed');

  const legacyPending=randomUUID(),socPending=randomUUID();
  const pending=sessionId=>JSON.stringify({sessionId,release:'a'.repeat(64),elapsedMs:1500});
  storage.set('xray-analytics-playtime-v1:'+legacyPending,pending(legacyPending));
  storage.set('xray-analytics-playtime-v1:soc:'+socPending,pending(socPending));
  globalThis.window=new EventTarget();
  globalThis.document=new EventTarget();
  const firstSocPost=posts.length;
  startCampaignAnalytics('soc');
  globalThis.window.dispatchEvent(new CustomEvent('xray-stream-progress',{detail:{phase:'install',ready:true,firstInstall:true}}));
  await new Promise(setImmediate);
  const socPosts=posts.slice(firstSocPost);
  assert.ok(socPosts.every(post=>post.gameId==='soc' && post.browserId===sample.browserId));
  assert.ok(socPosts.some(post=>post.event==='playtime' && post.data.sessionId===socPending));
  assert.ok(socPosts.some(post=>post.event==='install'));
  assert.ok(storage.has('xray-analytics-playtime-v1:'+legacyPending));
  const csPending=randomUUID();
  storage.set('xray-analytics-playtime-v1:cs:'+csPending,pending(csPending));
  globalThis.window=new EventTarget();
  globalThis.document=new EventTarget();
  const firstCsPost=posts.length;
  startCampaignAnalytics('cs');
  globalThis.window.dispatchEvent(new CustomEvent('xray-stream-progress',{detail:{phase:'install',ready:true,firstInstall:true}}));
  await new Promise(setImmediate);
  const csPosts=posts.slice(firstCsPost);
  assert.ok(csPosts.every(post=>post.gameId==='cs'&&post.browserId===sample.browserId));
  assert.ok(csPosts.some(post=>post.event==='playtime'&&post.data.sessionId===csPending));
  assert.ok(csPosts.some(post=>post.event==='install'));
  assert.ok(storage.has('xray-analytics-playtime-v1:'+legacyPending));
 }finally{for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
});

test('playtime validates cumulative checkpoints and totals persist across sessions',async()=>{
 const {validateAnalyticsEvent,analyticsDashboard}=await import('./analytics-http.mjs');
 const db=openAnalytics(':memory:'),browserId=randomUUID(),sessionId=randomUUID(),release='a'.repeat(64);
 const checkpoint=ms=>({...event('playtime',browserId),data:{sessionId,release,elapsedMs:ms}});
 try{
  const first=checkpoint(60000);assert.ok(validateAnalyticsEvent(first));db.record(first,1);db.record(first,2);
  db.record(checkpoint(120000),3);db.record(checkpoint(90000),4);
  db.record({...checkpoint(30000),data:{...checkpoint(30000).data,sessionId:randomUUID()}},5);
  const s=db.summary();assert.equal(s.playtime.totalMs,150000);assert.equal(s.playtime.players,1);assert.equal(s.playtimeUsers[0].sessions,2);
  assert.equal(s.events.length,0);assert.match(analyticsDashboard(s),/0h 2m 30s/);
  for(const ms of [0,-1,1.5,Infinity,31536000001,null])assert.equal(validateAnalyticsEvent(checkpoint(ms)),null);
  assert.equal(validateAnalyticsEvent({...first,data:{...first.data,extra:'invalid'}}),null);
 }finally{db.close();}
});
