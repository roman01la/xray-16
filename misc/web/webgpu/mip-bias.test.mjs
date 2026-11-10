import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyMipBias} from './mip-bias.mjs';
import {compileProgram} from './compiler-core.mjs';
import {createWasmToolchain} from './wasm-toolchain.mjs';
const uniforms='uniform vec4 xr_webgpu_mip_bias; uniform sampler2D image; uniform sampler2DShadow shadow;';
test('LOD bias preserves shadow and explicit LOD semantics',()=>{
 const s=applyMipBias(uniforms+'void main(){texture(image, vec2(0)); texture(shadow, vec3(0)); textureLod(image,vec2(0),2.); texelFetch(image,ivec2(0),0);}');
 assert.match(s,/texture\(image, vec2\(0\), xr_webgpu_mip_bias.x\)/);
 assert.match(s,/texture\(shadow, vec3\(0\)\)/);
 assert.match(s,/textureLod\(image,vec2\(0\),2\.\)/);
 assert.match(s,/texelFetch\(image,ivec2\(0\),0\)/);
});
test('nested expressions and explicit bias retain their arguments',()=>{
 const s=applyMipBias(uniforms+'texture(image, texture(image, vec2(0)).xy, max(1.,2.)); textureGrad(image,vec2(0),vec2(1),vec2(2));');
 assert.match(s,/texture\(image, vec2\(0\), xr_webgpu_mip_bias.x\)/);
 assert.match(s,/\( max\(1\.,2\.\)\) \+ xr_webgpu_mip_bias.x/);
 assert.equal((s.match(/exp2\(xr_webgpu_mip_bias.x\)/g)||[]).length,2);
});
test('sidecar translates live bias to WGSL sample bias and gradients',async()=>{
 const toolchain=await createWasmToolchain({nagaBytes:await readFile(new URL('./compiler-wasm/naga.wasm',import.meta.url))});
 const program=await compileProgram({attributes:[],sources:{vert:'#version 300 es\nvoid main(){gl_Position=vec4(0);}',frag:'#version 300 es\nprecision highp float;\n'+uniforms+'out vec4 color; void main(){color=texture(image,gl_FragCoord.xy)+textureGrad(image,vec2(0),vec2(1),vec2(2));}'}},toolchain);
 assert.match(program.stages.frag,/textureSampleBias/);
 assert.match(program.stages.frag,/textureSampleGrad/);
 assert.match(program.stages.frag,/exp2/);
 assert(program.activeUniforms.some(u=>u.name==='xr_webgpu_mip_bias'));
});
