import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {installDetailInstancing} from './detail-instancing.js';
import {GPUFrontend} from './backend.js';
import {EngineFormat} from './engine-formats.js';
import {specializeVertex} from './vertex-conversion.js';

test('all packaged wind/static detail variants retain shader math and acquire unique instance layouts',async()=>{
  let tested=0;
  for(const file of await readdir(new URL('./shaders/',import.meta.url))) {
    if(!file.endsWith('.json'))continue;
    const meta=JSON.parse(await readFile(new URL('./shaders/'+file,import.meta.url),'utf8'));
    const oldKey=meta.key, fragment=meta.stages.frag;
    if(!installDetailInstancing(meta))continue;
    tested++;
    assert.equal(meta.key,oldKey+':detail-instances-v1');
    assert.equal(meta.stages.frag,fragment);
    assert.deepEqual(meta.attributes.slice(-4).map(a=>a.location),[12,13,14,15]);
    assert.match(meta.stages.vert,/xr_detail_rows = array<vec4<f32>, 4>/);
    assert.equal((meta.stages.vert.match(/@location\(1[2-5]\)/g)||[]).length,4);
    assert.match(specializeVertex(meta.stages.vert,[{location:8,scalar:'i32'}]),/@location\(8\)\s+\w+: vec4<i32>/);
    const stable=meta.stages.vert;
    assert.equal(installDetailInstancing(meta),true);
    assert.equal(meta.stages.vert,stable);
  }
  assert.ok(tested>=16,'wind, static and alpha/shadow variants must be covered');
});

test('native detail submission retains instance geometry across count and buffer-allocation changes',()=>{
  const r=Object.create(GPUFrontend.prototype),decl={},vertices={},indices={},instances={},program={};
  const calls=[];
  r.programs=new WeakMap([[program,{detailInstancing:true}]]);
  r.directDeclarations=new WeakMap();
  r.registerDeclaration(decl,new Uint32Array([3,3,EngineFormat.FLOAT,0,0,8,4,EngineFormat.SHORT,0,12]));
  r.encodeDraw=(...args)=>calls.push(args);
  r.submitDraw(decl,vertices,indices,20,program,EngineFormat.TRIANGLES,true,12,6,17,instances,130);
  const geometry=calls[0][1];
  assert.equal(calls[0][5],130);assert.equal(calls[0][6],6);assert.equal(calls[0][7],17);
  assert.deepEqual([...geometry.attrs].slice(-4).map(([n,a])=>[n,a.stride,a.offset,a.divisor,a.buffer]),[0,1,2,3].map(i=>[12+i,64,i*16,1,instances]));
  r.submitDraw(decl,vertices,indices,20,program,EngineFormat.TRIANGLES,true,12,6,17,instances,70000);
  assert.equal(calls[1][1],geometry);assert.equal(calls[1][5],70000);
  assert.throws(()=>r.submitDraw(decl,vertices,indices,20,program,EngineFormat.TRIANGLES,true,12,6,17),/requires instance/);
});

test('explicit bulk replacement preserves neighboring uniforms and overlaps scalar writes',()=>{
  const r=Object.create(GPUFrontend.prototype),program={uniformLocsById:[{name:'bones'},{name:'bones[1]'}]};
  const p={uniformData:new Uint8Array(80),uniformVersion:0,
    uniformByName:new Map([['bones',{name:'bones',type:'vec4',count:4,columns:1,rows:4,offset:16,stride:16}]])};
  new Float32Array(p.uniformData.buffer).fill(99);
  r.programs=new WeakMap([[program,p]]);
  const memory=new ArrayBuffer(128),w=new Uint32Array(memory),f=new Float32Array(memory),i=new Int32Array(memory);
  w.set([1,0,4,8]);f.set([1,2,3,4,5,6,7,8],4);
  r.consumeUniformBatch(w,f,i,0,12,[null,program]);
  assert.deepEqual([...new Float32Array(p.uniformData.buffer)], [99,99,99,99,1,2,3,4,5,6,7,8,99,99,99,99,99,99,99,99]);
  w.set([1,1,0,4]);f.set([9,10,11,12],4);r.consumeUniformBatch(w,f,i,0,8,[null,program]);
  assert.deepEqual([...new Float32Array(p.uniformData.buffer).slice(8,12)],[9,10,11,12]);
  w.set([1,1,4,4]);f.set([5,6,7,8],4);r.consumeUniformBatch(w,f,i,0,8,[null,program]);
  assert.deepEqual([...new Float32Array(p.uniformData.buffer).slice(8,12)],[5,6,7,8]);
  assert.equal(p.uniformVersion,3);
  w.set([1,1,4,13]);assert.throws(()=>r.consumeUniformBatch(w,f,i,0,17,[null,program]),/Invalid vector-array/);
});

