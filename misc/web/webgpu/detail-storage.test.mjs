import test from 'node:test';
import assert from 'node:assert/strict';
import {DetailStorage,DETAIL_PAGE_SHIFT} from './detail-storage.js';
function fixture() {
  globalThis.GPUBufferUsage??={STORAGE:128,COPY_DST:8,COPY_SRC:4,VERTEX:32,UNIFORM:64};
  globalThis.GPUShaderStage??={COMPUTE:4};
  let id=0;const writes=[],groups=[],dispatches=[];
  const r={objects:new WeakMap(),encoder:null,retired:[],flushes:0,
    info(t){if(!this.objects.has(t))this.objects.set(t,{});return this.objects.get(t)},
    flush(){this.flushes++;this.encoder=null},endPass(){},
    enc(){return this.encoder??=this.device.createCommandEncoder()},
    device:{limits:{maxStorageBufferBindingSize:128*1024*1024},
      createBuffer({size}){const data=new ArrayBuffer(size);return {id:++id,size,getMappedRange(){return data},unmap(){},destroy(){this.destroyed=true}}},
      createCommandEncoder(){return {copyBufferToBuffer(){},finish(){return {}},beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(...args){dispatches.push(args)},end(){}}}}},
      createBindGroupLayout(){return {}},createPipelineLayout(){return {}},createShaderModule(){return {}},createComputePipeline(){return {}},createBindGroup(descriptor){groups.push(descriptor);return {}},
      queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,bytes:[...data]})},submit(){}}}};
  const arena=new DetailStorage(r,{maxPageRecords:8,softBytes:1024});
  const heap=new Uint8Array(8192).fill(7),words=new Uint32Array(heap.buffer);
  const upload=(token,slots)=>{
    const d=[];for(const [id,rev,n]of slots){words[id*2+1]=1;d.push(id,rev,0,n,1024+id*512,id*8,id*8+4)}
    arena.upload(token,new Uint32Array(d),heap,words,new Uint32Array(slots.map(s=>s[0])));
  };
  const gather=(token,slots,changed=true)=>{
    const indices=[];for(const [id,rev,n]of slots)for(let i=0;i<n;i++)indices.push(words[id*2]+i);
    arena.gather(token,new Uint32Array(indices),changed);
    return [...new Uint32Array(indices)];
  };
  return {r,arena,writes,heap,words,upload,gather,groups,dispatches};
}
test('ordered indices span pages while only changed native records cross JS',()=>{
  const {arena,upload,gather}=fixture(),token={},slots=[[1,1,5],[2,1,5]];
  upload(token,slots);
  assert.deepEqual(gather(token,slots),[0,1,2,3,4,...[0,1,2,3,4].map(n=>2**DETAIL_PAGE_SHIFT+n)]);
  const bytes=arena.metrics.recordBytes;
  assert.deepEqual(gather(token,[slots[1],slots[0]]),[...[0,1,2,3,4].map(n=>2**DETAIL_PAGE_SHIFT+n),0,1,2,3,4]);
  assert.equal(arena.metrics.recordBytes,bytes,'visibility order changes upload no source records');
  upload(token,[[2,2,5]]);assert.equal(arena.metrics.recordBytes,bytes+320);
});
test('LRU reuse submits pending compute and invalidates native allocation handles',()=>{
  const {r,arena,words,upload,gather}=fixture(),a={},b={};
  upload(a,[[1,0,5],[2,0,5]]);gather(a,[[1,0,5],[2,0,5]]);
  upload(b,[[3,0,5],[4,0,5]]);gather(b,[[3,0,5],[4,0,5]]);
  assert.equal(r.flushes,1);assert.equal(words[2],0xffffffff);assert.equal(words[4],0xffffffff);
  assert.equal(arena.entries.size,2);assert.equal(arena.pages.length,2);assert.equal(arena.bytes,1024);
  assert.equal(arena.metrics.evictions,2);
  assert.equal(arena.release(r.info(a)),false);assert.equal(arena.release(r.info(b)),true);
  assert.ok(arena.pages.every(p=>p.gpu.destroyed));
});
test('count growth allocates safely and source generation changes upload new content',()=>{
  const {arena,upload,gather,words}=fixture(),token={};
  upload(token,[[1,0,2]]);gather(token,[[1,0,2]]);
  upload(token,[[1,1,5]]);assert.equal(arena.entries.get(1).capacity,8);
  const bytes=arena.metrics.recordBytes;upload(token,[[1,2,3]]);
  assert.equal(arena.metrics.recordBytes,bytes+192);assert.notEqual(words[2],0xffffffff);
});

test('large ordered gathers split bindings at device limits without truncation',()=>{
  const {r,arena,groups,dispatches}=fixture(),token={};
  r.device.limits.maxStorageBufferBindingSize=65536;
  arena.gather(token,new Uint32Array(2051),true);
  assert.equal(groups.length,3);
  assert.deepEqual(groups.map(g=>g.entries[6].resource.offset),[0,4096,8192]);
  assert.deepEqual(groups.map(g=>g.entries[6].resource.size),[4096,4096,12]);
  assert.deepEqual(groups.map(g=>g.entries[7].resource.offset),[0,65536,131072]);
  assert.deepEqual(groups.map(g=>g.entries[7].resource.size),[65536,65536,192]);
  assert.deepEqual(dispatches,[[16,1],[16,1],[1,1]]);
  const indexBytes=arena.metrics.indexBytes;
  arena.gather(token,new Uint32Array(2051),false);
  assert.equal(arena.metrics.indexBytes,indexBytes,'source-only updates reuse ordered indices');
});

test('compact slot ranges preserve spans, skip unchanged uploads and retire storage',()=>{
 const {r,arena,upload,words,dispatches}=fixture(),token={};
 upload(token,[[1,0,5],[2,0,5]]);
 const ranges=new Uint32Array([words[2],5,0,0,words[4],5,5,0]);
 arena.gatherRanges(token,ranges,10,true);
 assert.equal(arena.metrics.indexBytes,32);assert.deepEqual(dispatches,[[2,1]]);
 arena.gatherRanges(token,ranges,10,false);assert.equal(arena.metrics.indexBytes,32);
 assert.throws(()=>arena.gatherRanges(token,ranges,9,true),/count mismatch/);
 const bad=ranges.slice();bad[6]=4;assert.throws(()=>arena.gatherRanges(token,bad,10,true),/span/);
 const buffer=r.info(token).detailRangeBuffer;arena.release(r.info(token));assert.ok(buffer.destroyed);
});
test('range expansion splits large destination windows without truncating slots',()=>{
 const {r,arena,groups,dispatches}=fixture(),token={};
 r.device.limits.maxStorageBufferBindingSize=65536;
 arena.pages=[{gpu:r.device.createBuffer({size:4096*64}),capacity:4096}];
 arena.gatherRanges(token,new Uint32Array([0,2051,0,0]),2051,true);
 assert.deepEqual(groups.map(g=>g.entries[7].resource.offset),[0,65536,131072]);
 assert.deepEqual(groups.map(g=>g.entries[7].resource.size),[65536,65536,192]);
 assert.deepEqual(dispatches,[[1,1],[1,1],[1,1]]);
});

