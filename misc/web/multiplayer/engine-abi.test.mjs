import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeSnapshot,createEnginePoll,MAX_SNAPSHOT_BYTES} from './engine-abi.mjs';
const entity=(id=1)=>({id,x:1.5,y:-2,z:3,vx:4,vy:0,vz:-6,yaw:.5,health:100,kind:1,flags:1});
const frame=(tick=1,entities=[entity()])=>({tick,playerId:1,ack:42,entities});
test('ABI rejects invalid frames before touching engine memory',()=>{
  for(const f of [frame(1,[entity(),entity()]),frame(1,[]),frame(1,[{...entity(),x:NaN}]),frame(1,[{...entity(),x:1e100}]),frame(1,[{...entity(),kind:2}]),frame(-1),frame(1,[{...entity(),flags:16}])]){
    const h=new Uint8Array(MAX_SNAPSHOT_BYTES).fill(123);assert.throws(()=>writeSnapshot(f,h,0,h.length));assert.ok(h.every(n=>n===123));
  }
  assert.throws(()=>writeSnapshot(frame(),new Uint8Array(60),1,60));
});
test('poll returns credit after copy, refreshes heap and clears on disconnect',()=>{
  let heap=new Uint8Array(100),consumed=0;
  const e={closed:false,session:{},snapshot:{snapshot:frame()},consumeSnapshot(){consumed++;this.snapshot=null;},close(){this.closed=true;}};
  const poll=createEnginePoll(e,()=>heap);
  assert.equal(poll(4n,96),60);assert.equal(consumed,1);assert.equal(poll(4n,96),0);
  heap=new Uint8Array(120);e.snapshot={snapshot:frame(2)};assert.equal(poll(8n,112),60);assert.equal(new DataView(heap.buffer).getUint32(16,true),2);
  e.closed=true;assert.equal(poll(8n,112),-1);
});
test('JS-produced frames pass the real C++ adapter; corrupt/stale frames are atomic',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zone-abi-'));
  try {
    const bytes=new Uint8Array(MAX_SNAPSHOT_BYTES);let n=writeSnapshot(frame(0xffffffff,[entity(2),entity()]),bytes,0,bytes.length);
    await writeFile(join(dir,'first.bin'),bytes.subarray(0,n));
    n=writeSnapshot(frame(0),bytes,0,bytes.length);await writeFile(join(dir,'second.bin'),bytes.subarray(0,n));
    const include=fileURLToPath(new URL('../../../src/xrGame/multiplayer/Snapshot.h',import.meta.url));
    await writeFile(join(dir,'test.cpp'),`#include "${include}"
#include <cassert>
#include <fstream>
#include <iterator>
std::vector<unsigned char> read(const char* p) {std::ifstream f(p,std::ios::binary);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char** argv) {
 assert(argc==3);zone::SnapshotState state;auto first=read(argv[1]),second=read(argv[2]);
 assert(state.apply(first.data(),first.size()));assert(state.tick==0xffffffffu);assert(state.ack==42);
 assert(state.entities.size()==2 && state.entities[0].id==1);assert(state.entities[0].x==1.5f && state.entities[0].y==-2);
 assert(!state.apply(first.data(),first.size()));assert(state.entities.size()==2);
 for(std::size_t n=0;n<second.size();++n)assert(!state.apply(second.data(),n));
 auto corrupt=second;corrupt[28]=0;corrupt[29]=0;corrupt[30]=0x80;corrupt[31]=0x7f;
 assert(!state.apply(corrupt.data(),corrupt.size()));assert(state.entities.size()==2);
 auto duplicate=first;duplicate[8]=0;duplicate[9]=0;duplicate[10]=0;duplicate[11]=0;
 for(int i=0;i<4;++i)duplicate[60+i]=duplicate[24+i];
 assert(!state.apply(duplicate.data(),duplicate.size()));assert(state.entities.size()==2);
 assert(state.apply(second.data(),second.size()));assert(state.tick==0 && state.entities.size()==1);
 assert(!state.apply(first.data(),first.size()));state.reset();assert(!state.valid && state.entities.empty());
 assert(state.apply(first.data(),first.size()));
}
`);
    execFileSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',join(dir,'test.cpp'),'-o',join(dir,'test')]);
    execFileSync(join(dir,'test'),[join(dir,'first.bin'),join(dir,'second.bin')]);
  } finally {await rm(dir,{recursive:true,force:true});}
});
