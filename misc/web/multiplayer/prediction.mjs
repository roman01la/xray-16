import {newer} from './protocol.mjs';
export const MAX_REPLAY=8,MAX_HISTORY=32;
export class Reconciler {
 constructor(motor,now=()=>performance.now()){this.motor=motor;this.now=now;this.snapshot=null;this.history=[];this.result=null;this.updated=0;this.replays=0;}
 snapshotReceived(snapshot,vitals=null){this.snapshot=snapshot;this.vitals=vitals;this.updated=this.now();this.reconcile();}
 inputsReceived(history){
  if(!Array.isArray(history)||history.length>MAX_HISTORY||history.some((i,n)=>!Number.isInteger(i.sequence)||i.sequence<0||i.sequence>0xffffffff||!['x','z','yaw'].every(k=>Number.isFinite(i[k]))||Math.abs(i.x)>1.001||Math.abs(i.z)>1.001||typeof i.sprint!=='boolean'||(i.jump!==undefined&&typeof i.jump!=='boolean')||(i.crouch!==undefined&&typeof i.crouch!=='boolean')||(n>0&&!newer(i.sequence,history[n-1].sequence))))throw Error('Invalid prediction history');
  this.history=history;this.reconcile();
 }
 reconcile(){
  this.replays=0;const s=this.snapshot;if(!s)return;
  const player=s.entities.find(e=>e.id===s.playerId);if(!player||player.health===0){this.result=null;return;}
  const pending=this.history.filter(i=>newer(i.sequence,s.ack));
  // A paused/lagged client falls back to authority instead of simulating a
  // burst of old commands or running far ahead of the server.
  if(pending.length>MAX_REPLAY){this.result=null;return;}
  this.motor.reset(player);let yaw=player.yaw;
  for(const i of pending){
   if(this.vitals){
    const flags=this.vitals[6],scale=this.vitals[10]/1000,moving=i.x!==0||i.z!==0;
    const stopped=moving&&(flags&2)===0;
    const normalizer=Math.max(1,Math.hypot(i.x,i.z));
    this.motor.step({...i,x:stopped?0:i.x*scale/normalizer,z:stopped?0:i.z*scale/normalizer,
      sprint:i.sprint&&(flags&1)!==0,jump:i.jump&&!stopped});
   }else this.motor.step(i);
   yaw=i.yaw;
  }
  this.replays=pending.length;this.result={...this.motor.state(),yaw};
 }
 position(){return this.now()-this.updated<=350?this.result:null;}
}
export async function createWasmMotor(content,assets,wasmBytes=null){
 const geometry=assets.geometry,materials=assets.materials,v=new DataView(geometry.buffer,geometry.byteOffset,geometry.byteLength);
 const manifest={format:'xray-collision-v1',level:'zaton',coordinates:'metres-y-up',sha256:content.geometry,bytes:geometry.byteLength,vertices:v.getUint32(4,true),triangles:v.getUint32(8,true),bounds:{min:[0,1,2].map(i=>v.getFloat32(12+i*4,true)),max:[0,1,2].map(i=>v.getFloat32(24+i*4,true))},source:{archive:'verified-engine',path:'levels/zaton/level.cform'},materials:{sha256:content.materials,bytes:materials.byteLength}};
 const bytes=wasmBytes||await (await fetch(new URL('./zone_prediction.wasm',import.meta.url))).arrayBuffer();
 const {instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
 if(e.zone_version?.()!==4)throw Error('Stale prediction ABI');
 function put(b){const p=e.zone_alloc(b.length);if(!p)throw Error('Prediction allocation failed');new Uint8Array(e.memory.buffer,p,b.length).set(b);return p;}
 const json=new TextEncoder().encode(JSON.stringify(manifest)),pointers=[];
 try{for(const b of [json,geometry,materials])pointers.push([put(b),b.length]);if(e.zone_load(...pointers.flat())!==1)throw Error('Prediction collision validation failed');}
 finally{for(const [p,n]of pointers)e.zone_free(p,n);}
 const out=e.zone_alloc(28);
 return {
  reset(p){if(e.zone_reset(p.x,p.y,p.z,p.flags&2?0:p.vy,p.flags&14)!==1)throw Error('Prediction reset failed');},
  step(i){if(e.zone_step(i.x,i.z,i.sprint?1:0,i.jump?1:0,i.crouch?1:0)!==1)throw Error('Prediction step failed');},
  state(){if(e.zone_state(out)!==1)throw Error('Prediction read failed');const f=new Float32Array(e.memory.buffer,out,7);return {x:f[0],y:f[1],z:f[2],vy:f[3],grounded:!!f[4],crouched:!!f[5],jumpHeld:!!f[6]};},
 };
}
