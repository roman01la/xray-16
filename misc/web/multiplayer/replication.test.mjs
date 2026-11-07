import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {resolve} from 'node:path';
import {SnapshotAssembler,decodeSnapshot,encodeSnapshotFeedback} from './protocol.mjs';
const manifest=resolve(import.meta.dirname,'../../../server/Cargo.toml');
const frames=JSON.parse(execFileSync('cargo',['+1.93.1','run','--quiet','--offline','--manifest-path',manifest,'--bin','replication_fixture'],{encoding:'utf8',maxBuffer:1024*1024})).map(frame=>frame.map(a=>Uint8Array.from(a).buffer));
function feed(assembler,packets){let last=null;for(const p of packets){const value=assembler.push(p);if(value)last=value;}return last;}
test('actual Rust delta records preserve local precision and remote signed quantization',()=>{
 const a=new SnapshotAssembler();const first=feed(a,frames[0].toReversed());assert.equal(first.entities.length,200);
 assert.equal(first.entities[0].x,Math.fround(1.234567));assert.equal(first.entities[0].vy,Math.fround(-3.456));assert.equal(first.entities[0].flags,14);
 assert.equal(first.entities[1].x,-12.35);assert.equal(first.entities[1].y,3.13);assert.equal(first.entities[1].z,830);assert.equal(first.entities[1].vy,-3.46);
 const update=feed(a,frames[1]);assert.equal(update.entities[1].x,-10);assert.equal(update.ack,8);
 assert.equal(first.entities[1].x,-12.35);assert.equal(a.frames.get(1).get(2).x,-12.35);
 const removed=feed(a,frames[2]);assert.equal(removed.entities.length,199);assert.equal(removed.entities.some(e=>e.id===2),false);assert.equal(a.frames.get(1).has(2),true);assert.equal(update.entities.length,200);
 assert.equal(feed(a,frames[3]).entities.length,199);assert.equal(frames[4][0].byteLength,28);assert.equal(feed(a,frames[4]).entities.length,199);
});
test('missing chunks and missing baselines never partially apply membership',()=>{
 const a=new SnapshotAssembler();assert.equal(feed(a,frames[0].slice(1)),null);assert.equal(feed(a,frames[1]),null);assert.equal(a.needsResync,true);
 const recovered=feed(a,frames[5]);assert.equal(a.needsResync,false);assert.equal(recovered.tick,6);assert.equal(recovered.entities.length,199);
 assert.equal(feed(a,frames[3]),null);
});
test('malformed variable records and conflicting baseline metadata fail closed',()=>{
 const b=frames[0][0].slice(0);new DataView(b).setUint8(28,9);assert.equal(decodeSnapshot(b),null);
 assert.equal(decodeSnapshot(frames[0][0].slice(0,-1)),null);
 const feedback=new DataView(encodeSnapshotFeedback(0xffffffff));assert.equal(feedback.getUint8(3),4);assert.equal(feedback.getUint32(4,true),0xffffffff);
 assert.equal(new DataView(encodeSnapshotFeedback(4,true)).getUint8(3),5);
});

test('precise delta records reject non-finite coordinates without altering baseline',()=>{
 const a=new SnapshotAssembler();const first=feed(a,frames[0]);
 const invalid=frames[0][0].slice(0),view=new DataView(invalid);assert.equal(view.getUint8(28),2);
 view.setUint32(4,10,true);view.setFloat32(33,NaN,true);
 assert.equal(decodeSnapshot(invalid),null);assert.equal(a.push(invalid),null);
 assert.equal(a.latest,first.tick);assert.equal(a.frames.get(first.tick).size,200);
});
