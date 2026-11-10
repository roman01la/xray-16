// Stable grass records live in bounded GPU storage pages. Visibility uploads only
// ordered uint32 references, not a new copy of every transform and lighting row.
export const DETAIL_PAGE_SHIFT=21, DETAIL_PAGE_COUNT=6, DETAIL_RECORD_BYTES=64;
const power2=n=>2**Math.ceil(Math.log2(Math.max(1,n)));
export class DetailStorage {
  constructor(renderer,{maxPageRecords,softBytes=256*1024*1024}={}) {
    this.r=renderer;this.device=renderer.device;this.entries=new Map();this.pages=[];
    this.maxPageRecords=Math.min(2**DETAIL_PAGE_SHIFT,maxPageRecords||2**Math.floor(Math.log2(this.device.limits.maxStorageBufferBindingSize/64)));
    this.softBytes=softBytes;this.bytes=0;this.clock=0;this.sets=0;
    this.metrics={recordBytes:0,indexBytes:0,evictions:0,growths:0,gathers:0};
    this.empty=this.device.createBuffer({size:64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  }
  free(page,offset,size) {
    page.free.push([offset,size]);page.free.sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<page.free.length;) {
      const a=page.free[i-1],b=page.free[i];
      if(a[0]+a[1]===b[0]){a[1]+=b[1];page.free.splice(i,1);}else i++;
    }
  }
  take(size) {
    for(let p=0;p<this.pages.length;p++) {
      const page=this.pages[p],at=page.free.findIndex(r=>r[1]>=size);
      if(at<0)continue;
      const range=page.free[at],offset=range[0];range[0]+=size;range[1]-=size;
      if(!range[1])page.free.splice(at,1);
      return {page:p,offset,capacity:size};
    }
  }
  evict(protectedIds,size) {
    const candidates=[...this.entries.values()].filter(e=>!protectedIds.has(e.id)).sort((a,b)=>(this.words[a.seenAddress/4]-this.words[b.seenAddress/4])||a.used-b.used);
    for(const entry of candidates) {
      // Earlier draws may still reference this exact range. Submit before reuse.
      if(this.r.encoder&&entry.owner?.detailComputeEncoder===this.r.encoder)this.r.flush();
      this.words[entry.indexAddress/4]=0xffffffff;this.entries.delete(entry.id);this.free(this.pages[entry.page],entry.offset,entry.capacity);
      this.metrics.evictions++;
      const span=this.take(size);if(span)return span;
    }
  }
  grow(page,capacity) {
    // All six pages are bound together; a binding can retain the old page even
    // when this draw's indices happen to address a different page.
    if(this.r.encoder&&this.encoder===this.r.encoder)this.r.flush();
    const old=page.gpu,oldCapacity=page.capacity;
    const gpu=this.device.createBuffer({label:'X-Ray persistent detail records',size:capacity*64,
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
    if(old){const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(old,0,gpu,0,oldCapacity*64);this.device.queue.submit([encoder.finish()]);old.destroy();}
    page.gpu=gpu;page.capacity=capacity;this.bytes+=(capacity-oldCapacity)*64;
    this.free(page,oldCapacity,capacity-oldCapacity);this.group=null;this.metrics.growths++;
  }
  allocate(count,protectedIds) {
    const size=power2(count);if(size>this.maxPageRecords)throw Error('Detail slot exceeds storage page');
    let span=this.take(size);if(span)return span;
    if(this.bytes>=this.softBytes){span=this.evict(protectedIds,size);if(span)return span;}
    let page=this.pages.find(p=>p.capacity+size<=this.maxPageRecords);
    if(!page&&this.pages.length<DETAIL_PAGE_COUNT){page={capacity:0,free:[],gpu:null};this.pages.push(page);}
    if(page){this.grow(page,Math.min(this.maxPageRecords,power2(Math.max(1024,page.capacity+size))));return this.take(size);}
    span=this.evict(protectedIds,size);if(span)return span;
    throw Error('Visible detail records exceed device storage capacity');
  }
  upload(token,descriptors,heap,words,visible) {
    if(descriptors.length%7)throw Error("Invalid detail record descriptors");
    this.words=words;const owner=this.r.info(token);
    let protectedSet;const protectedIds={has:id=>(protectedSet??=new Set(visible)).has(id)};
    for(let i=0;i<descriptors.length;i+=7) {
      const id=descriptors[i],lo=descriptors[i+1],hi=descriptors[i+2],n=descriptors[i+3],
        pointer=descriptors[i+4],indexAddress=descriptors[i+5],seenAddress=descriptors[i+6];
      if(!id||!n||pointer+n*64>heap.length||indexAddress%4||indexAddress+4>heap.length||seenAddress%4||seenAddress+4>heap.length)
        throw Error("Invalid detail record range");
      let entry=this.entries.get(id);
      if(entry&&entry.capacity<n) {
        if(this.r.encoder&&entry.owner?.detailComputeEncoder===this.r.encoder)this.r.flush();
        this.free(this.pages[entry.page],entry.offset,entry.capacity);this.entries.delete(id);entry=null;
      }
      if(!entry){entry={id,...this.allocate(n,protectedIds),lo:-1,hi:-1};this.entries.set(id,entry);}
      if(entry.lo!==lo||entry.hi!==hi||entry.count!==n) {
        if(this.r.encoder&&entry.owner?.detailComputeEncoder===this.r.encoder)this.r.flush();
        const bytes=new Uint8Array(heap.subarray(pointer,pointer+n*64));
        this.device.queue.writeBuffer(this.pages[entry.page].gpu,entry.offset*64,bytes);
        this.metrics.recordBytes+=bytes.length;entry.lo=lo;entry.hi=hi;entry.count=n;
      }
      entry.owner=owner;entry.indexAddress=indexAddress;entry.seenAddress=seenAddress;entry.used=++this.clock;
      words[indexAddress/4]=entry.page*2**DETAIL_PAGE_SHIFT+entry.offset;
    }
  }
  pipeline() {
    if(this.compute)return this.compute;
    const entries=Array.from({length:DETAIL_PAGE_COUNT},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}}));
    entries.push({binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
      {binding:7,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}});
    this.layout=this.device.createBindGroupLayout({entries});
    const pages=Array.from({length:DETAIL_PAGE_COUNT},(_,i)=>`@group(0) @binding(${i}) var<storage,read> page${i}:array<vec4<f32>>;`).join("\n");
    const cases=Array.from({length:DETAIL_PAGE_COUNT},(_,i)=>`case ${i}u: {${[0,1,2,3].map(n=>`output[outRow+${n}u]=page${i}[row+${n}u];`).join('')}}`).join("\n");
    const code=pages+`
@group(0) @binding(6) var<storage,read> refs:array<u32>;
@group(0) @binding(7) var<storage,read_write> output:array<vec4<f32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 let index=gid.x+gid.y*4194240u;
 if(index>=arrayLength(&refs)){return;}
 let reference=refs[index];let row=(reference&2097151u)*4u;let outRow=index*4u;
 switch(reference>>21u){${cases} default:{}}
}`;
    this.compute=this.device.createComputePipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.layout]}),
      compute:{module:this.device.createShaderModule({code,label:"X-Ray detail gather"}),entryPoint:"main"}});
    return this.compute;
  }
  gather(token,indices,changed) {
    const info=this.r.info(token),count=indices.length;if(!count)return;
    if(!info.detailSet){info.detailSet=true;this.sets++;}
    if(changed||!info.detailIndexBuffer) {
      if(this.r.encoder&&info.detailComputeEncoder===this.r.encoder)this.r.flush();
      const bytes=power2(Math.max(4,count*4));
      if(!info.detailIndexBuffer||info.detailIndexBuffer.size<bytes) {
        if(info.detailIndexBuffer)this.r.retired.push(info.detailIndexBuffer);
        info.detailIndexBuffer=this.device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        info.detailIndexCPU=new Uint32Array(bytes/4);
      }
      info.detailIndexCPU.set(indices);
      this.device.queue.writeBuffer(info.detailIndexBuffer,0,info.detailIndexCPU.subarray(0,count));
      this.metrics.indexBytes+=count*4;
    }
    const size=power2(count*64);
    if(!info.gpu||info.gpu.size<size) {
      if(info.gpu)this.r.retired.push(info.gpu);
      info.gpu=this.device.createBuffer({size,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      info.size=size;
    }
    this.r.endPass();const pass=this.r.enc().beginComputePass();pass.setPipeline(this.pipeline());
    const limit=2**Math.floor(Math.log2(this.device.limits.maxStorageBufferBindingSize/64));
    for(let first=0;first<count;first+=limit) {
      const n=Math.min(limit,count-first);
      const entries=Array.from({length:DETAIL_PAGE_COUNT},(_,binding)=>({binding,resource:{buffer:this.pages[binding]?.gpu||this.empty}}));
      entries.push({binding:6,resource:{buffer:info.detailIndexBuffer,offset:first*4,size:n*4}},
        {binding:7,resource:{buffer:info.gpu,offset:first*64,size:n*64}});
      pass.setBindGroup(0,this.device.createBindGroup({layout:this.layout,entries}));
      const groups=Math.ceil(n/64);pass.dispatchWorkgroups(Math.min(65535,groups),Math.ceil(groups/65535));
    }
    pass.end();info.detailComputeEncoder=this.r.encoder;this.encoder=this.r.encoder;this.metrics.gathers++;
  }
  rangePipeline() {
    if(this.rangeCompute)return this.rangeCompute;
    const entries=Array.from({length:6},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}}));
    entries.push({binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:7,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
      {binding:8,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}});
    this.rangeLayout=this.device.createBindGroupLayout({entries});
    const pages=Array.from({length:6},(_,i)=>`@group(0) @binding(${i}) var<storage,read> page${i}:array<vec4<f32>>;`).join('\n');
    const cases=Array.from({length:6},(_,i)=>`case ${i}u: {${[0,1,2,3].map(n=>`output[outRow+${n}u]=page${i}[row+${n}u];`).join('')}}`).join('\n');
    const code=pages+`
@group(0) @binding(6) var<storage,read> ranges:array<vec4<u32>>;
@group(0) @binding(7) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(8) var<uniform> window:vec4<u32>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
 let i=group.x+group.y*65535u;if(i>=arrayLength(&ranges)){return;}
 let range=ranges[i];
 // Each workgroup expands one contiguous slot. Window clipping retains support
 // for instance sets larger than maxStorageBufferBindingSize.
 let begin=max(range.z,window.x);let end=min(range.z+range.y,window.x+window.y);
 for(var destination=begin+lane;destination<end;destination+=64u) {
  let reference=range.x+destination-range.z;
  let row=(reference&2097151u)*4u;let outRow=(destination-window.x)*4u;
  switch(reference>>21u){${cases} default:{}}
 }
}`;
    this.rangeCompute=this.device.createComputePipeline({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.rangeLayout]}),
      compute:{module:this.device.createShaderModule({code,label:'X-Ray detail slot expansion'}),entryPoint:'main'}});
    return this.rangeCompute;
  }
  gatherRanges(token,ranges,count,changed) {
    if(!count)return;
    if(!Number.isSafeInteger(count)||count<0||ranges.length%4)throw Error('Invalid detail ranges');
    const info=this.r.info(token);
    if(!info.detailSet){info.detailSet=true;this.sets++;}
    if(changed||!info.detailRangeBuffer) {
      let end=0;
      for(let i=0;i<ranges.length;i+=4) {
        const [source,n,first,reserved]=ranges.subarray(i,i+4);
        const page=this.pages[source>>>21];
        if(!page||!n||first!==end||reserved||((source&2097151)+n)>page.capacity)throw Error('Invalid detail range span');
        end+=n;
      }
      if(end!==count)throw Error('Detail range count mismatch');
      if(this.r.encoder&&info.detailComputeEncoder===this.r.encoder)this.r.flush();
      const size=power2(Math.max(16,ranges.byteLength));
      if(!info.detailRangeBuffer||info.detailRangeBuffer.size<size){
        if(info.detailRangeBuffer)this.r.retired.push(info.detailRangeBuffer);
        info.detailRangeBuffer=this.device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      }
      this.device.queue.writeBuffer(info.detailRangeBuffer,0,ranges);
      info.detailRangeBytes=ranges.byteLength;info.detailRangeCount=count;
      this.metrics.indexBytes+=ranges.byteLength;
    }
    if(info.detailRangeCount!==count)throw Error('Unchanged detail range count mismatch');
    const size=power2(count*64);
    if(!info.gpu||info.gpu.size<size){
      if(info.gpu)this.r.retired.push(info.gpu);
      info.gpu=this.device.createBuffer({size,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});info.size=size;
    }
    this.r.endPass();const pass=this.r.enc().beginComputePass();pass.setPipeline(this.rangePipeline());
    const limit=2**Math.floor(Math.log2(this.device.limits.maxStorageBufferBindingSize/64));
    for(let first=0;first<count;first+=limit){
      const n=Math.min(limit,count-first);
      const params=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM,mappedAtCreation:true});
      new Uint32Array(params.getMappedRange()).set([first,n,0,0]);params.unmap();this.r.retired.push(params);
      const entries=Array.from({length:6},(_,binding)=>({binding,resource:{buffer:this.pages[binding]?.gpu||this.empty}}));
      entries.push({binding:6,resource:{buffer:info.detailRangeBuffer,size:info.detailRangeBytes}},
        {binding:7,resource:{buffer:info.gpu,offset:first*64,size:n*64}},{binding:8,resource:{buffer:params}});
      pass.setBindGroup(0,this.device.createBindGroup({layout:this.rangeLayout,entries}));
      const groups=info.detailRangeBytes/16;pass.dispatchWorkgroups(Math.min(65535,groups),Math.ceil(groups/65535));
    }
    pass.end();info.detailComputeEncoder=this.r.encoder;this.encoder=this.r.encoder;this.metrics.gathers++;
  }
  release(info) {
    if(!info.detailSet)return false;info.detailSet=false;
    this.r.flush();
    if(info.detailIndexBuffer)info.detailIndexBuffer.destroy();
    if(info.detailRangeBuffer)info.detailRangeBuffer.destroy();
    if(--this.sets)return false;
    this.r.flush();for(const p of this.pages)p.gpu.destroy();this.empty.destroy();this.entries.clear();return true;
  }
}
