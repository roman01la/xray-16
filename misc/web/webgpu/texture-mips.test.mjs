import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
test('production texture upload honors mip quality, exact bytes, cubes and BC alignment',()=>{
 const dir=mkdtempSync(join(tmpdir(),'texture-mips-'));
 try{
 const source=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRenderGL/glTexture.cpp'),'utf8');
 const start=source.indexOf('    xr_strlwr(fn);\n    // Honor');const block=source.slice(start,source.indexOf('\n#endif',start));
 const shim=`#include <vector>
#include <algorithm>
#include <cassert>
#include <cstdint>
using u8=uint8_t;using u32=uint32_t;using GLenum=int;template<class T>using xr_vector=std::vector<T>;
constexpr int GL_TEXTURE_CUBE_MAP_POSITIVE_X=100,GL_BLUE=7;
namespace gli{constexpr int TARGET_2D=2,SWIZZLE_RED=0;bool is_compressed(int f){return f==1;}size_t block_size(int){return 4;}bool is_target_cube(int t){return t==6;}}
struct Extent{int x,y,z;};struct Texture{int w,h,n,t,f;int target(){return t;}size_t levels(){return n;}int format(){return f;}Extent extent(size_t l){return {std::max(1,w>>l),std::max(1,h>>l),1};}size_t layers(){return 1;}size_t faces(){return t==6?6:1;}size_t size(size_t l){auto e=extent(l);return f==1?size_t((e.x+3)/4)*((e.y+3)/4)*8:size_t(e.x)*e.y*4;}const void* data(size_t,size_t,size_t){return nullptr;}};
struct{int Internal=0,External=0,Type=0,Swizzles[1]{0};}format;
void xr_strlwr(char*){}int quality=0;int get_texture_load_lod(char*){return quality;}
struct{void r_close(void*){}}FS;
int allocatedMips,width,height,uploads;size_t bytes;std::vector<int> mipIndices;
void CreateWebGPUTexture(u32* p,int,size_t m,int,int w,int h,int){*p=1;allocatedMips=m;width=w;height=h;}
void UploadWebGPUTexture(u32,int,int level,int,int,int,int,int,bool,const void*,size_t n){++uploads;bytes+=n;mipIndices.push_back(level);}
u32 load(Texture texture,u32& ret_msize){char fn[]="test";u32 pTexture=0,ret_width=0,ret_height=0;int target=texture.target(),ret_desc=0;void* S=nullptr;${block}}
void reset(){uploads=0;bytes=0;mipIndices.clear();}
int main(){u32 memory;quality=0;reset();load({1024,1024,11,2,1},memory);auto full=bytes;assert(uploads==11&&width==1024&&memory==bytes);
quality=1;reset();load({1024,1024,11,2,1},memory);assert(uploads==10&&width==512&&mipIndices.front()==0&&bytes==full-524288&&memory==bytes);
quality=2;reset();load({4,4,3,2,1},memory);assert(width==4&&uploads==3);reset();load({8,8,4,2,1},memory);assert(width==4&&uploads==3);
reset();load({8,8,4,6,1},memory);assert(width==8&&uploads==24);reset();load({8,8,4,2,0},memory);assert(width==2&&uploads==2&&bytes==20);reset();load({8,8,1,2,0},memory);assert(width==8&&uploads==1);}
`;
 writeFileSync(join(dir,'test.cpp'),shim);const c=spawnSync('c++',['-std=c++17','-O2',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
