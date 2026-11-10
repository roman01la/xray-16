
// WebGPU loadOp clears are whole-attachment operations. Partial clears use a
// dedicated triangle pipeline, preserving pixels outside each clipped rectangle.
export function clearNativeRects(renderer, token, depthOnly, color, depth, rectangles) {
  renderer.flushNativeStates?.();
  const info = renderer.info(token);
  if (!info?.gpu) throw Error('Missing native rectangle-clear texture');
  renderer.endPass();
  const pipelines = renderer.rectClearPipelines ??= new Map();
  const key = `${depthOnly}:${info.format}:${info.samples||1}`;
  let pipeline = pipelines.get(key);
  if (!pipeline) {
    const module = renderer.device.createShaderModule({code:`
struct Clear { color: vec4f, depth: f32 };
@group(0) @binding(0) var<uniform> value: Clear;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[index],0,1);
}
${depthOnly ? '@fragment fn fs() -> @builtin(frag_depth) f32 { return value.depth; }' : '@fragment fn fs() -> @location(0) vec4f { return value.color; }'}
`});
    const descriptor = {layout:'auto',multisample:{count:info.samples||1},vertex:{module,entryPoint:'vs'},
      fragment:{module,entryPoint:'fs',targets:depthOnly ? [] : [{format:info.format}]},primitive:{topology:'triangle-list'}};
    if (depthOnly) descriptor.depthStencil = {format:info.format,depthWriteEnabled:true,depthCompare:'always'};
    pipeline = renderer.device.createRenderPipeline(descriptor);
    pipelines.set(key,pipeline);
  }
  const uniform = renderer.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  renderer.device.queue.writeBuffer(uniform,0,new Float32Array([...color,depth,0,0,0]));
  renderer.retired.push(uniform);
  const view = info.gpu.createView();
  const descriptor = {colorAttachments:depthOnly ? [] : [{view,loadOp:'load',storeOp:'store'}]};
  if (depthOnly) {
    descriptor.depthStencilAttachment = {view,depthLoadOp:'load',depthStoreOp:'store'};
    if (info.format.includes('stencil')) Object.assign(descriptor.depthStencilAttachment,{stencilLoadOp:'load',stencilStoreOp:'store'});
    renderer.state.depthWrite = true;
  } else {
    renderer.state.colorMask=15;
  }
  const pass = renderer.enc().beginRenderPass(descriptor);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0,renderer.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]}));
  for (const [left,top,right,bottom] of rectangles) {
    const x=Math.max(0,left), y=Math.max(0,info.height-bottom);
    const width=Math.min(info.width,right)-x, height=Math.min(info.height,info.height-top)-y;
    if (width<=0 || height<=0) continue;
    pass.setScissorRect(x,y,width,height);
    pass.draw(3);
  }
  pass.end();
  renderer.state.scissor=false;
  renderer.pipelineStateKey=null;
}
