import {skipZeroTerrainLayers} from './terrain-zero-layers.js';
export async function verifyFullTerrain(){
 const meta=await(await fetch('./terrain-full.json')).json(),original=meta.stages.frag;
 if(!skipZeroTerrainLayers(meta))throw Error('Unsupported fixture');
 const adapter=await navigator.gpu.requestAdapter(),d=await adapter.requestDevice();d.pushErrorScope('validation');
 const vs=d.createShaderModule({code:`struct O {@builtin(position) p:vec4<f32>,@location(0) a:vec4<f32>,@location(1) b:vec4<f32>,@location(2) c:vec4<f32>,@location(3) uv:vec4<f32>,@location(4) mask:vec4<f32>,@location(5) pos:vec4<f32>}
 @vertex fn main(@builtin(vertex_index) i:u32)->O {let p=array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));let uv=(p[i]+1)*0.5;return O(vec4(p[i],0,1),vec4(1,0,0,0),vec4(0,1,0,0),vec4(0,0,1,0),vec4(uv*4,0,0),vec4(uv,0,0),vec4(0,0,1,1));}`});
 const pipes=[original,meta.stages.frag].map(code=>d.createRenderPipeline({layout:'auto',vertex:{module:vs,entryPoint:'main'},fragment:{module:d.createShaderModule({code}),entryPoint:'main',targets:[{format:'rgba32float'},{format:'rgba32float'}]}}));
 const sampler=d.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
 const bindings=[1,17,19,21,23,25,27,29,31,33],textures=bindings.map(()=>d.createTexture({size:[16,16],mipLevelCount:5,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
 const uniform=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(uniform,0,new Float32Array([0,0,0,0.5,1,1,1,1]));
 let compared=0,maxDifference=0;
 for(const mode of ['single','mixed','alternating']){
  for(let t=0;t<textures.length;t++)for(let mip=0;mip<5;mip++){
   const size=16>>mip,bytes=new Uint8Array(size*size*4);
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let color=t===1?(mode==='single'?[255,0,0,0]:mode==='mixed'?[50,80,110,160]:((x+y)%2?[255,0,0,0]:[0,0,255,0])):[70+t*9+mip*4+x,130+y,200-mip*7,220];
    bytes.set(color,(y*size+x)*4);
   }
   d.queue.writeTexture({texture:textures[t],mipLevel:mip},bytes,{bytesPerRow:size*4},[size,size]);
  }
  const results=[];
  for(const pipeline of pipes){
   const targets=[0,1].map(()=>d.createTexture({size:[16,16],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}));
   const read=d.createBuffer({size:8192,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
   const entries=bindings.flatMap((binding,i)=>[{binding,resource:textures[i].createView()},{binding:binding+1,resource:sampler}]);
   const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries}),empty=d.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}),material=d.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:uniform}}]});
   const e=d.createCommandEncoder(),pass=e.beginRenderPass({colorAttachments:targets.map(t=>({view:t.createView(),loadOp:'clear',storeOp:'store'}))});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,empty);pass.setBindGroup(2,material);pass.draw(3);pass.end();targets.forEach((texture,i)=>e.copyTextureToBuffer({texture},{buffer:read,offset:i*4096,bytesPerRow:256},[16,16]));d.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);results.push(new Float32Array(read.getMappedRange().slice(0)));read.unmap();read.destroy();targets.forEach(t=>t.destroy());
  }
  for(let i=0;i<results[0].length;i++){const delta=Math.abs(results[0][i]-results[1][i]);if(!Number.isFinite(delta)||delta>0.0001)throw Error('Full terrain output mismatch '+mode+' '+i+' '+delta);maxDifference=Math.max(maxDifference,delta);compared++;}
 }
 const error=await d.popErrorScope();d.destroy();if(error)throw Error(error.message);return {passed:true,comparedValues:compared,maxDifference};
}
