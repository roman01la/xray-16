import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('production light ordering retains capacity without changing order',()=>{
 const dir=mkdtempSync(join(tmpdir(),'light-scratch-'));
 try {
  const source=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRender_R2/r2_R_lights.cpp'),'utf8');
  const block=source.slice(source.indexOf('    // 2. refactor'),source.indexOf('    auto& cmd_list'));
  const shim=`#include <vector>
#include <algorithm>
#include <cassert>
#include <cstdlib>
#include <new>
#include <cstdio>
using u16=unsigned short;using u32=unsigned int;
static size_t allocations=0;
void* operator new(size_t n){++allocations;if(auto p=malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{free(p);}
template<class T>using xr_vector=std::vector<T>;
struct light{struct{struct{u32 size,posX,posY;}S;}X;struct{u16 smap_ID;}vis;};
struct SMAP_Rect{struct{u32 x,y;}min;};
struct{struct{u32 smapsize=1024;}o;}RImplementation;
struct{void initialize(u32){}bool push(SMAP_Rect&,u32){return true;}}LP_smap_pool;
struct Package{std::vector<light*>v_shadowed;};
void order(Package& LP){${block}}
int main(){Package p;light lights[3]{};lights[0].X.S.size=16;lights[1].X.S.size=32;lights[2].X.S.size=64;
for(int i=0;i<2;++i){p.v_shadowed.clear();for(auto& l:lights)p.v_shadowed.push_back(&l);order(p);}
auto before=allocations;
for(int i=0;i<100;++i){p.v_shadowed.clear();for(auto& l:lights)p.v_shadowed.push_back(&l);order(p);assert(p.v_shadowed[0]==&lights[0]&&p.v_shadowed[1]==&lights[1]&&p.v_shadowed[2]==&lights[2]);}
printf("%zu",allocations-before);}
`;
  writeFileSync(join(dir,'test.cpp'),shim);
  const counts=[];
  for(const web of [false,true]){
   const compile=spawnSync('c++',['-std=c++17','-O2',...(web?['-DXR_PLATFORM_WEB']:[]),join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});
   assert.equal(compile.status,0,compile.stderr);
   const run=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);counts.push(Number(run.stdout));
  }
  assert.deepEqual(counts,[100,0]);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
