import {GPUFrontend} from './backend.js';
import {EngineFormat as G} from './engine-formats.js';

// Pixel readback proves all four samples execute, resolve correctly, and A2C
// changes geometric coverage rather than merely changing the stored alpha.
export async function validateMultisampling(device) {
  const canvas=new OffscreenCanvas(4,4),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
  device.pushErrorScope('validation');
  const color={},resolved={},fbo={},vertices={},decl={};
  r.allocateNativeTexture(color,G.TEXTURE_2D_MULTISAMPLE,1,G.RGBA8,4,4,1,4);
  r.allocateNativeTexture(resolved,G.TEXTURE_2D,1,G.RGBA8,4,4,1,1);
  r.fbo=fbo;r.info(fbo).attachments=new Map([[G.COLOR_ATTACHMENT0,{texture:color,level:0,layer:0}]]);
  r.state.viewport=[0,0,4,4];r.state.depthTest=false;r.state.cull=false;r.state.blend=false;
  r.registerDeclaration(decl,new Uint32Array([0,2,G.FLOAT,0,0]));
  r.uploadNativeBuffer(vertices,new Uint8Array(new Float32Array([-1,-1,3,-1,-1,3]).buffer));
  const make=(name,frag)=>{const p={meta:{key:name,uniforms:[],uniformBytes:16,activeBindings:[],activeUniforms:[],samplers:[],attributes:[{name:'position',location:0,type:G.FLOAT_VEC2,size:1}],outputs:[0],stages:{vert:'@vertex fn main(@location(0) p:vec2f)->@builtin(position) vec4f{return vec4f(p,0,1);}',frag}}};r.link(p);return p;};
  const sample=make('msaa-sample-test','@fragment fn main(@builtin(sample_index) i:u32)->@location(0) vec4f{return vec4f(f32(i)/3.0,0,0,1);}');
  const alpha=make('msaa-alpha-test','@fragment fn main()->@location(0) vec4f{return vec4f(1,0,0,0.5);}');
  const reads=[];
  for(const [p,coverage] of [[sample,false],[alpha,false],[alpha,true]]) {
    r.clearNativeTarget(color,G.COLOR_BUFFER_BIT,0,0,0,0,1,0);
    r.consumeStateBatch(new Uint32Array([18,+coverage,0,0,0,0]),0,6);
    r.submitDraw(decl,vertices,null,8,p,G.TRIANGLES,false,3,0,0,null,1);
    r.copyNativeTexture(color,resolved,4,4);
    const read=device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    r.enc().copyTextureToBuffer({texture:r.info(resolved).gpu},{buffer:read,bytesPerRow:256},[4,4,1]);reads.push(read);
  }
  const load=make('msaa-load-test',`@group(0) @binding(1) var image:texture_multisampled_2d<f32>;
@fragment fn main(@builtin(position) p:vec4f)->@location(0) vec4f {let xy=vec2i(p.xy);return (textureLoad(image,xy,0)+textureLoad(image,xy,1)+textureLoad(image,xy,2)+textureLoad(image,xy,3))/4.0;}`);
  load.meta.samplers=[{name:'image',type:'sampler2DMS'}];load.meta.activeBindings=[1];r.link(load);
  r.setNativeAttachment(fbo,G.COLOR_ATTACHMENT0,resolved);
  r.textures[0].set(G.TEXTURE_2D_MULTISAMPLE,color);r.resourceGeneration++;
  r.consumeStateBatch(new Uint32Array([18,0,0,0,0,0]),0,6);
  r.submitDraw(decl,vertices,null,8,load,G.TRIANGLES,false,3,0,0,null,1);r.endPass();
  const loaded=device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  r.enc().copyTextureToBuffer({texture:r.info(resolved).gpu},{buffer:loaded,bytesPerRow:256},[4,4,1]);reads.push(loaded);
  const {compileProgram}=await import('./compiler-core.mjs');
  const {createWasmToolchain}=await import('./wasm-toolchain.mjs');
  const toolchain=await createWasmToolchain({nagaBytes:new Uint8Array(await(await fetch('./compiler-wasm/naga.wasm')).arrayBuffer())});
  const masked={meta:await compileProgram({attributes:[{name:'position',location:0}],sources:{
    vert:'#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0,1);}',
    frag:'#version 300 es\nprecision highp float; out vec4 color; void main(){color=vec4(1,0,0,1);gl_SampleMask[0]=3;}'
  }},toolchain)};
  r.link(masked);r.setNativeAttachment(fbo,G.COLOR_ATTACHMENT0,color);
  r.clearNativeTarget(color,G.COLOR_BUFFER_BIT,0,0,0,0,1,0);
  r.submitDraw(decl,vertices,null,8,masked,G.TRIANGLES,false,3,0,0,null,1);
  r.copyNativeTexture(color,resolved,4,4);
  const maskRead=device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  r.enc().copyTextureToBuffer({texture:r.info(resolved).gpu},{buffer:maskRead,bytesPerRow:256},[4,4,1]);reads.push(maskRead);
  r.flush();const pixels=[];
  for(const read of reads){await read.mapAsync(GPUMapMode.READ);pixels.push([...new Uint8Array(read.getMappedRange()).slice(0,4)]);read.unmap();read.destroy();}
  const error=await device.popErrorScope();if(error)throw Error(error.message);
  if(JSON.stringify(pixels[3])!==JSON.stringify(pixels[2]))throw Error('MSAA textureLoad differs from hardware resolve '+JSON.stringify(pixels));
  if(Math.abs(pixels[0][0]-128)>1||pixels[1][0]!==255||pixels[2][0]<=0||pixels[2][0]>=255)throw Error('Invalid MSAA/A2C readback '+JSON.stringify(pixels));
  if(Math.abs(pixels[4][0]-128)>1||Math.abs(pixels[4][3]-128)>1)throw Error('Compiled sample mask failed '+JSON.stringify(pixels[4]));
  for(const token of [color,resolved])r.info(token).gpu.destroy();
  return {passed:true,samples:4,pixels};
}
