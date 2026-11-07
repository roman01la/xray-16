import test from 'node:test';import assert from 'node:assert/strict';import {DurableOutbox} from './outbox.mjs';
const identity={principalId:'a'.repeat(32),secret:'b'.repeat(64)};
function env(){const map=new Map();let tail=Promise.resolve();return {storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},locks:{request:(_k,_o,fn)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;}}};}
const payload={expectedRevision:0,value:{fixture:true}};
test('lost committed response survives reload and reuses exact request',async()=>{
 const e=env(),ledger=new Map();let effects=0,lose=true;
 const send=async(kind,c)=>{assert.equal(kind,'record');if(!ledger.has(c.requestId)){effects++;ledger.set(c.requestId,{status:'committed',revision:1});}if(lose){lose=false;throw Error('reply lost');}return ledger.get(c.requestId);};
 let box=new DurableOutbox(identity,{...e,send});const queued=await box.enqueue('record',payload);
 await assert.rejects(box.flush(),/reply lost/);assert.equal((await box.entries())[0].result,null);
 box=new DurableOutbox(identity,{...e,send});const done=await box.flush();assert.equal(effects,1);assert.equal(done[0].command.requestId,queued.command.requestId);assert.equal(done[0].result.status,'committed');
 await box.acknowledge(queued.command.requestId);assert.deepEqual(await box.entries(),[]);
});
test('storage failures never lose the original pending command',async()=>{
 const e=env();let calls=0,fail=false;const original=e.storage.setItem;e.storage.setItem=(k,v)=>{if(fail)throw Error('quota');original(k,v);};
 const box=new DurableOutbox(identity,{...e,send:async()=>{calls++;fail=true;return {status:'committed',revision:1};}});
 fail=true;await assert.rejects(box.enqueue('record',payload),/quota/);assert.equal(calls,0);
 fail=false;await box.enqueue('record',payload);await assert.rejects(box.flush(),/quota/);fail=false;assert.equal((await box.entries())[0].result,null);
});
test('two tabs serialize sends and preserve conflicts until acknowledged',async()=>{
 const e=env();let calls=0;const send=async()=>{calls++;return {status:'conflict',revision:4};};
 const a=new DurableOutbox(identity,{...e,send}),b=new DurableOutbox(identity,{...e,send});const item=await a.enqueue('record',payload);
 await assert.rejects(a.acknowledge(item.command.requestId),/unresolved/);
 await Promise.all([a.flush(),b.flush()]);assert.equal(calls,1);assert.equal((await b.entries())[0].result.status,'conflict');
 await assert.rejects(a.enqueue('record',{...payload,requestId:item.command.requestId,value:42}),/already used/);
});
test('bounded outbox cannot silently evict or cross principal storage',async()=>{
 const e=env(),a=new DurableOutbox(identity,e);for(let i=0;i<32;i++)await a.enqueue('record',{...payload,requestId:'r'+i});
 await assert.rejects(a.enqueue('record',payload),/full/);assert.equal((await a.entries()).length,32);
 const b=new DurableOutbox({...identity,principalId:'c'.repeat(32)},e);assert.deepEqual(await b.entries(),[]);
});
