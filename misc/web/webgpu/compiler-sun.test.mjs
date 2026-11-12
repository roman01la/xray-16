import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWasmToolchain} from './wasm-toolchain.mjs';
import {compileProgram} from './compiler-core.mjs';

const toolchain = await createWasmToolchain({
  nagaBytes: await readFile(new URL('./compiler-wasm/naga.wasm', import.meta.url)),
});
const shadow = await readFile(new URL('../../../res/gamedata/shaders/gl/shadow.h', import.meta.url), 'utf8');
const extreme = shadow.slice(shadow.indexOf('#if SUN_QUALITY>=4'), shadow.indexOf('// WebGPU comparison gathers'));

for (const comparisonGather of [false, true]) {
  test(`Extreme sun filter compiles with comparison gather ${comparisonGather ? 'enabled' : 'disabled'}`, async () => {
    const result = await compileProgram({
      attributes: [],
      sources: {
        vert: '#version 300 es\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}',
        frag: `#version 300 es
precision highp float;
#define SUN_QUALITY 4
#define SMAP_size 2048
${comparisonGather ? '#define SM_4_1 1' : ''}
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define int2 ivec2
#define saturate(value) clamp(value,0.0,1.0)
uniform sampler2D s_dmap;
uniform sampler2DShadow s_smap;
out vec4 color;
${extreme}
void main(){color=vec4(shadow_extreme_quality(vec3(gl_FragCoord.xy/2048.0,0.5)));}`,
      },
    }, toolchain);
    assert.match(result.stages.frag, /@fragment/);
    assert.match(result.stages.frag, /textureSampleLevel/);
    if (comparisonGather) assert.match(result.stages.frag, /textureGatherCompare/);
  });
}
