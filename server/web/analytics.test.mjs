import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openAnalytics} from './analytics-store.mjs';
import {createGateway} from './gateway.mjs';

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

test('gateway protects every dashboard read and persists accepted milestones',async () => {
  const root = await mkdtemp(join(tmpdir(),'zone-analytics-'));
  const origin = 'https://game.example', password = 'isolated-analytics-test';
  const options = {root,origin,token:'isolated-gateway-token'};
  let server;
  async function listen(analyticsPassword) {
    server = await createGateway({...options,analyticsPassword});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return 'http://127.0.0.1:'+server.address().port;
  }
  async function close() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    server = undefined;
  }
  const auth = {Authorization:'Basic '+Buffer.from('analytics:'+password).toString('base64')};
  const wrongAuth = {Authorization:'Basic '+Buffer.from('analytics:wrong').toString('base64')};
  const a = randomUUID();
  try {
    let base = await listen(password);
    const dashboard = () => fetch(base+'/analytics',{headers:auth});
    const send = (body,headers={}) => fetch(base+'/analytics/event',{
      method:'POST', headers:{Origin:origin,'Content-Type':'application/json',...headers},
      body:JSON.stringify(body),
    });
    const guest = await fetch(base+'/analytics');
    assert.equal(guest.status,401);
    assert.match(guest.headers.get('www-authenticate'),/^Basic /);
    assert.doesNotMatch(await guest.text(),/Successful save loads/);
    assert.equal((await fetch(base+'/analytics/',{method:'HEAD'})).status,401);
    assert.equal((await fetch(base+'/analytics',{headers:{Authorization:'Bearer '+options.token}})).status,401);
    assert.equal((await fetch(base+'/analytics/event')).status,405);
    assert.equal((await send(event('visit',a),{Origin:'https://foreign.example'})).status,403);
    assert.equal((await send(event('visit',a),{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await send(event('visit',a),{'Content-Type':'text/plain'})).status,415);
    assert.equal((await send({...event('visit',a),saveName:'personal save'})).status,400);
    assert.equal((await send({...event('visit',a),eventId:'x'.repeat(1200)})).status,413);
    assert.equal((await send(event('unexpected',a))).status,400);
    const accepted = ['visit','visit','install','install','start_game','new_campaign','load_save','load_save'];
    await Promise.all(accepted.map(async kind=>assert.equal((await send(event(kind,a))).status,204)));
    const response = await dashboard();
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    const page = await response.text();
    assert.match(page,/Unique browsers <strong>1<\/strong>/);
    assert.match(page,/First completed game installs<\/th><td>1<\/td><td>1<\/td>/);
    assert.match(page,/Successful save loads<\/th><td>1<\/td><td>2<\/td>/);
    assert.ok(!page.includes(a)&&!page.includes(password));
    assert.equal((await fetch(base+'/analytics.sqlite')).status,404);
    assert.equal((await fetch(base+'/analytics',{method:'HEAD',headers:auth})).status,200);
    const attackingIp = {'Fly-Client-IP':'192.0.2.9'};
    for (let i=0;i<8;i++)
      assert.equal((await fetch(base+'/analytics',{headers:{...wrongAuth,...attackingIp}})).status,401);
    const throttled = await fetch(base+'/analytics',{headers:{...auth,...attackingIp}});
    assert.equal(throttled.status,429);
    assert.ok(throttled.headers.get('retry-after'));
    let distributedStatus;
    for (let i=1;i<=61&&distributedStatus!==429;i++){
      const headers = {...wrongAuth,'Fly-Client-IP':'198.51.100.'+i};
      distributedStatus = (await fetch(base+'/analytics',{headers})).status;
    }
    assert.equal(distributedStatus,429);
    await close();
    base = await listen(password);
    assert.equal(await (await dashboard()).text(),page);
    await close();
    base = await listen('');
    assert.equal((await dashboard()).status,404);
    assert.equal((await send(event('visit',a))).status,404);
  } finally {
    await close();
    await rm(root,{recursive:true,force:true});
  }
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

test('browser client sends device info and gameplay summary without hidden-tab frames',async()=>{
 const saved=new Map(),keys=['window','document','navigator','screen','location','localStorage','fetch','innerWidth','innerHeight','devicePixelRatio','crossOriginIsolated'];
 for(const key of keys)saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 const posts=[],storage=new Map(),window=new EventTarget(),document=new EventTarget();document.hidden=false;
 const values={window,document,navigator:{userAgent:'Mozilla Windows Chrome/140.0',platform:'Win32',hardwareConcurrency:8,deviceMemory:8,language:'en',maxTouchPoints:0,gpu:{}},screen:{width:2560,height:1440,availWidth:2560,availHeight:1400,colorDepth:24},location:{pathname:'/releases/'+'a'.repeat(64)+'/index.html',search:'?stream=/pack'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},innerWidth:1280,innerHeight:720,devicePixelRatio:2,crossOriginIsolated:true,fetch:async(_url,options)=>{posts.push(JSON.parse(options.body));return {status:204}}};
 try{
  for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {startCampaignAnalytics}=await import('./analytics-client.mjs');startCampaignAnalytics();
  const detail={width:1280,height:720,pacing:{vsync:true,limitMs:1000/60},adapter:{vendor:'TestGPU'},gameplayPerformance:{frames:360,elapsedMs:6000,maxMs:30,stalls50:0,stalls100:0,hist:{17:360}}};
  document.hidden=true;window.dispatchEvent(new CustomEvent('xray-performance',{detail}));
  document.hidden=false;window.dispatchEvent(new CustomEvent('xray-performance',{detail}));window.dispatchEvent(new Event('pagehide'));
  await new Promise(setImmediate);
  const sample=posts.find(p=>p.event==='performance');assert.equal(sample.data.frames,360);assert.equal(sample.data.avgFps,60);assert.equal(sample.data.p95Ms,17);assert.equal(sample.data.width,1280);
  assert.ok(posts.some(p=>p.event==='device'&&p.data.cores===8));
 }finally{for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
});
