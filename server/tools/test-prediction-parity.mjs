// Runs actual browser WASM motor on the owned map and compares the native probe.
import {readFile} from 'node:fs/promises';import {resolve,dirname,join} from 'node:path';import assert from 'node:assert/strict';
import {createWasmMotor} from '../../misc/web/multiplayer/prediction.mjs';
const [manifestPath,probePath,idlePath]=process.argv.slice(2);if(!manifestPath||!probePath)throw Error('Usage: test-prediction-parity.mjs MANIFEST NATIVE_PROBE_JSON');
const m=JSON.parse(await readFile(manifestPath)),probe=JSON.parse(await readFile(probePath));
assert.equal(probe.sha256,m.sha256);assert.ok(probe.motor);
const assets={geometry:new Uint8Array(await readFile(join(dirname(manifestPath),m.sha256+'.cform'))),materials:new Uint8Array(await readFile(join(dirname(manifestPath),m.materials.sha256+'.gamemtl')))};
const wasm=await readFile(resolve(import.meta.dirname,'../prediction/target/wasm32-unknown-unknown/release/zone_prediction.wasm'));
const start=performance.now();const motor=await createWasmMotor(m.level,{geometry:m.sha256,materials:m.materials.sha256},assets,wasm);
const initMs=performance.now()-start;
const [x,y,z]=probe.motor.spawn;motor.reset({x,y,z,vy:0,flags:0});
for(let i=0;i<probe.motor.ticks;i++)motor.step({x:1,z:0,sprint:false});
const actual=motor.state(),delta=Math.hypot(actual.x-probe.motor.end[0],actual.y-probe.motor.end[1],actual.z-probe.motor.end[2]);
assert.ok(delta<0.002,`Native/WASM motor divergence ${delta} m`);
let idleMaxDelta=0;
if(idlePath)for(const fixture of JSON.parse(await readFile(idlePath))){
 const [x,y,z]=fixture.spawn;motor.reset({x,y,z,vy:0,flags:0});
 for(let i=0;i<fixture.idleTicks;i++)motor.step({x:0,z:0,sprint:false});
 const state=motor.state(),difference=Math.hypot(state.x-fixture.end[0],state.y-fixture.end[1],state.z-fixture.end[2]);
 assert.ok(difference<0.002,`Idle native/WASM divergence ${difference}`);idleMaxDelta=Math.max(idleMaxDelta,difference);
}
console.log(JSON.stringify({idleMaxDelta,ticks:probe.motor.ticks,initMs,deltaMetres:delta,actual,wasmBytes:wasm.length},null,2));
