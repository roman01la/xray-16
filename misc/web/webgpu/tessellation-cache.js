import {EngineFormat as G} from './engine-formats.js';
import {tessellationPattern} from './tessellation-core.js';
import {createTessellationShaders} from './tessellation-shader.js';
const align=(n,a=4)=>Math.ceil(n/a)*a;
const sameBytes=(a,b)=>a?.length===b.length&&b.every((v,i)=>a[i]===v);
export class TessellationCache {
 constructor(renderer,{maxBytes=128*1024*1024,maxEntries=1024}={}) {
  this.r=renderer;this.device=renderer.device;this.maxBytes=maxBytes;this.maxEntries=maxEntries;
  this.entries=new Map();this.patterns=new Map();this.bytes=0;this.clock=0;
  this.metrics={draws:0,generated:0,reused:0,sourceTriangles:0,outputTriangles:0,bytes:0,peakBytes:0,evictions:0,budgetDowngrades:0,unsupported:0,levels:{1:0,2:0,4:0,8:0},methods:{PN:0,HM:0,PN_HM:0},shadowDraws:0};
 }
 prepare(meta,geometry,indexFormat) {
  if(!['uint16','uint32'].includes(indexFormat))throw Error('Tessellation requires indexed triangles');
  const buffers=new Set([...geometry.attrs.values()].filter(a=>a.enabled!==false).map(a=>a.buffer));
  if(buffers.size!==1)throw Error('Tessellation currently requires the native single-stream mesh layout');
  const source=createTessellationShaders(meta,geometry,indexFormat);
  const entries=[0,1,2,3,4,6].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:[3,4].includes(binding)?'storage':'read-only-storage'}}));
  entries.push({binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}});
  const layout=this.device.createBindGroupLayout({entries});
  const pipeline=this.device.createComputePipeline({label:'X-Ray native tessellation',
   layout:this.device.createPipelineLayout({bindGroupLayouts:[meta.bindGroupLayout,...meta.extraUniformLayouts,layout]}),
   compute:{module:this.device.createShaderModule({label:'X-Ray stock VS + tessellation',code:source.compute}),entryPoint:'main'}});
  return {...source,pipeline,layout,vertexToken:[...buffers][0],indexFormat,
   renderModule:this.device.createShaderModule({label:'X-Ray tessellated surface vertex',code:source.render})};
 }
 pattern(factor) {
  let data=this.patterns.get(factor);if(data)return data;const pattern=tessellationPattern(factor);
  const points=this.device.createBuffer({size:pattern.points.length*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  const indices=this.device.createBuffer({size:pattern.indices.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  this.device.queue.writeBuffer(points,0,new Float32Array(pattern.points.flatMap(p=>[...p,0])));
  this.device.queue.writeBuffer(indices,0,new Uint32Array(pattern.indices));
  data={points,indices,vertices:pattern.points.length,count:pattern.indices.length};this.patterns.set(factor,data);return data;
 }
 discard(key,entry) {
  if(entry.encoder===this.r.encoder)this.r.flush();
  for(const buffer of [entry.vertices,entry.indices])buffer.destroy();
  this.entries.delete(key);this.bytes-=entry.bytes;this.metrics.bytes=this.bytes;this.metrics.evictions++;
 }
 allocate(key,bytes,vertexBytes,indexBytes) {
  while(this.bytes+bytes>this.maxBytes||this.entries.size>=this.maxEntries){const oldest=[...this.entries].reduce((a,b)=>!a||b[1].used<a[1].used?b:a,null);if(!oldest)throw Error('Tessellation allocation exceeds budget');this.discard(...oldest);}
  const entry={bytes,used:++this.clock,vertices:this.device.createBuffer({size:vertexBytes,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),
   indices:this.device.createBuffer({size:indexBytes,usage:GPUBufferUsage.INDEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),
   indexToken:{},uniforms:null};
  this.r.info(entry.indexToken).gpu=entry.indices;this.entries.set(key,entry);this.bytes+=bytes;
  this.metrics.bytes=this.bytes;this.metrics.peakBytes=Math.max(this.metrics.peakBytes,this.bytes);return entry;
 }
 range(plan,geometry,count,first,baseVertex) {
  const vertices=this.r.info(plan.vertexToken),indices=this.r.info(geometry.element);
  const indexBytes=plan.indexFormat==='uint16'?2:4;
  if(!indices?.cpu||!vertices?.cpu||first<0||count%3||first*indexBytes+count*indexBytes>indices.size)throw Error('Invalid tessellation source range');
  const stride=geometry.attrs.values().next().value.stride,view=new DataView(indices.cpu.buffer,indices.cpu.byteOffset,indices.cpu.byteLength);
  let low=Infinity,high=-Infinity;for(let i=first;i<first+count;i++){const index=(indexBytes===2?view.getUint16(i*2,true):view.getUint32(i*4,true))+baseVertex;low=Math.min(low,index);high=Math.max(high,index);}
  if(low<0||(high+1)*stride>vertices.size)throw Error('Tessellation source vertex out of bounds');
  const alignment=this.device.limits.minStorageBufferOffsetAlignment;
  const vertexOffset=Math.floor(low*stride/alignment)*alignment,indexOffset=Math.floor(first*indexBytes/alignment)*alignment;
  const vertexSize=align((high+1)*stride-vertexOffset),indexSize=align((first+count)*indexBytes-indexOffset);
  if(vertexSize>this.device.limits.maxStorageBufferBindingSize||indexSize>this.device.limits.maxStorageBufferBindingSize)return null;
  return {vertices,indices,vertexOffset,vertexSize,indexOffset,indexSize,first:first-indexOffset/indexBytes,baseVertex};
 }
 generate(plan,meta,geometry,count,first,baseVertex,factor,record,uniformBase) {
  if(!count)return null;this.metrics.draws++;this.metrics.sourceTriangles+=count/3;
  const limit=this.device.limits.maxStorageBufferBindingSize;
  let pattern,vertexBytes,indexBytes,total;
  do {pattern=this.pattern(factor);vertexBytes=count/3*pattern.vertices*128;indexBytes=count/3*pattern.count*4;total=vertexBytes+indexBytes+96;
   if(total<=this.maxBytes&&vertexBytes<=limit&&indexBytes<=limit)break;
   if(factor===1){this.metrics.unsupported++;return null;}factor/=2;this.metrics.budgetDowngrades++;
  }while(true);
  this.metrics.levels[factor]++;this.metrics.methods[[null,"PN","HM","PN_HM"][meta.tessellation.method]]++;
  if(meta.tessellation.shadow)this.metrics.shadowDraws++;
  const vertexInfo=this.r.info(plan.vertexToken),indexInfo=this.r.info(geometry.element);
  const key=[this.r.id(plan),this.r.id(vertexInfo.gpu),this.r.id(indexInfo.gpu),vertexInfo.tessellationRevision||0,indexInfo.tessellationRevision||0,count,first,baseVertex,factor].join(':');
  let entry=this.entries.get(key);if(!entry)entry=this.allocate(key,total,vertexBytes,indexBytes);
  entry.used=++this.clock;
  if(!entry.range){entry.range=this.range(plan,geometry,count,first,baseVertex);if(!entry.range){this.discard(key,entry);this.metrics.unsupported++;return null;}}
  const blocks=meta.uniformBlocks||[meta];
  const displacementRevision=(meta.tessellation.method&2)&&meta.tessellation.detail
   ? ['s_bumpX',...(meta.tessellation.detailBump?['s_detailBumpX']:[])].map(name=>{
      const unit=meta.values.get(name)?.[0]??0,texture=this.r.textures[unit].get(G.TEXTURE_2D);
      return this.r.info(texture)?.tessellationContentRevision||0;
     }).join(':') : '';
  const unchanged=entry.displacementRevision===displacementRevision&&entry.material===record.material&&entry.uniforms?.length===blocks.length&&blocks.every((b,i)=>sameBytes(entry.uniforms[i],b.uniformData));
  if(!unchanged) {
   const projection=meta.uniformByName.get('m_P');if(!projection||projection.columns!==4||projection.rows!==4)throw Error('Tessellated stock vertex shader must retain m_P');
   const data=new ArrayBuffer(96),f=new Float32Array(data),u=new Uint32Array(data),projectionBlock=blocks[projection.group||0];
   f.set(new Float32Array(projectionBlock.uniformData.buffer,projectionBlock.uniformData.byteOffset+projection.offset,16),0);
   const range=entry.range,flags=(meta.tessellation.shadow?1:0)|(meta.tessellation.detail?2:0)|(meta.tessellation.detailBump?4:0);
   u.set([count/3,range.first,baseVertex>>>0,range.vertexOffset,pattern.vertices,pattern.count,meta.tessellation.method,flags],16);
   // Use the renderer's batched uniform ring: distinct offsets preserve earlier
   // draws while allowing compute/render commands to share one submission.
   const paramOffset=this.r.allocateUniformBlock({uniformData:new Uint8Array(data)});
   const group=this.device.createBindGroup({layout:plan.layout,entries:[
    {binding:0,resource:{buffer:range.vertices.gpu,offset:range.vertexOffset,size:range.vertexSize}},
    {binding:1,resource:{buffer:range.indices.gpu,offset:range.indexOffset,size:range.indexSize}},
    {binding:2,resource:{buffer:pattern.points}},{binding:3,resource:{buffer:entry.vertices}},
    {binding:4,resource:{buffer:entry.indices}},{binding:5,resource:{buffer:this.r.uniformBuffer,offset:paramOffset,size:96}},{binding:6,resource:{buffer:pattern.indices}}]});
   this.r.endPass();const pass=this.r.enc().beginComputePass();pass.setPipeline(plan.pipeline);
   pass.setBindGroup(0,record.material.group,record.hasUniform?[uniformBase]:[]);
   for(let i=0;i<record.extraUniforms.length;i++)pass.setBindGroup(i+1,record.extraUniforms[i].group,[record.extraUniforms[i].offset]);
   pass.setBindGroup(plan.group,group);const patches=count/3;pass.dispatchWorkgroups(Math.min(65535,patches),Math.ceil(patches/65535));pass.end();
   entry.displacementRevision=displacementRevision;entry.material=record.material;entry.uniforms=blocks.map(b=>b.uniformData.slice());this.metrics.generated++;
  }else this.metrics.reused++;
  entry.encoder=this.r.encoder;this.metrics.outputTriangles+=count/3*pattern.count/3;
  return {bindings:[{buffer:entry.vertices,offset:0}],geometry:{element:entry.indexToken},count:count/3*pattern.count};
 }
 destroy() {this.r.flush();for(const [key,entry] of [...this.entries])this.discard(key,entry);for(const p of this.patterns.values()){p.points.destroy();p.indices.destroy();}this.patterns.clear();}
}
