import test from 'node:test';
import assert from 'node:assert/strict';
import {createShaderStore, SHADER_CACHE_VERSION, validateProgram} from './shader-cache.mjs';
import {shaderKey} from './shader-key.js';
import {migrateLegacyCache} from '../../../server/web/opfs-store.mjs';

const request = {sources:{frag:'fragment',vert:'vertex'},attributes:[]};
const program = {key:shaderKey(request), uniformPacking:1, attributes:[], activeUniforms:[], stages:{vert:'vertex',frag:'fragment'}};
function storage() {
  const items = new Map(), names = [];
  return {items,names,async openStore(name) {
    names.push(name);
    return {get:async key=>items.get(key),put:async (key,bytes)=>items.set(key,new Blob([bytes]))};
  }};
}
for (const origin of ['package','compiled']) test(`${origin} shaders persist in the same cache and survive worker restart`,async()=>{
  const cacheStorage = storage();
  let fetches=0, compiles=0;
  const options = {openStore:cacheStorage.openStore, baseURL:'https://game.test/webgpu/shader-cache.mjs',
    async fetchProgram() {fetches++;return new Response(origin==='package'?JSON.stringify(program):'',{status:origin==='package'?200:404});},
    async compile() {compiles++;return program;}};
  const first = createShaderStore(options);
  const [a,b] = await Promise.all([first.load(request),first.load(request)]);
  assert.deepEqual(a,program);assert.equal(a,b);
  assert.equal(fetches,1);assert.equal(compiles,origin==='compiled'?1:0);
  assert.equal(cacheStorage.items.size,1);
  assert.equal([...cacheStorage.items.keys()][0],program.key);
  const second = createShaderStore({...options,fetchProgram(){throw Error('must use cache');},compile(){throw Error('must use cache');}});
  assert.deepEqual(await second.load(request),program);
  assert.deepEqual(cacheStorage.names,[SHADER_CACHE_VERSION,SHADER_CACHE_VERSION]);
});
test('corrupt cached and packaged artifacts are replaced by compiled results',async()=>{
  const cacheStorage=storage();
  cacheStorage.items.set(program.key,new Blob(['{broken']));
  let compiles=0;
  const store=createShaderStore({openStore:cacheStorage.openStore,baseURL:'https://game.test/shader-cache.mjs',
    fetchProgram:async()=>new Response(JSON.stringify({...program,key:'wrong'})),
    compile:async()=>{compiles++;return program;}});
  assert.deepEqual(await store.load(request),program);
  assert.equal(compiles,1);
  assert.deepEqual(JSON.parse(await cacheStorage.items.get(program.key).text()),program);
});
test('cache quota failure preserves playable shader and failed compilation can retry',async()=>{
  let attempts=0;
  const store=createShaderStore({async openStore(){throw Error('quota');},
    fetchProgram:async()=>new Response('',{status:404}),
    compile:async()=>{if(++attempts===1)throw Error('bad shader');return program;}});
  await assert.rejects(store.load(request),/bad shader/);
  assert.deepEqual(await store.load(request),program);
  assert.equal(attempts,2);
});

test('unchanged shader artifacts survive versioned deployments and rollback',async()=>{
 const cacheStorage=storage();let fetches=0,compiles=0;
 const options={openStore:cacheStorage.openStore,fetchProgram:async()=>{fetches++;return new Response(JSON.stringify(program));},compile:async()=>{compiles++;return program;}};
 for(const version of ['v1','v2','v1']){
  const store=createShaderStore({...options,baseURL:`https://game.test/releases/${version}/shader-cache.mjs`});
  assert.deepEqual(await store.load(request),program);
 }
 assert.equal(fetches,1);assert.equal(compiles,0);assert.equal(cacheStorage.items.size,1);
});
test('runtime shaders outside the shipped manifest survive migration',async()=>{
 const opfs=storage(),url=`https://game.test/releases/v1/shaders/${program.key}.json`;
 let retired=false;
 const cacheStorage={has:async()=>!retired,delete:async()=>{retired=true;},open:async()=>({
   keys:async()=>[{url}],match:async()=>Response.json(program),delete:async()=>true,
 })};
 const migrate=store=>migrateLegacyCache({cacheStorage,name:SHADER_CACHE_VERSION,store,retire:true,
  identify:url=>url.pathname.match(/\/shaders\/([a-f0-9]{64})\.json$/)?.[1],
  validate:async (file,key)=>!!validateProgram(JSON.parse(await file.text()),key)});
 const store=createShaderStore({openStore:opfs.openStore,migrate,
  fetchManifest:async()=>Response.json({version:3,keys:[],shaderCount:0}),
  fetchProgram:()=>assert.fail('unexpected shader download'),compile:()=>assert.fail('unexpected compilation')});
 await store.preload();
 assert.deepEqual(await store.load(request),program);
 assert.ok(opfs.items.has(program.key));
 assert.ok(retired);
});

test('the release index eliminates HTTP requests for unpackaged shader variants', async () => {
  const changed = {...request, sources:{...request.sources, vert:'other vertex'}};
  const runtimeProgram = {...program, key:shaderKey(changed)};
  const baseURL = 'https://game.test/releases/v3/shader-cache.mjs';
  const requests = [], reports = [];
  const store = createShaderStore({
    openStore:storage().openStore, baseURL, report:event=>reports.push(event),
    async fetchManifest(url) {
      requests.push(String(url));
      return Response.json({version:3, shaderCount:1, keys:[program.key]});
    },
    async fetchProgram(url) {
      requests.push(url);
      return Response.json(program);
    },
    async compile(value) {
      assert.deepEqual(value, changed);
      return runtimeProgram;
    },
  });
  assert.deepEqual(await store.load(changed), runtimeProgram);
  assert.deepEqual(await store.load(request), program);
  assert.deepEqual(requests, [
    'https://game.test/releases/v3/shader-manifest.json',
    'https://game.test/releases/v3/shaders/'+program.key+'.json',
  ]);
  assert.deepEqual(reports.map(event=>event.source), ['compiled', 'package']);
});

test('startup installs every packaged shader, then gameplay compiles new variants without HTTP',async()=>{
  const next={...request,sources:{...request.sources,vert:'changed vertex'}},added={...program,key:shaderKey(next)};
  const unknown={...request,sources:{...request.sources,vert:'runtime only'}},runtime={...program,key:shaderKey(unknown)};
  const cacheStorage=storage(),downloads=[],reported=[];
  const make=version=>createShaderStore({openStore:cacheStorage.openStore,report:event=>reported.push(event.source),baseURL:`https://game.test/${version}/shader-cache.mjs`,
    fetchManifest:async()=>{const keys=version==='v1'?[program.key]:[program.key,added.key];return Response.json({version:3,shaderCount:keys.length,keys});},
    fetchProgram:async url=>{downloads.push(url);return Response.json(url.includes(program.key)?program:added);},
    compile:async value=>{assert.deepEqual(value,unknown);return runtime;}});
  const first=make('v1');await first.preload();
  assert.deepEqual(await first.load(request),program);
  assert.deepEqual(await first.load(unknown),runtime);
  assert.equal(downloads.length,1);
  const second=make('v2');await second.preload();
  assert.deepEqual(await second.load(request),program);
  assert.deepEqual(await second.load(next),added);
  assert.deepEqual(await second.load(unknown),runtime);
  assert.deepEqual(downloads,[`https://game.test/v1/shaders/${program.key}.json`,`https://game.test/v2/shaders/${added.key}.json`]);
  assert.deepEqual(reported,['package','compiled','cache','package','cache']);
});
