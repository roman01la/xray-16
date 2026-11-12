import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {record,summary,prune} from './analytics-d1.mjs';import worker from './worker.mjs';
const schemaSoc=readFileSync(new URL('./schema-soc.sql',import.meta.url),'utf8');
function fixture({migrate=true}={}){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));if(migrate)sqlite.exec(schemaSoc);sqlite.exec('PRAGMA foreign_keys=ON');
 const db={prepare(sql){return {bind(...args){this.args=args;return this;},args:[],async run(){return sqlite.prepare(sql).run(...this.args);},sql};},async batch(statements){sqlite.exec('BEGIN');try{const rows=statements.map(s=>({results:sqlite.prepare(s.sql).all(...s.args)}));sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};return {db,sqlite};}
const browserId='11111111-1111-4111-8111-111111111111';
const event=(name,id=crypto.randomUUID())=>({browserId,eventId:id,event:name});
test('D1 preserves visit sessions, install uniqueness and retry idempotency',async()=>{
 const {db,sqlite}=fixture();try{const first=event('new_campaign');await record(db,first,100);await record(db,first,200);await record(db,event('visit'),300);await record(db,event('install'),400);await record(db,event('install'),500);await record(db,event('visit'),500+30*60000);const s=await summary(db,1000);assert.equal(s.browsers,1);assert.equal(s.events.find(e=>e.event==='visit').total,2);assert.equal(s.events.find(e=>e.event==='install').total,1);assert.equal(s.events.find(e=>e.event==='new_campaign').total,1);}finally{sqlite.close();}
});
test('D1 batches roll back instead of partially storing a failed event',async()=>{const {db,sqlite}=fixture();try{sqlite.exec("CREATE TRIGGER test_fail BEFORE INSERT ON analytics_events BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");await assert.rejects(record(db,event('visit'),10));assert.equal((await summary(db)).browsers,0);}finally{sqlite.close();}});
test('performance summaries keep weighted FPS and hourly retention',async()=>{const {db,sqlite}=fixture();try{const sessionId=crypto.randomUUID();await record(db,{...event('device'),data:{sessionId,os:'macOS',browser:'Chrome',gpuVendor:'Apple'}},100);for(const [frames,elapsedMs] of [[600,10000],[300,10000]])await record(db,{...event('performance'),data:{sessionId,frames,elapsedMs,p95Ms:22,maxMs:45,stalls100:0}},100);assert.equal((await summary(db,100)).performance[0].fps,45);await prune(db,31*86400000);assert.equal((await summary(db,31*86400000)).performance.length,0);}finally{sqlite.close();}});
test('worker gates origin, size, authentication and unknown routes',async()=>{const {db,sqlite}=fixture();const env={DB:db,ORIGIN:'https://stalker-online.xyz',ANALYTICS_PASSWORD:'test-secret'};const req=(path,init={})=>new Request('https://stalker-online.xyz'+path,init);try{
 assert.equal((await worker.fetch(req('/analytics'),env)).status,401);
 assert.equal((await worker.fetch(req('/analytics',{headers:{Authorization:'Basic '+btoa('analytics:wrong')}}),env)).status,401);
 assert.equal((await worker.fetch(req('/analytics',{headers:{Authorization:'Basic '+btoa('analytics:test-secret')}}),env)).status,200);
 assert.equal((await worker.fetch(req('/analytics/event',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify(event('visit'))}),env)).status,403);
 assert.equal((await worker.fetch(req('/analytics/event',{method:'POST',headers:{Origin:env.ORIGIN,'Content-Type':'application/json'},body:'x'.repeat(8193)}),env)).status,413);
 assert.equal((await worker.fetch(req('/analytics/event',{method:'POST',headers:{Origin:env.ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(event('visit'))}),env)).status,204);
 assert.equal((await summary(db)).browsers,1);
 assert.equal((await worker.fetch(req('/world.json'),env)).status,404);assert.equal((await worker.fetch(req('/_deploy/publish'),env)).status,404);
 env.EVENT_LIMIT={limit:async()=>({success:false})};assert.equal((await worker.fetch(req('/analytics/event',{method:'POST',headers:{Origin:env.ORIGIN,'Content-Type':'application/json'},body:'{}'}),env)).status,429);
 }finally{sqlite.close();}});

test('D1 cumulative playtime is monotonic, separates sessions and survives pruning',async()=>{
 const {db,sqlite}=fixture();const sessionId=crypto.randomUUID();
 const checkpoint=(ms,session=sessionId)=>({...event('playtime'),data:{sessionId:session,release:'a'.repeat(64),elapsedMs:ms}});
 try{
  const first=checkpoint(60000);await record(db,first,1);await record(db,first,2);
  await record(db,checkpoint(120000),3);await record(db,checkpoint(30000),4);
  await record(db,checkpoint(10000,crypto.randomUUID()),5);
  await record(db,{...checkpoint(20000),browserId:crypto.randomUUID()},6);
  await prune(db,31*86400000);
  const s=await summary(db,31*86400000);assert.equal(s.playtime.totalMs,150000);assert.equal(s.playtime.players,2);
  assert.equal(s.playtimeUsers[0].elapsed_ms,130000);assert.equal(s.playtimeUsers[0].sessions,2);
  assert.equal(s.events.length,0,'checkpoints do not inflate milestone or visit counts');
 }finally{sqlite.close();}
});

test('adding SoC preserves CoP history and separates every metric for the same browser',async()=>{
 const {db,sqlite}=fixture({migrate:false});
 const sessionId=crypto.randomUUID(), release='a'.repeat(64);
 const recordSample=async(gameId,frames,gpu,elapsedMs)=>{
  await record(db,{...event('device'),gameId,data:{sessionId,release,gpuDescription:gpu}},10);
  await record(db,{...event('performance'),gameId,data:{sessionId,release,frames,elapsedMs:10000}},10);
  await record(db,{...event('playtime'),gameId,data:{sessionId,release,elapsedMs}},10);
 };
 try{
  await record(db,event('visit'),1);
  await record(db,event('install'),2);
  await recordSample(undefined,600,'CoP GPU',1000);
  const previous=await summary(db,10);
  sqlite.exec(schemaSoc);
  sqlite.exec(schemaSoc);
  assert.deepEqual(await summary(db,10),previous);
  assert.equal((await summary(db,10,'soc')).browsers,0);

  const soc=(name)=>({...event(name),gameId:'soc'});
  await record(db,soc('visit'),3);
  await record(db,soc('install'),4);
  await record(db,soc('install'),5);
  await record(db,soc('start_game'),6);
  await record(db,soc('new_campaign'),7);
  await record(db,soc('load_save'),8);
  await recordSample('soc',300,'SoC GPU',3000);
  assert.deepEqual(await summary(db,10),previous);
  const result=await summary(db,10,'soc');
  assert.equal(result.browsers,1);
  assert.deepEqual(Object.fromEntries(result.events.map(e=>[e.event,e.total])),{visit:1,install:1,start_game:1,new_campaign:1,load_save:1});
  assert.equal(result.performance[0].fps,30);
  assert.equal(result.performance[0].gpu,'SoC GPU');
  assert.equal(JSON.parse(result.devices[0].data).gpuDescription,'SoC GPU');
  assert.equal(result.playtime.totalMs,3000);

  const env={DB:db,ORIGIN:'https://stalker-online.xyz',ANALYTICS_PASSWORD:'test-secret'};
  const headers={Authorization:'Basic '+btoa('analytics:test-secret')};
  const request=game=>worker.fetch(new Request(env.ORIGIN+'/analytics?game='+game,{headers}),env);
  const response=await request('soc');
  assert.equal(response.status,200);
  const page=await response.text();
  assert.match(page,/game=soc" aria-current="page"/);
  assert.match(page,/SoC GPU/);
  assert.doesNotMatch(page,/CoP GPU/);
  assert.equal((await request('other')).status,400);
  const post=gameId=>worker.fetch(new Request(env.ORIGIN+'/analytics/event',{
   method:'POST',headers:{Origin:env.ORIGIN,'Content-Type':'application/json'},
   body:JSON.stringify({...event('start_game'),gameId}),
  }),env);
  assert.equal((await post('other')).status,400);
  assert.equal((await post('soc')).status,204);
  assert.equal((await summary(db,10,'soc')).events.find(e=>e.event==='start_game').total,2);
  await prune(db,31*86400000);
  const retained=await summary(db,31*86400000,'soc');
  assert.equal(retained.devices.length,0);
  assert.equal(retained.performance.length,0);
  assert.equal(retained.playtime.totalMs,3000);
 }finally{sqlite.close();}
});

test('crash ingestion forwards one scrubbed fatal event and rejects invalid reports', async t => {
 const env = {ORIGIN:'https://stalker-online.xyz', SENTRY_DSN:'https://abc@o123.ingest.us.sentry.io/456'};
 const release = 'a'.repeat(64);
 const report = {
  game:'soc', release, kind:'assertion', level:'l01_escape\\',
  message:'Expression : motion_ID.valid()\nFunction : ID_Cycle\nFile : /Users/private user/source/SkeletonAnimated.cpp',
  stack:`Error: unreachable\n    at abort (${env.ORIGIN}/releases/${release}/xr_3da.js?private=1:3:3082)\n    at xr_3da.wasm:0x849659`,
 };
 const request = (body, origin=env.ORIGIN) => new Request(env.ORIGIN+'/crash-report',{
  method:'POST', headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.2'},body,
 });
 let forwarded = 0;
 t.mock.method(globalThis,'fetch',async (endpoint, options) => {
  forwarded++;
  assert.equal(endpoint,'https://o123.ingest.us.sentry.io/api/456/envelope/');
  assert.deepEqual(options.headers,{'Content-Type':'application/x-sentry-envelope'});
  assert.doesNotMatch(options.body,/private|192\.0\.2\.2/);
  const [header, item, crash] = options.body.trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(header.event_id,crash.event_id);
  assert.equal(item.type,'event');
  assert.equal(crash.release,release);
  assert.deepEqual(crash.tags,{game:'soc',kind:'assertion',map:'l01_escape'});
  assert.deepEqual(crash.fingerprint,['soc','assertion','motion_ID.valid()','ID_Cycle']);
  assert.deepEqual(crash.exception.values[0].stacktrace.frames,[
   {filename:'xr_3da.wasm',instruction_addr:'0x849659',in_app:true},
   {function:'abort',filename:'xr_3da.js',lineno:3,colno:3082,in_app:true},
  ]);
  return new Response('{}');
 });
 assert.equal((await worker.fetch(request('{}','https://example.com'),env)).status,403);
 assert.equal((await worker.fetch(request('x'.repeat(24577)),env)).status,413);
 assert.equal((await worker.fetch(request(JSON.stringify({...report,game:'other'})),env)).status,400);
 assert.equal((await worker.fetch(request(JSON.stringify(report)),env)).status,204);
 env.CRASH_LIMIT = {limit:async()=>({success:false})};
 assert.equal((await worker.fetch(request(JSON.stringify(report)),env)).status,429);
 assert.equal(forwarded,1);
});
