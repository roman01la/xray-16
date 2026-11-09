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
test('stock disabled quality options evaluate as zero while remaining undefined',async()=>{
  const request={attributes:[],sources:{
    vert:`#version 300 es
void main(){ gl_Position=vec4(0.0); }`,
    frag:`#version 300 es
precision highp float;
#if SUN_QUALITY > 0 || SSAO_QUALITY > 0
#error Off settings must evaluate as zero
#endif
#if defined(SUN_QUALITY) || defined(SSAO_QUALITY)
#error Off settings must remain undefined
#endif
#if !defined(GL_ES) || __VERSION__ != 310
#error Keep the ES profile during recovery
#endif
out vec4 color;
void main(){ color=vec4(1.0); }`,
  }};
  const result=await compileProgram(request,toolchain);
  assert.equal(result.key,shaderKey(request));
  assert.match(result.stages.frag,/@fragment/);
  const unrelated={...request,sources:{...request.sources,frag:request.sources.frag.replaceAll('SUN_QUALITY','UNEXPECTED_QUALITY')}};
  await assert.rejects(compileProgram(unrelated,toolchain),/undefined macro.*UNEXPECTED_QUALITY/);
});
