// Deterministic packet-delay/loss/reordering test using two actual WASM motors.
import {readFile} from 'node:fs/promises';import {dirname,join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {createWasmMotor,Reconciler,MAX_REPLAY} from '../../misc/web/multiplayer/prediction.mjs';import {newer} from '../../misc/web/multiplayer/protocol.mjs';
const [path,probePath]=process.argv.slice(2);if(!path||!probePath)throw Error('Usage: test-prediction-network.mjs MANIFEST PROBE');
const m=JSON.parse(await readFile(path)),probe=JSON.parse(await readFile(probePath)),content={geometry:m.sha256,materials:m.materials.sha256};
const assets={geometry:new Uint8Array(await readFile(join(dirname(path),m.sha256+'.cform'))),materials:new Uint8Array(await readFile(join(dirname(path),m.materials.sha256+'.gamemtl')))};
const wasm=await readFile(resolve(import.meta.dirname,'../prediction/target/wasm32-unknown-unknown/release/zone_prediction.wasm'));
const authority=await createWasmMotor(content,assets,wasm),local=await createWasmMotor(content,assets,wasm),reports=[];
for(const [delay,loss]of [[0,0],[3,.1],[5,.2]]){
 let now=0,seed=42,ack=0,history=[],inputQueue=[],snapshotQueue=[],held={x:0,z:0,sprint:false},lastTick=0,fallbacks=0,maxReplay=0,maxError=0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const [x,y,z]=probe.motor.spawn;authority.reset({x,y,z,vy:0,flags:0});const prediction=new Reconciler(local,()=>now);
 for(let tick=1;tick<=240;tick++){
  now=tick*1000/30;
  const input={sequence:tick,x:tick<=120?1:0,z:0,yaw:Math.PI/2,sprint:tick>=90&&tick<=110,jump:tick>=30&&tick<=34,crouch:tick>=70&&tick<=100};history.push(input);history=history.slice(-32);prediction.inputsReceived(history);
  if(tick>180||random()>=loss)inputQueue.push({due:tick+(tick>180?delay:delay+(random()<.2?2:0)),input});
  for(const p of inputQueue.filter(p=>p.due<=tick)){if(newer(p.input.sequence,ack)){held=p.input;ack=p.input.sequence;}}
  inputQueue=inputQueue.filter(p=>p.due>tick);authority.step(held);
  const p=authority.state();
  if(tick%2===0 && (tick>180||random()>=loss))snapshotQueue.push({due:tick+delay+(tick>180?0:(random()<.2?2:0)),snapshot:{tick,playerId:1,ack,entities:[{id:1,...p,yaw:Math.PI/2,flags:(p.grounded?2:0)|(p.crouched?4:0)|(p.jumpHeld?8:0),health:100}]}});
  for(const p of snapshotQueue.filter(p=>p.due<=tick)){if(newer(p.snapshot.tick,lastTick)){lastTick=p.snapshot.tick;history=history.filter(i=>newer(i.sequence,p.snapshot.ack));prediction.snapshotReceived(p.snapshot);prediction.inputsReceived(history);}}
  snapshotQueue=snapshotQueue.filter(p=>p.due>tick);
  maxReplay=Math.max(maxReplay,prediction.replays);assert.ok(maxReplay<=MAX_REPLAY);
  const predicted=prediction.position();if(!predicted)fallbacks++;else {const error=Math.hypot(predicted.x-p.x,predicted.y-p.y,predicted.z-p.z);assert.ok(Number.isFinite(error)&&error<5,'prediction runaway');maxError=Math.max(maxError,error);}
 }
 // Hard authoritative reconciliation must converge exactly even after a backlog.
 const p=authority.state();prediction.snapshotReceived({tick:241,playerId:1,ack:240,entities:[{id:1,...p,yaw:0,flags:(p.grounded?2:0)|(p.crouched?4:0)|(p.jumpHeld?8:0),health:100}]});prediction.inputsReceived([]);
 assert.deepEqual([prediction.position().x,prediction.position().y,prediction.position().z],[p.x,p.y,p.z]);
 reports.push({oneWayDelayMs:delay*1000/30,loss,reordering:true,maxReplay,fallbacks,maxErrorMetres:maxError,finalReconciliationError:0});
}
console.log(JSON.stringify(reports,null,2));
