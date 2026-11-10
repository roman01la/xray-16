import { fluidKernelSource, fluidKernelBindings } from './fluid-kernels.js';
import { FluidRenderer, fluidRaymarchSource } from './fluid-renderer.js';
import { FluidSimulation } from './fluid-simulation.js';
export async function validateFluid(device) {
  const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const module=device.createShaderModule({code:fluidKernelSource});
  const info=await module.getCompilationInfo();
  if(info.messages.some(m=>m.type==='error'))throw Error(info.messages.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
  for(const entryPoint of Object.keys(fluidKernelBindings))await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
  for(const multisampled of [false,true]) {
    const ray=device.createShaderModule({code:fluidRaymarchSource(multisampled)});
    await device.createRenderPipelineAsync({layout:'auto',vertex:{module:ray,entryPoint:'vs'},fragment:{module:ray,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}});
  }
  const volume=new FluidSimulation(device,{size:[12,12,12],settings:{type:'Fog',decay:.99,confinement:.06,gravity:0},emitters:[{position:[6,6,6],radius:.4,density:.5,applyDensity:true,applyImpulse:false}]});
  for(let frameId=0;frameId<4;frameId++){
    const encoder=device.createCommandEncoder();volume.update(encoder,{frameId,timeSeconds:frameId/60,timestep:2});device.queue.submit([encoder.finish()]);volume.submitted();
  }
  await device.queue.onSubmittedWorkDone();
  const read=device.createBuffer({size:256*12*12,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:volume.density.texture},{buffer:read,bytesPerRow:256,rowsPerImage:12},[12,12,12]);device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);const bits=new Uint16Array(read.getMappedRange());
  const half=h=>{const e=(h>>10)&31,m=h&1023;return (h&32768?-1:1)*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
  let maximum=0,total=0,nonfinite=0;for(let z=0;z<12;z++)for(let y=0;y<12;y++)for(let x=0;x<12;x++){const d=half(bits[(z*12+y)*128+x*4]);maximum=Math.max(maximum,d);total+=d;if(!Number.isFinite(d))nonfinite++;}
  read.unmap();read.destroy();volume.destroy();
  if(errors.length||nonfinite||maximum<=0||maximum>2||total<=0)throw Error(JSON.stringify({errors,nonfinite,maximum,total}));
  const boxMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,-.5,-.5,-.5,1],obstacleChecks=[];
  for(const fixed of [false,true]){
    const sim=new FluidSimulation(device,{size:[12,12,12],settings:{type:'Fog'},obstacles:fixed?[{gridToObstacle:boxMatrix}]:[]});
    const enc=device.createCommandEncoder();sim.update(enc,{frameId:1,timestep:2,obstacles:[{gridToObstacle:boxMatrix,translationVelocityWorld:[.1,0,0]}]});
    const b=device.createBuffer({size:256*12*12,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyTextureToBuffer({texture:sim.dynamicObstacles.texture},{buffer:b,bytesPerRow:256,rowsPerImage:12},[12,12,12]);device.queue.submit([enc.finish()]);sim.submitted();
    await b.mapAsync(GPUMapMode.READ);const values=new Uint16Array(b.getMappedRange());
    const boundary=(6*12+6)*128+4,center=(6*12+6)*128+24;
    const result={fixed,velocity:half(values[boundary]),boundary:half(values[boundary+3]),interior:half(values[center+3])};obstacleChecks.push(result);
    if(Math.abs(result.velocity-(fixed?0:1.2))>.002||result.boundary!==1||result.interior!==.5)throw Error(JSON.stringify(result));
    b.unmap();b.destroy();sim.destroy();
  }
  const dimensions=32, color=device.createTexture({size:[dimensions,dimensions],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const position=device.createTexture({size:[dimensions,dimensions],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  const target={},depth={},objects=new Map([[target,{gpu:color,format:'rgba8unorm',samples:1}],[depth,{gpu:position,samples:1}]]);
  const r={device,retired:[],handles:{textures:[null,depth]},info:t=>objects.get(t),view:t=>objects.get(t).gpu.createView(),
    attachments:()=>({colors:[{texture:target,level:0,layer:0}]}),endPass(){},enc(){return this.encoder??=device.createCommandEncoder();},
    flush(){if(this.encoder){device.queue.submit([this.encoder.finish()]);this.encoder=null;this.retired.splice(0).forEach(b=>b.destroy());}}};
  const renderer=new FluidRenderer(r),identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const id=renderer.create({size:[12,12,12],worldToGrid:identity,gridToWorld:identity,settings:{type:'Fog',decay:.99},emitters:[{position:[6,6,6],radius:.4,density:.5,applyDensity:true}]});
  const totals=[];
  for(const [frameId,sceneZ] of [10,1].entries()){
    const pixels=new Float32Array(dimensions*dimensions*4);for(let i=0;i<pixels.length;i+=4)pixels[i+2]=sceneZ;
    device.queue.writeTexture({texture:position},pixels,{bytesPerRow:dimensions*16},[dimensions,dimensions]);
    r.enc().beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]}).end();
    renderer.render(id,{frameId,timeSeconds:0,timestep:2,eyeWorld:[.5,.5,-2],inverseView:identity,projection:identity,lightColor:[1,1,1],depthTexture:1});
    const readColor=device.createBuffer({size:256*dimensions,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    r.enc().copyTextureToBuffer({texture:color},{buffer:readColor,bytesPerRow:256},[dimensions,dimensions]);r.flush();
    await readColor.mapAsync(GPUMapMode.READ);const rgba=new Uint8Array(readColor.getMappedRange());let sum=0;
    for(let y=0;y<dimensions;y++)for(let x=0;x<dimensions;x++)sum+=rgba[y*256+x*4];totals.push(sum);readColor.unmap();readColor.destroy();
  }
  renderer.destroy(id);color.destroy();position.destroy();renderer.fallback.destroy();
  if(totals[0]<=0||totals[1]!==0||errors.length)throw Error(JSON.stringify({raymarch:totals,errors}));
  return {obstacleChecks,raymarch:totals,pipelines:Object.keys(fluidKernelBindings).length,steps:4,maximum,total,nonfinite,errors};
}
