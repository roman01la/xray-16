import test from 'node:test';import assert from 'node:assert/strict';
import {ZoneClient} from './client.mjs';
test('inactive window sends neutral input while retaining a sequenced heartbeat',()=>{
  const client=new ZoneClient(),sent=[];
  client.state={readyState:'open',bufferedAmount:0,send:b=>sent.push(new DataView(b))};
  client.setInput({x:1,z:-1,sprint:true});client.sendInput();
  client.inputActive=false;client.sendInput();
  assert.equal(sent[0].getInt16(8,true),32767);assert.equal(sent[1].getInt16(8,true),0);
  assert.equal(sent[1].getInt16(10,true),0);assert.equal(sent[1].getUint16(16,true),0);
  assert.equal(sent[1].getUint32(4,true),sent[0].getUint32(4,true)+1);
});
test('prediction history preserves quantized stance commands and stays bounded',()=>{
  const client=new ZoneClient(),sent=[];client.state={readyState:'open',bufferedAmount:0,send:b=>sent.push(new DataView(b))};
  client.setInput({x:.3333,z:0,yaw:1,sprint:true,jump:true,crouch:true});for(let i=0;i<40;i++)client.sendInput();
  assert.equal(client.inputHistory.length,32);assert.equal(sent[39].getUint16(16,true),7);
  const last=client.inputHistory.at(-1);assert.equal(last.x,sent[39].getInt16(8,true)/32767);assert.equal(last.jump,true);assert.equal(last.crouch,true);
  client.inputActive=false;client.sendInput();assert.equal(sent[40].getUint16(16,true),0);assert.equal(client.inputHistory.at(-1).jump,false);
});
test('held aim shares the sequenced input datagram and disappears on release or blur',async()=>{
 const client=new ZoneClient(),sent=[],control=[];
 client.snapshot={tick:321};
 client.state={readyState:'open',bufferedAmount:0,send:b=>sent.push(new DataView(b))};
 client.control={readyState:'open',bufferedAmount:0,send:b=>control.push(new DataView(b))};
 const takeReply=sequence=>{const p=client.pending.get(sequence);clearTimeout(p.timer);client.pending.delete(sequence);p.resolve({status:'miss',ammo:6});};
 const start=client.startTrigger({tick:321,yaw:1,pitch:.25},'a'.repeat(32));
 takeReply(1);await start;
 client.sendInput();
 assert.equal(control[0].getUint8(3),11);
 assert.equal(sent[0].byteLength,32);
 assert.equal(sent[0].getUint32(20,true),control[0].getUint32(4,true));
 assert.equal(sent[0].getUint32(24,true),321);
 client.snapshot.tick=322;client.setInput({yaw:-.5,pitch:-.25});client.sendInput();
 assert.equal(sent[1].getFloat32(12,true),-.5);
 assert.equal(sent[1].getUint32(24,true),322);
 assert.equal(sent[1].getFloat32(28,true),-.25);
 client.inputActive=false;client.sendInput();assert.equal(sent[2].byteLength,20);
 const stop=client.stopTrigger();takeReply(2);await stop;
 assert.equal(control[1].getUint8(3),12);
 client.inputActive=true;client.sendInput();assert.equal(sent[3].byteLength,20);
});
test('transport silence closes once and clears stale authority state even without ICE close',()=>{
 const client=new ZoneClient();client.connectedAt=100;
 client.snapshot={receivedAt:200};client.assembler={pending:new Map([[1,{}]]),frames:new Map([[1,{}]])};
 let disconnects=0;client.addEventListener('disconnected',()=>disconnects++);
 assert.equal(client.checkLiveness(5200),true);assert.equal(client.checkLiveness(5201),false);
 assert.equal(client.closed,true);assert.equal(client.snapshot,null);assert.equal(client.assembler.frames.size,0);
 assert.equal(client.checkLiveness(6000),false);assert.equal(disconnects,1);
});
