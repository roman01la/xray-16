import {readFile} from 'node:fs/promises';import {dirname,join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {createWasmMotor} from '../../misc/web/multiplayer/prediction.mjs';
const [path,fixturesPath]=process.argv.slice(2);
if(!path||!fixturesPath)throw Error('Usage: test-traversal-parity.mjs MANIFEST NATIVE_FIXTURES');
const manifest=JSON.parse(await readFile(path)),fixtures=JSON.parse(await readFile(fixturesPath));
assert.equal(manifest.sha256,fixtures.sha256);
const content={geometry:manifest.sha256,materials:manifest.materials.sha256};
const assets={geometry:new Uint8Array(await readFile(join(dirname(path),content.geometry+'.cform'))),materials:new Uint8Array(await readFile(join(dirname(path),content.materials+'.gamemtl')))};
const wasm=await readFile(resolve(import.meta.dirname,'../prediction/target/wasm32-unknown-unknown/release/zone_prediction.wasm'));
const motor=await createWasmMotor(content,assets,wasm);let maxDelta=0,checks=0,ticks=0;
for(const route of fixtures.routes){
 const [x,y,z]=route.spawn;motor.reset({x,y,z,vy:0,flags:0});
 const checkpoints=new Map(route.checkpoints.map(c=>[c.tick,c]));
 for(const [tick,command] of route.commands.entries()){
  motor.step(command);ticks++;
  if(!checkpoints.has(tick))continue;
  const expected=checkpoints.get(tick),state=motor.state();
  const delta=Math.hypot(state.x-expected.feet[0],state.y-expected.feet[1],state.z-expected.feet[2]);
  assert.ok(delta<.002,`Route ${route.spawn}, tick ${tick}: ${delta}m native/WASM difference`);
  assert.equal(state.grounded,expected.grounded);assert.equal(state.crouched,expected.crouched);
  maxDelta=Math.max(maxDelta,delta);checks++;
 }
}
console.log(JSON.stringify({routes:fixtures.routes.length,ticks,checks,maxDeltaMetres:maxDelta,scope:fixtures.scope},null,2));
