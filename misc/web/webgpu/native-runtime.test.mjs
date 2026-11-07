import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHandles, allocateHandle, loadNativeProgram, nativeUniformLocation, nativeSamplerParameter, deleteNativeObject} from './native-runtime.js';
import {clearNativeRects} from './native-clear.js';
import {GPUFrontend} from './backend.js';
import {EngineFormat} from './engine-formats.js';
import {shaderKey} from './shader-key.js';

test('native handle ownership and packaged shaders work without Emscripten EngineFormat',()=>{
  const handles=createNativeHandles(), linked=[];
  const vertex=allocateHandle(handles,'shaders',{source:'vertex'});
  const fragment=allocateHandle(handles,'shaders',{source:'fragment'});
  const id=loadNativeProgram({link(p){linked.push(p);}},handles,vertex,fragment,request=>{
    assert.deepEqual(request,{sources:{frag:'fragment',vert:'vertex'},attributes:[]});
    return {activeUniforms:[]};
  });
  assert.equal(handles.programs[id],linked[0]);
  assert.ok(id>fragment);
  assert.equal(handles.shaders[vertex].source,'vertex');
});
test('native uniform reflection caches locations and validates array bounds',()=>{
  const p={meta:{activeUniforms:[{name:'bones[0]',size:3},{name:'color',size:1}]},uniformNames:new Map(),uniformLocsById:[]};
  const a=nativeUniformLocation(p,'bones[2]');
  assert.equal(nativeUniformLocation(p,'bones[2]'),a);
  assert.equal(p.uniformLocsById[a].name,'bones[2]');
  assert.equal(nativeUniformLocation(p,'bones[3]'),-1);
  assert.equal(nativeUniformLocation(p,'missing'),-1);
  assert.equal(nativeUniformLocation(p,'color'),3);
  assert.equal(nativeUniformLocation(p,'bones'),0);
  assert.equal(nativeUniformLocation(p,'bones[0]'),0);
  assert.equal(nativeUniformLocation(p,'bones[1]'),1);
});
test('sampler mutation/deletion consumes queued bindings and invalidates cached resources',()=>{
  const r=Object.create(GPUFrontend.prototype),handles=createNativeHandles(),events=[];
  const id=allocateHandle(handles,'samplers'),token=handles.samplers[id];
  Object.assign(r,{objects:new WeakMap(),samplers:[token],resourceGeneration:0,
    flushNativeBindings(){events.push('bindings');},flushNativeStates(){events.push('states');},flushNativeUniforms(){events.push('uniforms');}});
  nativeSamplerParameter(r,token,EngineFormat.TEXTURE_MIN_FILTER,EngineFormat.LINEAR);
  assert.equal(r.info(token).params.get(EngineFormat.TEXTURE_MIN_FILTER),EngineFormat.LINEAR);
  deleteNativeObject(r,handles,'samplers',id);
  assert.equal(handles.samplers[id],null);assert.equal(r.samplers[0],null);
  assert.deepEqual(events,['bindings','states','bindings','uniforms']);
  assert.equal(r.resourceGeneration,2);
});
test('native renderer exposes no compatibility dispatch',()=>{
  assert.equal(GPUFrontend.prototype.call, undefined);
  assert.equal(GPUFrontend.prototype.draw, undefined);
});
test('native rectangular clears clip bounds and load untouched attachment pixels',()=>{
  globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2};
  for(const depthOnly of [false,true]) {
    const calls=[],rectangles=[],descriptors=[],token={},fbo={};
    const info={gpu:{createView(){return 'view';}},format:depthOnly?'depth24plus-stencil8':'rgba8unorm',width:100,height:80};
    const r=Object.create(GPUFrontend.prototype);
    const pass={setPipeline(){},setBindGroup(){},setScissorRect(...x){rectangles.push(x);},draw(n){calls.push(n);},end(){calls.push('end');}};
    Object.assign(r,{objects:new WeakMap([[token,info],[fbo,{}]]),fbo,retired:[],state:{},gl:{stateQueries:new Map()},
      endPass(){calls.push('end-prior');},enc(){return {beginRenderPass(d){descriptors.push(d);return pass;}};},
      device:{createShaderModule(x){assert.match(x.code,/fn fs/);return {};},createRenderPipeline(d){return {getBindGroupLayout(){return {};}};},
        createBuffer(){return {};},createBindGroup(){return {};},queue:{writeBuffer(){}}}});
    clearNativeRects(r,token,depthOnly,[1,0,0,1],0.5,[[-10,10,40,60],[120,0,140,20]]);
    assert.deepEqual(rectangles,[[0,20,40,50]]);
    assert.deepEqual(calls,['end-prior',3,'end']);
    const attachment=depthOnly?descriptors[0].depthStencilAttachment:descriptors[0].colorAttachments[0];
    assert.equal(depthOnly?attachment.depthLoadOp:attachment.loadOp,'load');
    if(depthOnly) assert.equal(attachment.stencilLoadOp,'load');
    assert.equal(r.retired.length,1);assert.equal(r.state.scissor,false);
  }
});

test('native presentation reports diagnostics without compatibility-mode globals',()=>{
  const r=Object.create(GPUFrontend.prototype),texture={},framebuffer={},calls=[];
  const pass={setPipeline(){},setBindGroup(){},draw(n){calls.push(n);},end(){}};
  Object.assign(r,{gl:EngineFormat,readFbo:framebuffer,fbo:null,objects:new WeakMap([[framebuffer,{attachments:new Map([[EngineFormat.COLOR_ATTACHMENT0,{texture,level:0,layer:0}]])}]]),
    presentPipeline:{getBindGroupLayout(){return {};}},endPass(){},view(){return {};},enc(){return {beginRenderPass(){return pass;}};},flush(){calls.push('submit');},
    context:{getCurrentTexture(){return {createView(){return {};}};}},device:{createBindGroup(){return {};}},occlusion:{resolve(){return null;}}});
  const previous=globalThis.performance;
  globalThis.performance={now:()=>2000};
  try {r.blit([0,0,4,4,0,0,4,4,EngineFormat.COLOR_BUFFER_BIT,EngineFormat.NEAREST]);}
  finally {globalThis.performance=previous;}
  assert.deepEqual(calls,[3,'submit']);assert.equal(r.lastPresented.texture,texture);
});

test('native state records need no EngineFormat context, query mirror or active binding cursor',()=>{
  const r=Object.create(GPUFrontend.prototype);
  r.state={stencilFront:{},stencilBack:{}};
  r.consumeStateBatch(new Uint32Array([7,1,0,0,0,0,8,5,6,2,1,0,10,7,0,0,0,0]),0,18);
  assert.equal(r.state.blend,true);
  assert.equal(r.state.blendSrc,'src-alpha');
  assert.equal(r.state.blendDst,'one-minus-src-alpha');
  assert.equal(r.state.colorMask,7);
  assert.equal(r.gl,undefined);
  assert.equal(r.enabledCaps,undefined);
  assert.equal(r.activeUnit,undefined);
});
test('native framebuffer validation flushes records and rejects missing, released and mismatched attachments',()=>{
  const r=Object.create(GPUFrontend.prototype),fbo={},color={},depth={};let flushed=0;
  Object.assign(r,{fbo,objects:new WeakMap([[fbo,{}],[color,{gpu:{},width:64,height:32,mips:1}],[depth,{gpu:{},width:64,height:32,mips:1}]]),
    flushNativeStates(){flushed++;},attachments(){return {colors:[{texture:color,level:0}],depth:{texture:depth,level:0}};}});
  assert.equal(r.validateNativeFramebuffer(),true);assert.equal(flushed,1);
  r.info(depth).height=16;assert.throws(()=>r.validateNativeFramebuffer(),/sizes differ/);
  r.info(depth).height=32;depth.deleted=true;assert.throws(()=>r.validateNativeFramebuffer(),/invalid attachment/);
  r.fbo=null;assert.throws(()=>r.validateNativeFramebuffer(),/not bound/);
});
