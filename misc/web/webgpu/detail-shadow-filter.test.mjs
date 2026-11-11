import test from 'node:test';
import assert from 'node:assert/strict';
import {DetailShadowFilter} from './detail-shadow-filter.js';
import {GPUFrontend} from './backend.js';

function laterCascadeOnly() {
  const r={retired:[]},filter=new DetailShadowFilter(r),geometry={};
  const output={},args={},params={};
  filter.beginFrame(1);
  filter.entries.set(geometry,{frame:1});
  filter.compact=(bundle)=>{
    Object.assign(bundle,{outputs:new Map([[geometry,output]]),groups:new Map([[geometry,{}]]),args,params});
    return new Map([[geometry,{output,args,slot:0}]]);
  };
  const program={uniforms:[{name:'m_WVP',type:'mat4',offset:0}],uniformData:new Uint8Array(64)};
  assert.ok(filter.cascadeJob(program,geometry,2));
  assert.equal(filter.bundles[0],undefined);
  return {r,filter,geometry,output,args,params};
}

test('purge retires stale outputs when an earlier sun cascade was skipped',()=>{
  const {r,filter,geometry,output,args,params}=laterCascadeOnly();
  filter.purge(1024);
  assert.equal(filter.entries.has(geometry),false);
  assert.equal(filter.bundles[1].outputs.size,0);
  assert.equal(filter.bundles[1].groups.size,0);
  assert.deepEqual(r.retired,[output]);
  filter.release();
  assert.deepEqual(r.retired,[output,args,params]);
});

test('release handles sparse cascade resources and is idempotent',()=>{
  const {r,filter,output,args,params}=laterCascadeOnly();
  filter.release();filter.release();
  assert.deepEqual(r.retired,[args,params,output]);
  assert.equal(filter.entries.size,0);
  assert.deepEqual(filter.bundles,[]);
});

test('disabled compaction preserves audit markers and bypasses filter jobs',()=>{
  const calls=[];
  const renderer={nativeShadowCascade:2,nativeGrassShadowFilterEnabled:false,
    grassShadowFilter:{beginFrame(){calls.push('frame');},cascadeJob(){calls.push('compact');return null;}}};
  const job=()=>GPUFrontend.prototype.grassShadowJob.call(renderer,{}, {}, {},3,1,0,0);
  assert.equal(job(),null);
  assert.equal(renderer.nativeShadowCascade,2);
  assert.deepEqual(calls,[]);
  renderer.nativeGrassShadowFilterEnabled=true;
  assert.equal(job(),null);
  assert.deepEqual(calls,['frame','compact']);
});
