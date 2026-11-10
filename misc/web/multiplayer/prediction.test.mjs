import test from 'node:test';import assert from 'node:assert/strict';import {Reconciler,MAX_REPLAY} from './prediction.mjs';
const input=(sequence,x=1)=>({sequence,x,z:0,yaw:0,sprint:false});
const snap=(ack,x=0)=>({tick:ack,playerId:1,ack,entities:[{id:1,x,y:0,z:0,vy:0,yaw:0,health:100,flags:2}]});
function mock(){let p;return {reset:e=>{p={...e};},step:i=>{p.x+=i.x;},state:()=>p};}
test('reconciles to authority and replays only unacknowledged quantized inputs',()=>{
 let now=0;const r=new Reconciler(mock(),()=>now);r.inputsReceived([input(10),input(11)]);r.snapshotReceived(snap(9,20));assert.equal(r.position().x,22);
 r.snapshotReceived(snap(10,20.5));assert.equal(r.position().x,21.5);assert.equal(r.replays,1);
 r.snapshotReceived(snap(11,21));assert.equal(r.position().x,21);assert.equal(r.replays,0);
 now=351;assert.equal(r.position(),null);assert.equal(r.replays,0);
});
test('loss/backlog, sequence wrap and invalid input cannot create unbounded replay',()=>{
 const r=new Reconciler(mock(),()=>0);r.snapshotReceived(snap(0));r.inputsReceived(Array.from({length:MAX_REPLAY+1},(_,i)=>input(i+1)));assert.equal(r.position(),null);
 r.snapshotReceived(snap(0xfffffffe,10));r.inputsReceived([input(0xffffffff),input(0)]);assert.equal(r.position().x,12);
 assert.throws(()=>r.inputsReceived([input(2),input(1)]),/history/);assert.throws(()=>r.inputsReceived([input(1,NaN)]),/history/);
 const dead=snap(0);dead.entities[0].health=0;r.snapshotReceived(dead);assert.equal(r.position(),null);assert.equal(r.replays,0);
});
test('replay applies authoritative walking restrictions and limp speed to raw intent',()=>{
 const r=new Reconciler(mock(),()=>0),vitals=[0,900,1000,800,0,0,4,61000,50000,60000,1000];
 r.inputsReceived([input(2)]);
 r.snapshotReceived(snap(1,10),vitals);assert.equal(r.position().x,10);
 r.snapshotReceived(snap(1,10),[...vitals.slice(0,6),2,49000,50000,60000,500]);assert.equal(r.position().x,10.5);
});
test('render pose advances between fixed steps and absorbs small corrections without a jump',()=>{
 let now=0;
 const r=new Reconciler(mock(),()=>now);
 const history=[{...input(11,.1),sentAt:0}];
 r.update(snap(10,20),history);
 const first=r.renderPosition().x;
 now=1000/60;
 const half=r.renderPosition().x;
 assert.ok(Math.abs(half-first-.05)<1e-9);
 assert.equal(r.position().x,20.1);
 r.snapshotReceived(snap(10,19.95));
 assert.ok(Math.abs(r.renderPosition().x-half)<1e-9);
 now=300;
 assert.ok(Math.abs(r.renderPosition().x-20.15)<.001);
 r.snapshotReceived(snap(11,30));
 assert.equal(r.renderPosition().x,30);
 now=651;
 assert.equal(r.renderPosition(),null);
});

test('rendered walking stays continuous as delayed acknowledgements shift between frames',()=>{
 let now=0,history=[],raw=[],visual=[];
 const r=new Reconciler(mock(),()=>now),walkStep=.07,tickMs=1000/30;
 for(let frame=0;frame<480;frame++){
  now=frame*tickMs/4;
  if(frame%4===0){
   history=[...history,{...input(frame/4+1,walkStep),sentAt:now}].slice(-32);
   r.inputsReceived(history);
  }
  // Deliver 15 Hz snapshots 133-150 ms after the simulated client command.
  if((frame>=16 && (frame-16)%16===0) || (frame>=26 && (frame-26)%16===0)){
   const ack=Math.floor((frame-16)/4)+1;
   r.snapshotReceived(snap(ack,ack*walkStep+(frame%16===0?.025:-.025)));
  }
  if(frame>=32){
   raw.push(r.position().x);
   visual.push(r.renderPosition().x);
  }
 }
 const error=values=>values.slice(1).reduce((sum,value,i)=>sum+Math.abs(value-values[i]-walkStep/4),0);
 assert.ok(error(visual)<error(raw)*.35);
});
