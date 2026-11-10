import { FluidSimulation, prepareFluidSimulation } from './fluid-simulation.js';

export function fluidRaymarchSource(multisampled = false) {
  return `
struct View { worldToGrid:mat4x4f, inverseView:mat4x4f, eye:vec4f, projection:vec4f, size:vec4f, light:vec4f };
@group(0) @binding(0) var<uniform> u:View;
@group(0) @binding(1) var linearSampler:sampler;
@group(0) @binding(2) var density:texture_3d<f32>;
@group(0) @binding(3) var scene:${multisampled ? 'texture_multisampled_2d' : 'texture_2d'}<f32>;
@group(0) @binding(4) var fire:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) pixel:vec4f)->@location(0) vec4f {
 let dimensions=vec2f(textureDimensions(scene));let ndc=vec2f(pixel.x/dimensions.x*2-1,1-pixel.y/dimensions.y*2);
 let viewDirection=vec3f(ndc/u.projection.xy,1);
 let worldDirection=(u.inverseView*vec4f(viewDirection,0)).xyz;
 let origin=(u.worldToGrid*vec4f(u.eye.xyz,1)).xyz;
 let direction=(u.worldToGrid*vec4f(worldDirection,0)).xyz;
 let inv=1.0/select(vec3f(1e-20),direction,abs(direction)>vec3f(1e-20));
 let first=(vec3f(0)-origin)*inv;let last=(vec3f(1)-origin)*inv;
 let near=min(first,last);let far=max(first,last);
 let begin=max(max(max(near.x,near.y),near.z),0.0);
 var end=min(min(far.x,far.y),far.z);
 let sceneZ=textureLoad(scene,vec2i(pixel.xy),0).z;if(sceneZ>.0001){end=min(end,sceneZ);}
 if(end<=begin){discard;}
 let step=.5/max(length(direction*u.size.xyz),1e-6);
 let jitter=fract(sin(dot(floor(pixel.xy),vec2f(12.9898,78.233)))*43758.5453);
 var color=vec4f(0);let samples=(end-begin)/step;let count=u32(ceil(samples));
 for(var i=0u;i<count;i++){
  let offset=(f32(i)+jitter)*step;
  let t=select(begin+offset,end-offset,u.size.w>0.0);
  let weight=min(1.0,samples-f32(i));
  let d=abs(textureSampleLevel(density,linearSampler,origin+direction*t,0).x);
  if(u.size.w>0.0){
   let s=clamp(d,0.0,3.0);
   if(s>1.4){let lookup=1-pow((s-1.4)/1.6,5);let c=textureSampleLevel(fire,linearSampler,vec2f(lookup,0),0);color+=weight*vec4f(c.rgb,(s-1.4)*(s-1.4)*.95);}
   else{let alpha=weight*s*.05;color=vec4f(vec3f(.9,.35,.055)*.1*alpha*weight*s+color.rgb*(1-alpha),alpha+color.a*(1-alpha));}
  }else{let alpha=weight*d*.1*(1-color.a);color+=vec4f(vec3f(alpha*weight*d),alpha);if(color.a>.99){break;}}
 }
 return color*select(vec4f(u.light.xyz,1),vec4f(1),u.size.w>0.0);
}`;
}

export class FluidRenderer {
  constructor(renderer) {
    this.renderer=renderer;this.device=renderer.device;
    // Native registration happens during level loading; compile solver pipelines
    // here so first visibility does not synchronously compile eleven kernels.
    prepareFluidSimulation(this.device);this.volumes=new Map();this.nextId=1;this.pipelines=new Map();
    this.sampler=this.device.createSampler({minFilter:'linear',magFilter:'linear'});
    this.fallback=this.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.device.queue.writeTexture({texture:this.fallback},new Uint8Array([255,255,255,255]),{},[1,1]);
    this.diagnostics={volumes:0,initialized:0,updates:0,draws:0};
  }
  create(config) {const id=this.nextId++;this.volumes.set(id,{config});this.diagnostics.volumes=this.volumes.size;return id;}
  destroy(id) {
    const volume=this.volumes.get(id);if(!volume)return;
    // Drain pending draws before destroying textures referenced by this encoder.
    this.renderer.flushNativeDraws?.();this.renderer.flush();volume.simulation?.destroy();
    this.volumes.delete(id);this.diagnostics.volumes=this.volumes.size;
  }
  render(id,frame) {
    const volume=this.volumes.get(id);if(!volume)throw Error('Unknown native fluid volume');
    const r=this.renderer;
    r.flushNativeDraws?.();r.flushNativeBindings?.();r.flushNativeStates?.();r.flushNativeUniforms?.();r.endPass();
    if(!volume.simulation){volume.simulation=new FluidSimulation(this.device,volume.config);this.diagnostics.initialized++;}
    const simulation=volume.simulation;
    if(simulation.update(r.enc(),frame))this.diagnostics.updates++;
    r.retired.push(...simulation.pendingBuffers.splice(0));
    const target=r.attachments().colors.find(Boolean);
    if(!target)throw Error('Fluid compositing requires a color attachment');
    const targetInfo=r.info(target.texture);
    const depthToken=typeof frame.depthTexture==='number'?r.handles.textures[frame.depthTexture]:frame.depthTexture;
    const depth=r.info(depthToken);if(!depth?.gpu)throw Error('Fluid rendering requires the native position texture');
    const fireHandle=frame.fireTexture ?? volume.config.fireTexture;
    const fireToken=typeof fireHandle==='number'?r.handles.textures[fireHandle]:fireHandle;
    const fire=r.info(fireToken)?.gpu||this.fallback;
    const key=`${targetInfo.format}:${targetInfo.samples||1}:${depth.samples||1}`;
    let pipeline=this.pipelines.get(key);
    if(!pipeline){
      const module=this.device.createShaderModule({label:'X-Ray fluid raymarch',code:fluidRaymarchSource((depth.samples||1)>1)});
      pipeline=this.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs'},
        fragment:{module,entryPoint:'fs',targets:[{format:targetInfo.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'}}}]},
        primitive:{topology:'triangle-list'},multisample:{count:targetInfo.samples||1}});
      this.pipelines.set(key,pipeline);
    }
    const data=new Float32Array(48);data.set(volume.config.worldToGrid,0);data.set(frame.inverseView,16);
    data.set(frame.eyeWorld,32);data.set([frame.projection[0],frame.projection[5],0,0],36);
    data.set([...simulation.size,+(volume.config.settings?.type==='Fire')],40);data.set(frame.lightColor||[1,1,1],44);
    const uniform=this.device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.UNIFORM,mappedAtCreation:true});new Float32Array(uniform.getMappedRange()).set(data);uniform.unmap();r.retired.push(uniform);
    const bindGroup=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:uniform}},{binding:1,resource:this.sampler},{binding:2,resource:simulation.density.view},
      {binding:3,resource:depth.gpu.createView()},{binding:4,resource:fire.createView()}]});
    const pass=r.enc().beginRenderPass({label:'Fluid volume composite',colorAttachments:[{view:r.view(target.texture,target.level,target.layer),loadOp:'load',storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();this.diagnostics.draws++;
  }
}
