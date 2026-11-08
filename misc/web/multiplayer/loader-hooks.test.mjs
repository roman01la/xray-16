import test from 'node:test';import assert from 'node:assert/strict';
import {attachMultiplayerLoader} from './loader-hooks.mjs';
const input='await installWebGPUBackend(msgData.shaderCompilerPort,msgData.gpuDiagnosticsChannel);createWasm();\nworker.postMessage({cmd:1,handlers,wasmMemory,wasmModule,shaderCompilerPort,gpuDiagnosticsChannel:globalThis.__xrayGPUDiagnosticsChannel},[shaderCompilerPort])';
test('isolated loader transfers a dormant bridge to pool workers with fresh heap access',()=>{const out=attachMultiplayerLoader(input);assert.match(out,/getHeap:\(\)=>HEAPU8/);assert.ok(out.includes('...(zonePort?[zonePort]:[])'));assert.ok(out.includes('Module["zoneBridge"]?.createPort()'));assert.match(out,/zoneEpoch:Module\["zoneEpoch"\]/);assert.equal(input.includes('zonePort'),false);});
test('loader hooks reject version drift and duplicate application',()=>{for(const s of ['',input+input,attachMultiplayerLoader(input)])assert.throws(()=>attachMultiplayerLoader(s),/hook/);});
test('same loader starts without a network bridge and transfers ports only for multiplayer',()=>{
 const statement=attachMultiplayerLoader(input).split('\n').at(-1),calls=[];
 const run=new Function('Module','worker','shaderCompilerPort','handlers','wasmMemory','wasmModule','globalThis',statement);
 const worker={postMessage:(message,ports)=>calls.push({message,ports})},shader={};
 run({},worker,shader,[],{},{},{});assert.deepEqual(calls[0].ports,[shader]);assert.equal(calls[0].message.zonePort,undefined);
 const network={};run({zoneBridge:{createPort:()=>network},zoneEpoch:'test'},worker,shader,[],{},{},{__xrayGPUDiagnosticsChannel:'test-tab'});
 assert.deepEqual(calls[1].ports,[shader,network]);assert.equal(calls[1].message.zoneEpoch,'test');
 assert.equal(calls[1].message.gpuDiagnosticsChannel,'test-tab');
});
