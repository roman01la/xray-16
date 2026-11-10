import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
test('bone bounds conservatively contain all transformed corners including shear and large coordinates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bone-bounds-'));try{
 const header=resolve(import.meta.dirname,'../../../src/Layers/xrRender/ConservativeBoneBounds.h');
 writeFileSync(join(dir,'probe.cpp'),`#include <algorithm>
#include <random>
#include <cassert>
#include "${header}"
struct V{float x,y,z;void set(float a,float b,float c){x=a;y=b;z=c;}};
struct M{float _11,_12,_13,_21,_22,_23,_31,_32,_33,_41,_42,_43;};
struct B{V lo{1e30f,1e30f,1e30f},hi{-1e30f,-1e30f,-1e30f};void modify(V p){lo.set(std::min(lo.x,p.x),std::min(lo.y,p.y),std::min(lo.z,p.z));hi.set(std::max(hi.x,p.x),std::max(hi.y,p.y),std::max(hi.z,p.z));}};
int main(){std::mt19937 rng(71);std::uniform_real_distribution<float>d(-20,20);for(int n=0;n<100000;n++){M m;float* v=&m._11;for(int i=0;i<12;i++)v[i]=d(rng);if(n%3==0){m._41*=100000;m._42*=100000;m._43*=100000;}V h{std::abs(d(rng)),std::abs(d(rng)),std::abs(d(rng))};B b;ExpandConservativeBoneBounds(b,m,h);for(int i=0;i<8;i++){float x=(i&1)?h.x:-h.x,y=(i&2)?h.y:-h.y,z=(i&4)?h.z:-h.z;V p{m._11*x+m._21*y+m._31*z+m._41,m._12*x+m._22*y+m._32*z+m._42,m._13*x+m._23*y+m._33*z+m._43};assert(p.x>=b.lo.x&&p.x<=b.hi.x&&p.y>=b.lo.y&&p.y<=b.hi.y&&p.z>=b.lo.z&&p.z<=b.hi.z);}}}
`);const c=spawnSync('c++',['-O2','-std=c++17',join(dir,'probe.cpp'),'-o',join(dir,'probe')],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=spawnSync(join(dir,'probe'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
