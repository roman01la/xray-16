// Run after sourcing emsdk_env.sh; compiles the production parser for wasm64.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {writeSnapshot,MAX_SNAPSHOT_BYTES} from './engine-abi.mjs';
const dir=await mkdtemp(join(tmpdir(),'zone-wasm-abi-'));
try {
  const header=fileURLToPath(new URL('../../../src/xrGame/multiplayer/Snapshot.h',import.meta.url));
  await writeFile(join(dir,'probe.cpp'),`#include "${header}"
#include <array>
zone::SnapshotState state;
std::array<unsigned char,zone::maxSnapshotBytes> buffer;
extern "C" {
unsigned char* address() {return buffer.data();}
int apply(unsigned size) {return state.apply(buffer.data(),size) ? int(state.entities.size()) : -1;}
unsigned tick() {return state.tick;}
void reset() {state.reset();}
}
`);
  const module=join(dir,'probe.mjs');
  execFileSync('em++',[join(dir,'probe.cpp'),'-O3','-std=c++17','--no-entry','-sMEMORY64=1','-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=node','-sEXPORTED_FUNCTIONS=["_address","_apply","_tick","_reset"]','-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',module],{stdio:'inherit'});
  const {default:create}=await import(pathToFileURL(module));const wasm=await create();
  const pointer=wasm._address();assert.equal(typeof pointer,'bigint');
  const e={id:1,x:12.25,y:2,z:-7,vx:0,vy:0,vz:1,yaw:1,health:100,kind:1,flags:0};
  let size=writeSnapshot({tick:0xffffffff,playerId:1,ack:5,entities:[e,{...e,id:2}]},wasm.HEAPU8,Number(pointer),MAX_SNAPSHOT_BYTES);
  assert.equal(wasm._apply(size),2);assert.equal(wasm._apply(size),-1);
  size=writeSnapshot({tick:0,playerId:1,ack:6,entities:[e]},wasm.HEAPU8,Number(pointer),MAX_SNAPSHOT_BYTES);
  assert.equal(wasm._apply(size),1);assert.equal(wasm._tick(),0);
  wasm._reset();assert.equal(wasm._apply(size),1);
  console.log('Optimized wasm64 adapter: pointer ABI, JS binary layout, tick wrap, despawn and reset passed.');
} finally {await rm(dir,{recursive:true,force:true});}
