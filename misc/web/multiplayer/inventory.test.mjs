import test from 'node:test';import assert from 'node:assert/strict';
import {InventoryClient} from './inventory.mjs';
const principal='a'.repeat(32),item={id:'b'.repeat(32),revision:0,section:'fixture',place:'rucksack',state:{condition:1}};
const page=(items,generation=1,nextCursor=null)=>({items,generation,nextCursor,life:0,alive:true,corpse:null});
const storage=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
test('a committed shell reaches the view before the reload journal closes',async()=>{
 const saved=storage();let revision=0,complete;
 const client={inventoryPage:async()=>page([{...item,revision}],revision+1),
  moveInventory:()=>new Promise(resolve=>{complete=resolve;})};
 const adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 const reloading=adapter.move(item,{kind:'reload'});
 revision=1;
 await adapter.refresh();
 assert.equal(adapter.view.items[0].revision,1);
 assert.equal(JSON.parse(saved.getItem(adapter.key)).command.revision,0);
 complete({status:'committed'});await reloading;
 assert.equal(saved.getItem(adapter.key),null);adapter.close();
});
test('batch resumes after a lost middle reply without repeating completed items or rebasing life',async()=>{
 const items=[item,{...item,id:'c'.repeat(32)},{...item,id:'d'.repeat(32)}],saved=storage(),sent=[];
 let lose=true;
 const client={inventoryPage:async()=>({...page(items),life:lose?0:1}),moveInventory:async command=>{
  sent.push(structuredClone(command));
  if(command.item===items[1].id&&lose){lose=false;throw Error('lost middle reply');}
  return {status:command.item===items[2].id?'rejected':'committed'};
 }};
 let adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 await assert.rejects(adapter.moveBatch(items,{kind:'drop'}),/lost middle reply/);adapter.close();
 assert.equal(JSON.parse(saved.getItem(adapter.key)).commands.length,2);
 adapter=new InventoryClient(client,{principal,storage:saved});
 const result=await adapter.recover();
 assert.deepEqual(sent.map(c=>c.item),[items[0].id,items[1].id,items[1].id,items[2].id]);
 assert.deepEqual(sent[1],sent[2]);assert.ok(sent.every(c=>c.life===0));
 assert.deepEqual(result.results.map(r=>r.status),['committed','committed','rejected']);
 assert.equal(saved.getItem(adapter.key),null);adapter.close();
});
test('batch persistence failure replays acknowledged head and never skips an item',async()=>{
 const saved=storage(),write=saved.setItem,sent=[];let fail=false;
 saved.setItem=(key,value)=>{if(fail){fail=false;throw Error('quota');}write(key,value);};
 const client={inventoryPage:async()=>page([item]),moveInventory:async command=>{
  sent.push(structuredClone(command));if(sent.length===1)fail=true;return {status:'committed'};
 }};
 const adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 await assert.rejects(adapter.moveBatch([item],{kind:'drop'}),/quota/);
 await adapter.recover();assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);
 assert.equal(saved.getItem(adapter.key),null);
 await assert.rejects(adapter.moveBatch([item,item],{kind:'drop'}),/Invalid inventory batch/);
 assert.equal(sent.length,2);adapter.close();
});
test('lost reply survives adapter recreation and replays exactly one command ID',async()=>{
 const saved=storage(),sent=[];let lost=true;
 const client={inventoryPage:async()=>page(lost?[item]:[]),moveInventory:async command=>{sent.push(command);if(lost){lost=false;throw Error('lost reply');}return {status:'committed'};}};
 let adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 await assert.rejects(adapter.move(item,{kind:'drop'}),/lost reply/);adapter.close();
 adapter=new InventoryClient(client,{principal,storage:saved});await adapter.recover();
 assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.deepEqual(adapter.view.items,[]);assert.equal(saved.getItem(adapter.key),null);
});
test('generation conflict discards partial inventory before publishing',async()=>{
 let call=0;const published=[];
 const client={inventoryPage:async()=>[page([item],1,item.id),{status:'conflict',generation:2},page([],2)][call++]};
 const adapter=new InventoryClient(client,{principal,storage:storage(),onChange:view=>published.push(view)});
 await adapter.refresh();assert.equal(call,3);assert.equal(published.length,1);assert.deepEqual(published[0].items,[]);
});
test('durable rejection clears pending intent; storage failure sends nothing',async()=>{
 let sends=0;const client={inventoryPage:async()=>page([item]),moveInventory:async()=>{sends++;return {status:'rejected',reason:'stale_or_dead_life'};}};
 const saved=storage(),adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 await adapter.move(item,{kind:'drop'});assert.equal(saved.getItem(adapter.key),null);assert.equal(sends,1);
 saved.setItem=()=>{throw Error('quota');};await assert.rejects(adapter.move(item,{kind:'drop'}),/quota/);assert.equal(sends,1);
});
test('malformed pages do not replace the last coherent inventory',async()=>{
 let invalid=false;const client={inventoryPage:async()=>invalid?page([item,item]):page([item])};
 const adapter=new InventoryClient(client,{principal,storage:storage()});await adapter.refresh();invalid=true;
 await assert.rejects(adapter.refresh(),/Invalid inventory item/);assert.equal(adapter.view.items.length,1);
});
test('lost respawn reply replays its original life and reconciles a later death',async()=>{
 const saved=storage(),sent=[];let lost=true;
 const client={inventoryPage:async()=>({...page([]),life:lost?0:1,alive:false}),respawnInventory:async command=>{
  sent.push(command);if(lost){lost=false;throw Error('lost respawn reply');}return {status:'respawned',life:1,alive:true};
 }};
 let adapter=new InventoryClient(client,{principal,storage:saved});await adapter.refresh();
 await assert.rejects(adapter.respawn(),/lost respawn reply/);adapter.close();
 adapter=new InventoryClient(client,{principal,storage:saved});await adapter.recover();
 assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[1].life,0);
 assert.equal(adapter.view.life,1);assert.equal(adapter.view.alive,false);assert.deepEqual(adapter.view.items,[]);
 assert.equal(saved.getItem(adapter.key),null);
});
test('open inventory recovers lost replies with bounded backoff and stops after close',async()=>{
 const sent=[],timers=new Map(),delays=[];let next=0,lost=2;
 const client={inventoryPage:async()=>page(lost?[item]:[]),moveInventory:async command=>{
  sent.push(structuredClone(command));if(lost-->0)throw Error('lost reply');return {status:'committed'};
 }};
 const saved=storage(),adapter=new InventoryClient(client,{principal,storage:saved,
  schedule:(fn,delay)=>{delays.push(delay);timers.set(++next,fn);return next;},cancel:id=>timers.delete(id)});
 await adapter.refresh();await assert.rejects(adapter.move(item,{kind:'drop'}),/lost reply/);
 assert.deepEqual(delays,[1000]);
 // Manual recovery uses the same journal and cancels the pending scheduled retry.
 await assert.rejects(adapter.recover(),/lost reply/);assert.deepEqual(delays,[1000,2000]);assert.equal(timers.size,1);
 const run=[...timers.values()][0];timers.clear();run();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,3);assert.deepEqual(sent[0],sent[1]);assert.deepEqual(sent[0],sent[2]);
 assert.equal(saved.getItem(adapter.key),null);assert.equal(timers.size,0);
 lost=1;await assert.rejects(adapter.move(item,{kind:'drop'}),/lost reply/);assert.equal(delays.at(-1),1000);
 adapter.close();assert.equal(timers.size,0);await adapter.recover();assert.equal(sent.length,4);
});
test('default retry timers keep the browser timer receiver rather than the inventory adapter',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;let scheduled=0,cancelled=0;
 globalThis.setTimeout=function(){assert.equal(this,undefined);scheduled++;return 7;};
 globalThis.clearTimeout=function(timer){assert.equal(this,undefined);assert.equal(timer,7);cancelled++;};
 try{
  const adapter=new InventoryClient({inventoryPage:async()=>page([item]),moveInventory:async()=>{throw Error('lost reply');}},{principal,storage:storage()});
  await adapter.refresh();await assert.rejects(adapter.move(item,{kind:'drop'}),/lost reply/);
  assert.equal(scheduled,1);adapter.close();assert.equal(cancelled,1);
 }finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});
