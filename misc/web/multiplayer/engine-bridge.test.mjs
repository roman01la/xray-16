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
test('inputs coalesce under backpressure and actions return reliable results',async t=>{const {c,e}=setup(t);await wait();for(let i=0;i<1000;i++)e.setInput({x:i/1000,z:0,yaw:0,sprint:false});await wait();await wait();assert.equal(c.input.x,.999);assert.deepEqual(await e.attack(2),{applied:{health:75}});assert.equal(c.attacks,1);});
test('old-session messages cannot affect new session',async t=>{const {c,b,e}=setup(t);await wait();b.receive({epoch:'old',type:'input',sequence:1,input:{x:1,z:0,yaw:0,sprint:true}});e.receive({epoch:'old',type:'closed'});assert.deepEqual(c.input,{});assert.equal(e.closed,false);});
test('world mismatch closes bridge before snapshots or inputs',async t=>{const c=new Client(),{port1,port2}=new MessageChannel();const b=new BrowserEngineBridge(c,port1,{epoch:'test'});const e=new EngineBridgeEndpoint(port2,{epoch:'test',contract:{...contract,world:'zaton'}});t.after(()=>{b.close();e.close();});await wait();assert.equal(c.closed,true);assert.equal(b.ready,false);});
test('disconnect clears entity snapshot and rejects pending actions',async t=>{const {c,b,e}=setup(t);await wait();c.push(1);await wait();c.attack=()=>new Promise(()=>{});const action=e.attack(2);const rejected=assert.rejects(action,/transport|closed/);b.close('transport disconnected');await wait();assert.equal(e.consumeSnapshot(),null);assert.equal(e.closed,true);await rejected;});
test('invalid input closes transport instead of entering simulation',async t=>{const {c,b}=setup(t);await wait();b.receive({epoch:'test-1',type:'input',sequence:1,input:{x:NaN,z:0,yaw:0,sprint:false}});assert.equal(c.closed,true);});

test('fire intent crosses the worker boundary without client hit claims',async t=>{
 const {c,e}=setup(t);await wait();let received;
 c.fire=async aim=>{received=aim;return {status:'blocked',ammo:29};};
 assert.deepEqual(await e.fire({tick:12,yaw:.5,pitch:-.2,target:99}),{status:'blocked',ammo:29});
 assert.deepEqual(received,{tick:12,yaw:.5,pitch:-.2});
 await assert.rejects(e.fire({tick:13,yaw:NaN,pitch:0}),/Invalid aim/);
 assert.equal(e.closed,false);
});
test('reload and respawn remain bounded reliable worker actions',async t=>{
 const {c,e}=setup(t);await wait();c.reload=async()=>({status:'started',ready_tick:90});c.respawn=async()=>({status:'rejected',reason:'alive'});
 assert.deepEqual(await e.reload(),{status:'started',ready_tick:90});
 assert.deepEqual(await e.respawn(),{status:'rejected',reason:'alive'});
 assert.equal(e.requests.size,0);e.close();await assert.rejects(e.reload(),/unavailable/);
});
