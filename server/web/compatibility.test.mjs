import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkGameCompatibility,showCompatibilityFailure} from './compatibility.mjs';
const supported=()=>({
 isSecureContext:true,crossOriginIsolated:true,SharedArrayBuffer,WebAssembly,Worker:class{},OffscreenCanvas:class{},
 HTMLCanvasElement:{prototype:{transferControlToOffscreen(){}}},
 FileSystemFileHandle:{prototype:{createWritable(){}}},
 navigator:{serviceWorker:{},locks:{request(){}},storage:{async getDirectory(){return {}}},
 gpu:{async requestAdapter(){return {features:new Set(['texture-compression-bc','texture-compression-bc-sliced-3d'])}}}},
});
test('current runtime validates real shared memory64 binary and supported environment passes',async()=>{
 assert.deepEqual(await checkGameCompatibility(supported()),[]);
});
test('Safari-like missing memory64, writable storage and GPU produce actionable reasons',async()=>{
 const env=supported();env.WebAssembly={validate:()=>false};delete env.navigator.gpu;delete env.FileSystemFileHandle;
 const missing=await checkGameCompatibility(env);
 assert.equal(missing.length,3);assert.match(missing.join(' '),/Memory64/);assert.match(missing.join(' '),/OPFS/);assert.match(missing.join(' '),/WebGPU/);
});
test('memory descriptor failure is caught even if wasm validation passes',async()=>{
 const env=supported();env.WebAssembly={validate:()=>true,Memory:class{constructor(){throw TypeError('BigInt')}}};
 assert.match((await checkGameCompatibility(env)).join(' '),/Memory64/);
});
test('blocked storage and disabled GPU are reported without writes',async()=>{
 const env=supported();env.navigator.storage.getDirectory=async()=>{throw Error('denied')};env.navigator.gpu.requestAdapter=async()=>null;
 assert.equal((await checkGameCompatibility(env)).length,2);
});
test('GPU compression requirements match actual launch requirements',async()=>{
 const env=supported();env.navigator.gpu.requestAdapter=async()=>({features:new Set(['texture-compression-bc'])});
 assert.match((await checkGameCompatibility(env))[0],/texture-compression-bc-sliced-3d/);
});
test('isolation, secure context, workers, offscreen canvas and locks are checked',async()=>{
 const env=supported();env.isSecureContext=false;env.crossOriginIsolated=false;delete env.Worker;delete env.OffscreenCanvas;delete env.navigator.locks;
 assert.equal((await checkGameCompatibility(env)).length,5);
});
test('failure hides loading progress and keeps Start disabled',()=>{
 const elements=Object.fromEntries(['boot-status','load-detail','load-progress','start-game','retry'].map(id=>['#'+id,{style:{}}]));
 showCompatibilityFailure(Error('Missing Memory64'),{querySelector:id=>elements[id]});
 assert.equal(elements['#load-progress'].hidden,true);assert.equal(elements['#start-game'].disabled,true);
 assert.match(elements['#load-detail'].textContent,/No engine or game assets/);
});
test('gate precedes release downloads and runtime imports; publishing keeps it in bootstrap',async()=>{
 const ui=await readFile(new URL('./game-ui.mjs',import.meta.url),'utf8');
 assert.ok(ui.indexOf('await requireGameCompatibility()')<ui.indexOf('await holdInstalledGame()'));
 assert.ok(ui.indexOf('await requireGameCompatibility()')<ui.indexOf("await import('./release-cache.mjs')"));
 const cache=await readFile(new URL('./release-cache.mjs',import.meta.url),'utf8');assert.match(cache,/\['', 'compatibility.mjs', 'index.html'/);
 const publish=await readFile(new URL('../tools/publish-web.py',import.meta.url),'utf8');
 assert.match(publish,/bootstrap=\{'index.html','game-ui.mjs'/);
 assert.match(publish,/bundle-web\.mjs/);
 const bundler=await readFile(new URL('../../misc/web/tools/bundle-web.mjs',import.meta.url),'utf8');
 assert.match(bundler,/'game-ui\.mjs'/);assert.match(bundler,/bundle:true/);
});
