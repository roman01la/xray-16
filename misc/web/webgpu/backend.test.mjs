import test from "node:test";
import assert from "node:assert/strict";
import { transposeMatrices } from "./backend.js";
import { CompatibilityReference as GPUFrontend } from "./compatibility-reference.mjs";

test("row-major world matrix preserves its translation when packed for WGSL", () => {
  assert.deepEqual(
    transposeMatrices([1, 0, 0, 143, 0, 1, 0, 2, 0, 0, 1, -274], 4, 3),
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 143, 2, -274],
  );
});
test("matrix arrays transpose each matrix independently", () => {
  assert.deepEqual(
    transposeMatrices([1, 2, 3, 4, 5, 6, 7, 8], 2, 2),
    [1, 3, 2, 4, 5, 7, 6, 8],
  );
});

function uniformFixture(name, uniform) {
  const renderer = Object.create(GPUFrontend.prototype);
  const program = {}, location = {};
  const meta = { uniformData: new Uint8Array(256), uniformByName: new Map([[uniform.name, uniform]]), values: new Map() };
  renderer.locations = new WeakMap([[location, { program, name }]]);
  renderer.programs = new WeakMap([[program, meta]]);
  return { renderer, location, meta, data: new Float32Array(meta.uniformData.buffer) };
}
test("cached scalar uniform updates preserve array element offsets", () => {
  const f = uniformFixture("colors[2]", {name:"colors", type:"vec4", rows:4, columns:1, count:4, offset:16, stride:16});
  f.renderer.setUniform("uniform4f", [f.location, 1,2,3,4]);
  f.renderer.setUniform("uniform4f", [f.location, 5,6,7,8]);
  assert.deepEqual([...f.data.slice(12,16)], [5,6,7,8]);
  assert.equal(f.data[11],0); assert.equal(f.data[16],0);
});
test("matrix uploads preserve std140 padding and transpose rectangular arrays", () => {
  const f = uniformFixture("bones", {name:"bones",type:"mat4x3", rows:3, columns:4, count:2, offset:0, stride:64});
  f.renderer.setUniform("uniformMatrix4x3fv", [f.location,true,new Float32Array([99,1,0,0,143,0,1,0,2,0,0,1,-274,2,0,0,10,0,2,0,20,0,0,2,30,99]),1,24]);
  assert.deepEqual([...f.data.slice(0,16)], [1,0,0,0,0,1,0,0,0,0,1,0,143,2,-274,0]);
  assert.deepEqual([...f.data.slice(16,32)], [2,0,0,0,0,2,0,0,0,0,2,0,10,20,30,0]);
});

test("cached draws rebind changed vertex buffers and rebuild changed pipeline state", async () => {
  const { createCommandContext } = await import("./command-context.js");
  const { EngineFormat } = await import("./engine-formats.js");
  const renderer = Object.create(GPUFrontend.prototype);
  const program = {}, buffer = {}, texture = {}, fbo = {};
  const gpuBuffer = {}, replacements = [];
  let pipelines = 0;
  const viewports = [], scissors = [], indexedDraws = [], arrayDraws = [];
  const pass = {
    setPipeline() {}, setBindGroup() {}, setIndexBuffer() {},
    drawIndexed(...args) { indexedDraws.push(args); },
    setViewport(...args) { viewports.push(args); },
    setScissorRect(...args) { scissors.push(args); },
    setStencilReference() {}, setBlendConstant() {}, draw(...args) { arrayDraws.push(args); },
    setVertexBuffer(slot, resource, offset) { replacements.push([resource, offset]); },
  };
  const meta = {
    key: "fixture", attributes: [{ location: 0, type: EngineFormat.FLOAT_VEC3, name: "position" }],
    outputs: [0], modules: { vert: {}, frag: {} }, pipelineLayout: {},
    uniformData: new Uint8Array(16), activeBindings: [], samplers: [], bindGroups: new Map(),
  };
  Object.assign(renderer, {
    gl: createCommandContext({width:1920,height:1080}, {limits:{}}),
    objects: new WeakMap([[buffer,{gpu:gpuBuffer}],[texture,{format:"rgba8unorm",width:1920,height:1080}],
      [fbo,{attachments:new Map([[EngineFormat.COLOR_ATTACHMENT0,{texture,level:0,layer:0}]])}]]),
    programs: new WeakMap([[program,meta]]), program, fbo,
    ids:new WeakMap(),nextId:1,bufferGeneration:0,resourceGeneration:0,
    vao:{attrs:new Map([[0,{enabled:true,type:EngineFormat.FLOAT,size:3,stride:12,offset:0,buffer,divisor:0}]])},
    boundBuffers:new Map([[EngineFormat.ARRAY_BUFFER,buffer]]),
    state:{frontFace:"ccw",cull:false,blend:false,colorMask:15,viewport:[0,0,1920,1080],depthRange:[0,1],stencilRef:0,blendColor:[0,0,0,0]},
    pipelineCache:new Map(),uniformOffset:0,uniformBuffer:{size:1024},
    passState:{vertices:[]},begin:()=>pass,
    device:{createRenderPipeline(){pipelines++;return {};},createBindGroup(){return {};}}
  });
  renderer.gl.frontend = renderer;
  const draw = () => renderer.draw("drawArrays",[EngineFormat.TRIANGLES,0,3]);
  draw(); draw();
  assert.equal(pipelines,1); assert.equal(replacements.length,1);
  assert.equal(viewports.length,1); assert.equal(scissors.length,1);
  const stableLayout = renderer.vao.layouts.get(meta);
  const stableRecord = stableLayout.preparedRecords.get(renderer.pipelineToken).get(renderer.attachments().compatibility).get(EngineFormat.TRIANGLES*3);
  draw();
  assert.equal(stableLayout.preparedRecords.get(renderer.pipelineToken).get(renderer.attachments().compatibility).get(EngineFormat.TRIANGLES*3),stableRecord);
  // Allocating an unrelated buffer must not rebuild this VAO's layout.
  renderer.bufferGeneration++; draw();
  assert.equal(renderer.vao.layouts.get(meta), stableLayout);
  renderer.call("vertexAttribPointer",[0,3,EngineFormat.FLOAT,false,12,24]); draw();
  assert.equal(replacements.at(-1)[1],24);
  const newBuffer = {}; renderer.info(buffer).gpu = newBuffer; renderer.bufferGeneration++; draw();
  assert.equal(replacements.at(-1)[0],newBuffer);
  renderer.call("colorMask",[true,false,true,false]); draw();
  assert.equal(pipelines,2);
  renderer.call("viewport", [5,6,800,600]);
  renderer.call("depthRange", [0.2,0.8]);
  renderer.call("scissor", [10,20,100,200]);
  renderer.call("enable", [EngineFormat.SCISSOR_TEST]); draw();
  assert.deepEqual(viewports.at(-1),[5,6,800,600,0.2,0.8]);
  assert.deepEqual(scissors.at(-1),[10,20,100,200]);
  renderer.call("disable", [EngineFormat.SCISSOR_TEST]); draw();
  assert.deepEqual(scissors.at(-1),[0,0,1920,1080]);
  // Base vertex/instance must reach WebGPU without shifting attribute pointers.
  renderer.vao.element = buffer;
  renderer.call("drawElementsInstancedBaseVertexBaseInstanceWEBGL", [EngineFormat.TRIANGLES,6,EngineFormat.UNSIGNED_SHORT,4n,3,17,2]);
  assert.deepEqual(indexedDraws.at(-1),[6,3,2,17,2]);
  renderer.call("drawElements", [EngineFormat.TRIANGLES,6,EngineFormat.UNSIGNED_INT,8]);
  assert.deepEqual(indexedDraws.at(-1),[6,1,2,0,0]);
  // A material must not keep a stale bind group when a texture is rebound.
  const texA = {}, texB = {}, viewA = {}, viewB = {}, sampler = {};
  renderer.objects.set(texA, { sampleView:viewA, gpuSamplers:{filtering:sampler} });
  renderer.objects.set(texB, { sampleView:viewB, gpuSamplers:{filtering:sampler} });
  renderer.textures = [new Map()]; renderer.samplers = [null]; renderer.activeUnit = 0;
  renderer.view = t => renderer.info(t).sampleView;
  meta.samplers = [{name:"image",type:"sampler2D"}]; meta.values = new Map();
  meta.activeBindings = [1,2];
  renderer.device.createBindGroup = desc => ({ entries:desc.entries });
  renderer.call("bindTexture", [EngineFormat.TEXTURE_2D,texA]); draw();
  assert.equal(meta.lastGroup.entries[0].resource,viewA);
  const materialA = meta.lastMaterial;
  renderer.call("bindTexture", [EngineFormat.TEXTURE_2D,texB]); draw();
  assert.equal(meta.lastGroup.entries[0].resource,viewB);
  renderer.call("bindTexture", [EngineFormat.TEXTURE_2D,texA]); draw();
  assert.equal(meta.lastMaterial,materialA); // return to the same resolved material handle
  // Direct submission uses explicit geometry/program and leaves EngineFormat state intact.
  const declaration = {}, oldVAO = renderer.vao;
  const packed = new Uint32Array([0,3,EngineFormat.FLOAT,0,0]);
  renderer.registerDeclaration(declaration, packed);
  packed[4] = 999; // declaration memory is copied, not retained across heap growth
  renderer.program = null; // explicit program, not the compatibility current program
  assert.equal(renderer.submitDraw(declaration,buffer,buffer,12,program,EngineFormat.TRIANGLES,true,6,5,17),true);
  assert.deepEqual(indexedDraws.at(-1),[6,1,5,17,0]);
  assert.equal(replacements.at(-1)[1],0);
  assert.equal(renderer.vao,oldVAO);
  const directGeometry = renderer.directDeclarations.get(declaration).geometries.get(buffer).get(12);
  const directLayout = directGeometry.layouts.get(meta);
  renderer.submitDraw(declaration,buffer,buffer,12,program,EngineFormat.TRIANGLES,true,6,0,0);
  assert.equal(directGeometry.layouts.get(meta),directLayout);
  const resized = {}; renderer.info(buffer).gpu = resized; renderer.bufferGeneration++;
  renderer.submitDraw(declaration,buffer,buffer,12,program,EngineFormat.TRIANGLES,true,6,0,2);
  assert.equal(replacements.at(-1)[0],resized);
  renderer.submitDraw(declaration,buffer,null,24,program,EngineFormat.TRIANGLES,false,3,2,0);
  assert.equal(renderer.directDeclarations.get(declaration).geometries.get(buffer).size,2);
  assert.deepEqual(arrayDraws.at(-1),[3,1,2,0]);
  renderer.program = program; draw(); // GLES fallback still selects its own layout
  assert.equal(replacements.at(-1)[1],24);

});

test("batched uniforms preserve Fmatrix layout, array elements, integer bits and unchanged versions", () => {
  const renderer = Object.create(GPUFrontend.prototype);
  const program = {uniformLocsById:{10:1,20:{name:"colors[1]"},30:0,40:0},
    uniformArrayNamesById:{10:"bones",20:"colors",30:"integer",40:"s_image"}};
  renderer.resourceGeneration=0;
  const meta = {values:new Map(),uniformData:new Uint8Array(192), uniformByName:new Map([
    ["bones",{name:"bones",type:"mat4x3",columns:4,rows:3,count:2,offset:0,stride:64}],
    ["colors",{name:"colors",type:"vec4",columns:1,rows:4,count:2,offset:128,stride:16}],
    ["integer",{name:"integer",type:"int",columns:1,rows:1,count:1,offset:160,stride:16}],
  ])};
  renderer.programs = new WeakMap([[program,meta]]);
  const heap = new ArrayBuffer(256), words = new Uint32Array(heap), floats = new Float32Array(heap), ints = new Int32Array(heap);
  words.set([1,10,1,16],0);
  floats.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 143,2,-274,1],4);
  words.set([1,20,0,4],20); floats.set([.25,.5,.75,1],24);
  words.set([1,30,2,1],28); ints[32] = -123456;
  words.set([1,40,3,1,3],33);
  const consume = () => renderer.consumeUniformBatch(words,floats,ints,0,38,[null,program]);
  consume();
  const result = new Float32Array(meta.uniformData.buffer);
  assert.deepEqual([...result.slice(16,32)],[1,0,0,0,0,1,0,0,0,0,1,0,143,2,-274,0]);
  assert.deepEqual([...result.slice(32,40)],[0,0,0,0,.25,.5,.75,1]);
  assert.equal(new Int32Array(meta.uniformData.buffer)[40],-123456);
  assert.equal(meta.values.get("s_image")[0],3);
  const generation = renderer.resourceGeneration;
  const version = meta.uniformVersion; consume(); assert.equal(meta.uniformVersion,version);
  assert.equal(renderer.resourceGeneration,generation);
  floats[24] = .125; consume(); assert.equal(meta.uniformVersion,version+1);
  assert.throws(() => renderer.consumeUniformBatch(words,floats,ints,0,32,[null,program]),/Truncated/);
});

test("uniform allocations reuse unchanged data but never reuse overwritten arena ranges", () => {
  const renderer = Object.create(GPUFrontend.prototype);
  Object.assign(renderer,{uniformEpoch:0,uniformOffset:0,uniformUploaded:0,
    uniformBuffer:{size:512},uniformStaging:new Uint8Array(512)});
  let flushes=0; renderer.flush=()=>flushes++;
  const p={uniformData:new Uint8Array([1,2,3,4]),uniformVersion:1};
  assert.equal(renderer.allocateUniformBlock(p),0);
  assert.equal(renderer.allocateUniformBlock(p),0);
  assert.equal(renderer.uniformOffset,256);
  p.uniformData[0]=9; p.uniformVersion++;
  assert.equal(renderer.allocateUniformBlock(p),256);
  assert.equal(renderer.uniformStaging[0],1); // earlier draw snapshot remains intact
  assert.equal(renderer.uniformStaging[256],9);
  const q={uniformData:new Uint8Array([7]),uniformVersion:0};
  assert.equal(renderer.allocateUniformBlock(q),0); assert.equal(flushes,1);
  assert.equal(renderer.allocateUniformBlock(p),256); // p's old allocation belongs to a prior epoch
  renderer.uniformEpoch++; renderer.uniformOffset=0;
  assert.equal(renderer.allocateUniformBlock(p),0); // next frame must upload again
});

test("native Fmatrix batches match legacy transpose packing for all matrix shapes", () => {
  for (const rows of [2,3,4]) {
    const u={name:"matrix",type:rows===4?"mat4":"mat4x"+rows,rows,columns:4,count:1,offset:0,stride:64};
    const legacy=uniformFixture("matrix",u), native=uniformFixture("matrix",u);
    const original=Float32Array.from({length:16},(_,i)=>(i+1)*.25);
    const transposed=[];
    for(let r=0;r<rows;r++)for(let c=0;c<4;c++)transposed.push(original[c*4+r]);
    legacy.renderer.setUniform(rows===4?"uniformMatrix4fv":"uniformMatrix4x"+rows+"fv",[legacy.location,true,new Float32Array(transposed)]);
    const program={uniformLocsById:{1:0},uniformArrayNamesById:{1:"matrix"}};
    native.renderer.programs.set(program,native.meta);
    const buffer=new ArrayBuffer(80), words=new Uint32Array(buffer), floats=new Float32Array(buffer);
    words.set([1,1,1,16]);floats.set(original,4);
    native.renderer.consumeUniformBatch(words,floats,new Int32Array(buffer),0,20,[null,program]);
    assert.deepEqual(native.meta.uniformData,legacy.meta.uniformData);
  }
});

test("native state batches match compatibility state and preserve dynamic-only pipeline handles", async () => {
  const {createCommandContext} = await import('./command-context.js');
  const {EngineFormat} = await import('./engine-formats.js');
  const make = () => { const renderer = Object.assign(Object.create(GPUFrontend.prototype), {
    gl:createCommandContext({width:1280,height:720},{limits:{}}),
    state:{stencilFront:{},stencilBack:{}},pipelineStateKey:'cached',
  }); renderer.gl.frontend = renderer; return renderer; };
  const native = make(), legacy = make();
  const batch = [];
  const add = (kind, ...values) => batch.push(kind,...values,...Array(5-values.length).fill(0));
  const compare = [EngineFormat.NEVER,EngineFormat.LESS,EngineFormat.EQUAL,EngineFormat.LEQUAL,EngineFormat.GREATER,EngineFormat.NOTEQUAL,EngineFormat.GEQUAL,EngineFormat.ALWAYS];
  const stencil = [EngineFormat.KEEP,EngineFormat.ZERO,EngineFormat.REPLACE,EngineFormat.INCR,EngineFormat.DECR,EngineFormat.INVERT,EngineFormat.INCR_WRAP,EngineFormat.DECR_WRAP];
  const factors = [EngineFormat.ZERO,EngineFormat.ONE,EngineFormat.SRC_COLOR,EngineFormat.ONE_MINUS_SRC_COLOR,EngineFormat.SRC_ALPHA,EngineFormat.ONE_MINUS_SRC_ALPHA,EngineFormat.DST_ALPHA,EngineFormat.ONE_MINUS_DST_ALPHA,EngineFormat.DST_COLOR,EngineFormat.ONE_MINUS_DST_COLOR,EngineFormat.SRC_ALPHA_SATURATE];
  const ops = [EngineFormat.FUNC_ADD,EngineFormat.FUNC_SUBTRACT,EngineFormat.FUNC_REVERSE_SUBTRACT,EngineFormat.MIN,EngineFormat.MAX];
  const check = () => {
    native.consumeStateBatch(new Uint32Array(batch),0,batch.length); batch.length=0;
    assert.deepEqual(native.state,legacy.state);


  };
  for (let i=1;i<=8;i++) {
    add(1,i,9,0xff); legacy.call('stencilFunc',[compare[i-1],9,0xff]);
    add(3,i,i,i); legacy.call('stencilOp',[stencil[i-1],stencil[i-1],stencil[i-1]]);
    add(5,i); legacy.call('depthFunc',[compare[i-1]]); check();
  }
  for (let i=1;i<=11;i++) {
    add(8,i,i,i,i); legacy.call('blendFuncSeparate',Array(4).fill(factors[i-1])); check();
  }
  for (let i=1;i<=5;i++) {
    add(9,i,i); legacy.call('blendEquationSeparate',[ops[i-1],ops[i-1]]); check();
  }
  for (const v of [1,0,1]) {
    for (const [kind,cap] of [[0,EngineFormat.STENCIL_TEST],[4,EngineFormat.DEPTH_TEST],[7,EngineFormat.BLEND]]) {
      add(kind,v); legacy.call(v?'enable':'disable',[cap]);
    }
    add(6,v); legacy.call('depthMask',[!!v]);
    add(2,0xffffffff); legacy.call('stencilMask',[0xffffffff]);
    add(10,5); legacy.call('colorMask',[true,false,true,false]);
    check();
  }
  for (const mode of [2,3,1]) {
    add(11,mode); legacy.call(mode===1?'disable':'enable',[EngineFormat.CULL_FACE]);
    if(mode!==1) legacy.call('cullFace',[mode===2?EngineFormat.BACK:EngineFormat.FRONT]); check();
  }
  add(12,1,-2,40,800,600); legacy.call('enable',[EngineFormat.SCISSOR_TEST]); legacy.call('scissor',[-2,40,800,600]); check();
  native.pipelineStateKey='cached';
  add(1,8,25,0xff); legacy.call('stencilFunc',[EngineFormat.ALWAYS,25,0xff]);
  add(12,0); legacy.call('disable',[EngineFormat.SCISSOR_TEST]); check();
  assert.equal(native.pipelineStateKey,'cached','reference/scissor changes must not rebuild pipeline keys');
  assert.throws(()=>native.consumeStateBatch(new Uint32Array(5),0,5),/Invalid/);
  assert.throws(()=>native.consumeStateBatch(new Uint32Array([99,0,0,0,0,0]),0,6),/Unknown/);
});

test("pending native states apply before compatibility overrides and clear operations", async () => {
  const {createCommandContext} = await import('./command-context.js');
  const renderer = Object.assign(Object.create(GPUFrontend.prototype), {
    gl:createCommandContext({width:1,height:1},{limits:{}}),state:{stencilFront:{},stencilBack:{}},
  });
  let pending = new Uint32Array([6,0,0,0,0,0,10,3,0,0,0,0]);
  renderer.flushNativeStates = () => {
    if (pending) {renderer.consumeStateBatch(pending,0,pending.length);pending=null;}
  };
  renderer.call('depthMask',[true]);
  assert.equal(renderer.state.depthWrite,true,'later compatibility write must win');
  assert.equal(renderer.state.colorMask,3);
  renderer.gl.frontend = renderer;
  const {EngineFormat} = await import('./engine-formats.js');
  pending = new Uint32Array([7,1,0,0,0,0]);
  renderer.flushNativeStates(); assert.equal(renderer.state.blend,true);
  pending = new Uint32Array([10,5,0,0,0,0]);
  renderer.flushNativeStates(); assert.equal(renderer.state.colorMask,5);

  pending = new Uint32Array([10,15,0,0,0,0]);
  renderer.begin = () => {assert.equal(renderer.state.colorMask,15); throw Error('clear reached after flush');};
  assert.throws(()=>renderer.clear(0),/clear reached after flush/);
});

test("native texture and sampler records match compatibility bindings and invalidate only changed resources", async () => {
  const {createCommandContext} = await import('./command-context.js');
  const {EngineFormat} = await import('./engine-formats.js');
  const texA={},texB={},sampler={};
  const make = () => {
    const r = Object.assign(Object.create(GPUFrontend.prototype), {
      gl:createCommandContext({width:1,height:1},{limits:{}}),
      textures:Array.from({length:32},()=>new Map()),samplers:[],activeUnit:0,boundBuffers:new Map(),vao:{},
      objects:new WeakMap([[texA,{}],[texB,{}],[sampler,{}]]),resourceGeneration:0,
      state:{viewport:[0,0,1,1]},
    }); r.gl.frontend=r; return r;
  };
  const n=make(),l=make(),textures=[null,texA,texB],samplers=[null,sampler];
  const compare = () => {
    assert.deepEqual(n.textures,l.textures); assert.deepEqual(n.samplers,l.samplers);
    assert.equal(n.activeUnit,l.activeUnit); assert.equal(n.resourceGeneration,l.resourceGeneration);
    for (const query of [EngineFormat.ACTIVE_TEXTURE,EngineFormat.TEXTURE_BINDING_2D,EngineFormat.TEXTURE_BINDING_CUBE_MAP,EngineFormat.SAMPLER_BINDING])
      assert.equal(n.call('getParameter',[query]),l.call('getParameter',[query]));
  };
  for(const [stage,target,id] of [[2,EngineFormat.TEXTURE_2D,1],[3,EngineFormat.TEXTURE_CUBE_MAP,2],[2,EngineFormat.TEXTURE_3D,2],[2,EngineFormat.TEXTURE_2D,1],[2,EngineFormat.TEXTURE_2D,2]]) {
    n.consumeBindingBatch(new Uint32Array([0,stage,target,id,1,stage,1,0]),0,8,textures,samplers);
    l.call('activeTexture',[EngineFormat.TEXTURE0+stage]); l.call('bindTexture',[target,textures[id]]); l.call('bindSampler',[stage,sampler]); compare();
  }
  const generation=n.resourceGeneration;
  n.consumeBindingBatch(new Uint32Array([0,2,EngineFormat.TEXTURE_2D,2,1,2,1,0]),0,8,textures,samplers);
  assert.equal(n.resourceGeneration,generation);
  n.consumeBindingBatch(new Uint32Array([2,2,0,0]),0,4,textures,samplers);
  l.call('activeTexture',[EngineFormat.TEXTURE0+2]);
  for(const target of [EngineFormat.TEXTURE_2D,EngineFormat.TEXTURE_3D,EngineFormat.TEXTURE_CUBE_MAP]) l.call('bindTexture',[target,null]); compare();
  assert.equal(n.textures[3].get(EngineFormat.TEXTURE_CUBE_MAP),texB,'clear is limited to the requested stage');
  assert.throws(()=>n.consumeBindingBatch(new Uint32Array(3),0,3,textures,samplers),/Invalid/);
  assert.throws(()=>n.consumeBindingBatch(new Uint32Array([0,0,EngineFormat.TEXTURE_2D,99]),0,4,textures,samplers),/Missing/);
  assert.throws(()=>n.consumeBindingBatch(new Uint32Array([0,32,EngineFormat.TEXTURE_2D,1]),0,4,textures,samplers),/Invalid/);
});

test("pending bindings flush before uploads, overrides, queries and resource deletion", async () => {
  const {createCommandContext} = await import('./command-context.js');
  const {EngineFormat} = await import('./engine-formats.js');
  const texture={}, sampler={}; let destroyed=false, submitted=false;
  const r=Object.assign(Object.create(GPUFrontend.prototype),{
    gl:createCommandContext({width:1,height:1},{limits:{}}),textures:Array.from({length:32},()=>new Map()),samplers:[],activeUnit:0,boundBuffers:new Map(),vao:{},
    objects:new WeakMap([[texture,{gpu:{destroy(){assert.equal(submitted,true);destroyed=true;}}}],[sampler,{}]]),resourceGeneration:0,state:{},
  }); r.gl.frontend=r;
  let pending;
  r.flushNativeBindings=()=>{if(pending){r.consumeBindingBatch(pending,0,pending.length,[null,texture],[null,sampler]);pending=null;}};
  const queue=()=>{pending=new Uint32Array([0,4,EngineFormat.TEXTURE_2D,1,1,4,1,0]);};
  r.uploadTexture=()=>{assert.equal(r.textureInfo(EngineFormat.TEXTURE_2D),r.info(texture));assert.equal(pending,null);};
  queue();r.call('texSubImage2D',[EngineFormat.TEXTURE_2D]);
  queue();r.call('activeTexture',[EngineFormat.TEXTURE0+3]);assert.equal(r.activeUnit,3);
  queue();assert.equal(r.call('getParameter',[EngineFormat.TEXTURE_BINDING_2D]),texture);
  queue();r.call('bindTexture',[EngineFormat.TEXTURE_2D,null]);assert.equal(r.textures[4].get(EngineFormat.TEXTURE_2D),null);
  queue();r.flush=()=>{submitted=true;assert.equal(pending,null);};r.call('deleteTexture',[texture]);
  assert.equal(destroyed,true);assert.equal(r.textures[4].get(EngineFormat.TEXTURE_2D),null);
  r.call('deleteSampler',[sampler]);assert.equal(r.samplers[4],null);
});

test("native viewport preserves signed coordinates and float depth range without rebuilding pipelines", async () => {
  const {createCommandContext} = await import('./command-context.js');
  const r=Object.assign(Object.create(GPUFrontend.prototype),{gl:createCommandContext({width:1,height:1},{limits:{}}),state:{},pipelineStateKey:'cached'});
  const words=new Uint32Array([13,-2,3,1280,720,0,14,0,0,0,0,0]);
  const floats=new Float32Array(words.buffer);floats[7]=0.25;floats[8]=0.75;
  r.consumeStateBatch(words,0,words.length);
  assert.deepEqual(r.state.viewport,[-2,3,1280,720]);assert.deepEqual(r.state.depthRange,[0.25,0.75]);
  const viewport=r.state.viewport,range=r.state.depthRange;
  r.consumeStateBatch(words,0,words.length);
  assert.equal(r.state.viewport,viewport);assert.equal(r.state.depthRange,range);assert.equal(r.pipelineStateKey,'cached');
  let pending=true;r.flushNativeStates=()=>{if(pending){r.consumeStateBatch(words,0,words.length);pending=false;}};
  r.call('viewport',[0,0,640,480]);assert.deepEqual(r.state.viewport,[0,0,640,480]);
  pending=true;r.call('depthRange',[0,1]);assert.deepEqual(r.state.depthRange,[0,1]);
});

test("native pass records preserve framebuffer targets, sparse MRTs and attachment cache invalidation", async () => {
  const {EngineFormat}=await import('./engine-formats.js');
  const {createCommandContext}=await import('./command-context.js');
  const fb={},read={},a={},b={},z={};
  const make=()=>{
    const r=Object.assign(Object.create(GPUFrontend.prototype),{
      gl:createCommandContext({width:1280,height:720},{limits:{}}),state:{},
      objects:new WeakMap([[fb,{}],[read,{}],[a,{format:'rgba8unorm'}],[b,{format:'rgba8unorm'}],[z,{format:'depth24plus-stencil8'}]]),
      ids:new WeakMap(),nextId:1,
    });r.gl.frontend=r;return r;
  };
  const n=make(),l=make(),frames=[null,fb,read],textures=[null,a,b,z];
  const words=new Uint32Array([
    15,EngineFormat.FRAMEBUFFER,1,0,0,0,
    16,EngineFormat.COLOR_ATTACHMENT0,1,0,0,0,
    16,EngineFormat.COLOR_ATTACHMENT0+2,2,0,0,0,
    16,EngineFormat.DEPTH_STENCIL_ATTACHMENT,3,0,0,0,
    17,3,EngineFormat.COLOR_ATTACHMENT0,EngineFormat.NONE,EngineFormat.COLOR_ATTACHMENT0+2,0,
    15,EngineFormat.READ_FRAMEBUFFER,2,0,0,0,
  ]);
  n.consumeStateBatch(words,0,words.length,undefined,frames,textures);
  l.call('bindFramebuffer',[EngineFormat.FRAMEBUFFER,fb]);
  for(const [slot,t] of [[EngineFormat.COLOR_ATTACHMENT0,a],[EngineFormat.COLOR_ATTACHMENT0+2,b],[EngineFormat.DEPTH_STENCIL_ATTACHMENT,z]])
    l.call('framebufferTexture2D',[EngineFormat.FRAMEBUFFER,slot,EngineFormat.TEXTURE_2D,t,0]);
  l.call('drawBuffers',[[EngineFormat.COLOR_ATTACHMENT0,EngineFormat.NONE,EngineFormat.COLOR_ATTACHMENT0+2]]);
  l.call('bindFramebuffer',[EngineFormat.READ_FRAMEBUFFER,read]);
  assert.equal(n.fbo,l.fbo);assert.equal(n.readFbo,l.readFbo);
  assert.deepEqual(n.info(fb),l.info(fb));
  const attachments=n.attachments(); assert.equal(attachments.colors[1],null);assert.equal(attachments.depth.texture,z);
  n.consumeStateBatch(words,0,words.length,undefined,frames,textures);
  assert.equal(n.attachments(),attachments,'unchanged pass records retain cached attachments');
  n.consumeStateBatch(new Uint32Array([16,EngineFormat.COLOR_ATTACHMENT0,2,1,2,0]),0,6,undefined,frames,textures);
  assert.notEqual(n.attachments(),attachments);assert.equal(n.attachments().colors[0].texture,b);
  assert.equal(n.attachments().colors[0].level,1);assert.equal(n.attachments().colors[0].layer,2);
  n.consumeStateBatch(new Uint32Array([15,EngineFormat.DRAW_FRAMEBUFFER,0,0,0,0]),0,6,undefined,frames,textures);
  assert.equal(n.fbo,null);assert.equal(n.readFbo,read);
  assert.throws(()=>n.consumeStateBatch(new Uint32Array([15,EngineFormat.FRAMEBUFFER,99,0,0,0]),0,6,undefined,frames,textures),/Missing/);
});

test("native clears and presentation flush pending pass state and retain compatibility clear/query behavior", async () => {
  const {EngineFormat}=await import('./engine-formats.js');
  const {createCommandContext}=await import('./command-context.js');
  const fb={},color={},depth={};
  const make=()=>{
    const r=Object.assign(Object.create(GPUFrontend.prototype),{
      gl:createCommandContext({width:1280,height:720},{limits:{}}),state:{colorMask:3,depthWrite:false,stencilMask:0},
      objects:new WeakMap([[fb,{}],[color,{}],[depth,{}]]),pipelineStateKey:'cached',
    });r.gl.frontend=r;r.begin=mask=>{r.cleared={mask,fbo:r.fbo,state:structuredClone(r.state)};};return r;
  };
  const n=make();let pending=true;const clears=[];
  n.objects.set(color,{gpu:{},format:'rgba8unorm'});
  n.objects.set(depth,{gpu:{},format:'depth24plus-stencil8'});
  n.endPass=()=>{}; n.view=t=>t;
  n.enc=()=>({beginRenderPass(d){clears.push(d);return {end(){}};}});
  n.flushNativeStates=()=>{if(pending){n.consumeStateBatch(new Uint32Array([15,EngineFormat.FRAMEBUFFER,1,0,0,0]),0,6,undefined,[null,fb],[null,color,depth]);pending=false;}};
  n.clearNativeTarget(color,EngineFormat.COLOR_BUFFER_BIT,0.25,0.5,0.75,1,1,0);
  assert.deepEqual(clears[0],{colorAttachments:[{view:color,loadOp:'clear',storeOp:'store',clearValue:[0.25,0.5,0.75,1]}]});
  const mask=EngineFormat.DEPTH_BUFFER_BIT|EngineFormat.STENCIL_BUFFER_BIT;
  n.clearNativeTarget(depth,mask,0,0,0,0,0.5,7);
  assert.deepEqual(clears[1].colorAttachments,[]);
  assert.equal(clears[1].depthStencilAttachment.view,depth);
  assert.equal(clears[1].depthStencilAttachment.stencilClearValue,7);
  assert.equal(n.info(fb).attachments,undefined,'standalone clear must not corrupt cached engine attachments');
  pending=true;let bindings=false,uniforms=false;
  n.flushNativeBindings=()=>{bindings=true;};n.flushNativeUniforms=()=>{uniforms=true;};
  n.blit=args=>{assert.equal(pending,false);assert.equal(bindings,true);assert.equal(uniforms,true);assert.equal(n.readFbo,fb);assert.equal(n.fbo,null);assert.deepEqual(args,[0,0,1280,720,0,0,1280,720,EngineFormat.COLOR_BUFFER_BIT,EngineFormat.NEAREST]);};
  n.presentNative(fb,1280,720);
  pending=true;n.call('deleteFramebuffer',[fb]);assert.equal(n.fbo,null);assert.equal(n.readFbo,null);
});

test("native program and vertex-array selection preserve engine handles and element-buffer isolation", async () => {
  const {EngineFormat}=await import('./engine-formats.js');
  const {createCommandContext}=await import('./command-context.js');
  const p={},q={},v1={},v2={},index1={},index2={};
  const r=Object.assign(Object.create(GPUFrontend.prototype),{
    gl:createCommandContext({width:1,height:1},{limits:{}}),
    objects:new WeakMap([[v1,{vao:{attrs:new Map(),element:index1}}],[v2,{vao:{attrs:new Map(),element:index2}}]]),
    boundBuffers:new Map(),defaultVAO:{attrs:new Map(),element:null},
  });r.gl.frontend=r;
  r.selectNativeProgram(p);assert.equal(r.program,p);
  r.call('useProgram',[q]);r.gl.currentProgram=q; // The legacy Emscripten wrapper performs the latter assignment.
  r.selectNativeProgram(p);assert.equal(r.program,p);
  r.selectNativeVertexArray(v1);assert.equal(r.vaoObject,v1);assert.equal(r.vao.element,index1);
  r.call('bindVertexArray',[v2]);assert.equal(r.boundBuffers.get(EngineFormat.ELEMENT_ARRAY_BUFFER),index2);
  r.selectNativeVertexArray(v1);assert.equal(r.vao.element,index1);
  r.selectNativeVertexArray(null);assert.equal(r.vao,r.defaultVAO);assert.equal(r.vao.element,null);
  r.selectNativeProgram(null);assert.equal(r.program,null);
});

test('native buffer uploads preserve queued draws, unaligned updates and bound state', async () => {
  const { EngineFormat } = await import('./engine-formats.js');
  globalThis.GPUBufferUsage = {VERTEX:1, INDEX:2, COPY_DST:4, COPY_SRC:8};
  const r = Object.create(GPUFrontend.prototype), token = {}, unrelated = {};
  const writes = [], copies = [], order = [];
  Object.assign(r, {objects:new WeakMap(), boundBuffers:new Map([[EngineFormat.ARRAY_BUFFER,unrelated]]),
    bufferGeneration:0, retired:[], uploadOffset:0, uploadUploaded:0,
    uploadBuffer:{size:128}, uploadStaging:new Uint8Array(128), vao:{element:null},
    device:{createBuffer(d){return {...d,destroy(){order.push('destroy');}}},queue:{writeBuffer(b,o,data){writes.push([...data]);}}},
    endPass(){order.push('end');}, flush(){order.push('flush');},
    enc(){return {copyBufferToBuffer(...a){copies.push(a);}}}});
  r.uploadNativeBuffer(token,new Uint8Array([1,2,3,4,5,6]));
  const first = r.info(token).gpu;
  r.uploadNativeBuffer(token,new Uint8Array([7,8]));
  assert.equal(r.retired[0],first); // previous draws retain the old allocation
  r.uploadNativeBuffer(token,new Uint8Array([9]),1,false);
  assert.deepEqual([...r.info(token).cpu.subarray(0,r.info(token).size)],[7,9,0,0]);
  assert.equal(copies.length,0); // fresh GPU storage needs no in-pass copy
  assert.ok(!order.includes('end')); // uploads preserve the render pass
  assert.equal(r.boundBuffers.get(EngineFormat.ARRAY_BUFFER),unrelated);
  assert.deepEqual(writes,[[1,2,3,4,5,6,0,0],[7,8,0,0],[7,9,0,0]]);
  r.deleteNativeBuffer(token);
  assert.deepEqual(order.slice(-2),['flush','destroy']);
  assert.throws(()=>r.uploadNativeBuffer(token,4),/Invalid native buffer/);
});

test('native occlusion queries retain asynchronous availability and flush pass state before begin', () => {
  const r = Object.create(GPUFrontend.prototype), q = {}, order = [], pass = {};
  Object.assign(r,{flushNativeStates(){order.push('states');},begin(){order.push('pass');return pass;},pass,
    occlusion:{begin(p,t){assert.equal(p,pass);assert.equal(t,q);order.push('query');t.available=false;},end(p){assert.equal(p,pass);order.push('end');}}});
  assert.equal(r.nativeQueryResult(q),-1);
  r.beginNativeQuery(q); r.endNativeQuery();
  assert.deepEqual(order,['states','pass','query','end']);
  q.available=true;q.result=0;assert.equal(r.nativeQueryResult(q),0);
  q.result=1;assert.equal(r.nativeQueryResult(q),1);
  q.deleted=true;assert.throws(()=>r.beginNativeQuery(q),/Invalid native query/);
});

test('native texture storage/uploads address explicit resources, cube faces and 3D extents', async () => {
  const { EngineFormat } = await import('./engine-formats.js');
  const r = Object.create(GPUFrontend.prototype), token = {}, calls = [];
  Object.assign(r,{objects:new WeakMap(),allocateTexture(a,is3,i){calls.push({a,is3,i});},
    uploadTexture(a,is3,compressed,i){calls.push({a,is3,compressed,i});}});
  r.allocateNativeTexture(token,EngineFormat.TEXTURE_CUBE_MAP,4,EngineFormat.RGBA8,8,8,1);
  assert.equal(calls[0].is3,false);
  assert.equal(calls[0].i.target,EngineFormat.TEXTURE_CUBE_MAP);
  assert.equal(calls[0].i.params.get(EngineFormat.TEXTURE_MAX_LEVEL),3);
  const bytes = new Uint8Array(16);
  r.uploadNativeTexture(token,EngineFormat.TEXTURE_CUBE_MAP_POSITIVE_X+2,1,4,4,1,0x83f1,0,true,bytes);
  assert.deepEqual(calls[1].a,[EngineFormat.TEXTURE_CUBE_MAP_POSITIVE_X+2,1,0,0,4,4,0x83f1,bytes]);
  r.uploadNativeTexture(token,EngineFormat.TEXTURE_3D,0,2,2,2,EngineFormat.RGBA,EngineFormat.UNSIGNED_BYTE,false,bytes);
  assert.deepEqual(calls[2].a,[EngineFormat.TEXTURE_3D,0,0,0,0,2,2,2,EngineFormat.RGBA,EngineFormat.UNSIGNED_BYTE,bytes]);
  assert.equal(calls[2].is3,true);
  assert.equal(calls[2].i,r.info(token));
});

test('native texture copy flushes pending state and ends the pass before encoding', () => {
  const r = Object.create(GPUFrontend.prototype), src = {}, dst = {}, order=[];
  Object.assign(r,{objects:new WeakMap([[src,{gpu:'source'}],[dst,{gpu:'destination'}]]),
    flushNativeStates(){order.push('states');},flushNativeBindings(){order.push('bindings');},endPass(){order.push('end');},
    enc(){return {copyTextureToTexture(...args){order.push(args);}}}});
  r.copyNativeTexture(src,dst,1280,720);
  assert.deepEqual(order,['states','bindings','end',[{texture:'source'},{texture:'destination'},[1280,720,1]]]);
});

test('failed asynchronous screenshot mapping releases its GPU readback buffer', async () => {
  globalThis.GPUBufferUsage = {COPY_DST:1,MAP_READ:2};
  globalThis.GPUMapMode = {READ:1};
  const r = Object.create(GPUFrontend.prototype), texture = {}, order=[];
  Object.assign(r,{lastPresented:{texture,level:0,layer:0},
    objects:new WeakMap([[texture,{gpu:{},width:2,height:2,format:'rgba8unorm'}]]),
    device:{createBuffer(){return {mapState:'unmapped',async mapAsync(){throw Error('device lost');},destroy(){order.push('destroy');}};}},
    endPass(){},enc(){return {copyTextureToBuffer(){order.push('copy');}};},flush(){order.push('submit');}});
  await r.captureScreenshot('/test.jpg');
  assert.deepEqual(order,['copy','submit','destroy']);
});

test('multisample color copies encode a resolve pass, not an illegal texture copy',()=>{
  const r=Object.create(GPUFrontend.prototype),src={},dst={},views=[],passes=[];
  r.objects=new WeakMap([[src,{gpu:{},format:'rgba8unorm',samples:4}],[dst,{gpu:{},format:'rgba8unorm',samples:1}]]);
  r.endPass=()=>{};r.view=t=>(views.push(t),t);r.enc=()=>({beginRenderPass:d=>(passes.push(d),{end(){}}),copyTextureToTexture(){throw Error('must resolve')}});
  r.copyNativeTexture(src,dst,4,4);
  assert.deepEqual(views,[src,dst]);assert.equal(passes[0].colorAttachments[0].resolveTarget,dst);assert.equal(passes[0].colorAttachments[0].loadOp,'load');
  r.info(dst).samples=4;assert.throws(()=>r.copyNativeTexture(src,dst,4,4),/Invalid multisample/);
});
