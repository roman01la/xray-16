import {EngineFormat} from './engine-formats.js';
const align = n => Math.ceil(n/4)*4;
export function beginNativeUIList(r, vertices, indices, indexSize, display) {
  endNativeUIList(r);
  r.flushNativeStates?.();r.flushNativeBindings?.();r.flushNativeUniforms?.();r.endPass();
  r.nativeUIBuffers ??= [{},{},{}];
  let slot=0;
  const upload=(bytes,usage)=>{
    const info=r.nativeUIBuffers[slot++];
    if(!info.cpu || info.cpu.length<align(bytes.length))info.cpu=new Uint8Array(align(bytes.length));
    info.cpu.set(bytes);info.cpu.fill(0,bytes.length,align(bytes.length));
    r.streamSnapshot(info,info.cpu.subarray(0,align(bytes.length)));
    return info.gpu;
  };
  const [x,y,w,h,sx,sy]=display;
  const matrix=new Float32Array([2/w,2/h,-1-2*x/w,-1-2*y/h]);
  r.nativeUI={vertices:upload(vertices,GPUBufferUsage.VERTEX),indices:upload(indices,GPUBufferUsage.INDEX),
    uniform:upload(new Uint8Array(matrix.buffer),GPUBufferUsage.UNIFORM),indexFormat:indexSize===2?'uint16':'uint32',width:Math.round(w*sx),height:Math.round(h*sy)};
}
export function drawNativeUI(r, texture, count, first, base, clip) {
  const ui=r.nativeUI;
  if(!ui || !count)return;
  const source=r.info(r.fbo)?.attachments?.get(EngineFormat.COLOR_ATTACHMENT0) || r.lastPresented;
  const target=r.info(source?.texture),image=r.info(texture);
  if(!target?.gpu || !image?.gpu)throw Error('Missing native ImGui target or texture');
  const pipelines=r.nativeUIPipelines??=new Map();
  let pipeline=pipelines.get(target.format);
  if(!pipeline){
    const module=r.device.createShaderModule({code:`
@group(0) @binding(0) var<uniform> transform:vec4f;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
struct Output { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) color:vec4f };
@vertex fn vs(@location(0) position:vec2f,@location(1) uv:vec2f,@location(2) color:vec4f)->Output {
 var output:Output; output.position=vec4f(position*transform.xy+transform.zw,0,1);output.uv=uv;output.color=color;return output;
}
@fragment fn fs(input:Output)->@location(0) vec4f {return input.color*textureSample(image,filtering,input.uv);}
`});
    pipeline=r.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:20,attributes:[
      {shaderLocation:0,format:'float32x2',offset:0},{shaderLocation:1,format:'float32x2',offset:8},{shaderLocation:2,format:'unorm8x4',offset:16}]}]},
      fragment:{module,entryPoint:'fs',targets:[{format:target.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},primitive:{topology:'triangle-list'}});
    pipelines.set(target.format,pipeline);
  }
  if(!ui.pass)ui.pass=r.enc().beginRenderPass({colorAttachments:[{view:r.view(source.texture,source.level || 0,source.layer || 0),loadOp:'load',storeOp:'store'}]});
  const pass=ui.pass;
  pass.setPipeline(pipeline);pass.setViewport(0,0,ui.width,ui.height,0,1);
  pass.setVertexBuffer(0,ui.vertices);pass.setIndexBuffer(ui.indices,ui.indexFormat);
  r.nativeUISampler??=r.device.createSampler({minFilter:'linear',magFilter:'linear'});
  const view=r.view(texture);
  const pipelinesCache=r.nativeUIGroupCache??=new WeakMap();
  let uniforms=pipelinesCache.get(pipeline);if(!uniforms)pipelinesCache.set(pipeline,uniforms=new WeakMap());
  let images=uniforms.get(ui.uniform);if(!images)uniforms.set(ui.uniform,images=new WeakMap());
  let group=images.get(view);
  if(!group){group=r.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:ui.uniform,offset:0,size:16}},{binding:1,resource:view},{binding:2,resource:r.nativeUISampler}]});images.set(view,group);}
  pass.setBindGroup(0,group);
  pass.setScissorRect(clip[0],ui.height-clip[1]-clip[3],clip[2],clip[3]);
  pass.drawIndexed(count,1,first,base,0);
}
export function endNativeUIList(r){
  if(r.nativeUI?.pass){r.nativeUI.pass.end();r.nativeUI.pass=null;}
}
