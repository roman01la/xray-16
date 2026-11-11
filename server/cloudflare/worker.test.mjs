import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {record,summary,prune} from './analytics-d1.mjs';import worker from './worker.mjs';
function fixture(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));sqlite.exec('PRAGMA foreign_keys=ON');
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
 assert.equal((await worker.fetch(req('/world.json'),env)).status,503);assert.equal((await worker.fetch(req('/_deploy/publish'),env)).status,404);
 env.EVENT_LIMIT={limit:async()=>({success:false})};assert.equal((await worker.fetch(req('/analytics/event',{method:'POST',headers:{Origin:env.ORIGIN,'Content-Type':'application/json'},body:'{}'}),env)).status,429);
 }finally{sqlite.close();}});
