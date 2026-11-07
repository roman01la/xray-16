import test from 'node:test';import assert from 'node:assert/strict';
import {attachMultiplayerLoader} from './loader-hooks.mjs';
const input='await installWebGPUBackend(msgData.shaderCompilerPort);createWasm();\nworker.postMessage({cmd:1,handlers,wasmMemory,wasmModule,shaderCompilerPort},[shaderCompilerPort])';
test('isolated loader transfers a dormant bridge to pool workers with fresh heap access',()=>{const out=attachMultiplayerLoader(input);assert.match(out,/getHeap:\(\)=>HEAPU8/);assert.match(out,/\[shaderCompilerPort,zonePort\]/);assert.match(out,/zoneEpoch:Module\["zoneEpoch"\]/);assert.equal(input.includes('zonePort'),false);});
test('loader hooks reject version drift and duplicate application',()=>{for(const s of ['',input+input,attachMultiplayerLoader(input)])assert.throws(()=>attachMultiplayerLoader(s),/hook/);});
