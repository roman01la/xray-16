import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {MessageChannel} from 'node:worker_threads';
import {BrowserEngineBridge,EngineBridgeEndpoint} from './engine-bridge.mjs';
import {validateContract,assertCompatible} from './contract.mjs';
const contract=validateContract(JSON.parse(await readFile(new URL('./contract.json',import.meta.url))));
const wait=()=>new Promise(r=>setTimeout(r,15));
class Client extends EventTarget {contract=contract;playerId=1;input={};closed=false;snapshot=null;attacks=0;setInput(i){this.input=i;}close(){this.closed=true;}async attack(){this.attacks++;return {applied:{health:75}};}push(tick){this.snapshot={tick,playerId:1,entities:[{id:1}]};this.dispatchEvent(new CustomEvent('snapshot',{detail:this.snapshot}));}}
function setup(t){const c=new Client(),{port1,port2}=new MessageChannel();const b=new BrowserEngineBridge(c,port1,{epoch:'test-1'});const e=new EngineBridgeEndpoint(port2,{epoch:'test-1',contract});t.after(()=>{b.close();e.close();});return {c,b,e};}
test('strict contract rejects wrong world/content/authority and extra fields',()=>{for(const patch of [{world:'zaton'},{contentRevision:'different'},{authority:'client'},{extra:true}])assert.throws(()=>assertCompatible(contract,{...contract,...patch}));});
test('paused engine retains first in-flight plus latest frame only',async t=>{const {c,e,b}=setup(t);await wait();for(let i=1;i<=10000;i++)c.push(i);await wait();assert.equal(e.consumeSnapshot().tick,1);assert.equal(b.snapshots.pending.tick,10000);await wait();assert.equal(e.consumeSnapshot().tick,10000);await wait();assert.equal(e.consumeSnapshot(),null);assert.equal(b.snapshots.pending,null);});
test('detonation effects stay bounded and expired effects return their credit',async t=>{
 const {c,b,e}=setup(t);await wait();
 const effect=n=>[['wpn_fake_missile2',n,3,-1]];
 for(let n=1;n<=100;n++)c.dispatchEvent(new CustomEvent('detonations',{detail:effect(n)}));
 await wait();assert.deepEqual(e.detonations.effects,effect(1));
 assert.deepEqual(b.detonations.pending.effects,effect(100));
 assert.equal(e.consumeDetonations(Date.now()+2000),null);
 await wait();assert.deepEqual(e.consumeDetonations(),effect(100));
 await wait();assert.equal(b.detonations.inflight,null);
 assert.equal(e.consumeDetonations(),null);
});
test('confirmed firearm cues stay bounded and stale cues cannot replay',async t=>{
 const {c,b,e}=setup(t);await wait();
 const cue=ammo=>({type:'weapon_fired',life:9,item:'e'.repeat(32),ammo,launcher:false});
 for(let ammo=30;ammo>=0;ammo--)c.dispatchEvent(new CustomEvent('weapon-fired',{detail:cue(ammo)}));
 await wait();assert.deepEqual(e.weaponFire.cue,cue(30));
 assert.deepEqual(b.weaponFire.pending.cue,cue(0));
 assert.equal(e.consumeWeaponFire(e.weaponFire.receivedAt+301),null);
 await wait();assert.deepEqual(e.consumeWeaponFire(e.weaponFire.receivedAt),cue(0));
 await wait();assert.equal(b.weaponFire.inflight,null);
 assert.equal(e.consumeWeaponFire(),null);
});
test('observer gunshot batches coalesce and return credit when stale',async t=>{
 const {c,b,e}=setup(t);await wait();
 const effects=n=>[[9,'wpn_ak74',0,n,3,-1]];
 for(let n=1;n<=100;n++)c.dispatchEvent(new CustomEvent('gunshots',{detail:effects(n)}));
 await wait();assert.deepEqual(e.gunshots.effects,effects(1));
 assert.deepEqual(b.gunshots.pending.effects,effects(100));
 assert.equal(e.consumeGunshots(e.gunshots.receivedAt+301),null);
 await wait();assert.deepEqual(e.consumeGunshots(e.gunshots.receivedAt),effects(100));
 await wait();assert.equal(b.gunshots.inflight,null);
});
test('an expired reload animation returns credit for its cancellation',async t=>{
 const {c,b,e}=setup(t);await wait();
 const cue={type:'weapon_reload',life:9,item:'e'.repeat(32),alias:'anm_open',milliseconds:434,sound:6,cancelled:false};
 const cancel={...cue,alias:'',milliseconds:0,sound:0,cancelled:true};
 for(const detail of [cue,cancel])c.dispatchEvent(new CustomEvent('weapon-reload',{detail}));
 await wait();assert.equal(e.consumeWeaponReload(e.weaponReload.receivedAt+434),null);
 await wait();assert.deepEqual(e.consumeWeaponReload(e.weaponReload.receivedAt+500),cancel);
 await wait();assert.equal(b.weaponReload.inflight,null);
});
test('inputs coalesce under backpressure and actions return reliable results',async t=>{const {c,e}=setup(t);await wait();for(let i=0;i<1000;i++)e.setInput({x:i/1000,z:0,yaw:0,sprint:false});await wait();await wait();assert.equal(c.input.x,.999);assert.deepEqual(await e.attack(2),{applied:{health:75}});assert.equal(c.attacks,1);});
test('old-session messages cannot affect new session',async t=>{const {c,b,e}=setup(t);await wait();b.receive({epoch:'old',type:'input',sequence:1,input:{x:1,z:0,yaw:0,sprint:true}});e.receive({epoch:'old',type:'closed'});assert.deepEqual(c.input,{});assert.equal(e.closed,false);});
test('world mismatch closes bridge before snapshots or inputs',async t=>{const c=new Client(),{port1,port2}=new MessageChannel();const b=new BrowserEngineBridge(c,port1,{epoch:'test'});const e=new EngineBridgeEndpoint(port2,{epoch:'test',contract:{...contract,world:'zaton'}});t.after(()=>{b.close();e.close();});await wait();assert.equal(c.closed,true);assert.equal(b.ready,false);});
test('disconnect clears entity snapshot and rejects pending actions',async t=>{const {c,b,e}=setup(t);await wait();c.push(1);await wait();c.attack=()=>new Promise(()=>{});const action=e.attack(2);const rejected=assert.rejects(action,/transport|closed/);b.close('transport disconnected');await wait();assert.equal(e.consumeSnapshot(),null);assert.equal(e.closed,true);await rejected;});
test('invalid input closes transport instead of entering simulation',async t=>{const {c,b}=setup(t);await wait();b.receive({epoch:'test-1',type:'input',sequence:1,input:{x:NaN,z:0,yaw:0,sprint:false}});assert.equal(c.closed,true);});

test('fire intent crosses the worker boundary without client hit claims',async t=>{
 const {c,e}=setup(t);await wait();let received;
 c.fire=async (aim,item)=>{received={aim,item};return {status:'blocked',ammo:29};};
 assert.deepEqual(await e.fire({tick:12,yaw:.5,pitch:-.2,target:99},'f'.repeat(32)),{status:'blocked',ammo:29});
 assert.deepEqual(received,{aim:{tick:12,yaw:.5,pitch:-.2},item:'f'.repeat(32)});
 await assert.rejects(e.fire({tick:13,yaw:NaN,pitch:0}),/Invalid aim/);
 assert.equal(e.closed,false);
});
test('reload, respawn and travel Use cross the reliable worker bridge',async t=>{
 const {c,e}=setup(t);await wait();c.reload=async()=>({status:'started',ready_tick:90});c.respawn=async()=>({status:'rejected',reason:'alive'});
 c.useTravel=async()=>({status:'rejected',reason:'access_card_required'});
 assert.deepEqual(await e.reload(),{status:'started',ready_tick:90});
 assert.deepEqual(await e.respawn(),{status:'rejected',reason:'alive'});
 assert.deepEqual(await e.useTravel(),{status:'rejected',reason:'access_card_required'});
 assert.equal(e.requests.size,0);e.close();await assert.rejects(e.reload(),/unavailable/);
});
test('weapon selection carries the life and requested slot from the engine',async t=>{
 const {c,e}=setup(t);await wait();
 c.selectWeapon=async(life,slot)=>({life,slot});
 assert.deepEqual(await e.selectWeapon(3,2),{life:3,slot:2});
 assert.deepEqual(await e.selectWeapon(3,0),{life:3,slot:0});
});
test('a paused engine receives the first appearance update and then the latest cleared view',async t=>{
 const {c,e,b}=setup(t);await wait();
 c.lifecycle={entries:new Map()};
 const publish=appearance=>{
   if(appearance)c.lifecycle.entries.set(2,{id:2,appearance});else c.lifecycle.entries.clear();
   c.dispatchEvent(new CustomEvent('lifecycle'));
 };
 publish({weapon:'wpn_lr300'});publish({weapon:'wpn_lr300',weaponAddons:1});publish({weapon:'wpn_lr300',weaponAddons:7});
 await wait();assert.deepEqual(e.appearances.entries,[[2,{weapon:'wpn_lr300'}]]);
 assert.deepEqual(b.appearances.pending,[[2,{weapon:'wpn_lr300',weaponAddons:7}]]);e.consumeAppearances();
 await wait();assert.deepEqual(e.appearances.entries,[[2,{weapon:'wpn_lr300',weaponAddons:7}]]);e.consumeAppearances();
 publish(null);await wait();assert.deepEqual(e.appearances.entries,[]);e.consumeAppearances();
 await wait();assert.equal(e.appearances,null);
});
const inventoryView=(generation=1,life=0)=>({generation,life,alive:true,corpse:null,items:[{id:'a'.repeat(32),revision:generation,section:'wpn_ak74',place:'rucksack',state:{condition:.75,upgrades:[],payload:{kind:'equipment'}}}]});
test('inventory delivers the initial coherent view and coalesces while engine is paused',async t=>{
 const {c,b,e}=setup(t);c.inventory={view:inventoryView()};await wait();
 assert.equal(e.inventory.view.generation,1);
 for(let generation=2;generation<=1000;generation++)c.dispatchEvent(new CustomEvent('inventory',{detail:inventoryView(generation)}));
 await wait();assert.equal(e.consumeInventory().generation,1);await wait();
 assert.equal(e.consumeInventory().generation,1000);await wait();assert.equal(b.inventories.pending,null);
 b.close();await wait();assert.equal(e.consumeInventory(),null);
});
test('engine inventory intents use the journal and cannot target a later life',async t=>{
 const {c,e}=setup(t);let received=[];
 c.inventory={view:inventoryView(1,2),move:async(item,action)=>{received.push({item,action});return {status:'committed'};}};await wait();
 const intent={life:2,item:'a'.repeat(32),revision:1,action:{kind:'drop'}};
 assert.deepEqual(await e.moveInventory(intent),{status:'committed'});
 assert.deepEqual(received,[{item:{id:intent.item,revision:1},action:{kind:'drop'}}]);
 c.inventory.view=inventoryView(2,3);
 assert.deepEqual(await e.moveInventory(intent),{status:'rejected',reason:'stale_or_dead_life'});assert.equal(received.length,1);
 await assert.rejects(e.moveInventory({...intent,state:{condition:1}}),/Invalid inventory intent/);
 assert.equal(e.closed,false);
});

test('stack drop crosses worker boundary as one bounded journal batch',async t=>{
 const {c,e}=setup(t);const received=[];
 c.inventory={view:inventoryView(1,2),moveBatch:async(items,action)=>{received.push({items,action});return {status:'batch_complete'};}};await wait();
 const intents=Array.from({length:40},(_,n)=>({life:2,item:(n+1).toString(16).padStart(32,'0'),revision:n,action:{kind:'drop'}}));
 assert.deepEqual(await e.moveInventoryBatch(intents),{status:'batch_complete'});
 assert.equal(received.length,1);assert.equal(received[0].items.length,40);assert.deepEqual(received[0].action,{kind:'drop'});
 assert.equal(e.closed,false);assert.equal(e.requests.size,0);
 await assert.rejects(e.moveInventoryBatch([intents[0],intents[0]]),/Invalid inventory batch/);
 await assert.rejects(e.moveInventoryBatch([intents[0],{...intents[1],life:3}]),/Invalid inventory batch/);
 await assert.rejects(e.moveInventoryBatch([{...intents[0],action:{kind:'place',placement:{kind:'rucksack'}}}]),/Invalid inventory batch/);
 c.inventory.view=inventoryView(2,3);
 assert.deepEqual(await e.moveInventoryBatch(intents),{status:'rejected',reason:'stale_or_dead_life'});
 assert.equal(received.length,1);
});
test('world items coalesce behind worker credit and are cleared on disconnect',async t=>{
 const {c,b,e}=setup(t);const view=generation=>({generation,life:0,items:[{...inventoryView().items[0],source:'b'.repeat(32),position:[1,0,2]}]});
 c.worldItemsView={view:view(1)};await wait();
 for(let n=2;n<=50;n++)c.dispatchEvent(new CustomEvent('world-items',{detail:view(n)}));
 await wait();assert.equal(e.consumeWorldItems().generation,1);await wait();assert.equal(e.consumeWorldItems().generation,50);
 await wait();assert.equal(b.worldItems.pending,null);b.close();await wait();assert.equal(e.worldItems,null);
});
test('corpse views deliver dismissal after paused engine returns mailbox credit',async t=>{
 const {c,e,b}=setup(t);const view={source:'b'.repeat(32),life:0,generation:1,items:inventoryView().items};c.corpseSearch={view};await wait();
 for(let generation=2;generation<100;generation++)c.dispatchEvent(new CustomEvent('corpse-search',{detail:{...view,generation}}));
 c.dispatchEvent(new CustomEvent('corpse-search',{detail:null}));await wait();
 assert.equal(e.consumeCorpseSearch().view.generation,1);await wait();assert.deepEqual(e.consumeCorpseSearch(),{view:null});await wait();assert.equal(b.corpseViews.pending,null);
 b.close();await wait();assert.equal(e.consumeCorpseSearch(),null);
});
test('corpse intents reject delayed life and generation instead of using newer item revisions',async t=>{
 const {c,e}=setup(t);let taken=0,opened=0,dismissed=0;
 c.inventory={view:inventoryView(1,2)};
 c.corpseSearch={view:{source:'b'.repeat(32),life:2,generation:5,items:inventoryView().items},open:async()=>{opened++;},dismiss:()=>{dismissed++;},take:async()=>{taken++;return {status:'batch_complete'};}};await wait();
 const intent={kind:'take',source:'b'.repeat(32),life:2,generation:4,items:['a'.repeat(32)]};
 assert.deepEqual(await e.corpseIntent(intent),{status:'conflict'});assert.equal(taken,0);
 assert.deepEqual(await e.corpseIntent({...intent,generation:5}),{status:'batch_complete'});assert.equal(taken,1);
 c.inventory.view.life=3;assert.equal((await e.corpseIntent({...intent,generation:5})).reason,'stale_or_dead_life');assert.equal(taken,1);
 await e.corpseIntent({kind:'open',source:intent.source,life:3});await e.corpseIntent({kind:'dismiss',life:3});assert.equal(opened,1);assert.equal(dismissed,1);
 await assert.rejects(e.corpseIntent({...intent,position:[0,0,0]}),/Invalid corpse intent/);
 await assert.rejects(e.corpseIntent({...intent,items:['a'.repeat(32),'a'.repeat(32)]}),/Invalid corpse selection/);
});

test('store-all carries one private destination for every journaled item',async t=>{
 const {c,e}=setup(t),received=[];
 c.inventory={view:inventoryView(1,2),moveBatch:async(items,action)=>{received.push({items,action});return {status:'batch_complete'};}};
 await wait();
 const destination='f'.repeat(32),action={kind:'store',destination};
 const first={life:2,item:'a'.repeat(32),revision:7,action};
 const second={life:2,item:'b'.repeat(32),revision:11,action};
 assert.deepEqual(await e.moveInventoryBatch([first,second]),{status:'batch_complete'});
 assert.deepEqual(received,[{items:[{id:first.item,revision:7},{id:second.item,revision:11}],action}]);
 await assert.rejects(e.moveInventoryBatch([first,{...second,action:{kind:'store',destination:'e'.repeat(32)}}]),/Invalid inventory batch/);
 assert.equal(received.length,1);
});
