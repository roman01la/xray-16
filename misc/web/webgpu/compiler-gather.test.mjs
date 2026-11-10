import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWasmToolchain} from './wasm-toolchain.mjs';
import {compileProgram} from './compiler-core.mjs';
const toolchain=await createWasmToolchain({nagaBytes:await readFile(new URL('./compiler-wasm/naga.wasm',import.meta.url))});
function request(type,call){return {attributes:[],sources:{vert:'#version 300 es\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}',frag:`#version 300 es\nprecision highp float;\nuniform ${type} image;\nout vec4 color;\nvoid main(){color=${call};}`}};}
for(const component of [0,1,2,3])test(`sampled gather preserves channel ${component}`,async()=>{
 const p=await compileProgram(request('sampler2D',`textureGatherOffset(image,vec2(0.5),ivec2(-3,3),${component})`),toolchain);
 assert.match(p.stages.frag,new RegExp(`textureGather\\(${component}[iu]?,`));
 assert.match(p.stages.frag,/vec2<i32>\(-3i, 3i\)/);
});
test('comparison gather retains reference and constant offset',async()=>{
 const p=await compileProgram(request('sampler2DShadow','textureGatherOffset(image,vec2(0.5),0.25,ivec2(-3,3))'),toolchain);
 assert.match(p.stages.frag,/textureGatherCompare\(/);assert.match(p.stages.frag,/texture_depth_2d/);assert.match(p.stages.frag,/sampler_comparison/);assert.match(p.stages.frag,/0\.25f, vec2<i32>\(-3i, 3i\)/);
});
test('dynamic gather offsets are rejected instead of silently discarded',async()=>{
 await assert.rejects(()=>compileProgram(request('sampler2D','textureGatherOffset(image,vec2(0.5),ivec2(int(gl_FragCoord.x),0))'),toolchain),/ImageGatherExtended/);
});
test('multisample loads retain sample-frequency shading and need no sampler',async()=>{
 const p=await compileProgram(request('sampler2DMS','texelFetch(image,ivec2(0),gl_SampleID)'),toolchain);
 assert.match(p.stages.frag,/texture_multisampled_2d<f32>/);assert.match(p.stages.frag,/@builtin\(sample_index\)/);assert.doesNotMatch(p.stages.frag,/: sampler/);
 assert.deepEqual(p.activeBindings,[1]);
});
test('SPIR-V sample-mask array becomes an unsigned WGSL output builtin',async()=>{
 const r=request('sampler2D','vec4(1.0)');
 r.sources.frag=r.sources.frag.replace('color=vec4(1.0);','color=vec4(1.0);gl_SampleMask[0]=3;');
 const p=await compileProgram(r,toolchain);
 assert.match(p.stages.frag,/@builtin\(sample_mask\)/);
 assert.match(p.stages.frag,/u32/);
 assert.deepEqual(p.outputs,[0]);
});
