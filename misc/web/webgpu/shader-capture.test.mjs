import test from 'node:test';
import assert from 'node:assert/strict';
import {openShaderCapture,readShaderCapture} from './shader-capture.mjs';
import {compareCaptures} from './shader-coverage.mjs';
import {shaderKey} from './shader-key.js';

function memoryStorage() {
  const missing = () => new DOMException('Missing file','NotFoundError');
  function directory() {
    const handles = new Map();
    async function get(name, create, make) {
      if (!handles.has(name)) {
        if (!create) throw missing();
        handles.set(name,make());
      }
      return handles.get(name);
    }
    return {
      kind:'directory',
      getDirectoryHandle:(name,{create=false}={})=>get(name,create,directory),
      getFileHandle:(name,{create=false}={})=>get(name,create,()=>{
        let text;
        return {kind:'file', getFile:async()=>({text:async()=>text}),
          createWritable:async()=>({write:async value=>{text=value;},close:async()=>{},abort:async()=>{}})};
      }),
      entries:()=>handles.entries(),
    };
  }
  const root = directory();
  return {getDirectory:async()=>root};
}
const request = {sources:{
  frag:'#version 300 es\n// combine.ps_4_0\n#define SMAP_size\t2048\n',
  vert:'#version 300 es\n// combine.vs_4_0\n#define SKIN_NONE\t1\n',
},attributes:[]};
const options = new URLSearchParams('shaderCapture=zaton-default&shaderMap=zaton&shaderPreset=default');
const key = shaderKey(request);

test('captures a complete warm request once and compares to exact package keys',async()=>{
  const storage = memoryStorage();
  const capture = await openShaderCapture(options,storage);
  let reads = 0, checks = 0;
  const program = {key};
  const store = {load:async()=>{reads++;return program;},hasPackaged:async()=>{checks++;return false;}};
  assert.equal(await capture.load(store,request),program);
  assert.equal(await capture.load(store,request),program);
  assert.equal(reads,2);
  assert.equal(checks,1);
  const trace = await readShaderCapture('zaton-default',storage);
  assert.deepEqual(trace.records,[{key,inManifest:false,stages:{
    frag:{label:'combine.ps_4_0',options:['#define SMAP_size 2048']},
    vert:{label:'combine.vs_4_0',options:['#define SKIN_NONE 1']},
  },request,outcome:'loaded'}]);
  const comparison = compareCaptures([trace],new Set());
  assert.equal(comparison.report.missingKeys,1);
  assert.equal(comparison.report.missing[0].loaded,true);
  assert.equal(compareCaptures([trace],new Set([key])).report.missingKeys,0);
  assert.throws(()=>compareCaptures([trace,trace],new Set()),/duplicate/);
  assert.throws(()=>compareCaptures([{...trace,records:[{...trace.records[0],key:'wrong'}]}],new Set()),/Malformed/);
});

test('retains failures as diagnostics and updates the same key when it succeeds',async()=>{
  const storage = memoryStorage();
  const capture = await openShaderCapture(options,storage);
  const store = {load:async()=>{throw Error('invalid shader');},hasPackaged:async()=>true};
  await assert.rejects(capture.load(store,request),/invalid shader/);
  let trace = await readShaderCapture('zaton-default',storage);
  assert.equal(trace.records[0].outcome,'error');
  assert.equal(compareCaptures([trace],new Set()).report.missing[0].loaded,false);
  await capture.load({...store,load:async()=>({key})},request);
  trace = await readShaderCapture('zaton-default',storage);
  assert.equal(trace.records[0].inManifest,true);
  assert.equal(trace.records[0].outcome,'loaded');
  await assert.rejects(openShaderCapture(new URLSearchParams('shaderCapture=zaton-default&shaderMap=jupiter'),storage),/different settings/);
  await assert.rejects(readShaderCapture('../outside',storage),/Invalid shader capture name/);
});
