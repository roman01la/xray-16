import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('production LOD fast paths preserve results and pass sorting is strict for ties',()=>{
 const dir=mkdtempSync(join(tmpdir(),'render-work-'));
 try{
 const source=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRender/r__dsgraph_render.cpp'),'utf8');
 const functions=source.slice(source.indexOf('ICF float calcLOD'),source.indexOf('void R_dsgraph_structure::render_graph'));
 writeFileSync(join(dir,'test.cpp'),`#include <cmath>
#include <algorithm>
#include <cassert>
#include <vector>
#define XR_PLATFORM_WEB 1
#define ICF inline
int roots=0;float _sqrt(float x){++roots;return std::sqrt(x);}float clampr(float x,float a,float b){return std::min(std::max(x,a),b);}float r_ssaGLOD_start=10,r_ssaGLOD_end=1;
${functions}
struct Pass{bool equal(const Pass&){assert(false);return false;}};struct Item{Pass* first;struct{float ssa;}second;};
int main(){for(int i=-10000;i<100000;++i){float x=i/1000.f;assert(calcLOD(x,1)==std::sqrt(clampr((x-1)/9,0,1)));}assert(roots==8999);
Pass p,q;Item a{&p,{5}},b{&q,{5}},c{&p,{10}};assert(!cmp_pass(&a,&a)&&!cmp_pass(&a,&b)&&!cmp_pass(&b,&a));std::vector<Item*> items{&a,&c,&b};std::sort(items.begin(),items.end(),cmp_pass<Item*>);assert(items[0]==&c);
r_ssaGLOD_start=1;r_ssaGLOD_end=10;for(int i=0;i<100;++i){float x=i/10.f;assert(calcLOD(x,1)==std::sqrt(clampr((x-10)/-9,0,1)));}}
`);
 const c=spawnSync('c++',['-std=c++17','-O2',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
