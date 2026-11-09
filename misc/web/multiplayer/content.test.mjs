import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha256,validateWorld,createContentVerifier,levelForWorld} from './content.mjs';
const base=JSON.parse(await readFile(new URL('./contract.json',import.meta.url)));
test('world identity binds both files and motor version',async()=>{
 const content={geometry:'a'.repeat(64),materials:'b'.repeat(64),movement:'capsule-motor-v4'};
 const contract={...base,world:'zaton-static-v1',contentRevision:await sha256(new TextEncoder().encode(`zaton-static-v1\n${content.geometry}\n${content.materials}\n${content.movement}`))};
 assert.equal((await validateWorld({contract,content})).contract.world,contract.world);
 await assert.rejects(validateWorld({contract,content:{...content,materials:'c'.repeat(64)}}),/identity/);
 await assert.rejects(validateWorld({contract,content:{...content,movement:'unknown'}}),/Unsupported/);
 assert.equal((await validateWorld({contract:base,content:null})).content,null);
 for(const level of ['jupiter','pripyat','jupiter_underground','labx8']){
  const world=level+'-static-v1';
  const other={...contract,world};
  assert.equal(levelForWorld(world),level);
  await assert.rejects(validateWorld({contract:other,content}),/identity/);
  other.contentRevision=await sha256(new TextEncoder().encode(`${world}\n${content.geometry}\n${content.materials}\n${content.movement}`));
  assert.equal((await validateWorld({contract:other,content})).contract.world,world);
 }
 await assert.rejects(validateWorld({contract:{...contract,world:'unknown-static-v1'},content}),/Unsupported/);
});
test('ladder worlds pin the exact geometry passed to the shared predictor',async()=>{
 const world='jupiter_underground-static-v1';
 const content={geometry:'a'.repeat(64),materials:'b'.repeat(64),movement:'capsule-motor-v5',ladders:'[{"spawnId":6146}]'};
 const contract={...base,world,contentRevision:await sha256(new TextEncoder().encode(`${world}\n${content.geometry}\n${content.materials}\n${content.movement}\n${content.ladders}`))};
 assert.equal((await validateWorld({contract,content})).content.ladders,content.ladders);
 await assert.rejects(validateWorld({contract,content:{...content,ladders:content.ladders+' '}}),/identity/);
});
test('engine verifies both actual byte ranges and fails closed on mismatch',async()=>{
 const heap=new Uint8Array([1,2,3,4]);const content={geometry:await sha256(heap.slice(0,2)),materials:await sha256(heap.slice(2))};
 const errors=[],v=createContentVerifier(content,()=>heap,e=>errors.push(e.message));
 assert.equal(v.status(),0);await v.verify(0,0n,2);assert.equal(v.status(),0);await v.verify(1,2n,2);assert.equal(v.status(),1);
 const wrong=createContentVerifier(content,()=>heap,e=>errors.push(e.message));await wrong.verify(0,1,2);assert.equal(wrong.status(),-1);assert.match(errors[0],/differs/);
 const range=createContentVerifier(content,()=>heap);await range.verify(0,5,2);assert.equal(range.status(),-1);
});
