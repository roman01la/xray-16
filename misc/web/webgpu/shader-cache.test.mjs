import test from 'node:test';
import assert from 'node:assert/strict';
import {createShaderStore, SHADER_CACHE_VERSION} from './shader-cache.mjs';
import {shaderKey} from './shader-key.js';

const request = {sources:{frag:'fragment',vert:'vertex'},attributes:[]};
const program = {key:shaderKey(request), uniformPacking:1, attributes:[], activeUniforms:[], stages:{vert:'vertex',frag:'fragment'}};
function storage() {
  const items = new Map(), names = [];
  return {items,names,async open(name) {
    names.push(name);
    return {async match(url) {return items.get(url)?.clone();},
      async put(url,response) {items.set(url,response.clone());},
      async delete(url) {items.delete(url);}};
  }};
}
for (const origin of ['package','compiled']) test(`${origin} shaders persist in the same cache and survive worker restart`,async()=>{
  const cacheStorage = storage();
  let fetches=0, compiles=0;
  const options = {cacheStorage, baseURL:'https://game.test/webgpu/shader-cache.mjs',
    async fetchProgram() {fetches++;return new Response(origin==='package'?JSON.stringify(program):'',{status:origin==='package'?200:404});},
    async compile() {compiles++;return program;}};
  const first = createShaderStore(options);
  const [a,b] = await Promise.all([first.load(request),first.load(request)]);
  assert.deepEqual(a,program);assert.equal(a,b);
  assert.equal(fetches,1);assert.equal(compiles,origin==='compiled'?1:0);
  assert.equal(cacheStorage.items.size,1);
  assert.equal([...cacheStorage.items.keys()][0],`https://game.test/webgpu/shaders/${program.key}.json`);
  const second = createShaderStore({...options,fetchProgram(){throw Error('must use cache');},compile(){throw Error('must use cache');}});
  assert.deepEqual(await second.load(request),program);
  assert.deepEqual(cacheStorage.names,[SHADER_CACHE_VERSION,SHADER_CACHE_VERSION]);
});
test('corrupt cached and packaged artifacts are replaced by compiled results',async()=>{
  const cacheStorage=storage();
  const url=`https://game.test/shaders/${program.key}.json`;
  cacheStorage.items.set(url,new Response('{broken'));
  let compiles=0;
  const store=createShaderStore({cacheStorage,baseURL:'https://game.test/shader-cache.mjs',
    fetchProgram:async()=>new Response(JSON.stringify({...program,key:'wrong'})),
    compile:async()=>{compiles++;return program;}});
  assert.deepEqual(await store.load(request),program);
  assert.equal(compiles,1);
  assert.deepEqual(await cacheStorage.items.get(url).json(),program);
});
test('cache quota failure preserves playable shader and failed compilation can retry',async()=>{
  let attempts=0;
  const store=createShaderStore({cacheStorage:{async open(){throw Error('quota');}},
    fetchProgram:async()=>new Response('',{status:404}),
    compile:async()=>{if(++attempts===1)throw Error('bad shader');return program;}});
  await assert.rejects(store.load(request),/bad shader/);
  assert.deepEqual(await store.load(request),program);
  assert.equal(attempts,2);
});
