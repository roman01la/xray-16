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
