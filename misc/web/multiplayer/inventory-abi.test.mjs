import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {writeInventory,createInventoryPoll,MAX_INVENTORY_BYTES} from './inventory-abi.mjs';
const item=(id,kind='equipment')=>({id:id.repeat(32),revision:5,section:'test_'+kind,place:'rucksack',state:{condition:.75,upgrades:['up_a'],payload:kind==='weapon'?{kind,cartridges:['ammo_a','ammo_b'],launcher_cartridges:['grenade'],selected_ammunition:'ammo_b',attachments:['scope'],fire_mode:2,launcher_mode:true,jammed:true}:kind==='equipment'?{kind}:kind==='ammunition'?{kind,rounds:12}:{kind,uses:2}}});
const view=(generation=7)=>({generation,life:3,alive:true,corpse:null,items:[{...item('a','weapon'),place:'slot:3'},item('b','ammunition'),item('c','consumable'),{...item('d'),place:'belt:2'}]});
test('invalid inventory never partially overwrites native memory',()=>{
 const invalid=[{...view(),generation:-1},{...view(),alive:false},{...view(),items:[item('a'),item('a')]},{...view(),items:[{...item('b'),place:'slot:14'}]}];
 const badWeapon=item('b','weapon');badWeapon.state.payload.cartridges=[null];invalid.push({...view(),items:[badWeapon]});
 const badJam=item('b','weapon');badJam.state.payload.jammed=1;invalid.push({...view(),items:[badJam]});
 for(const v of invalid){const heap=new Uint8Array(4096).fill(123);assert.throws(()=>writeInventory(v,heap,0,heap.length));assert.ok(heap.every(b=>b===123));}
 assert.throws(()=>writeInventory(view(),new Uint8Array(4096),0,48),/too small/);
});
test('inventory poll copies into the current heap before returning producer credit',()=>{
 let heap=new Uint8Array(4096),credits=0;
 const endpoint={closed:false,session:{},inventory:{view:view()},consumeInventory(){credits++;this.inventory=null;},close(){this.closed=true;}};
 const poll=createInventoryPoll(endpoint,()=>heap);assert.ok(poll(8n,4088)>48);assert.equal(credits,1);assert.equal(poll(0n,4096),0);
 heap=new Uint8Array(8192);endpoint.inventory={view:view(8)};poll(0n,8192);assert.equal(new DataView(heap.buffer).getBigUint64(8,true),8n);
 endpoint.inventory={view:view(9)};assert.equal(poll(0n,1),-1);assert.equal(credits,2);assert.equal(endpoint.closed,true);
});
test('real native parser preserves full item state and rejects truncation/rollback atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zone-inventory-abi-'));
 try{
  const bytes=new Uint8Array(MAX_INVENTORY_BYTES);let n=writeInventory(view(),bytes,0,bytes.length);await writeFile(join(dir,'items.bin'),bytes.subarray(0,n));
  n=writeInventory({generation:8,life:3,alive:false,corpse:'e'.repeat(32),items:[]},bytes,0,bytes.length);await writeFile(join(dir,'dead.bin'),bytes.subarray(0,n));
  const include=fileURLToPath(new URL('../../../src/xrGame/multiplayer/InventoryState.h',import.meta.url));
  await writeFile(join(dir,'test.cpp'),`#include "${include}"
#include <cassert>
#include <fstream>
#include <iterator>
std::vector<unsigned char> read(const char* p){std::ifstream f(p,std::ios::binary);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char** argv){
 assert(argc==3);zone::InventoryState state;auto bytes=read(argv[1]),dead=read(argv[2]);
 for(std::size_t n=0;n<bytes.size();++n)assert(!state.apply(bytes.data(),n));
 assert(!state.valid);assert(state.apply(bytes.data(),bytes.size()));assert(state.items.size()==4 && state.life==3 && state.generation==7);
 const auto& w=state.items[0];assert(w.id==std::string(32,'a') && w.revision==5 && w.placement==1 && w.index==3 && w.condition==.75f);
 assert(w.kind==3 && w.fireMode==2 && w.launcherMode && w.jammed && w.selectedAmmunition=="ammo_b");
 assert(w.upgrades==std::vector<std::string>{"up_a"} && w.attachments==std::vector<std::string>{"scope"});
 assert(w.cartridges.size()==2 && w.cartridges[0]=="ammo_a" && w.cartridges[1]=="ammo_b" && w.launcherCartridges[0]=="grenade");
 assert(state.items[1].quantity==12 && state.items[2].quantity==2 && state.items[3].placement==2 && state.items[3].index==2);
 assert(state.updates==1);assert(state.apply(bytes.data(),bytes.size()));assert(state.updates==2);
 auto corrupt=bytes;corrupt[8]=8;corrupt[72]=0;corrupt[73]=0;corrupt[74]=0x80;corrupt[75]=0x7f;
 assert(!state.apply(corrupt.data(),corrupt.size()));assert(state.generation==7 && state.items.size()==4);
 assert(state.apply(dead.data(),dead.size()));assert(!state.alive && state.items.empty() && state.corpse==std::string(32,'e'));
 assert(!state.apply(bytes.data(),bytes.size()));assert(!state.alive && state.items.empty());
 state.reset();assert(!state.valid);assert(state.apply(bytes.data(),bytes.size()));
}
`);
  execFileSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',join(dir,'test.cpp'),'-o',join(dir,'test')]);
  execFileSync(join(dir,'test'),[join(dir,'items.bin'),join(dir,'dead.bin')]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
