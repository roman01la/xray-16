// Run from the workspace after capturing shaders. Verifies the actual WASM
// modules against every available offline artifact, without accepting cache hits.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createWasmToolchain} from './wasm-toolchain.mjs';
import {compileProgram} from './compiler-core.mjs';
import assert from 'node:assert/strict';
const toolchain = await createWasmToolchain({nagaBytes:await readFile(new URL('./compiler-wasm/naga.wasm',import.meta.url))});
const samples=[], failures=[];
let reconstructedRequests=0;
for(const file of (await readdir(new URL('./shaders/',import.meta.url))).filter(x=>/^[a-f0-9]{64}\.json$/.test(x)).sort()) {
  const key=file.slice(0,-5), start=performance.now();
  try {
    const expected=JSON.parse(await readFile(new URL('./shaders/'+file,import.meta.url),'utf8'));
    let request, reconstructed=false;
    try { request=JSON.parse(await readFile(resolve('.cache/webgpu-shaders',key,'request.json'),'utf8')); }
    catch (error) {
      if(error.code!=='ENOENT')throw error;
      // Older captures retained preprocessed inputs but not the request envelope.
      // Recover active attribute locations from their offline reflection, and
      // compare every output field except the unrecoverable original request key.
      const sources={};
      for(const stage of Object.keys(expected.stages)) sources[stage]=(await readFile(resolve('.cache/webgpu-shaders',key,stage+'.input'),'utf8')).replace('#version 310 es','#version 300 es');
      request={sources,attributes:expected.attributes.map(({name,location})=>({name,location}))};
      reconstructed=true;
    }
    const actual=await compileProgram(request,toolchain);
    if(reconstructed) {actual.key=expected.key;reconstructedRequests++;}
    assert.deepEqual(actual,expected);
    samples.push(performance.now()-start);
  } catch(error) {failures.push({key,error:String(error)});}
  if((samples.length+failures.length)%50===0)console.log({passed:samples.length,failed:failures.length});
}
samples.sort((a,b)=>a-b);
const result={passed:samples.length,reconstructedRequests,failures,medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*.95)],totalMs:samples.reduce((a,b)=>a+b,0)};
await writeFile('shader-sidecar-corpus-result.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,failures:failures.map(x=>({key:x.key,error:x.error.slice(0,400)}))},null,2));
if(failures.length)process.exitCode=1;
