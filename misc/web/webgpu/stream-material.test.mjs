import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUFrontend} from './backend.js';
import {EngineFormat} from './engine-formats.js';
globalThis.GPUBufferUsage={STORAGE:1,VERTEX:2,INDEX:4,UNIFORM:8,COPY_DST:16,COPY_SRC:32};
function fixture(){
 const r=Object.create(GPUFrontend.prototype),writes=[];
 Object.assign(r,{retired:[],streamRetired:[],resourceGeneration:0,bindingGeneration:0,
 unitBindingGenerations:new Uint32Array(32),textures:Array.from({length:32},()=>new Map()),samplers:Array(32).fill(null),objects:new WeakMap(),
 device:{createBuffer({size}){return {size,bytes:new Uint8Array(size)}},queue:{writeBuffer(gpu,offset,bytes){gpu.bytes.set(bytes,offset);writes.push({gpu,offset,bytes:bytes.slice()});}}}});
 return {r,writes};
}
test('dynamic appends upload only new bytes and retain buffer identity',()=>{
 const {r,writes}=fixture(),i={};r.bufferData([0,4096],i);const gpu=i.gpu;
 for(let n=0;n<32;n++)r.bufferSubData([0,n*64,new Uint8Array(64).fill(n+1)],i);
 assert.equal(i.gpu,gpu);assert.equal(writes.reduce((n,w)=>n+w.bytes.length,0),2048);
 assert.equal(gpu.bytes[2047],32);
});
test('wrap and overlapping writes preserve previous draw data and full capacity',()=>{
 const {r}=fixture(),i={};r.bufferData([0,4096],i);r.bufferSubData([0,0,new Uint8Array(64).fill(1)],i);const old=i.gpu;
 r.bufferData([0,4096],i);r.bufferSubData([0,0,new Uint8Array(64).fill(2)],i);
 assert.notEqual(i.gpu,old);assert.equal(old.bytes[0],1);assert.equal(i.gpu.bytes[0],2);assert.equal(i.gpu.size,4096);
 const next=i.gpu;r.bufferSubData([0,64,new Uint8Array(64).fill(3)],i);assert.equal(i.gpu,next);
 r.bufferSubData([0,2,new Uint8Array([4,5])],i);assert.notEqual(i.gpu,next);assert.equal(next.bytes[2],2);
 assert.equal(i.gpu.bytes[64],3);assert.equal(i.gpu.bytes[2],4);
});
test('unaligned append cannot overwrite the alignment word used by prior draws',()=>{
 const {r}=fixture(),i={};r.bufferData([0,64],i);r.bufferSubData([0,0,new Uint8Array([1,2])],i);const old=i.gpu;
 r.bufferSubData([0,2,new Uint8Array([3,4])],i);assert.notEqual(i.gpu,old);assert.deepEqual([...old.bytes.slice(0,4)],[1,2,0,0]);assert.deepEqual([...i.gpu.bytes.slice(0,4)],[1,2,3,4]);
});
test('materials survive unrelated bindings but invalidate on dependencies and mutations',()=>{
 const {r}=fixture();const p={lastResourceGeneration:0,lastBindingGeneration:0,lastMaterial:{group:{}},materialDependencies:[{unit:0,version:0}]};
 const bind=(unit,id)=>r.consumeBindingBatch(new Uint32Array([0,unit,EngineFormat.TEXTURE_2D,id]),0,4,[null,{}],[]);
 bind(4,1);assert.equal(r.cachedMaterial(p),p.lastMaterial);
 bind(0,1);assert.equal(r.cachedMaterial(p),null);
 p.materialDependencies[0].version=r.unitBindingGenerations[0];assert.equal(r.cachedMaterial(p),p.lastMaterial);
 r.resourceGeneration++;assert.equal(r.cachedMaterial(p),null);
});

test('submitted detail buffers reuse storage and upload only changed rows',()=>{
 const {r,writes}=fixture(),i={};
 const source=new Uint8Array(4096).fill(1);r.bufferData([0,source],i);
 const gpu=i.gpu;i.detailEncoder={};r.encoder={};writes.length=0;
 r.bufferData([0,source],i);assert.equal(writes.length,0);assert.equal(i.gpu,gpu);
 const next=source.slice();next[3072]=9;
 r.bufferData([0,next],i);
 assert.equal(i.gpu,gpu);assert.equal(writes.length,1);assert.equal(writes[0].offset,3072);
 assert.equal(writes[0].bytes.length,256);assert.deepEqual(gpu.bytes,next);
});
test('detail data already referenced by the current encoder keeps snapshot semantics',()=>{
 const {r}=fixture(),i={};r.bufferData([0,new Uint8Array(512).fill(1)],i);
 const previous=i.gpu;r.encoder={};i.detailEncoder=r.encoder;
 r.bufferData([0,new Uint8Array(512).fill(2)],i);
 assert.notEqual(i.gpu,previous);assert.equal(previous.bytes[0],1);assert.equal(i.gpu.bytes[0],2);
});
test('unsubmitted compute reads also prevent in-place detail updates',()=>{
 const {r}=fixture(),i={};r.bufferData([0,new Uint8Array(512).fill(1)],i);
 const previous=i.gpu;r.encoder={};i.detailEncoder={};i.detailComputeEncoder=r.encoder;
 r.bufferData([0,new Uint8Array(512).fill(2)],i);
 assert.notEqual(i.gpu,previous);assert.equal(previous.bytes[0],1);
});
test('GPU-written detail buffers cannot reuse a stale CPU shadow after submission',()=>{
 const {r}=fixture(),i={};r.bufferData([0,new Uint8Array(512).fill(1)],i);
 const previous=i.gpu;r.encoder={};i.detailEncoder={};i.detailComputeEncoder={};
 previous.bytes.fill(9);
 r.bufferData([0,new Uint8Array(512).fill(1)],i);
 assert.notEqual(i.gpu,previous);assert.equal(previous.bytes[0],9);assert.equal(i.gpu.bytes[0],1);
});
test('pending shadow compaction reads retain the original detail buffer',()=>{
 const {r}=fixture(),i={};r.bufferData([0,new Uint8Array(512).fill(1)],i);
 const previous=i.gpu;r.encoder={};i.detailEncoder={};i.detailShadowReadEncoder=r.encoder;
 r.bufferData([0,new Uint8Array(512).fill(2)],i);
 assert.notEqual(i.gpu,previous);assert.equal(previous.bytes[0],1);
 i.detailShadowReadEncoder={};
 const submitted=i.gpu;r.bufferData([0,new Uint8Array(512).fill(3)],i);
 assert.equal(i.gpu,submitted);assert.equal(i.gpu.bytes[0],3);
});
test('many separated dirty detail ranges fall back to one complete upload',()=>{
 const {r,writes}=fixture(),i={};const bytes=new Uint8Array(256*3*140);
 r.bufferData([0,bytes],i);i.detailEncoder={};r.encoder={};writes.length=0;
 for(let block=0;block<140;block++)bytes[block*768]=1;
 r.bufferData([0,bytes],i);
 assert.equal(writes.length,1);assert.equal(writes[0].bytes.length,bytes.length);
 assert.deepEqual(i.gpu.bytes.slice(0,bytes.length),bytes);
});

test('detail count changes reuse spare GPU capacity without losing new rows',()=>{
 const {r,writes}=fixture(),i={};
 r.bufferData([0,new Uint8Array(1024).fill(1)],i);
 r.bufferData([0,new Uint8Array(1028).fill(1)],i);
 const gpu=i.gpu;assert.equal(gpu.size,2048);
 i.detailEncoder={};r.encoder={};writes.length=0;
 const larger=new Uint8Array(1536).fill(1);larger[1500]=3;
 r.bufferData([0,larger],i);
 assert.equal(i.gpu,gpu);assert.equal(i.size,1536);assert.deepEqual(gpu.bytes.slice(0,1536),larger);
 r.bufferData([0,larger.subarray(0,768)],i);assert.equal(i.size,768);
 const next=larger.slice();next[1400]=4;r.bufferData([0,next],i);
 assert.equal(i.gpu,gpu);assert.deepEqual(gpu.bytes.slice(0,1536),next);
});
