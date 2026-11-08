// Run after sourcing emsdk_env.sh; compiles the production parser for wasm64.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {writeSnapshot,MAX_SNAPSHOT_BYTES} from './engine-abi.mjs';
import {writeInventory,MAX_INVENTORY_BYTES} from './inventory-abi.mjs';
const dir=await mkdtemp(join(tmpdir(),'zone-wasm-abi-'));
try {
  const header=fileURLToPath(new URL('../../../src/xrGame/multiplayer/Snapshot.h',import.meta.url));
  const inventoryHeader=fileURLToPath(new URL('../../../src/xrGame/multiplayer/InventoryState.h',import.meta.url));
  const intentHeader=fileURLToPath(new URL('../../../src/xrGame/multiplayer/InventoryIntent.h',import.meta.url));
  await writeFile(join(dir,'probe.cpp'),`#include "${header}"
#include "${inventoryHeader}"
#include "${intentHeader}"
#include <array>
zone::SnapshotState state;
std::array<unsigned char,zone::maxSnapshotBytes> buffer;
zone::InventoryState inventory;
std::vector<unsigned char> inventoryBuffer(zone::maxInventoryBytes);
extern "C" {
void fire() {
  zone_weapon_fire(0xffffffffu, 0.5f, -0.25f, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  zone_weapon_fire(0, 0, 0, nullptr);
  zone_weapon_trigger_start(3, 0.25f, 0.5f, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  zone_weapon_trigger_stop();
}
void inventory_pickup() {zone_inventory_pickup("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",0xffffffffu,0x80000000u);}
void inventory_store() {zone_inventory_store("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",0xffffffffu,0x80000000u);}
void inventory_attachments() {
  zone_inventory_attach("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",0xffffffffu,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",0x90000000u,0x80000000u);
  zone_inventory_detach("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",0xffffffffu,0x80000000u,2);
}
void inventory_batch_begin() {zone_inventory_batch_begin();}
void inventory_batch_end() {zone_inventory_batch_end();}
void inventory_intent(unsigned action,unsigned index) {zone_inventory_intent("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",0xffffffffu,0x80000000u,action,index);}
unsigned char* address() {return buffer.data();}
int apply(unsigned size) {return state.apply(buffer.data(),size) ? int(state.entities.size()) : -1;}
unsigned tick() {return state.tick;}
void reset() {state.reset();}
unsigned char* inventory_address() {return inventoryBuffer.data();}
int inventory_apply(unsigned size) {return inventory.apply(inventoryBuffer.data(),size) ? int(inventory.items.size()) : -1;}
unsigned inventory_life() {return inventory.life;}
int inventory_alive() {return inventory.alive;}
}
`);
  const module=join(dir,'probe.mjs');
  execFileSync('em++',[join(dir,'probe.cpp'),'-O3','-std=c++17','--no-entry','-sMEMORY64=1','-sALLOW_MEMORY_GROWTH=1','-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=node','-sEXPORTED_FUNCTIONS=["_fire","_address","_apply","_tick","_reset","_inventory_address","_inventory_apply","_inventory_life","_inventory_alive","_inventory_intent","_inventory_batch_begin","_inventory_batch_end","_inventory_pickup","_inventory_store","_inventory_attachments"]','-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-o',module],{stdio:'inherit'});
  const {default:create}=await import(pathToFileURL(module));const wasm=await create();
  const shots=[];let released=0;
  globalThis.zoneEngineFire=(aim,item,held=false)=>shots.push({aim,item,held});
  globalThis.zoneEngineTriggerStop=()=>released++;
  try{
    wasm._fire();
    assert.deepEqual(shots,[{aim:{tick:0xffffffff,yaw:0.5,pitch:-0.25},item:'a'.repeat(32),held:false},{aim:{tick:0,yaw:0,pitch:0},item:null,held:false},{aim:{tick:3,yaw:0.25,pitch:0.5},item:'a'.repeat(32),held:true}]);
    assert.equal(released,1);
  }finally{delete globalThis.zoneEngineFire;delete globalThis.zoneEngineTriggerStop;}
  const batches=[];globalThis.zoneEngineInventoryBatch=async intents=>{batches.push(intents);};
  const intents=[];globalThis.zoneEngineInventoryMove=async intent=>{intents.push(intent);};
  try {
    for(const [action,index] of [[1,0],[2,0],[3,7],[4,2],[5,0],[6,0],[7,0],[9,0]])wasm._inventory_intent(action,index);
    assert.deepEqual(intents.map(i=>i.action),[{kind:'drop'},{kind:'place',placement:{kind:'rucksack'}},{kind:'place',placement:{kind:'slot',slot:7}},{kind:'place',placement:{kind:'belt',cell:2}},{kind:'reload'},{kind:'unload'},{kind:'nextAmmo'},{kind:'consume'}]);
    for(const intent of intents)assert.deepEqual({item:intent.item,revision:intent.revision,life:intent.life},{item:'a'.repeat(32),revision:0xffffffff,life:0x80000000});
    wasm._inventory_batch_begin();
    for(let i=0;i<40;i++)wasm._inventory_intent(1,0);
    assert.equal(batches.length,0);assert.equal(intents.length,8);
    wasm._inventory_batch_end();assert.equal(batches.length,1);assert.equal(batches[0].length,40);
    assert.ok(batches[0].every(i=>i.action.kind==='drop'&&i.revision===0xffffffff&&i.life===0x80000000));
    wasm._inventory_intent(1,0);assert.equal(intents.length,9);
    wasm._inventory_pickup();assert.deepEqual(intents.at(-1),{item:'a'.repeat(32),life:0x80000000,revision:0xffffffff,action:{kind:'pickup',source:'b'.repeat(32)}});
    wasm._inventory_batch_begin();wasm._inventory_store();wasm._inventory_batch_end();
    assert.deepEqual(batches.at(-1),[{item:'a'.repeat(32),life:0x80000000,revision:0xffffffff,action:{kind:'store',destination:'b'.repeat(32)}}]);
    wasm._inventory_intent(10,0);wasm._inventory_intent(10,1);
    assert.deepEqual(intents.slice(-2).map(i=>i.action),[{kind:'fireMode',next:false},{kind:'fireMode',next:true}]);
    wasm._inventory_intent(13,1);wasm._inventory_intent(13,0);
    assert.deepEqual(intents.slice(-2).map(i=>i.action),[{kind:'launcherMode',active:true},{kind:'launcherMode',active:false}]);
    wasm._inventory_attachments();
    assert.deepEqual(intents.slice(-2),[
      {item:'a'.repeat(32),life:0x80000000,revision:0xffffffff,action:{kind:'attach',addon:'b'.repeat(32),addonRevision:0x90000000}},
      {item:'a'.repeat(32),life:0x80000000,revision:0xffffffff,action:{kind:'detach',slot:'launcher'}},
    ]);
  } finally {delete globalThis.zoneEngineInventoryMove;delete globalThis.zoneEngineInventoryBatch;}
  const pointer=wasm._address();assert.equal(typeof pointer,'bigint');
  const e={id:1,x:12.25,y:2,z:-7,vx:0,vy:0,vz:1,yaw:1,health:100,kind:1,flags:0};
  let size=writeSnapshot({tick:0xffffffff,playerId:1,ack:5,entities:[e,{...e,id:2}]},wasm.HEAPU8,Number(pointer),MAX_SNAPSHOT_BYTES);
  assert.equal(wasm._apply(size),2);assert.equal(wasm._apply(size),-1);
  size=writeSnapshot({tick:0,playerId:1,ack:6,entities:[e]},wasm.HEAPU8,Number(pointer),MAX_SNAPSHOT_BYTES);
  assert.equal(wasm._apply(size),1);assert.equal(wasm._tick(),0);
  wasm._reset();assert.equal(wasm._apply(size),1);
  const inventoryPointer=Number(wasm._inventory_address());
  const inventory={generation:1,life:0,alive:true,corpse:null,items:[{id:'a'.repeat(32),revision:0,section:'bandage',place:'rucksack',state:{condition:1,upgrades:[],payload:{kind:'consumable',uses:1}}}]};
  size=writeInventory(inventory,wasm.HEAPU8,inventoryPointer,MAX_INVENTORY_BYTES);
  assert.equal(wasm._inventory_apply(size),1);assert.equal(wasm._inventory_life(),0);assert.equal(wasm._inventory_alive(),1);
  size=writeInventory({...inventory,generation:2,alive:false,corpse:'b'.repeat(32),items:[]},wasm.HEAPU8,inventoryPointer,MAX_INVENTORY_BYTES);
  assert.equal(wasm._inventory_apply(size),0);assert.equal(wasm._inventory_alive(),0);
  size=writeInventory(inventory,wasm.HEAPU8,inventoryPointer,MAX_INVENTORY_BYTES);
  assert.equal(wasm._inventory_apply(size),-1);assert.equal(wasm._inventory_alive(),0);
  console.log('Optimized wasm64 adapter: pointer ABI, JS binary layout, tick wrap, despawn and reset passed.');
  console.log('Optimized wasm64 inventory: coherent item state, death, stale-view rejection and native menu intents passed.');
} finally {await rm(dir,{recursive:true,force:true});}
