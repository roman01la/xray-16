import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {writeWorldItems,createWorldItemsPoll} from './world-items-abi.mjs';
const view={generation:1,life:0,storage:{id:'d'.repeat(32),position:[4,5,6],rotation:[0,.5,0]},items:[{id:'a'.repeat(32),revision:7,section:'bandage',state:{condition:.75,upgrades:[],payload:{kind:'consumable',uses:2}},source:'b'.repeat(32),position:[1.25,-2,3]}]};
test('world ABI validates before writes and returns worker credit only after copying',()=>{
 const heap=new Uint8Array(4096).fill(123);
 assert.throws(()=>writeWorldItems({...view,items:[{...view.items[0],position:[NaN,0,0]}]},heap,0,4096));assert.ok(heap.every(b=>b===123));
 assert.throws(()=>writeWorldItems(view,heap,0,1));assert.ok(heap.every(b=>b===123));
 let credits=0;const endpoint={session:{},worldItems:{view},consumeWorldItems(){credits++;this.worldItems=null;},close(){this.closed=true;}};
 const poll=createWorldItemsPoll(endpoint,()=>heap);assert.ok(poll(8n,4088)>8);assert.equal(credits,1);assert.equal(poll(0n,4096),0);
 endpoint.worldItems={view};assert.equal(poll(0n,1),-1);assert.equal(credits,1);assert.equal(endpoint.closed,true);
});
test('native world parser preserves item/source pairing and rejects malformed data atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zone-world-abi-'));
 try{
  const bytes=new Uint8Array(4096);const size=writeWorldItems(view,bytes,0,bytes.length);await writeFile(join(dir,'world.bin'),bytes.subarray(0,size));
  const header=fileURLToPath(new URL('../../../src/xrGame/multiplayer/WorldItemsState.h',import.meta.url));
  await writeFile(join(dir,'test.cpp'),`#include "${header}"
#include <cassert>
#include <fstream>
#include <iterator>
int main(int argc,char** argv){assert(argc==2);std::ifstream f(argv[1],std::ios::binary);std::vector<unsigned char> bytes{std::istreambuf_iterator<char>(f),{}};zone::WorldItemsState state;
for(std::size_t n=0;n<bytes.size();++n)assert(!state.apply(bytes.data(),n));assert(!state.state.valid);
assert(state.apply(bytes.data(),bytes.size()));assert(state.state.items.size()==1 && state.locations.size()==1);
assert(state.state.items[0].id==std::string(32,'a') && state.state.items[0].revision==7 && state.state.items[0].quantity==2);
assert(state.storage && state.storage->source==std::string(32,'d') && state.storage->position[1]==5.f && state.storage->rotation[1]==.5f);
assert(state.locations[0].source==std::string(32,'b') && state.locations[0].position[0]==1.25f && state.locations[0].position[1]==-2.f);
auto bad=bytes;bad[bad.size()-1]=0x7f;bad[bad.size()-2]=0x80;assert(!state.apply(bad.data(),bad.size()));assert(state.locations[0].position[2]==3.f);
bad=bytes;bad[16]=0;assert(!state.apply(bad.data(),bad.size()));assert(state.state.generation==1);
state.reset();assert(!state.state.valid && state.locations.empty() && !state.storage);assert(state.apply(bytes.data(),bytes.size()));}
`);
  execFileSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',join(dir,'test.cpp'),'-o',join(dir,'test')]);execFileSync(join(dir,'test'),[join(dir,'world.bin')]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
