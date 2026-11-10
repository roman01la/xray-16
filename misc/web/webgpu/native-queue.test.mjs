import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeQueues} from './native-queue.js';
import {packUniforms} from './pack-uniforms.mjs';
import {GPUFrontend} from './backend.js';

test('draw batches replay immutable state boundaries and drain trailing changes before resource mutation',()=>{
  let memory=new ArrayBuffer(4096),w=new Uint32Array(memory);const events=[];
  const pointers=[0,400,800,1200,1600,2000,2400,3000];
  const r={consumeUniformBatch(_w,_f,_i,start,n){events.push(['uniform',...w.slice(start,start+n)]);},
    consumeStateBatch(_w,start,n){events.push(['state',...w.slice(start,start+n)]);},
    consumeBindingBatch(_w,start,n){events.push(['binding',...w.slice(start,start+n)]);},
    submitDraw(...args){events.push(['draw',args[0],args[7],args[9],r.tessellationFactor]);r.flushNativeDraws();}};
  installNativeQueues(r,()=>({words:w,floats:new Float32Array(memory),ints:new Int32Array(memory)}),pointers,{vaos:[null,'geometry'],buffers:[],programs:[],textures:[],samplers:[],framebuffers:[]});
  w.set([11,12,13],0);w[100]=3;w.set([21,22],200);w[300]=2;w.set([31,32],400);w[500]=2;
  w.set([1,0,0,12,0,4,0,3,0,0,1,1,1,4,0,1, 1,0,0,12,0,4,0,6,0,0xffffffff,2,2,2,8,0,1],600);w[750]=32;
  // Simulate memory growth; the queue must read the current heap, not an old view.
  const grown=new ArrayBuffer(8192);new Uint8Array(grown).set(new Uint8Array(memory));memory=grown;w=new Uint32Array(memory);
  r.flushNativeStates();events.push(['mutation']);
  assert.deepEqual(events,[['uniform',11],['state',21],['binding',31],['draw','geometry',3,0,4],['uniform',12],['state',22],['binding',32],['draw','geometry',6,-1,8],['uniform',13],['mutation']]);
  assert.deepEqual([w[100],w[300],w[500],w[750]],[0,0,0,0]);
});

test('uniform packing removes inactive fields and separates per-object, frame and material fields in both stages',()=>{
  const stage='struct Values {\n a: vec4<f32>,\n b: vec4<f32>,\n c: vec4<f32>,\n d: vec4<f32>,\n}\n@group(0) @binding(0) var<uniform> values: Values;\nfn read()->vec4f{return values.a+values.c+values.d;}';
  const names=['object','unused','timers','L_material'];
  const p={uniforms:names.map((name,i)=>({name,type:'vec4',count:1,columns:1,rows:4,stride:16,offset:i*16})),activeUniforms:[0,2,3].map(i=>({name:names[i]})),stages:{vert:stage,frag:stage},uniformBytes:64};
  packUniforms(p);
  assert.deepEqual(p.uniforms.map(u=>[u.name,u.group,u.offset]),[['object',0,0],['timers',1,0],['L_material',2,0]]);
  assert.deepEqual(p.uniformGroups,[{bytes:16},{bytes:16},{bytes:16}]);
  assert.doesNotMatch(p.stages.vert,/ b:/);assert.match(p.stages.frag,/@group\(2\)/);assert.match(p.stages.vert,/values_block1\.c/);
  assert.equal(packUniforms(p),p);
});

test('stream slots are not recycled until submission and never interrupt an open render pass',()=>{
  globalThis.GPUBufferUsage={VERTEX:1,INDEX:2,COPY_DST:4,UNIFORM:8};
  const r=Object.create(GPUFrontend.prototype),events=[],i={};let created=0;
  Object.assign(r,{streamPool:new Map(),streamRetired:[],retired:[],uniformOffset:0,uniformUploaded:0,uploadOffset:0,uploadUploaded:0,pass:null,
    device:{createBuffer(d){return {size:d.size,id:++created,destroy(){}}},queue:{writeBuffer(b,o,data){events.push(['write',b.id,[...data]]);},submit(){events.push(['submit']);}}}});
  r.streamSnapshot(i,new Uint8Array([1,2,3,4]));const first=i.gpu;
  r.streamSnapshot(i,new Uint8Array([5,6,7,8]));assert.notEqual(i.gpu,first);assert.equal(created,2);
  r.encoder={finish(){return {};}};r.flush();
  r.streamSnapshot(i,new Uint8Array([9,10,11,12]));assert.equal(i.gpu,first);assert.equal(created,2);
  assert.deepEqual(events.map(x=>x[0]),['write','write','submit','write']);
});

test('changing frame uniforms preserves the object block allocation',()=>{
  const r=Object.create(GPUFrontend.prototype),handle={uniformLocsById:[{name:'object'},{name:'timers'}]};
  const p={uniformData:new Uint8Array(16),uniformVersion:0,uniformByName:new Map([
    ['object',{name:'object',type:'vec4',count:1,columns:1,rows:4,stride:16,offset:0,group:0}],
    ['timers',{name:'timers',type:'vec4',count:1,columns:1,rows:4,stride:16,offset:0,group:1}]
  ])};
  p.uniformBlocks=[p,{uniformData:new Uint8Array(16),uniformVersion:0}];
  Object.assign(r,{programs:new WeakMap([[handle,p]]),uniformEpoch:1,uniformOffset:0,uniformBuffer:{size:4096},uniformStaging:new Uint8Array(4096)});
  const initial=r.allocateUniformBlock(p),memory=new ArrayBuffer(32),words=new Uint32Array(memory),floats=new Float32Array(memory);
  words.set([1,1,0,4]);floats.set([1,2,3,4],4);
  r.consumeUniformBatch(words,floats,new Int32Array(memory),0,8,[null,handle]);
  assert.deepEqual([...new Float32Array(p.uniformData.buffer)],[0,0,0,0]);
  assert.deepEqual([...new Float32Array(p.uniformBlocks[1].uniformData.buffer)],[1,2,3,4]);
  assert.equal(r.allocateUniformBlock(p),initial);
  assert.notEqual(r.allocateUniformBlock(p.uniformBlocks[1]),initial);
});

 test('instanced records preserve counts and buffer handles between ordinary draws',()=>{
 const memory=new ArrayBuffer(4096),w=new Uint32Array(memory),calls=[];
 const r={submitDraw(...args){calls.push(args);}};
 installNativeQueues(r,()=>({words:w,floats:new Float32Array(memory),ints:new Int32Array(memory)}),[0,400,800,1200,1600,2000,2400,3000],{vaos:[null,'vao'],buffers:[null,'vertices','indices','instances'],programs:[null,'program']});
 for(let i=0;i<3;i++)w.set([1,1,2,20,1,4,1,6,2,0xffffffff,0,0,0,0,i===1?3:0,i===1?130:1],600+i*16);
 w[750]=48;r.flushNativeDraws();
 assert.deepEqual(calls.map(c=>c.slice(7)),[[6,2,-1,null,1],[6,2,-1,'instances',130],[6,2,-1,null,1]]);
 assert.equal(w[750],0);
 });
 test('detail profiling flag follows enablement and refreshed heap views',()=>{
 const r=Object.create(GPUFrontend.prototype);let heap=new Uint32Array(4);
 r.configureDetailProfiling(()=>heap,4);assert.equal(heap[1],0);
 r.syncDetailProfilingFlag(true);assert.equal(heap[1],1);
 heap=new Uint32Array(8);r.syncDetailProfilingFlag(true);assert.equal(heap[1],1);
 r.syncDetailProfilingFlag(false);assert.equal(heap[1],0);
 });
