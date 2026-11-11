// Experimental cascade-wide GPU compaction. Installed only by the private harness.
export const filterWGSL = `
struct Params { matrix:mat4x4<f32>, center:vec4<f32>, extent:vec4<f32>, wind:vec4<f32>, count:vec4<u32> }
@group(0) @binding(0) var<storage,read> source:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> args:array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p:Params;
var<workgroup> survivors:atomic<u32>;
var<workgroup> base:u32;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
 if(lane==0u){atomicStore(&survivors,0u);} workgroupBarrier();
 let i=gid.x;var keep=false;var a=vec4<f32>(0);var b=a;var c=a;
 if(i<p.count.x){
  a=source[i*4u];b=source[i*4u+1u];c=source[i*4u+2u];
  let center=vec3(dot(a,vec4(p.center.xyz,1)),dot(b,vec4(p.center.xyz,1)),dot(c,vec4(p.center.xyz,1)));
  let height=dot(abs(b.xyz),abs(p.center.xyz)+p.extent.xyz);
  let extent=vec3(dot(abs(a.xyz),p.extent.xyz),dot(abs(b.xyz),p.extent.xyz),dot(abs(c.xyz),p.extent.xyz))+vec3(height*p.wind.x+0.05,0.05,height*p.wind.x+0.05);
  let m=transpose(p.matrix);let planes=array<vec4<f32>,4>(m[3]+m[0],m[3]-m[0],m[3]+m[1],m[3]-m[1]);
  keep=true;
  for(var j=0u;j<4u;j++){if(dot(planes[j],vec4(center,1))+dot(abs(planes[j].xyz),extent)<0){keep=false;}}
 }
 var local=0u;if(keep){local=atomicAdd(&survivors,1u);}workgroupBarrier();
 if(lane==0u){base=atomicAdd(&args[p.count.y*5u+1u],atomicLoad(&survivors));}workgroupBarrier();
 if(keep){let dst=(base+local)*4u;output[dst]=a;output[dst+1u]=b;output[dst+2u]=c;output[dst+3u]=source[i*4u+3u];}
}`;
function uniform(p,name){const u=p.uniforms.find(u=>u.name===name);if(!u)return null;return new Float32Array((p.uniformBlocks?.[u.group||0]||p).uniformData.buffer,u.offset,u.type==='mat4'?16:4);}
function bounds(r,g,count,first,base){
 const pos=g.attrs.get(3),tc=g.attrs.get(8),v=r.info(pos.buffer).cpu,ix=r.info(g.element).cpu;
 if(!v||!ix||pos.stride!==20||tc.offset!==12)return null;
 const view=new DataView(v.buffer,v.byteOffset,v.byteLength),indices=new DataView(ix.buffer,ix.byteOffset,ix.byteLength);
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let fraction=0;
 for(let j=0;j<count;j++){
  const at=(indices.getUint16((first+j)*2,true)+base)*pos.stride+pos.offset;
  for(let k=0;k<3;k++){const x=view.getFloat32(at+k*4,true);min[k]=Math.min(min[k],x);max[k]=Math.max(max[k],x);}
  fraction=Math.max(fraction,Math.abs(view.getInt16(at+16,true)/16384));
 }
 return {center:min.map((v,k)=>(v+max[k])/2),extent:min.map((v,k)=>(max[k]-v)/2),fraction};
}
export function installGPUGrassFilter(Frontend,diagnostics){
 const original=Frontend.prototype.encodeDraw,prepared=Frontend.prototype.encodePreparedDraw;
 Frontend.prototype.encodePreparedDraw=function(record,g,indexFormat,count,instances,first,base,firstInstance,uniformBase){
  const job=this.grassIndirect;
  if(!job)return prepared.call(this,record,g,indexFormat,count,instances,first,base,firstInstance,uniformBase);
  const info=this.info(g.attrs.get(12).buffer);
  const bindings=record.bindings.map(b=>b.info===info?{buffer:job.output,offset:0}:b);
  // Capture only this draw call; all normal render-state setup remains unchanged.
  const begin=this.begin;
  this.begin=function(){const pass=begin.call(this);return new Proxy(pass,{get(t,k){if(k==='drawIndexed')return ()=>t.drawIndexedIndirect(job.args,job.slot*20);const value=t[k];return typeof value==='function'?value.bind(t):value;}});};
  try{return prepared.call(this,{...record,bindings},g,indexFormat,count,instances,first,base,firstInstance,uniformBase);}finally{this.begin=begin;}
 };
 Frontend.prototype.encodeDraw=function(p,g,primitive,indexFormat,count,instances,first,base,firstInstance){
  if(!p?.detailInstancing||indexFormat!=='uint16')return original.call(this,p,g,primitive,indexFormat,count,instances,first,base,firstInstance);
  const state=this.grassFilter??={entries:new Map(),bundles:[],frame:-1};
  const frame=diagnostics.frames;
  if(state.frame!==frame){state.frame=frame;state.cascade=-1;state.matrix=null;}
  const a=this.attachments(),colors=a.colors.filter(Boolean);
  if(colors.length>=2){
   let e=state.entries.get(g);
   if(!e){const box=bounds(this,g,count,first,base);if(box){e={g,box};state.entries.set(g,e);}}
   if(e){Object.assign(e,{frame,count,instances,first,base});const wind=uniform(p,'dir2D');e.wind=wind?Math.hypot(wind[0],wind[2])*e.box.fraction*1.01:0;}
  }else if(a.depth&&state.entries.get(g)?.frame===frame){
   const matrix=uniform(p,'m_WVP');
   if(matrix){
    if(!state.matrix||matrix.some((v,i)=>v!==state.matrix[i])){
     state.matrix=Array.from(matrix);state.cascade++;
     const jobs=[...state.entries.values()].filter(e=>e.frame===frame);
     state.jobs=compact(this,state,state.bundles[state.cascade]??={},jobs,matrix);
    }
    this.grassIndirect=state.jobs?.get(g);
   }
  }
  try{return original.call(this,p,g,primitive,indexFormat,count,instances,first,base,firstInstance);}finally{this.grassIndirect=null;}
 };
}
function compact(r,state,bundle,jobs,matrix){
 const d=r.device;
 if(!state.pipeline){state.pipeline=d.createComputePipeline({layout:'auto',compute:{module:d.createShaderModule({code:filterWGSL,label:'Experimental grass shadow compaction'}),entryPoint:'main'}});}
 const valid=jobs.filter(e=>e.instances*64<=d.limits.maxStorageBufferBindingSize);
 if(!valid.length)return null;
 const bytes=Math.ceil(valid.length*20/256)*256;
 if(!bundle.args||bundle.args.size<bytes){if(bundle.args)r.retired.push(bundle.args);bundle.args=d.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});bundle.groups=new Map();}
 bundle.jobCount=valid.length;bundle.outputs??=new Map();const indirect=new Uint32Array(valid.length*5),params=new Uint8Array(valid.length*256);
 const groups=[],result=new Map();
 for(let slot=0;slot<valid.length;slot++){
  const e=valid[slot],input=r.info(e.g.attrs.get(12).buffer).gpu;
  let output=bundle.outputs.get(e.g);
  if(!output||output.size<e.instances*64){if(output)r.retired.push(output);output=d.createBuffer({size:2**Math.ceil(Math.log2(e.instances*64)),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE});bundle.outputs.set(e.g,output);bundle.groups.delete(e.g);}
  indirect.set([e.count,0,e.first,e.base,0],slot*5);
  const floats=new Float32Array(params.buffer,slot*256,28),words=new Uint32Array(params.buffer,slot*256+112,4);
  floats.set(matrix);floats.set(e.box.center,16);floats.set(e.box.extent,20);floats[24]=e.wind;words.set([e.instances,slot,0,0]);
  groups.push({e,input,output,slot});result.set(e.g,{output,args:bundle.args,slot});
 }
 if(!bundle.params||bundle.params.size<params.length){if(bundle.params)r.retired.push(bundle.params);bundle.params=d.createBuffer({size:params.length,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});bundle.groups=new Map();}
 // Each cascade owns these buffers; do not overwrite while earlier commands use them.
 if(bundle.encoder===r.encoder&&r.encoder)r.flush();
 d.queue.writeBuffer(bundle.args,0,indirect);d.queue.writeBuffer(bundle.params,0,params);
 r.endPass();const pass=r.enc().beginComputePass();pass.setPipeline(state.pipeline);
 for(const {e,input,output,slot} of groups){
  let saved=bundle.groups.get(e.g);
  if(!saved||saved.input!==input||saved.slot!==slot){saved={input,slot,group:d.createBindGroup({layout:state.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}},{binding:2,resource:{buffer:bundle.args}},{binding:3,resource:{buffer:bundle.params,offset:slot*256,size:128}}]})};bundle.groups.set(e.g,saved);}
  pass.setBindGroup(0,saved.group);pass.dispatchWorkgroups(Math.ceil(e.instances/64));
 }
 pass.end();bundle.encoder=r.encoder;return result;
}
export async function captureFilterCounts(r){
 const state=r.grassFilter;if(!state)return null;
 const result=[];r.endPass();
 const buffers=state.bundles.slice(0,state.cascade+1).map(bundle=>{const b=r.device.createBuffer({size:bundle.args.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});r.enc().copyBufferToBuffer(bundle.args,0,b,0,b.size);return {b,count:bundle.jobCount};});r.flush();
 for(const {b,count} of buffers){await b.mapAsync(GPUMapMode.READ);const words=new Uint32Array(b.getMappedRange());let draws=0,instances=0,triangles=0;for(let i=0;i<count*5;i+=5){if(!words[i])continue;draws++;instances+=words[i+1];triangles+=words[i]*words[i+1]/3;}result.push({draws,instances,triangles});b.unmap();b.destroy();}
 return result;
}
