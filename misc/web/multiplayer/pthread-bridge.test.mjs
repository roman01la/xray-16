import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPthreadBridge,installDormantEngineBridge} from './pthread-bridge.mjs';
const contract=JSON.parse(await readFile(new URL('./contract.json',import.meta.url)));
const wait=()=>new Promise(r=>setTimeout(r,20));
class Client extends EventTarget {
  contract=contract;playerId=1;closed=false;
  snapshot={tick:10,playerId:1,ack:0,entities:[{id:1,x:2,y:0,z:4,vx:0,vy:0,vz:0,yaw:0,health:100,kind:1,flags:0}]};
  close(){this.closed=true;}setInput(value){this.input=value;}
}
test('only a pthread executing the C++ hook claims the session',async t=>{
  const reports=[];const c=new Client(),hub=createPthreadBridge(c,{epoch:'test',onApplied:r=>reports.push(r)}),idle={},application={},other={},heap=new Uint8Array(100);
  const options={epoch:'test',contract,getHeap:()=>heap};
  const cleanups=[installDormantEngineBridge(idle,hub.createPort(),options),installDormantEngineBridge(application,hub.createPort(),options),installDormantEngineBridge(other,hub.createPort(),options)];
  t.after(()=>{cleanups.forEach(f=>f());hub.close();});
  await wait();assert.equal(c.closed,false);
  assert.equal(application.zoneEnginePoll(0n,100),0);await wait();
  assert.equal(application.zoneEnginePoll(0n,100),60);assert.equal(new DataView(heap.buffer).getFloat32(28,true),2);
  application.zoneEngineInput({x:1,z:0,yaw:0,sprint:false});await wait();assert.equal(c.input.x,1);
  assert.deepEqual(reports,[]);application.zoneEngineApplied(10,1);await wait();assert.deepEqual(reports,[{tick:10,entities:1}]);
  assert.equal(other.zoneEnginePoll(0n,100),0);await wait();assert.equal(other.zoneEnginePoll(0n,100),-1);assert.equal(c.closed,false);
  hub.close();await wait();assert.equal(application.zoneEnginePoll(0n,100),-1);assert.throws(()=>hub.createPort(),/closed/);
});
test('disconnect before a worker starts prevents late attachment',async t=>{
  const c=new Client(),hub=createPthreadBridge(c,{epoch:'test'}),scope={};
  const cleanup=installDormantEngineBridge(scope,hub.createPort(),{epoch:'test',contract,getHeap:()=>new Uint8Array(100)});
  t.after(()=>{cleanup();hub.close();});
  c.dispatchEvent(new Event('disconnected'));scope.zoneEnginePoll(0n,100);await wait();assert.equal(scope.zoneEnginePoll(0n,100),-1);
});
test('detonation polling writes stock sections and coordinates to the active wasm64 worker only',async t=>{
 const c=new Client(),hub=createPthreadBridge(c,{epoch:'blast'}),scope={},heap=new Uint8Array(1200).fill(255);
 const cleanup=installDormantEngineBridge(scope,hub.createPort(),{epoch:'blast',contract,getHeap:()=>heap});
 t.after(()=>{cleanup();hub.close();});
 assert.equal(scope.zoneEngineDetonations(8n,8),0);
 scope.zoneEnginePoll(0n,100);await wait();
 const maxSection='a'.repeat(128);
 c.dispatchEvent(new CustomEvent('detonations',{detail:[['wpn_fake_missile2',-15.5,3.25,7],[maxSection,2,4,-8]]}));
 await wait();
 assert.equal(scope.zoneEngineDetonations(100n,8),0);
 assert.equal(scope.zoneEngineDetonations(8n,8),2);
 const view=new DataView(heap.buffer);
 const stringAt=(at,length)=>new TextDecoder().decode(heap.subarray(at,at+length));
 assert.deepEqual([8,12,16].map(at=>view.getFloat32(at,true)),[-15.5,3.25,7]);
 assert.equal(stringAt(20,17),'wpn_fake_missile2');
 assert.equal(heap[37],0);
 assert.equal(view.getFloat32(152,true),2);
 assert.equal(stringAt(164,128),maxSection);
 assert.equal(heap[292],0);
 assert.equal(scope.zoneEngineDetonations(8n,8),0);
 cleanup();assert.equal(scope.zoneEngineDetonations,undefined);
});
test('corpse polling stays dormant until the application hook and copies explicit closure',async t=>{
 const c=new Client(),hub=createPthreadBridge(c,{epoch:'corpse'}),scope={},heap=new Uint8Array(512);
 c.inventory={view:{life:2,alive:true,generation:1,corpse:null,items:[]}};
 c.corpseSearch={view:{source:'b'.repeat(32),generation:1,life:2,items:[]},dismiss(){this.view=null;c.dispatchEvent(new CustomEvent('corpse-search',{detail:null}));}};
 const cleanup=installDormantEngineBridge(scope,hub.createPort(),{epoch:'corpse',contract,getHeap:()=>heap});
 t.after(()=>{cleanup();hub.close();});
 assert.equal(scope.zoneEngineCorpseSearchPoll(0n,512),0);await wait();assert.equal(c.closed,false);
 await assert.rejects(scope.zoneEngineCorpseIntent({kind:'dismiss',life:2}),/unavailable/);
 scope.zoneEnginePoll(0n,512);await wait();
 assert.equal(scope.zoneEngineCorpseSearchPoll(128n,384),72);const bytes=new DataView(heap.buffer);assert.equal(bytes.getUint32(144,true),1);
 await scope.zoneEngineCorpseIntent({kind:'dismiss',life:2});await wait();
 assert.equal(scope.zoneEngineCorpseSearchPoll(128n,384),24);assert.equal(bytes.getUint32(144,true),0);
 cleanup();assert.equal(scope.zoneEngineCorpseSearchPoll,undefined);assert.equal(scope.zoneEngineCorpseIntent,undefined);
});
