import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
test('particle reservation avoids early discard with production vertex stream rules',()=>{
 const dir=mkdtempSync(join(tmpdir(),'particle-stream-'));
 try{
 const root=resolve(import.meta.dirname,'../../../src/Layers/xrRender');
 const particle=readFileSync(join(root,'ParticleEffect.cpp'),'utf8');const count=particle.match(/Vertex.Lock\((p_cnt[^,]*), geom->vb_stride/)[1];
 const source=readFileSync(join(root,'R_DStreams.cpp'),'utf8');const functions=source.slice(source.indexOf('void* _VertexStream::Lock'),source.indexOf('void _VertexStream::reset_begin'));
 writeFileSync(join(dir,'test.cpp'),`#include <cassert>
#include <cstdio>
using u32=unsigned int;
#define XR_PLATFORM_WEB 1
#define R_ASSERT2(x,msg) assert(x)
#define VERIFY(x) assert(x)
struct _VertexStream{u32 mSize=65536*32,mPosition=0,mDiscardID=0;bool DiscardOnEveryLock=false;struct{char placeholder;void* Map(u32,u32,bool){return &placeholder;}void Unmap(u32){}}pVB;void* Lock(u32,u32,u32&);void Unlock(u32,u32);};
${functions}
int main(){_VertexStream before,after;u32 offset,p_cnt=1024;for(int i=0;i<100;++i){before.Lock(p_cnt*16,32,offset);before.Unlock(p_cnt*4,32);after.Lock(${count},32,offset);after.Unlock(p_cnt*4,32);}printf("%u %u",before.mDiscardID,after.mDiscardID);assert(after.mDiscardID<before.mDiscardID);}
`);const c=spawnSync('c++',['-std=c++17','-O2',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'8 6');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
