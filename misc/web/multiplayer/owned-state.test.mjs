import test from 'node:test';import assert from 'node:assert/strict';import {OwnedState,bindOwnedState} from './owned-state.mjs';
const entity=n=>({id:n.toString(16).padStart(32,'0'),revision:0,value:{fixture:n}});
function options(){return {schedule:()=>1,cancel:()=>{}};}
test('mixed generations are discarded and only a complete replacement is published',async()=>{
 const calls=[],seen=[];let run=0;
 const view=new OwnedState(async(after,generation)=>{
  calls.push([after,generation]);if(!after){run++;return {generation:run,entities:[entity(1)],nextCursor:entity(1).id};}
  return run===1?{status:'conflict',generation:2}:{generation:2,entities:[entity(2)],nextCursor:null};
 },options());view.addEventListener('snapshot',e=>seen.push(e.detail));
 await view.refresh();assert.equal(seen.length,1);assert.equal(seen[0].entities.length,2);assert.equal(calls[1][1],1);assert.equal(calls[3][1],2);view.close();
});
test('invalidation during a fetch cannot publish obsolete data',async()=>{
 let release,calls=0;const view=new OwnedState(async()=>{calls++;if(calls===1)return new Promise(r=>{release=r;});return {generation:2,entities:[entity(2)],nextCursor:null};},options());
 const first=view.refresh();view.refresh();release({generation:1,entities:[entity(1)],nextCursor:null});await first;
 assert.equal(view.snapshot().entities[0].id,entity(2).id);view.close();
});
test('errors retain the last complete view as stale and never publish partial pages',async()=>{
 let bad=false;const view=new OwnedState(async after=>bad?(after?{generation:2,entities:[entity(2)],nextCursor:entity(1).id}:{generation:2,entities:[entity(2)],nextCursor:entity(2).id}):{generation:1,entities:[entity(1)],nextCursor:null},options());
 await view.refresh();bad=true;await assert.rejects(view.refresh(),/ordering|cursor/);assert.equal(view.snapshot().entities[0].id,entity(1).id);assert.equal(view.snapshot().stale,true);view.close();
});
test('disconnect clears owned state and a late fetch cannot resurrect it',async()=>{
 let release;const view=new OwnedState(()=>new Promise(r=>{release=r;}),options());const pending=view.refresh();view.close();release({generation:1,entities:[entity(1)],nextCursor:null});await assert.rejects(pending,/closed/);assert.deepEqual(view.snapshot().entities,[]);
 const client=new EventTarget();client.closed=true;const bound=bindOwnedState(client,{principalId:'a'.repeat(32)},options());assert.equal(bound.closed,true);
});
test('capacity, ordering and repeated conflicts fail boundedly',async()=>{
 let calls=0;const busy=new OwnedState(async()=>{calls++;return {status:'conflict',generation:1};},options());await assert.rejects(busy.refresh(),/deferred/);assert.equal(calls,3);busy.close();
 const large=new OwnedState(async()=>({generation:1,entities:[entity(1),entity(2)],nextCursor:null}),{...options(),maxEntities:1});await assert.rejects(large.refresh(),/capacity/);large.close();
});
test('failed refresh backs off, successful refresh audits, and close cancels timers',async()=>{
 const delays=[],cancelled=[];let fail=true;
 const view=new OwnedState(async()=>{if(fail)throw Error('offline');return {generation:0,entities:[],nextCursor:null};},{schedule:(_fn,ms)=>{delays.push(ms);return delays.length;},cancel:id=>cancelled.push(id)});
 await assert.rejects(view.refresh(),/offline/);await assert.rejects(view.refresh(),/offline/);fail=false;await view.refresh();assert.deepEqual(delays,[1000,2000,30000]);view.close();assert.ok(cancelled.includes(3));
});
