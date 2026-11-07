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
