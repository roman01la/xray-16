import test from 'node:test';import assert from 'node:assert/strict';
import {WorldItemsClient} from './world-items.mjs';
const item=n=>({id:n.toString(16).padStart(32,'0'),revision:0,source:'f'.repeat(32),position:[1,2,3],section:'bandage',state:{condition:1,upgrades:[],payload:{kind:'consumable',uses:1}}});
const page=(items,nextCursor=null,life=0)=>({items,nextCursor,life});
function setup(worldItems){const timers=new Map(),views=[],errors=[];let timer=0;const client={inventory:{view:{life:0,alive:true}},worldItems};const adapter=new WorldItemsClient(client,{onChange:v=>views.push(v),onError:e=>errors.push(e),schedule:fn=>{timers.set(++timer,fn);return timer;},cancel:id=>timers.delete(id)});return {adapter,client,timers,views,errors};}
test('world scan publishes complete pages, preserves full state and replaces disappeared items',async()=>{
 let calls=0;const s=setup(async after=>{calls++;return after?page([item(2)]):page([item(1)],item(1).id);});
 await s.adapter.refresh();assert.equal(calls,2);assert.equal(s.views.length,1);assert.deepEqual(s.views[0].items,[item(1),item(2)]);
 s.client.worldItems=async()=>page([]);await s.adapter.refresh();assert.deepEqual(s.views[1].items,[]);assert.equal(s.timers.size,1);s.adapter.close();assert.equal(s.timers.size,0);
});
test('failed traversal retains last complete view and retries, inventory mutations take priority',async()=>{
 const s=setup(async()=>page([item(1)]));await s.adapter.refresh();
 s.client.worldItems=async after=>{if(after)throw Error('inventory busy');return page([item(2)],item(2).id);};
 await assert.rejects(s.adapter.refresh(),/busy/);assert.equal(s.views.length,1);assert.equal(s.timers.size,1);
 s.client.inventory.inFlight=true;let calls=0;s.client.worldItems=async()=>{calls++;return page([]);};
 await s.adapter.refresh();assert.equal(calls,0);s.client.inventory.inFlight=false;
 await s.adapter.refresh();assert.equal(calls,1);assert.deepEqual(s.adapter.view.items,[]);s.adapter.close();
});
test('death or life change during a scan clears old items without publishing a late response',async()=>{
 let release;const s=setup(async()=>page([item(1)]));await s.adapter.refresh();
 s.client.worldItems=()=>new Promise(resolve=>{release=resolve;});const pending=s.adapter.refresh();
 s.client.inventory.view={life:1,alive:false};s.adapter.clear();release(page([item(2)]));await pending;
 assert.deepEqual(s.adapter.view.items,[]);assert.equal(s.adapter.view.life,1);assert.equal(s.views.length,2);s.adapter.close();
});
test('malformed ordering and locations never replace a good view; close cancels pending publication',async()=>{
 const s=setup(async()=>page([item(1)]));await s.adapter.refresh();
 for(const items of [[item(2),item(1)],[{...item(2),position:[Infinity,0,0]}],[item(2),item(2)]]){
  s.client.worldItems=async()=>page(items);await assert.rejects(s.adapter.refresh());assert.equal(s.views.length,1);
 }
 let release;s.client.worldItems=()=>new Promise(resolve=>{release=resolve;});const pending=s.adapter.refresh();s.adapter.close();release(page([]));await pending;
 assert.equal(s.views.length,1);assert.equal(s.timers.size,0);
});
test('default browser timer functions are not invoked with adapter as their receiver',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;let scheduled=0,cancelled=0;
 globalThis.setTimeout=function(){assert.equal(this,undefined);scheduled++;return 7;};
 globalThis.clearTimeout=function(timer){assert.equal(this,undefined);assert.equal(timer,7);cancelled++;};
 try{
  const adapter=new WorldItemsClient({inventory:{view:{alive:true,life:0}},worldItems:async()=>page([])});
  await adapter.refresh();assert.equal(scheduled,1);adapter.close();assert.equal(cancelled,1);
 }finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});
test('corpse discovery is paginated independently of item contents and clears on death',async()=>{
 const s=setup(async()=>page([]));
 const first={id:'a'.repeat(32),position:[0,0,1]},second={id:'b'.repeat(32),position:[0,0,2]};
 s.client.corpses=async after=>({life:0,containers:after?[second]:[first],nextCursor:after?null:first.id});
 await s.adapter.refresh();
 assert.deepEqual(s.adapter.view.corpses,[first,second]);
 assert.deepEqual(s.adapter.view.items,[]);
 s.client.inventory.view={life:0,alive:false};
 await s.adapter.refresh();
 assert.deepEqual(s.adapter.view.corpses??[],[]);
 s.adapter.close();
});

test('discovery publishes the owner’s locker with no loose items and clears it on death',async()=>{
 const storage={id:'a'.repeat(32),position:[1,2,3],rotation:[0,.5,0]};
 const s=setup(async()=>({...page([]),storage}));await s.adapter.refresh();
 assert.deepEqual(s.adapter.view.storage,storage);
 s.client.inventory.view={life:0,alive:false};await s.adapter.refresh();
 assert.equal(s.adapter.view.storage,undefined);
 s.adapter.close();
});
