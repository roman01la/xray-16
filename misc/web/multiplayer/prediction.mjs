import {newer} from './protocol.mjs';
export const MAX_REPLAY=16,MAX_HISTORY=32;
const CORRECTION_TIME_MS = 65;
const MAX_SMOOTH_CORRECTION = 0.75;
const axes = ['x','y','z'];
const zeroOffset = [0,0,0];

export class Reconciler {
 constructor(motor,now=()=>performance.timeOrigin+performance.now(),tickHz=30){
  this.motor=motor;this.now=now;this.tickMs=1000/tickHz;
  this.snapshot=null;this.history=[];this.result=null;this.updated=0;this.replays=0;
  this.motion=null;this.presentation=null;
 }
 snapshotReceived(snapshot,vitals=null){this.update(snapshot,null,vitals);}
 inputsReceived(history){this.update(null,history);}
 update(snapshot,history,vitals=null){
  if(history!==null){
   if(!Array.isArray(history)||history.length>MAX_HISTORY||history.some((i,n)=>!Number.isInteger(i.sequence)||i.sequence<0||i.sequence>0xffffffff||!['x','z','yaw'].every(k=>Number.isFinite(i[k]))||Math.abs(i.x)>1.001||Math.abs(i.z)>1.001||typeof i.sprint!=='boolean'||(i.sentAt!==undefined&&!Number.isFinite(i.sentAt))||['jump','crouch','walk'].some(k=>i[k]!==undefined&&typeof i[k]!=='boolean')||(n>0&&!newer(i.sequence,history[n-1].sequence))))throw Error('Invalid prediction history');
   this.history=history;
  }
  if(snapshot){this.snapshot=snapshot;this.vitals=vitals;this.updated=this.now();}
  this.reconcile();
 }
 step(input){
  if(!this.vitals){this.motor.step(input);return;}
  const flags=this.vitals[6],scale=this.vitals[10]/1000;
  const stopped=(input.x!==0||input.z!==0)&&(flags&2)===0;
  const normalizer=Math.max(1,Math.hypot(input.x,input.z));
  this.motor.step({...input,x:stopped?0:input.x*scale/normalizer,z:stopped?0:input.z*scale/normalizer,
    sprint:input.sprint&&(flags&1)!==0,jump:input.jump&&!stopped});
 }
 reconcile(){
  this.replays=0;const s=this.snapshot;if(!s)return;
  const player=s.entities.find(e=>e.id===s.playerId);
  const pending=this.history.filter(i=>newer(i.sequence,s.ack));
  // A paused/lagged client falls back to authority instead of simulating a
  // burst of old commands or running far ahead of the server.
  if(!player||player.health===0||pending.length>MAX_REPLAY){
   this.result=null;this.motion=null;this.presentation=null;return;
  }
  this.motor.reset(player);let yaw=player.yaw;
  for(const i of pending){this.step(i);yaw=i.yaw;}
  this.replays=pending.length;this.result={...this.motor.state(),yaw};
  const latest=this.history.at(-1);
  this.motion={start:this.result,end:this.result,time:this.now()};
  // Project at most one fixed tick through the same collision motor. The
  // fractional position is only used by rendering.
  if(Number.isFinite(latest?.sentAt)&&this.motion.time-latest.sentAt<=2*this.tickMs){
   this.step(latest);
   this.motion={start:this.result,end:{...this.motor.state()},time:latest.sentAt};
  }
 }
 position(now=this.now()){return now-this.updated<=350?this.result:null;}
 sample(motion,now){
  const t=Math.max(0,Math.min(1,(now-motion.time)/this.tickMs));
  return axes.map(k=>motion.start[k]+(motion.end[k]-motion.start[k])*t);
 }
 renderPosition(){
  const now=this.now(),pose=this.position(now);
  if(!pose){this.presentation=null;return null;}
  const target=this.sample(this.motion,now);
  const previous=this.presentation;
  if(previous?.motion!==this.motion){
   let offset=zeroOffset;
   if(previous){
    const from=this.sample(previous.motion,now);
    const correction=from.map((value,i)=>value-target[i]);
    const decay=Math.exp(-(now-previous.time)/CORRECTION_TIME_MS);
    const residual=correction.map((value,i)=>value+previous.offset[i]*decay);
    if(Math.hypot(...correction)<=MAX_SMOOTH_CORRECTION&&Math.hypot(...residual)<=MAX_SMOOTH_CORRECTION)
     offset=residual;
   }
   this.presentation={motion:this.motion,offset,time:now};
  }
  const {offset,time}=this.presentation,decay=Math.exp(-(now-time)/CORRECTION_TIME_MS);
  return {x:target[0]+offset[0]*decay,y:target[1]+offset[1]*decay,z:target[2]+offset[2]*decay,yaw:pose.yaw};
 }
}
export async function createWasmMotor(level,content,assets,wasmBytes=null){
 const geometry=assets.geometry,materials=assets.materials,v=new DataView(geometry.buffer,geometry.byteOffset,geometry.byteLength);
 const manifest={format:'xray-collision-v1',level,coordinates:'metres-y-up',sha256:content.geometry,bytes:geometry.byteLength,vertices:v.getUint32(4,true),triangles:v.getUint32(8,true),bounds:{min:[0,1,2].map(i=>v.getFloat32(12+i*4,true)),max:[0,1,2].map(i=>v.getFloat32(24+i*4,true))},source:{archive:'verified-engine',path:`levels/${level}/level.cform`},materials:{sha256:content.materials,bytes:materials.byteLength}};
 if(content.ladders!==undefined)manifest.ladders=content.ladders;
 const bytes=wasmBytes||await (await fetch(new URL('./zone_prediction.wasm',import.meta.url))).arrayBuffer();
 const {instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
 if(e.zone_version?.()!==6)throw Error('Stale prediction ABI');
 function put(b){const p=e.zone_alloc(b.length);if(!p)throw Error('Prediction allocation failed');new Uint8Array(e.memory.buffer,p,b.length).set(b);return p;}
 const json=new TextEncoder().encode(JSON.stringify(manifest)),pointers=[];
 try{for(const b of [json,geometry,materials])pointers.push([put(b),b.length]);if(e.zone_load(...pointers.flat())!==1)throw Error('Prediction collision validation failed');}
 finally{for(const [p,n]of pointers)e.zone_free(p,n);}
 const out=e.zone_alloc(32);
 return {
  reset(p){if(e.zone_reset(p.x,p.y,p.z,p.flags&2?0:p.vy,p.flags&30)!==1)throw Error('Prediction reset failed');},
  step(i){if(e.zone_step(i.x,i.z,i.sprint?1:0,i.jump?1:0,i.crouch?1:0,i.walk?1:0)!==1)throw Error('Prediction step failed');},
  state(){if(e.zone_state(out)!==1)throw Error('Prediction read failed');const f=new Float32Array(e.memory.buffer,out,8);return {x:f[0],y:f[1],z:f[2],vy:f[3],grounded:!!f[4],crouched:!!f[5],jumpHeld:!!f[6],climbing:!!f[7]};},
 };
}
