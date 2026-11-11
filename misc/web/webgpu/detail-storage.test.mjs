import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUFrontend} from './backend.js';
import {DetailStorage,DETAIL_PAGE_SHIFT} from './detail-storage.js';
function fixture() {
  globalThis.GPUBufferUsage??={STORAGE:128,COPY_DST:8,COPY_SRC:4,VERTEX:32,UNIFORM:64};
  globalThis.GPUShaderStage??={COMPUTE:4};
  let id=0;const writes=[],groups=[],dispatches=[];
  const r={objects:new WeakMap(),encoder:null,retired:[],flushes:0,
    info(t){if(!this.objects.has(t))this.objects.set(t,{});return this.objects.get(t)},
    flush(){this.endPass();this.flushes++;this.encoder=null},endPass(){this.detailComputePass?.end();this.detailComputePass=null},
    enc(){return this.encoder??=this.device.createCommandEncoder()},
    device:{limits:{maxStorageBufferBindingSize:128*1024*1024},
      createBuffer({size}){const data=new ArrayBuffer(size);return {id:++id,size,getMappedRange(){return data},unmap(){},destroy(){this.destroyed=true}}},
      createCommandEncoder(){return {copyBufferToBuffer(){},finish(){return {}},beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(...args){dispatches.push(args)},end(){}}}}},
      createBindGroupLayout(){return {}},createPipelineLayout(){return {}},createShaderModule(){return {}},createComputePipeline(){return {}},createBindGroup(descriptor){groups.push(descriptor);return {}},
      queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,bytes:[...data]})},submit(){}}}};
  Object.assign(r,{uniformBuffer:r.device.createBuffer({size:4096}),uniformStaging:new Uint8Array(4096),uniformOffset:0,uniformUploaded:0,uniformEpoch:0,allocateUniformBlock:GPUFrontend.prototype.allocateUniformBlock});
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
 assert.deepEqual(groups.map(g=>g.entries[7].resource.size),[65536,65536,65536]);
 assert.deepEqual(dispatches,[[1,1],[1,1],[1,1]]);
});


test('range gathers reuse groups across count changes but invalidate replaced pages and storage',()=>{
 const {r,arena,upload,words,groups}=fixture(),token={};upload(token,[[1,0,5]]);
 const ranges=new Uint32Array([words[2],5,0,0]);arena.gatherRanges(token,ranges,5,true);
 const first=r.info(token).detailWindows[0],group=first.group,offset=first.offset;
 arena.gatherRanges(token,ranges,5,false);assert.equal(groups.length,1);assert.equal(first.offset,offset);
 ranges[1]=6;arena.gatherRanges(token,ranges,6,true);
 assert.equal(groups.length,1);assert.equal(first.group,group);assert.notEqual(first.offset,offset);
 assert.equal(new Uint32Array(r.uniformStaging.buffer,offset,4)[1],5,'earlier dispatch retains its count');
 const page=arena.pages[0];arena.grow(page,16);arena.gatherRanges(token,ranges,6,false);assert.equal(groups.length,2);
 ranges[1]=9;arena.gatherRanges(token,ranges,9,true);assert.equal(groups.length,3,'output growth replaces group');
 r.uniformOffset=r.uniformBuffer.size;const epoch=r.uniformEpoch;
 arena.gatherRanges(token,ranges,9,false);assert.equal(r.uniformEpoch,epoch+1);assert.equal(groups.length,3);
 assert.equal(r.info(token).detailWindows[0].offset,0,'overflow starts a new submitted arena epoch');
 arena.release(r.info(token));assert.equal(r.info(token).detailWindows,null);
});

test('cached range bindings ignore stale capacity beyond active range count',()=>{
 const {r,arena,upload,words,groups}=fixture(),token={};upload(token,[[1,0,5]]);
 arena.gatherRanges(token,new Uint32Array([words[2],2,0,0,words[2]+2,3,2,0]),5,true);
 const window=r.info(token).detailWindows[0],group=window.group,oldOffset=window.offset;
 arena.gatherRanges(token,new Uint32Array([words[2],5,0,0]),5,true);
 assert.equal(groups.length,1);assert.equal(window.group,group);
 assert.equal(new Uint32Array(r.uniformStaging.buffer,oldOffset,4)[2],2);
 assert.equal(new Uint32Array(r.uniformStaging.buffer,window.offset,4)[2],1);
 assert.equal(r.info(token).detailRangeBuffer.size,32,'capacity still includes an unused range');
});

test('partial detail ranges retain complete output and reject invalid updates',()=>{
 const {r,arena,upload,words,dispatches}=fixture(),token={};
 upload(token,[[1,0,5],[2,0,5]]);
 const all=new Uint32Array([words[2],5,0,0,words[4],5,5,0]);
 assert.throws(()=>arena.gatherRanges(token,all,10,true,true),/existing output/);
 arena.gatherRanges(token,all,10,true);const output=r.info(token).gpu;
 const patch=new Uint32Array([words[4],2,7,0]);
 arena.gatherRanges(token,patch,10,true,true);
 assert.equal(r.info(token).gpu,output);assert.equal(r.info(token).detailRangeCount,10);
 assert.deepEqual(dispatches.at(-1),[1,1]);
 assert.throws(()=>arena.gatherRanges(token,patch,11,true,true),/existing output/);
 assert.throws(()=>arena.gatherRanges(token,new Uint32Array([words[4],2,9,0]),10,true,true),/span/);
 assert.throws(()=>arena.gatherRanges(token,new Uint32Array([words[4],2,7,0,words[2],2,8,0]),10,true,true),/span/);
 arena.gatherRanges(token,all,10,true);assert.deepEqual(dispatches.at(-1),[2,1]);
});

test('record upload staging reuses allocation without changing queued snapshots',()=>{
 const {arena,heap,writes,upload}=fixture(),token={};
 heap.fill(17,1536,1536+128);upload(token,[[1,0,2]]);
 const scratch=arena.recordScratch;const first=writes.at(-1);
 heap.fill(29,1536,1536+128);upload(token,[[1,1,2]]);
 assert.equal(arena.recordScratch,scratch);
 assert.deepEqual(first.bytes,Array(128).fill(17));
 assert.deepEqual(writes.at(-1).bytes,Array(128).fill(29));
 heap.fill(41,1536,1536+320);upload(token,[[1,2,5]]);
 assert.ok(arena.recordScratch.length>=320);assert.notEqual(arena.recordScratch,scratch);
 assert.deepEqual(writes.at(-1).bytes,Array(320).fill(41));
});

test('independent range gathers share a compute pass until a reader boundary',()=>{
 const {r,arena,words,upload}=fixture(),a={},b={};
 upload(a,[[1,0,2]]);upload(b,[[2,0,2]]);
 arena.gatherRanges(a,new Uint32Array([words[2],2,0,0]),2,true);
 const pass=r.detailComputePass;
 arena.gatherRanges(b,new Uint32Array([words[4],2,0,0]),2,true);
 assert.equal(r.detailComputePass,pass);assert.equal(arena.metrics.computePasses,1);
 r.endPass();assert.equal(r.detailComputePass,null);
 arena.gatherRanges(a,new Uint32Array([words[2],2,0,0]),2,true);
 assert.notEqual(r.detailComputePass,pass);assert.equal(arena.metrics.computePasses,2);
 r.flush();assert.equal(r.detailComputePass,null);
});
