import test from 'node:test';import assert from 'node:assert/strict';
import {CorpseSearchClient} from './corpse-search.mjs';
const source='f'.repeat(32),other='e'.repeat(32);
const item=n=>({id:n.toString(16).padStart(32,'0'),revision:2,section:'bandage',place:'rucksack',state:{condition:1,upgrades:[],payload:{kind:'consumable',uses:1}}});
const page=(items=[],nextCursor=null,generation=1,src=source)=>({source:src,life:0,generation,items,nextCursor});
function setup(corpseItems){const views=[],timers=new Map();let count=0;const client={inventory:{view:{alive:true,life:0}},corpseItems};const adapter=new CorpseSearchClient(client,{onChange:v=>views.push(v),schedule:fn=>{timers.set(++count,fn);return count;},cancel:id=>timers.delete(id)});return {client,adapter,views,timers};}
test('corpse pagination restarts on concurrent loot and publishes only one coherent result',async()=>{
 let calls=0;const s=setup(async(src,after,generation)=>{
  calls++;assert.equal(src,source);
  if(calls===1)return page([item(1)],item(1).id);
  if(calls===2){assert.equal(generation,1);assert.equal(after,item(1).id);return {status:'conflict',generation:2};}
  assert.equal(after,'');assert.equal(generation,null);return page([item(2)],null,2);
 });
 await s.adapter.open(source);assert.equal(calls,3);assert.deepEqual(s.adapter.view.items,[item(2)]);assert.equal(s.views.filter(Boolean).length,1);s.adapter.close();assert.equal(s.timers.size,0);
});
test('source switching and dismissal discard late pages',async()=>{
 let release;const s=setup(()=>new Promise(r=>{release=r;}));const old=s.adapter.open(source);
 s.client.corpseItems=async()=>page([item(2)],null,1,other);await s.adapter.open(other);release(page([item(1)]));await old;
 assert.equal(s.adapter.view.source,other);assert.deepEqual(s.adapter.view.items,[item(2)]);
 s.client.corpseItems=()=>new Promise(r=>{release=r;});const pending=s.adapter.refresh();s.adapter.dismiss();release(page());await pending;
 assert.equal(s.adapter.view,null);assert.equal(s.timers.size,0);
});
test('death and revoked proximity clear actionable contents; malformed pages cannot publish',async()=>{
 const s=setup(async()=>page([item(1)]));await s.adapter.open(source);
 for(const bad of [{error:'corpse unavailable'},page([item(2),item(1)]),page([item(1)],'bad'),page([item(1)],null,2,other)]){
  s.client.corpseItems=async()=>bad;await assert.rejects(s.adapter.refresh());assert.equal(s.adapter.view,null);
 }
 let release;s.client.corpseItems=()=>new Promise(r=>{release=r;});const pending=s.adapter.refresh();s.client.inventory.view={alive:false,life:0};release(page());await pending;
 assert.equal(s.adapter.source,null);assert.equal(s.timers.size,0);
});
test('take all journals exact item revisions and re-reads authority after partial contention',async()=>{
 const s=setup(async()=>page([item(1),item(2)]));await s.adapter.open(source);
 s.client.inventory.moveBatch=async(items,action)=>{assert.deepEqual(items,[item(1),item(2)]);assert.deepEqual(action,{kind:'pickup',source});s.client.corpseItems=async()=>page([],null,3);return {status:'batch_complete',results:[{status:'committed'},{status:'conflict'}]};};
 await assert.rejects(s.adapter.take([item(3).id]),/Unknown/);
 const result=await s.adapter.take([item(1).id,item(2).id]);assert.equal(result.results[1].status,'conflict');assert.deepEqual(s.adapter.view.items,[]);s.adapter.close();
});
