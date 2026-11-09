import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {resolve} from 'node:path';
import {encodeControl,decodeControl,validateDetonations,validateGrenades,validateGunshots,validateVitals,validateWeaponReload} from './control.mjs';
const commands=[{type:'attack',sequence:1,target:42},{type:'reload',sequence:2},{type:'respawn',sequence:3,request_id:'d'.repeat(32),life:5},{type:'fire',sequence:0xffffffff,item:'e'.repeat(32),aim:{tick:123,yaw:Math.fround(1.2),pitch:Math.fround(-0.1)}},{type:'leave',sequence:0},{type:'use_travel',sequence:1}];
commands.push({type:'world_items',sequence:8,after:''},{type:'world_items',sequence:9,after:'d'.repeat(32)});
commands.push({type:'select_weapon',sequence:7,slot:3,life:5});
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
const launcherModeIndex=commands.length-1;
const grenade={type:'grenade',sequence:90,item:'c'.repeat(32),aim:{tick:123,yaw:0,pitch:0},phase:'prime'};
for(const [i,phase] of ['prime','release','cancel'].entries())commands.push({...grenade,sequence:90+i,phase});
const knife={type:'knife',sequence:95,item:'d'.repeat(32),aim:{tick:123,yaw:Math.fround(-1.2),pitch:Math.fround(0.3)},mode:'slash'};
commands.push(knife,{...knife,sequence:96,mode:'stab'},{type:'select_weapon',sequence:97,life:0,slot:1});
commands.push({type:'select_weapon',sequence:93,slot:4,life:0});
commands.push({type:'select_weapon',sequence:98,slot:6,life:0});
const detector={type:'select_detector',sequence:99,life:5,active:true};
commands.push(detector,{...detector,sequence:100,active:false});
const packets=commands.map(c=>Array.from(new Uint8Array(encodeControl(c))));
const malformed=[...packets.map(p=>p.slice(0,-1)),[...packets[1],0],packets[1].map((v,i)=>i===2?2:v),[0x58,0x5a,3,17]];
malformed.push(packets[launcherModeIndex].map((v,i)=>i===49?2:v),packets[launcherModeIndex].map((v,i)=>i===50?1:v));
malformed.push(packets.at(-1).map((v,i)=>i===8?2:v));
for(const opcode of [15,27]){
 const packet=packets.find(p=>p[3]===opcode);
 malformed.push(packet.map((v,i)=>i===36?3:v),packet.map((v,i)=>i>=20&&i<36?0:v));
}
const fixture=JSON.parse(execFileSync('cargo',['+1.93.1','run','--quiet','--offline','--manifest-path',resolve(import.meta.dirname,'../../../server/Cargo.toml'),'--bin','control_fixture'],{input:JSON.stringify([...packets,...malformed]),encoding:'utf8'}));
test('Rust decodes actual JS commands and rejects malformed or wrong-direction packets',()=>{
 assert.deepEqual(fixture.commands.slice(0,commands.length),commands);assert.ok(fixture.commands.slice(commands.length).every(c=>c===null));
 assert.deepEqual(packets.map(p=>p.length),[12,8,28,36,8,8,24,24,13,32,32,66,66,66,66,66,66,66,66,66,66,24,48,48,36,36,8,66,66,70,66,66,66,37,37,37,37,37,13,13,13,13,13]);
 assert.throws(()=>encodeControl({...grenade,force:1000}));
 assert.throws(()=>encodeControl({...knife,mode:'throw'}));
 assert.throws(()=>encodeControl({...knife,damage:999}));
 assert.throws(()=>encodeControl({...knife,item:null}));
 assert.throws(()=>encodeControl({...detector,active:1}));
 assert.throws(()=>encodeControl({...detector,position:[1,2,3]}));
});
test('browser decodes every Rust event type including nested contract, lifecycle and result',()=>{
 const events=fixture.encoded.map(p=>decodeControl(Uint8Array.from(p).buffer));
 assert.deepEqual(events,fixture.events);
 assert.equal(validateVitals(events.find(e=>e.type==='vitals').state)[12],864);
 assert.equal(validateVitals(events.find(e=>e.type==='vitals').state)[13],0x4052);
 const knifeCue=fixture.encoded.find(bytes=>bytes[3]===32);
 assert.equal(knifeCue.at(-1),2);
 assert.throws(()=>decodeControl(Uint8Array.from([...knifeCue.slice(0,-1),3,1,0,0,0]).buffer),/Invalid knife swing cue/);
});
test('travel events only accept known campaign worlds',()=>{
 const packet=Uint8Array.from(fixture.encoded.find(bytes=>bytes[3]===25));
 packet[7]='x'.charCodeAt(0);
 assert.throws(()=>decodeControl(packet.buffer),/Invalid travel world/);
 assert.throws(()=>encodeControl({type:'use_travel',sequence:1,destination:'labx8'}));
});
test('detonation batches reject untrusted paths, nonfinite coordinates and excess effects',()=>{
 const good=['wpn_fake_missile2',-15.5,3.25,7.0];
 assert.deepEqual(validateDetonations([good]),[good]);
 for(const effects of [[],Array(9).fill(good),[['../explode',0,0,0]],[['wpn_fake_missile2\n',0,0,0]],[['fake',Infinity,0,0]],[['fake',0,32769,0]],[['fake',0,0,0,1]]])
   assert.throws(()=>validateDetonations(effects),/detonation/);
});
test('grenade frames are bounded and require unique IDs and stock-style asset names',()=>{
 const entry=[8,'grenade_gd-05',2,3,4],frame={tick:110,entries:[entry]};
 assert.equal(validateGrenades(frame),frame);
 assert.deepEqual(validateGrenades({tick:112,entries:[]}).entries,[]);
 for(const entries of [[entry,entry],[[0,...entry.slice(1)]],[[1,'../mesh',2,3,4]],[[1,'grenade_f1',2,3,Infinity]]])
   assert.throws(()=>validateGrenades({...frame,entries}),/grenade/);
});
test('positional weapon effects accept only bounded sections, matching modes and coordinates',()=>{
 const shot=[9,'wpn_pb',1,-15.5,3.25,7];
 const slash=[9,'wpn_knife',3,-15.5,3.25,7],stab=[9,'wpn_knife',4,-15.5,3.25,7];
 assert.deepEqual(validateGunshots([shot,slash,stab]),[shot,slash,stab]);
 for(const effects of [[],Array(9).fill(shot),[[0,...shot.slice(1)]],[[9,'../shot',0,0,0,0]],[[9,'wpn_pb',3,0,0,0]],[[9,'wpn_knife',0,0,0,0]],[[9,'wpn_pb',1,Infinity,0,0]]])
   assert.throws(()=>validateGunshots(effects),/gunshot/);
});
test('reload phases and terminal cues have distinct sound and cancellation fields',()=>{
 const phase={life:9,item:'e'.repeat(32),alias:'anm_reload',milliseconds:3035,sound:3,cancelled:false};
 const end={...phase,alias:'',milliseconds:0,sound:0};
 assert.equal(validateWeaponReload(phase),phase);
 for(const cancelled of [true,false])assert.deepEqual(validateWeaponReload({...end,cancelled}),{...end,cancelled});
 for(const cue of [{...phase,sound:0},{...phase,sound:9},{...phase,cancelled:true},{...end,sound:3},{...end,alias:'anm_open'}])
   assert.throws(()=>validateWeaponReload(cue),/reload cue/);
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


test('private vitals carry bounded condition, load, movement, weapon slot and booster icons',()=>{
 const state=[7,123,456,789,10,0,4,62000,50000,60000,1000,3,864,0x2022];
 assert.equal(validateVitals(state),state);
 const drawnKnife=state.slice();drawnKnife[11]=1;
 assert.equal(validateVitals(drawnKnife),drawnKnife);
 const drawnBolt=state.slice();drawnBolt[11]=6;
 assert.equal(validateVitals(drawnBolt),drawnBolt);
 for(const [field,value] of [[1,1001],[1,NaN],[6,8],[7,-1],[8,65000],[10,1001],[11,5],[12,1001],[13,0x10000],[13,0x0100]]){
  const malformed=state.slice();malformed[field]=value;
  assert.throws(()=>validateVitals(malformed));
 }
 assert.throws(()=>validateVitals([7,0]));
});
