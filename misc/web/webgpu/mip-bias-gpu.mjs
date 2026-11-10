import {compileProgram} from './compiler-core.mjs';
import {createWasmToolchain} from './wasm-toolchain.mjs';

// Three solid mip levels make the selected LOD visible in a pixel readback.
export async function validateMipBias(device) {
  const toolchain=await createWasmToolchain({nagaBytes:new Uint8Array(await(await fetch('./compiler-wasm/naga.wasm')).arrayBuffer())});
  const p=await compileProgram({attributes:[],sources:{vert:'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexIndex<<1)&2,gl_VertexIndex&2);gl_Position=vec4(p*2.-1.,0,1);}',frag:'#version 300 es\nprecision highp float; uniform vec4 xr_webgpu_mip_bias; uniform sampler2D image; out vec4 color; void main(){color=texture(image,gl_FragCoord.xy/16.);}'}},toolchain);
  device.pushErrorScope('validation');
  const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module:device.createShaderModule({code:p.stages.vert}),entryPoint:'main'},fragment:{module:device.createShaderModule({code:p.stages.frag}),entryPoint:'main',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});
  const image=device.createTexture({size:[32,32],mipLevelCount:3,format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
  for(let mip=0;mip<3;mip++){const size=32>>mip,data=new Uint8Array(size*size*4);for(let i=0;i<data.length;i+=4){data[i+mip]=255;data[i+3]=255;}device.queue.writeTexture({texture:image,mipLevel:mip},data,{bytesPerRow:size*4},[size,size]);}
  const target=device.createTexture({size:[16,16],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const sampler=device.createSampler({minFilter:'nearest',magFilter:'nearest',mipmapFilter:'nearest'}),pixels=[];
  for(const bias of [-1,0,1]){
    const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,new Float32Array([bias,0,0,0]));
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:image.createView()},{binding:2,resource:sampler}]});
    const read=device.createBuffer({size:256*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store'}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256},[16,16]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);pixels.push([...new Uint8Array(read.getMappedRange()).slice(0,4)]);read.unmap();read.destroy();uniform.destroy();
  }
  const error=await device.popErrorScope();if(error)throw Error(error.message);
  image.destroy();target.destroy();
  if(JSON.stringify(pixels)!==JSON.stringify([[255,0,0,255],[0,255,0,255],[0,0,255,255]]))throw Error('LOD bias selected wrong mip '+JSON.stringify(pixels));
  return {biases:[-1,0,1],pixels};
}
