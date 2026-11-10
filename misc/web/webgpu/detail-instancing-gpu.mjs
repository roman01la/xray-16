import {installNativeQueues} from './native-queue.js';
import {DetailStorage} from './detail-storage.js';
import {GPUFrontend} from './backend.js';
import {EngineFormat as G} from './engine-formats.js';

// Standalone offscreen regression. Does not start or interact with the game.
export async function validateDetailInstancing(device, variants = [], rangeMode = false, queueMode = false) {
  const width=130,height=2;
  const canvas=new OffscreenCanvas(width,height),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
  const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  device.pushErrorScope('validation');
  const color={},second={},fbo={},vertices={},indices={},instances={},declaration={};
  for(const texture of [color,second])r.allocateNativeTexture(texture,G.TEXTURE_2D,1,G.RGBA8,width,height,1);
  r.fbo=fbo;r.info(fbo).attachments=new Map([[G.COLOR_ATTACHMENT0,{texture:color,level:0,layer:0}]]);
  r.state.viewport=[0,0,width,height];r.state.depthTest=false;r.state.cull=false;
  r.registerDeclaration(declaration,new Uint32Array([3,3,G.FLOAT,0,0,8,4,G.SHORT,0,12]));
  const mesh=new ArrayBuffer(80),meshView=new DataView(mesh);
  [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([x,y],i)=>{
    meshView.setFloat32(i*20,x,true);meshView.setFloat32(i*20+4,y,true);
  });
  r.uploadNativeBuffer(vertices,new Uint8Array(mesh));
  r.uploadNativeBuffer(indices,new Uint8Array(new Uint16Array([0,1,2,2,3,0]).buffer));
  const heap=new Uint8Array(1024+width*64),words=new Uint32Array(heap.buffer);
  const rows=new Float32Array(heap.buffer,1024,width*16);
  function gather(token,indices,changed) {
    if(!rangeMode){r.gatherDetailSet(token,indices,changed);return;}
    const ranges=[];
    for(let first=0;first<indices.length;){let end=first+1;
      while(end<indices.length && indices[end]===indices[first]+end-first)end++;
      ranges.push(indices[first],end-first,first,0);first=end;
    }
    r.gatherDetailRanges(token,new Uint32Array(ranges),indices.length,changed);
    r.info(token).fixtureIndices=indices;
  }
  function prepare(token,slots) {
    const d=[];for(let i=0;i<slots.length;i++){const [id,revision,count,pointer]=slots[i];d.push(id,revision,0,count,pointer,id*8,id*8+4);words[id*2+1]=1;}
    r.updateDetailRecords(token,new Uint32Array(d),heap,words,new Uint32Array(slots.map(s=>s[0])));
    const indices=[];for(let i=0;i<slots.length;i++)for(let j=0;j<slots[i][2];j++)indices.push(words[slots[i][0]*2]+j);
    const signature=indices.join(',');
    gather(token,new Uint32Array(indices),r.info(token).fixtureSignature!==signature);
    r.info(token).fixtureSignature=signature;
  }
  r.detailArena=new DetailStorage(r,{maxPageRecords:128,softBytes:128*64*2});
  function fill(swapped) {
    for(let n=0;n<width;n++)rows.set([1/width,0,0,-1+(2*n+1)/width,0,1,0,0,0,0,1,0.5,
      (n+swapped)%2?0:1,(n+swapped)%2?1:0,0,1],n*16);
    const ids=swapped===3?[3,4]:[1,2];
    prepare(instances,[[ids[0],swapped,65,1024],[ids[1],swapped===2?1:swapped,65,1024+65*64]]);
  }
  const meta={key:'detail-pixel-test',uniforms:[{name:'array',type:'vec4',count:244,columns:1,rows:4,offset:0,stride:16}],
    uniformBytes:3904,uniformGroups:[{bytes:3904}],activeBindings:[0],activeUniforms:[{name:'array',size:244,type:35666}],
    samplers:[],attributes:[{name:'position',location:3,type:35666,size:1},{name:'misc',location:8,type:35666,size:1}],outputs:[0],stages:{
    vert:`struct Uniforms {\n @align(16) @size(3904) values: array<vec4<f32>, 244>,\n}\n@group(0) @binding(0) var<uniform> uniforms: Uniforms;
struct Out { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, }
@vertex fn main(@location(3) position: vec4<f32>, @location(8) misc: vec4<f32>) -> Out {
 let i=i32(misc.w);
 return Out(vec4<f32>(dot(uniforms.values[i],position),dot(uniforms.values[i+1],position),dot(uniforms.values[i+2],position),1),uniforms.values[i+3]);
}`,
    frag:'@fragment fn main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> { return color; }'}};
  const program={meta};r.link(program);
  const queueMemory=new ArrayBuffer(4096),q=new Uint32Array(queueMemory),programHandles=[null,program];
  if(queueMode)installNativeQueues(r,()=>({words:q,floats:new Float32Array(queueMemory),ints:new Int32Array(queueMemory)}),[0,400,800,1200,1600,2000,2400,3000],{vaos:[null,declaration],buffers:[null,vertices,indices,instances],programs:programHandles});
  const draw=(...args)=>{
    if(!queueMode)return r.submitDraw(...args);
    let programId=programHandles.indexOf(args[4]);
    if(programId<0){programId=programHandles.length;programHandles.push(args[4]);}
    if(q[750]>=128)r.flushNativeDraws();
    q.set([1,1,2,20,programId,G.TRIANGLES,1,6,0,0,0,0,0,0,args[10]?3:0,args[11]??1],600+q[750]);q[750]+=16;
  };
  const readbacks=[];
  for(let swap=0;swap<4;swap++) {
    fill(swap);
    draw(declaration,vertices,indices,20,program,G.TRIANGLES,true,6,0,0,instances,width);
    r.flushNativeDraws?.();r.endPass();
    const read=device.createBuffer({size:768*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    r.enc().copyTextureToBuffer({texture:r.info(color).gpu},{buffer:read,bytesPerRow:768},[width,height,1]);
    readbacks.push(read);
    // Pending draws must survive content mutation and forced page range reuse.
    // Two pages also exercise ordered references across storage bindings.
    if(swap===1)r.flush();
  }
  // Grow a page while the last draw/readback is pending; old index references
  // must still retrieve the copied records from the new page afterwards.
  const growthSet={};r.detailArena.maxPageRecords=256;r.detailArena.softBytes=Infinity;
  prepare(growthSet,[[5,0,65,1024]]);
  gather(instances,rangeMode?r.info(instances).fixtureIndices:r.info(instances).detailIndexCPU.subarray(0,width),false);
  draw(declaration,vertices,indices,20,program,G.TRIANGLES,true,6,0,0,instances,width);
  r.flushNativeDraws?.();r.endPass();
  const grownRead=device.createBuffer({size:768*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  r.enc().copyTextureToBuffer({texture:r.info(color).gpu},{buffer:grownRead,bytesPerRow:768},[width,height,1]);
  readbacks.push(grownRead);
  r.flushNativeDraws?.();r.flush();
  await Promise.all(readbacks.map(b=>b.mapAsync(GPUMapMode.READ)));
  for(let swap=0;swap<5;swap++) {
    const pixels=new Uint8Array(readbacks[swap].getMappedRange());
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const at=y*768+x*4,red=(x+(swap===4?3:swap===2&&x>=65?1:swap))%2?0:255;
      if(pixels[at]!==red||pixels[at+1]!==255-red||pixels[at+3]!==255)
        throw Error(`Instance readback mismatch at draw ${swap}, pixel ${x},${y}: ${pixels.slice(at,at+4)}; ${(await device.popErrorScope())?.message || errors.join(";")}`);
    }
    readbacks[swap].unmap();readbacks[swap].destroy();
  }
  // Storage occupies the same group index as a non-detail extra uniform block.
  // Switching back and forth must invalidate both sides of the binding cache.
  const uniformProgram={meta:{key:'detail-uniform-switch',uniforms:[
    {name:'a',type:'vec4',count:1,columns:1,rows:4,offset:0,stride:16,group:0},
    {name:'b',type:'vec4',count:1,columns:1,rows:4,offset:0,stride:16,group:1}],
    uniformBytes:16,uniformGroups:[{bytes:16},{bytes:16}],activeBindings:[0],
    activeUniforms:[{name:'a',size:1,type:35666},{name:'b',size:1,type:35666}],samplers:[],
    attributes:[{name:'position',location:3,type:35666,size:1}],outputs:[0],stages:{
    vert:`@group(0) @binding(0) var<uniform> a:vec4<f32>;
@group(1) @binding(0) var<uniform> b:vec4<f32>;
@vertex fn main(@location(3) position:vec4<f32>)->@builtin(position) vec4<f32>{return position+vec4<f32>(a.x+b.x,0,0,0);}`,
    frag:'@fragment fn main()->@location(0) vec4<f32>{return vec4<f32>(1,0,0,1);}'}}};
  r.link(uniformProgram);
  draw(declaration,vertices,indices,20,uniformProgram,G.TRIANGLES,true,6,0,0);
  draw(declaration,vertices,indices,20,program,G.TRIANGLES,true,6,0,0,instances,width);
  draw(declaration,vertices,indices,20,uniformProgram,G.TRIANGLES,true,6,0,0);
  // Compile every packaged wind/static/alpha detail variant and its pipeline
  // against actual per-instance declarations and MRT attachments.
  r.flushNativeDraws?.();
  r.info(fbo).attachments.set(G.COLOR_ATTACHMENT0+1,{texture:second,level:0,layer:0});
  r.info(fbo).drawBuffers=[G.COLOR_ATTACHMENT0,G.COLOR_ATTACHMENT0+1];
  r.info(fbo).cachedAttachments=null;
  for(const variant of variants) {
    const handle={meta:structuredClone(variant)};r.link(handle);
    const info=await handle.meta.modules.vert.getCompilationInfo();
    const bad=info.messages.filter(m=>m.type==='error');
    if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));
    draw(declaration,vertices,indices,20,handle,G.TRIANGLES,true,6,0,0,instances,width);
  }
  r.flushNativeDraws?.();r.flush();
  await device.queue.onSubmittedWorkDone();
  const validation=await device.popErrorScope();
  if(validation||errors.length)throw Error(validation?.message||errors.join('\n'));
  for(const texture of [color,second])r.info(texture).gpu.destroy();
  for(const token of [vertices,indices,instances,growthSet])r.deleteNativeBuffer(token);
  r.uniformBuffer.destroy();
  return {passed:true,instances:width,draws:5,pixelsChecked:width*height*5,shaderVariants:variants.length};
}
