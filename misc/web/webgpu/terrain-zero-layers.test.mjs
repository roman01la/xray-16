import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {skipZeroTerrainLayers} from './terrain-zero-layers.js';
const source=()=>JSON.parse(readFileSync(new URL('./shaders/8e6475f989500874ab555720508e6ee956e30b51d38da4f1ccd0ac8def53318b.json',import.meta.url)));
test('stock terrain skips exact zeros and preserves the rest of the full fragment',()=>{
 const meta=source(),vertex=meta.stages.vert;
 assert.equal(skipZeroTerrainLayers(meta),true);
 assert.equal(meta.stages.vert,vertex);
 assert.equal((meta.stages.frag.match(/textureSampleGrad\(/g)||[]).length,8);
 assert.equal((meta.stages.frag.match(/ != 0\)/g)||[]).length,8);
 const key=meta.key,fragment=meta.stages.frag;
 assert.equal(skipZeroTerrainLayers(meta),false);
 assert.equal(meta.key,key);assert.equal(meta.stages.frag,fragment);
});
test('unknown or partially matching terrain shaders fall back atomically',()=>{
 for(const broken of ['active','layout']){
  const meta=source();if(broken==='active')meta.activeUniforms=[];
  else meta.stages.frag=meta.stages.frag.replace('textureSample(global_26,','unknownSample(global_26,');
  const before=JSON.stringify(meta);
  assert.equal(skipZeroTerrainLayers(meta),false);assert.equal(JSON.stringify(meta),before);
 }
});
