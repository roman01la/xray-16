import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {writeCorpseSearch,createCorpseSearchPoll} from './corpse-search-abi.mjs';
const view={source:'b'.repeat(32),life:4,generation:20,items:[{id:'a'.repeat(32),revision:7,section:'bandage',place:'rucksack',state:{condition:.75,upgrades:[],payload:{kind:'consumable',uses:2}}}]};
test('corpse ABI validates before writing and acknowledges only after copying',()=>{
 const heap=new Uint8Array(4096).fill(123),message={sequence:1,view};
 for(const [m,capacity] of [[message,24],[{...message,sequence:0},4096],[{sequence:1,view:{...view,source:'bad'}},4096]]){
  assert.throws(()=>writeCorpseSearch(m,heap,0,capacity));assert.ok(heap.every(b=>b===123));
 }
 let credits=0;const endpoint={session:{},corpseSearch:message,consumeCorpseSearch(){credits++;this.corpseSearch=null;},close(){this.closed=true;}};
 const poll=createCorpseSearchPoll(endpoint,()=>heap);assert.ok(poll(8n,4088)>24);assert.equal(credits,1);assert.equal(poll(0n,4096),0);
 endpoint.corpseSearch={sequence:2,view:null};assert.equal(poll(0n,4096),24);assert.equal(credits,2);
 endpoint.corpseSearch=message;assert.equal(poll(0n,1),-1);assert.equal(credits,2);assert.equal(endpoint.closed,true);
});
test('native corpse state switches sources, applies closure and rejects stale or malformed data atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zone-corpse-abi-'));
 try{
  for(const [name,message] of [['open',{sequence:1,view}],['switch',{sequence:2,view:{...view,source:'c'.repeat(32),generation:1}}],['close',{sequence:3,view:null}]]){
   const bytes=new Uint8Array(4096),size=writeCorpseSearch(message,bytes,0,4096);await writeFile(join(dir,name+'.bin'),bytes.subarray(0,size));
  }
  const header=fileURLToPath(new URL('../../../src/xrGame/multiplayer/CorpseSearchState.h',import.meta.url));
  await writeFile(join(dir,'test.cpp'),`#include "${header}"
#include <cassert>
#include <fstream>
#include <iterator>
std::vector<unsigned char> read(const char* path){std::ifstream f(path,std::ios::binary);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char**argv){assert(argc==4);auto bytes=read(argv[1]),other=read(argv[2]),closed=read(argv[3]);zone::CorpseSearchState state;
for(std::size_t n=0;n<bytes.size();++n)assert(!state.apply(bytes.data(),n));
assert(!state.open && state.sequence==0);assert(state.apply(bytes.data(),bytes.size()));
assert(state.open && state.state.corpse==std::string(32,'b') && state.state.life==4 && state.state.generation==20);
assert(state.state.items[0].revision==7 && state.state.items[0].quantity==2);
assert(!state.apply(bytes.data(),bytes.size()));
auto bad=other;bad[16]=0;assert(!state.apply(bad.data(),bad.size()));assert(state.state.corpse==std::string(32,'b'));
assert(state.apply(other.data(),other.size()));assert(state.state.corpse==std::string(32,'c') && state.state.generation==1);
assert(!state.apply(bytes.data(),bytes.size()));assert(state.apply(closed.data(),closed.size()));assert(!state.open && !state.state.valid && state.state.items.empty());
assert(!state.apply(other.data(),other.size()));state.reset();assert(state.apply(bytes.data(),bytes.size()));}
`);
  execFileSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',join(dir,'test.cpp'),'-o',join(dir,'test')]);execFileSync(join(dir,'test'),['open','switch','close'].map(n=>join(dir,n+'.bin')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
