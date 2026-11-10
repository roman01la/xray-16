import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Compile the production cache helper used by visibility and draw submission.
test('detail cache invalidates only affected object/classes, retaining unchanged majority',()=>{
  const header=new URL('../../../src/Layers/xrRender/DetailInstanceCache.h',import.meta.url).pathname;
  const dir=mkdtempSync(join(tmpdir(),'detail-cache-'));
  try {
    writeFileSync(join(dir,'test.cpp'),`
#include "${header}"
#include <vector>
#include <array>
#include <cassert>
using namespace xray::detail_cache;
struct List {uint64_t revision=0,uploadedRevision=0;uint32_t storageIndex=0;size_t length=1;size_t size()const{return length;}};
int main() {
 std::array<std::array<List,3>,30> slots{};
 std::array<std::vector<List*>,90> visible;
 std::array<std::vector<uint32_t>,90> saved;
 uint32_t count;
 for(int n=0;n<90;++n){slots[n/3][n%3].storageIndex=n*16;visible[n]={&slots[n/3][n%3]};assert(updateSignature(visible[n],saved[n],count));}
 auto updates=[&]{int changed=0;for(int n=0;n<90;++n){bool dirty=updateSignature(visible[n],saved[n],count);for(auto* list:visible[n]){dirty|=needsUpload(*list);list->uploadedRevision=list->revision;}changed+=dirty;}return changed;};
 for(int frame=0;frame<100;++frame)assert(updates()==0);
 invalidate(slots[4],1,1); assert(updates()==1); // scale: one object/class
 invalidate(slots[4],1,2); assert(updates()==2); // old+new,88 untouched
 invalidate(slots[4],2,255); assert(updates()==1); // cull
 invalidate(slots[4],255,255); assert(updates()==0); // invisible scale
 for(auto& list:slots[5])++list.revision; assert(updates()==3); // pooled transform/sun/hemi
 assert(updates()==0); // second pass
 visible[0].push_back(&slots[1][0]); assert(updates()==1);
 std::swap(visible[0][0],visible[0][1]);assert(updates()==1); // exact order
 visible[0].erase(visible[0].begin());assert(updates()==1);
 visible[0].clear();assert(updates()==1);
 visible[0]={&slots[0][0]};assert(updates()==1);
 ++slots[0][0].revision;assert(updates()==1); // identity reused with new data
 ++slots[0][0].storageIndex;assert(updates()==1); // GPU range reused/reallocated
 ++slots[0][0].length;assert(updates()==1); // same identity, different count
 assert(!updateSignature(visible[0],saved[0],count));assert(count==2);
 slots[0][0].storageIndex=uint32_t(-1);assert(needsUpload(slots[0][0])); // eviction
 slots[0][0].storageIndex=900;assert(updates()==1);assert(updates()==0);
}

`);
    const built=spawnSync('c++',['-std=c++17','-DXR_PLATFORM_WEB',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const ran=spawnSync(join(dir,'test'),[],{encoding:'utf8'});
    assert.equal(ran.status,0,ran.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
