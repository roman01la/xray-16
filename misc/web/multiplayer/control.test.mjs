import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {resolve} from 'node:path';
import {encodeControl,decodeControl,validateDetonations,validateVitals} from './control.mjs';
const commands=[{type:'attack',sequence:1,target:42},{type:'reload',sequence:2},{type:'respawn',sequence:3,request_id:'d'.repeat(32),life:5},{type:'fire',sequence:0xffffffff,item:'e'.repeat(32),aim:{tick:123,yaw:Math.fround(1.2),pitch:Math.fround(-0.1)}},{type:'leave',sequence:0}];
commands.push({type:'world_items',sequence:8,after:''},{type:'world_items',sequence:9,after:'d'.repeat(32)});
commands.push({type:'inventory_list',sequence:10,after:'',generation:null},{type:'inventory_list',sequence:11,after:'a'.repeat(32),generation:9007199254740991});
for(const action of [{kind:'pickup',source:'c'.repeat(32)},{kind:'drop'},{kind:'place',placement:{kind:'rucksack'}},{kind:'place',placement:{kind:'slot',slot:7}},{kind:'place',placement:{kind:'belt',cell:4}},{kind:'reload'},{kind:'unload'},{kind:'nextAmmo'},{kind:'store',destination:'f'.repeat(32)},{kind:'consume'}])commands.push({type:'inventory_move',sequence:20+commands.length,command:{requestId:'a'.repeat(32),life:7,item:'b'.repeat(32),revision:123,action}});
commands.push({type:'corpses',sequence:40,after:''},{type:'corpse_items',sequence:41,source:'e'.repeat(32),after:'',generation:null},{type:'corpse_items',sequence:42,source:'e'.repeat(32),after:'f'.repeat(32),generation:9007199254740991});
commands.push({type:'fire',sequence:43,item:null,aim:{tick:123,yaw:0,pitch:0}});
commands.push({...commands[3],type:'trigger_start',sequence:44},{type:'trigger_stop',sequence:45});
for(const next of [false,true]){
 commands.push({type:'inventory_move',sequence:46+Number(next),command:{requestId:'a'.repeat(32),life:7,item:'b'.repeat(32),revision:123,action:{kind:'fireMode',next}}});
}
for(const action of [{kind:'attach',addon:'c'.repeat(32),addonRevision:0xffffffff},{kind:'detach',slot:'launcher'},{kind:'launcherMode',active:true},{kind:'launcherMode',active:false}]){
 commands.push({type:'inventory_move',sequence:50+commands.length,command:{requestId:'a'.repeat(32),life:7,item:'b'.repeat(32),revision:123,action}});
}
const packets=commands.map(c=>Array.from(new Uint8Array(encodeControl(c))));
const malformed=[...packets.map(p=>p.slice(0,-1)),[...packets[1],0],packets[1].map((v,i)=>i===2?2:v),[0x58,0x5a,3,17]];
malformed.push(packets.at(-1).map((v,i)=>i===49?2:v),packets.at(-1).map((v,i)=>i===50?1:v));
const fixture=JSON.parse(execFileSync('cargo',['+1.93.1','run','--quiet','--offline','--manifest-path',resolve(import.meta.dirname,'../../../server/Cargo.toml'),'--bin','control_fixture'],{input:JSON.stringify([...packets,...malformed]),encoding:'utf8'}));
test('Rust decodes actual JS commands and rejects malformed or wrong-direction packets',()=>{
 assert.deepEqual(fixture.commands.slice(0,commands.length),commands);assert.ok(fixture.commands.slice(commands.length).every(c=>c===null));
 assert.deepEqual(packets.map(p=>p.length),[12,8,28,36,8,24,24,32,32,66,66,66,66,66,66,66,66,66,66,24,48,48,36,36,8,66,66,70,66,66,66]);
});
test('browser decodes every Rust event type including nested contract, lifecycle and result',()=>{
 assert.deepEqual(fixture.encoded.map(p=>decodeControl(Uint8Array.from(p).buffer)),fixture.events);
});
test('detonation batches reject untrusted paths, nonfinite coordinates and excess effects',()=>{
 const good=['wpn_fake_missile2',-15.5,3.25,7.0];
 assert.deepEqual(validateDetonations([good]),[good]);
 for(const effects of [[],Array(9).fill(good),[['../explode',0,0,0]],[['wpn_fake_missile2\n',0,0,0]],[['fake',Infinity,0,0]],[['fake',0,32769,0]],[['fake',0,0,0,1]]])
   assert.throws(()=>validateDetonations(effects),/detonation/);
});
test('control decoder rejects text, wrong version, opcode, truncation, oversized and trailing bytes',()=>{
 assert.throws(()=>decodeControl('{"type":"ownership_dirty"}'));
 for(const bytes of fixture.encoded){
  const b=Uint8Array.from(bytes);for(let n=0;n<b.length;n++)assert.throws(()=>decodeControl(b.slice(0,n).buffer));
  assert.throws(()=>decodeControl(Uint8Array.from([...bytes,0]).buffer));
  b[2]=2;assert.throws(()=>decodeControl(b.buffer));
 }
 assert.throws(()=>decodeControl(new ArrayBuffer(16385)));assert.throws(()=>decodeControl(Uint8Array.from([0x58,0x5a,3,255]).buffer));
});
test('client encoder rejects extra authority fields, nonfinite aim and invalid sequence',()=>{
 assert.throws(()=>encodeControl({type:'reload',sequence:1,damage:100}));
 for(const n of [NaN,Infinity,1e100])assert.throws(()=>encodeControl({type:'fire',sequence:1,item:null,aim:{tick:1,yaw:n,pitch:0}}));
 assert.throws(()=>encodeControl({type:'fire',sequence:1,item:null,aim:{tick:1,yaw:0,pitch:0,origin:[0,0,0]}}));
 assert.throws(()=>encodeControl({...commands[3],item:'0'.repeat(32)}),/Invalid weapon ID/);
 assert.throws(()=>encodeControl({...commands[3],item:'bad'}),/Invalid weapon ID/);
 assert.throws(()=>encodeControl({...commands[3],type:'trigger_start',item:null}),/Missing trigger weapon ID/);
 assert.throws(()=>encodeControl({type:'respawn',sequence:-1}));
});

test('inventory encoder rejects forged authority, invalid IDs and placement bounds',()=>{
 const good=commands.find(c=>c.type==='inventory_move');
 assert.throws(()=>encodeControl({...good,command:{...good.command,position:[0,0,0]}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,item:'bad'}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'place',placement:{kind:'belt',cell:5}}}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'reload',rounds:30}}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'fireMode',next:1}}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'attach',addon:good.command.item,addonRevision:0}}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'detach',slot:'knife'}}}));
 assert.throws(()=>encodeControl({...good,command:{...good.command,action:{kind:'launcherMode',active:1}}}));
 assert.throws(()=>encodeControl({type:'inventory_list',sequence:1,after:'a'.repeat(32),generation:null}));
});

test('world discovery cannot supply position, radius or a malformed cursor',()=>{
 for(const extra of [{position:[0,0,0]},{radius:10000}])assert.throws(()=>encodeControl({type:'world_items',sequence:1,after:'',...extra}));
 assert.throws(()=>encodeControl({type:'world_items',sequence:1,after:'bad'}));
});


test('private vitals carry bounded condition, load and movement policy',()=>{
 const state=[7,123,456,789,10,0,4,62000,50000,60000,1000];
 assert.equal(validateVitals(state),state);
 for(const [field,value] of [[1,1001],[1,NaN],[6,8],[7,-1],[8,65000],[10,1001]]){
  const malformed=state.slice();malformed[field]=value;
  assert.throws(()=>validateVitals(malformed));
 }
 assert.throws(()=>validateVitals([7,0]));
});
