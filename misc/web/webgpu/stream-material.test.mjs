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
