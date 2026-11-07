import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWasmToolchain} from './wasm-toolchain.mjs';
import {compileProgram} from './compiler-core.mjs';
import {shaderKey} from './shader-key.js';
const toolchain = await createWasmToolchain({nagaBytes:await readFile(new URL('./compiler-wasm/naga.wasm',import.meta.url))});
const request = JSON.parse(await readFile(new URL('./sidecar-test-request.json',import.meta.url),'utf8'));
test('actual WASM compiler reproduces an offline game shader including reflection and packing',async()=>{
  const expected=JSON.parse(await readFile(new URL('./shaders/'+shaderKey(request)+'.json',import.meta.url),'utf8'));
  assert.deepEqual(await compileProgram(request,toolchain),expected);
});
test('compiler errors are reported and do not poison the parked WASM compiler',async()=>{
  await assert.rejects(compileProgram({sources:{frag:'not valid shader syntax',vert:'invalid'},attributes:[]},toolchain),/error|version|syntax/i);
  const result=await compileProgram(request,toolchain);
  assert.equal(result.key,shaderKey(request));
  assert.equal(result.uniformPacking,1);
});
