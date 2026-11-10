import {tessellationPattern,pnPatch,evaluatePatch} from './tessellation-core.js';
import {tessellationValidationKernel} from './tessellation-kernel.js';
export async function validateTessellation(device) {
 device.pushErrorScope('validation');
 const module=device.createShaderModule({label:'X-Ray tessellation parity probe',code:tessellationValidationKernel});
 const compilation=await module.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');
 if(errors.length)throw Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const fixtures=[{p:[[0,0,0],[1,0,0],[0,1,0]],n:[[0,0,1],[0,0,1],[0,0,1]]},
  {p:[[-1,-1,1],[1,-1,1],[0,1,1]],n:[[-.5,0,.8660254],[.5,0,.8660254],[0,.5,.8660254]]},
  {p:[[0,0,0],[0,0,0],[0,0,0]],n:[[0,0,0],[0,0,0],[0,0,0]]}];
 const buffer=(bytes,usage)=>device.createBuffer({size:Math.max(4,bytes),usage:usage|GPUBufferUsage.COPY_DST});
 const control=buffer(fixtures.length*3*128,GPUBufferUsage.STORAGE),samples=buffer(64*16,GPUBufferUsage.STORAGE),
  output=buffer(fixtures.length*64*128,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),params=buffer(96,GPUBufferUsage.UNIFORM),
  read=buffer(fixtures.length*64*128,GPUBufferUsage.MAP_READ);
 const input=new Float32Array(fixtures.length*3*32);
 fixtures.forEach(({p,n},i)=>p.forEach((pos,j)=>{const at=(i*3+j)*32;input.set([...pos,1],at+8);input.set([1,0,n[j][0],0],at+12);input.set([0,1,n[j][1],0],at+16);input.set([0,0,n[j][2],0],at+20);}));
 device.queue.writeBuffer(control,0,input);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[control,samples,output,params].map((b,binding)=>({binding,resource:{buffer:b}}))});
 let checked=0,maxError=0;const counts={};
 for(const factor of [1,2,4,8]) {
  const pattern=tessellationPattern(factor),points=pattern.points;counts[factor]={vertices:points.length,triangles:pattern.indices.length/3};
  device.queue.writeBuffer(samples,0,new Float32Array(points.flatMap(p=>[...p,0])));
  for(const method of [1,2,3])for(const flags of [0,1,2,3,6,7]) {
   const raw=new ArrayBuffer(96),f=new Float32Array(raw),u=new Uint32Array(raw);f.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);u.set([points.length,method,flags,0],16);f.set([.8,.7,0,0],20);
   device.queue.writeBuffer(params,0,raw);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(fixtures.length);pass.end();
   encoder.copyBufferToBuffer(output,0,read,0,fixtures.length*points.length*128);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange());
   fixtures.forEach(({p,n},patch)=>{const reference=pnPatch(p,n);points.forEach((point,i)=>{const expected=evaluatePatch(reference,point,{method,shadow:!!(flags&1),detail:!!(flags&2),detailBump:!!(flags&4),height:.8,detailHeight:.7});
    for(let j=0;j<3;j++){const difference=Math.abs(actual[(patch*points.length+i)*32+8+j]-expected.position[j]);if(!Number.isFinite(difference)||difference>3e-5)throw Error(`Tessellation mismatch factor=${factor} method=${method} flags=${flags} patch=${patch} point=${i} component=${j}: ${difference}`);maxError=Math.max(maxError,difference);}checked++;});});read.unmap();
  }
 }
 for(const b of [control,samples,output,params,read])b.destroy();const error=await device.popErrorScope();if(error)throw error;
 return {passed:true,checkedVertices:checked,maxPositionError:maxError,patterns:counts};
}

// Exercise the actual stock-VS-to-compute adapter, including packed attribute
// decoding, pre-tessellation transforms and generated triangle indexing.
export async function validateTessellationSource(device) {
 const {createTessellationShaders}=await import('./tessellation-shader.js');
 const {EngineFormat:G}=await import('./engine-formats.js');
 const source=`struct VertexOutput {
 @builtin(position) clip:vec4<f32>, @location(0) tc:vec2<f32>, @location(1) pos:vec4<f32>,
 @location(2) m1:vec3<f32>, @location(3) m2:vec3<f32>, @location(4) m3:vec3<f32>, }
@vertex fn main(@location(3) position:vec4<f32>, @location(5) normal:vec4<f32>) -> VertexOutput {
 let n=normal.xyz*2.0-1.0;let p=position+vec4<f32>(0.25,0.5,0,0);
 return VertexOutput(p,vec2<f32>(0),p,vec3<f32>(1,0,n.x),vec3<f32>(0,1,n.y),vec3<f32>(0,0,n.z)); }
`;
 const meta={stages:{vert:source},uniformGroups:[{bytes:16}],attributes:[{location:3},{location:5}],
  samplers:[],tessellation:{method:1,detail:false,shadow:false},varyings:{v2p_bumped_tcdh:0,v2p_bumped_position:1,v2p_bumped_M1:2,v2p_bumped_M2:3,v2p_bumped_M3:4}};
 const geometry={attrs:new Map([[3,{size:3,type:G.FLOAT,stride:16,offset:0}],[5,{size:4,type:G.UNSIGNED_BYTE,stride:16,offset:12,normalized:true}]])};
 const code=createTessellationShaders(meta,geometry,'uint16');device.pushErrorScope('validation');
 const module=device.createShaderModule({code:code.compute}),render=device.createShaderModule({code:code.render});
 for(const m of [module,render]){const errors=(await m.getCompilationInfo()).messages.filter(x=>x.type==='error');if(errors.length)throw Error(errors.map(x=>x.message).join('\n'));}
 const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),buffers=[];
 const buffer=(data,usage)=>{const raw=typeof data==='number'?null:data;const b=device.createBuffer({size:typeof data==='number'?data:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST});if(raw)device.queue.writeBuffer(b,0,raw);buffers.push(b);return b;};
 const sourceBytes=new ArrayBuffer(64),data=new DataView(sourceBytes);const positions=[[0,0,0],[1,0,0],[0,1,0]];
 positions.forEach((p,i)=>{p.forEach((v,j)=>data.setFloat32(16*(i+1)+j*4,v,true));[128,128,255,0].forEach((v,j)=>data.setUint8(16*(i+1)+12+j,v));});
 const pattern=tessellationPattern(4),N=pattern.points.length,output=buffer(N*128,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),indices=buffer(pattern.indices.length*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
 const paramBytes=new ArrayBuffer(96),f=new Float32Array(paramBytes),u=new Uint32Array(paramBytes);f.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);u.set([1,1,1,0,N,pattern.indices.length,1,0],16);
 const resources=[buffer(new Uint8Array(sourceBytes),GPUBufferUsage.STORAGE),buffer(new Uint16Array([9,0,1,2]),GPUBufferUsage.STORAGE),buffer(new Float32Array(pattern.points.flatMap(p=>[...p,0])),GPUBufferUsage.STORAGE),output,indices,buffer(new Uint8Array(paramBytes),GPUBufferUsage.UNIFORM),buffer(new Uint32Array(pattern.indices),GPUBufferUsage.STORAGE)];
 const group=device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:resources.map((b,binding)=>({binding,resource:{buffer:b}}))});
 const read=buffer(N*128,GPUBufferUsage.MAP_READ),readIndices=buffer(pattern.indices.length*4,GPUBufferUsage.MAP_READ),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[]}));pass.setBindGroup(1,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,read,0,N*128);encoder.copyBufferToBuffer(indices,0,readIndices,0,pattern.indices.length*4);device.queue.submit([encoder.finish()]);await Promise.all([read.mapAsync(GPUMapMode.READ),readIndices.mapAsync(GPUMapMode.READ)]);
 const actual=new Float32Array(read.getMappedRange()),actualIndices=new Uint32Array(readIndices.getMappedRange()),normal=[128/255*2-1,128/255*2-1,1],reference=pnPatch(positions.map(p=>[p[0]+.25,p[1]+.5,p[2]]),[normal,normal,normal]);let maximum=0;
 pattern.points.forEach((point,i)=>{const expected=evaluatePatch(reference,point);for(let j=0;j<3;j++){const error=Math.abs(actual[i*32+8+j]-expected.position[j]);maximum=Math.max(maximum,error);if(error>3e-5)throw Error('Packed source tessellation mismatch');}});
 if(pattern.indices.some((index,i)=>actualIndices[i]!==index))throw Error('Generated tessellation index mismatch');
 read.unmap();readIndices.unmap();
 // Isolated geometry throughput, excluding rasterization and stock skinning.
 // Hardware timestamps exclude queue/readback scheduling latency.
 const benchmark=[];
 if(device.features.has('timestamp-query'))for(const patches of [1000,10000]) {
  const sample=tessellationPattern(8),vertexBytes=patches*sample.points.length*128,indexBytes=patches*sample.indices.length*4;
  const input=new Uint16Array(2+patches*3);input[0]=9;for(let i=0;i<patches*3;i++)input[i+1]=i%3;
  u.set([patches,1,1,0,sample.points.length,sample.indices.length,1,0],16);
  const resources2=[resources[0],buffer(input,GPUBufferUsage.STORAGE),buffer(new Float32Array(sample.points.flatMap(p=>[...p,0])),GPUBufferUsage.STORAGE),buffer(vertexBytes,GPUBufferUsage.STORAGE),buffer(indexBytes,GPUBufferUsage.STORAGE),buffer(new Uint8Array(paramBytes),GPUBufferUsage.UNIFORM),buffer(new Uint32Array(sample.indices),GPUBufferUsage.STORAGE)];
  const group2=device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:resources2.map((b,binding)=>({binding,resource:{buffer:b}}))});
  const queries=device.createQuerySet({type:'timestamp',count:2}),resolve=buffer(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC),timing=buffer(16,GPUBufferUsage.MAP_READ),times=[];
  for(let run=0;run<7;run++){
   const e=device.createCommandEncoder(),p=e.beginComputePass({timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
   p.setPipeline(pipe);p.setBindGroup(0,device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[]}));p.setBindGroup(1,group2);p.dispatchWorkgroups(patches);p.end();e.resolveQuerySet(queries,0,2,resolve,0);e.copyBufferToBuffer(resolve,0,timing,0,16);device.queue.submit([e.finish()]);await timing.mapAsync(GPUMapMode.READ);const ts=new BigUint64Array(timing.getMappedRange());if(run>1)times.push(Number(ts[1]-ts[0])/1e6);timing.unmap();
  }
  times.sort((a,b)=>a-b);benchmark.push({sourceTriangles:patches,outputTriangles:patches*sample.indices.length/3,outputBytes:vertexBytes+indexBytes,medianGpuMs:times[2],minGpuMs:times[0],maxGpuMs:times[4]});queries.destroy();
 }
 for(const b of buffers)b.destroy();const error=await device.popErrorScope();if(error)throw error;
 return {passed:true,packedSource:true,firstIndex:1,baseVertex:1,vertices:N,triangles:pattern.indices.length/3,maxPositionError:maximum,benchmark};
}

export async function validateTessellationFrontend(device) {
 const {GPUFrontend}=await import('./backend.js'),{EngineFormat:G}=await import('./engine-formats.js'),{TessellationCache}=await import('./tessellation-cache.js');
 device.pushErrorScope('validation');
 const canvas=new OffscreenCanvas(64,64),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
 r.tessellationCache=new TessellationCache(r,{maxBytes:10000,maxEntries:2});
 const color={},fbo={},vb={},ib={},decl={};r.allocateNativeTexture(color,G.TEXTURE_2D,1,G.RGBA8,64,64,1);r.fbo=fbo;r.info(fbo).attachments=new Map([[G.COLOR_ATTACHMENT0,{texture:color,level:0,layer:0}]]);r.state.viewport=[0,0,64,64];r.state.depthTest=false;r.state.cull=false;
 r.registerDeclaration(decl,new Uint32Array([3,3,G.FLOAT,0,0,5,4,G.UNSIGNED_BYTE,1,12]));
 const bytes=new ArrayBuffer(48),view=new DataView(bytes);[[-.8,-.8,0],[.8,-.8,0],[0,.8,0]].forEach((p,i)=>{p.forEach((x,j)=>view.setFloat32(i*16+j*4,x,true));[128,128,255,0].forEach((x,j)=>view.setUint8(i*16+12+j,x));});
 r.uploadNativeBuffer(vb,new Uint8Array(bytes));r.uploadNativeBuffer(ib,new Uint8Array(new Uint16Array([0,1,2]).buffer));
 const meta={key:'tessellation-frontend-test',uniforms:[{name:'m_P',type:'mat4',count:1,columns:4,rows:4,offset:0,stride:64,group:0}],uniformBytes:64,uniformGroups:[{bytes:64}],activeBindings:[0],activeUniforms:[{name:'m_P',size:1,type:G.FLOAT_MAT4}],samplers:[],
  attributes:[{name:'p',location:3,type:G.FLOAT_VEC4,size:1},{name:'n',location:5,type:G.FLOAT_VEC4,size:1}],outputs:[0],tessellation:{method:1,detail:false,shadow:false},varyings:{v2p_bumped_tcdh:0,v2p_bumped_position:1,v2p_bumped_M1:2,v2p_bumped_M2:3,v2p_bumped_M3:4},stages:{vert:`
struct Uniforms { projection:mat4x4<f32>, }
@group(0) @binding(0) var<uniform> uniforms:Uniforms;
struct VertexOutput {
 @builtin(position) clip:vec4<f32>, @location(0) tc:vec2<f32>, @location(1) pos:vec4<f32>,
 @location(2) m1:vec3<f32>, @location(3) m2:vec3<f32>, @location(4) m3:vec3<f32>, }
@vertex fn main(@location(3) position:vec4<f32>, @location(5) normal:vec4<f32>) -> VertexOutput {
 let n=normal.xyz*2.0-1.0;return VertexOutput(uniforms.projection*position,vec2<f32>(0),position,vec3<f32>(1,0,n.x),vec3<f32>(0,1,n.y),vec3<f32>(0,0,n.z)); }
`,frag:'@fragment fn main(@location(1) p:vec4<f32>)->@location(0) vec4<f32>{return vec4<f32>(1,0.25,0.5,1);}'}};
 const program={meta};r.link(program);new Float32Array(meta.uniformData.buffer).set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);meta.uniformVersion++;
 r.submitDraw(decl,vb,ib,16,program,G.TRIANGLES,true,3,0,0);
 r.submitDraw(decl,vb,ib,16,program,G.TRIANGLES,true,3,0,0);
 if(r.tessellationCache.metrics.generated!==1||r.tessellationCache.metrics.reused!==1)throw Error('Tessellation cache did not reuse identical native draw');
 // A changed pose/projection in the same command buffer must not overwrite
 // the preceding draw's parameters, and must not force a queue submission.
 const previousEncoder=r.encoder;new Float32Array(meta.uniformData.buffer)[12]=0.01;meta.uniformVersion++;
 r.submitDraw(decl,vb,ib,16,program,G.TRIANGLES,true,3,0,0);
 if(r.encoder!==previousEncoder||r.tessellationCache.metrics.generated!==2)throw Error('Changed tessellation uniforms forced a submission or reused stale output');
 // Resource replacement and eviction must preserve the preceding render work.
 const vb2={};r.uploadNativeBuffer(vb2,new Uint8Array(bytes));r.submitDraw(decl,vb2,ib,16,program,G.TRIANGLES,true,3,0,0);
 if(r.tessellationCache.metrics.evictions!==1)throw Error('Tessellation cache did not enforce its budget');
 const read=device.createBuffer({size:256*64,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});r.endPass();r.enc().copyTextureToBuffer({texture:r.info(color).gpu},{buffer:read,bytesPerRow:256},[64,64]);r.flush();await read.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(read.getMappedRange());let colored=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===255&&pixels[i+3]===255)colored++;
 if(colored<500)throw Error('Tessellated native frontend did not draw the expected surface');const metrics={...r.tessellationCache.metrics};read.unmap();read.destroy();r.tessellationCache.destroy();
 const error=await device.popErrorScope();if(error)throw error;return {passed:true,coloredPixels:colored,metrics};
}

// Optional real captured shader fixtures, compiled by the stock shader compiler.
export async function validateTessellationStock(device) {
 const {createTessellationShaders}=await import('./tessellation-shader.js');
 const {GPUFrontend}=await import('./backend.js'),{TessellationCache}=await import('./tessellation-cache.js');
 const canvas=new OffscreenCanvas(4,4),renderer=new GPUFrontend(canvas,device,canvas.getContext('webgpu')),cache=new TessellationCache(renderer);
 const files=await (await fetch('/stock/index.json')).json(),results=[];
 for(const file of files){
  const meta=await (await fetch('/stock/'+file)).json();
  const token={};const attrs=new Map(meta.attributes.map((a,i)=>[a.location,{buffer:token,type:5126,size:4,stride:meta.attributes.length*16,offset:i*16}]));
  const shaders=createTessellationShaders(meta,{attrs},'uint16');
  device.pushErrorScope('validation');
  const module=device.createShaderModule({code:shaders.compute,label:file});
  const messages=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
  if(messages.length)throw Error(file+': '+messages.map(m=>m.message).join('\n'));
  await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  renderer.link({meta});cache.prepare(meta,{attrs},'uint16');
  const error=await device.popErrorScope();if(error)throw Error(file+': '+error.message);
  const materialReadback=/^static-[23]\.json$/.test(file)?await validateStockDisplacement(device,await (await fetch('/stock/'+file)).json()):undefined;
  results.push({file,method:meta.tessellation.method,detail:meta.tessellation.detail,materialReadback});
 }
 return results;
}

// Execute original material shaders with real displacement texture bindings.
async function validateStockDisplacement(device,meta) {
 const {GPUFrontend}=await import('./backend.js'),{EngineFormat:G}=await import('./engine-formats.js');
 device.pushErrorScope('validation');
 const canvas=new OffscreenCanvas(8,8),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
 const colors=[{},{}],fbo={},height={},vb={},ib={},decl={};
 for(const t of colors)r.allocateNativeTexture(t,G.TEXTURE_2D,1,G.RGBA16F,8,8,1);
 r.fbo=fbo;r.info(fbo).attachments=new Map(colors.map((t,i)=>[G.COLOR_ATTACHMENT0+i,{texture:t,level:0,layer:0}]));r.state.viewport=[0,0,8,8];r.state.depthTest=false;r.state.cull=false;
 r.allocateNativeTexture(height,G.TEXTURE_2D,1,G.RGBA8,1,1,1);device.queue.writeTexture({texture:r.info(height).gpu},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);r.textures[0].set(G.TEXTURE_2D,height);
 const stride=meta.attributes.length*16,vertices=new Float32Array(stride*3/4),positions=[[-.8,-.8,0],[.8,-.8,0],[0,.8,0]];
 for(let i=0;i<3;i++)for(let a=0;a<meta.attributes.length;a++){
  const name=meta.attributes[a].name,value=name==='v_static_P'?[...positions[i],1]:name==='v_static_Nh'?[.75,.5,.5,1]:name==='v_static_T'?[.5,.5,.75,0]:name==='v_static_B'?[.5,.75,.5,0]:[0,0,0,0];vertices.set(value,(i*stride+a*16)/4);
 }
 r.registerDeclaration(decl,new Uint32Array(meta.attributes.flatMap((a,i)=>[a.location,4,G.FLOAT,0,i*16])));
 r.uploadNativeBuffer(vb,new Uint8Array(vertices.buffer));r.uploadNativeBuffer(ib,new Uint8Array(new Uint16Array([0,1,2]).buffer));
 const program={meta};r.link(program);
 for(const uniform of meta.uniforms){const block=meta.uniformBlocks[uniform.group||0],view=new Float32Array(block.uniformData.buffer,block.uniformData.byteOffset+uniform.offset,uniform.stride/4);
  if(uniform.name==='m_WV')view.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0]);
  else if(uniform.name==='m_P')view.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  else if(uniform.name==='dt_params'||uniform.name==='L_material')view.fill(1);
  block.uniformVersion=(block.uniformVersion||0)+1;
 }
 r.tessellationFactor=8;r.submitDraw(decl,vb,ib,stride,program,G.TRIANGLES,true,3,0,0);
 const entry=[...r.tessellationCache.entries.values()][0],pattern=tessellationPattern(8),size=pattern.points.length*128;
 const read=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});r.endPass();r.enc().copyBufferToBuffer(entry.vertices,0,read,0,size);r.flush();await read.mapAsync(GPUMapMode.READ);
 const actual=new Float32Array(read.getMappedRange()),patch=pnPatch(positions,[[0,0,1],[0,0,1],[0,0,1]]);let maximum=0,displaced=0;
 pattern.points.forEach((bary,i)=>{const expected=evaluatePatch(patch,bary,{method:meta.tessellation.method,detail:true,detailBump:true,height:1,detailHeight:1});for(let j=0;j<3;j++){const error=Math.abs(actual[i*32+8+j]-expected.position[j]);maximum=Math.max(maximum,error);if(error>3e-5)throw Error('Stock displacement readback mismatch '+error);}if(actual[i*32+10]>.01)displaced++;});
 read.unmap();
 // Same texture/view handle, different height contents must invalidate geometry.
 r.uploadNativeTexture(height,G.TEXTURE_2D,0,1,1,1,G.RGBA,G.UNSIGNED_BYTE,false,new Uint8Array([0,0,0,0]));
 r.submitDraw(decl,vb,ib,stride,program,G.TRIANGLES,true,3,0,0);r.endPass();r.enc().copyBufferToBuffer(entry.vertices,0,read,0,size);r.flush();await read.mapAsync(GPUMapMode.READ);
 const changed=new Float32Array(read.getMappedRange());let changedVertices=0;for(let i=0;i<pattern.points.length;i++)if(changed[i*32+10]<-0.001)changedVertices++;
 if(changedVertices!==displaced||r.tessellationCache.metrics.generated!==2)throw Error('Displacement texture update reused stale geometry');
 read.unmap();read.destroy();r.tessellationCache.destroy();const error=await device.popErrorScope();if(error)throw Error(error.message);if(!displaced)throw Error('No stock texture displacement');return {method:meta.tessellation.method,vertices:pattern.points.length,displaced,textureUpdateVerified:true,maxPositionError:maximum};
}
