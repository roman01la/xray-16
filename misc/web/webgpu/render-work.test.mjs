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

test('volumetric sunlight retains the caller geometry and rendering context',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sun-context-'));
 try {
 const source=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRenderPC_GL/gl_rendertarget_accum_direct.cpp'),'utf8');
 const start=source.indexOf('void CRenderTarget::accum_direct_volumetric(');
 const method=source.slice(start,source.lastIndexOf('} // namespace'));
 assert.ok(start>=0);
 writeFileSync(join(dir,'test.cpp'),`#include <cassert>
#include <initializer_list>
using u32=unsigned;
#define PIX_EVENT(event)
enum {SE_SUN_NEAR,SE_SUN_MIDDLE,SE_SUN_FAR,CULL_CCW,D3DCMP_GREATER,D3DCMP_ALWAYS,D3DPT_TRIANGLELIST};
struct Fvector {
 float x=0,y=0,z=0;
 void set(float a,float b,float c){x=a;y=b;z=c;}
 void normalize(){}
 void mad(const Fvector&,const Fvector&,float){}
};
struct Fmatrix {
 Fmatrix()=default;
 Fmatrix(std::initializer_list<float>){}
 void identity(){}
 void mul(const Fmatrix&,const Fmatrix&){}
 void transform_dir(Fvector&,const Fvector&)const{}
 void transform(Fvector&)const{}
};
struct CBackend {
 unsigned vb=0,ib=0,draws=0,vertices=0,primitives=0;
 struct Transforms {
  Fmatrix m_wvp;
  void set_W(const Fmatrix&){}
  void set_V(const Fmatrix&){}
  void set_P(const Fmatrix&){}
 } xforms;
 void set_ColorWriteEnable(){}
 void set_Element(int){}
 void set_CullMode(int){}
 template<class... Args> void set_c(Args...){}
 void set_ZFunc(int){}
 void Render(int,u32 offset,int,u32 vertexCount,int,u32 primitiveCount){
  assert(vb==17&&ib==23&&offset==11);
  vertices=vertexCount;primitives=primitiveCount;++draws;
 }
} RCache;
struct light {struct {float r=1,g=1,b=1;} color; Fvector direction;};
struct {
 struct {bool oldshadowcascades=false;} o;
 struct {struct {light value;light* _get(){return &value;}} sun;} Lights;
} RImplementation;
struct {Fmatrix mView,mProject,mFullTransform;float fFOV=60,fASPECT=1;unsigned dwWidth=1280,dwHeight=720;Fvector vCameraPosition,vCameraDirection;} Device;
float ps_r2_sun_near=20,ps_r2_sun_far=100;
using ref_selement=int;
struct Shader {int E[1]={0};};
struct CRenderTarget {
 Shader shader;
 Shader* s_accum_direct_volumetric=&shader;
 Shader* s_accum_direct_volumetric_minmax=&shader;
 CBackend* expected=nullptr;
 bool shafts=true,minmax=false;
 bool need_to_render_sunshafts(){return shafts;}
 bool use_minmax_sm_this_frame(){return minmax;}
 void phase_vol_accumulator(CBackend& context){assert(&context==expected);}
 void accum_direct_volumetric(CBackend&,u32,u32,const Fmatrix&);
};
${method}
int main(){
 CRenderTarget target;CBackend cascade;cascade.vb=17;cascade.ib=23;target.expected=&cascade;
 Fmatrix shadow;
 for(bool legacy:{false,true})for(bool minmax:{false,true}){
  RImplementation.o.oldshadowcascades=legacy;target.minmax=minmax;
  for(u32 phase:{SE_SUN_NEAR,SE_SUN_FAR}){
   const auto before=cascade.draws;
   target.accum_direct_volumetric(cascade,phase,11,shadow);
   assert(cascade.draws==before+1);
   assert(cascade.vertices==(legacy?4:8));assert(cascade.primitives==(legacy?2:16));
  }
 }
 const auto before=cascade.draws;
 target.accum_direct_volumetric(cascade,SE_SUN_MIDDLE,11,shadow);
 target.shafts=false;target.accum_direct_volumetric(cascade,SE_SUN_FAR,11,shadow);
 assert(cascade.draws==before&&RCache.draws==0);
}
`);
 const compiled=spawnSync('c++',['-std=c++17','-O2',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});
 assert.equal(compiled.status,0,compiled.stderr);
 const result=spawnSync(join(dir,'test'),[],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.match(source,/accum_direct_volumetric\(cmd_list, sub_phase, Offset, m_shadow\)/);
 assert.match(source,/accum_direct_volumetric\(RCache, sub_phase, Offset, m_shadow\)/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
