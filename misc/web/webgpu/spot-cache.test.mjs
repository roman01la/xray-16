import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
test('production spot cache keeps atlas resets and invalidates camera/light/quality/size changes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'spot-cache-'));try{
 const source=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRender/Light_Render_Direct_ComputeXFS.cpp'),'utf8').replace(/^#include.*$/gm,'');
 const setter=readFileSync(resolve(import.meta.dirname,'../../../src/Layers/xrRender/light.h'),'utf8').match(/void set_type\(LT type\) override[\s\S]*?\n    }/)[0].replace(' override','');
 const shim=`#include <cmath>
#include <cstring>
#include <algorithm>
#include <cassert>
#include <cstddef>
#define XR_PLATFORM_WEB 1
#define RENDER_NAMESPACE probe
#define ZoneScoped
#define FALSE 0
using u32=unsigned;float EPS=0.00001f,EPS_S=.000001f;float deg2rad(float x){return x*.0174532925f;}float clampr(float x,float a,float b){return std::min(std::max(x,a),b);}int iFloor(float x){return int(floorf(x));}int iCeil(float x){return int(ceilf(x));}template<class T>T _abs(T x){return std::abs(x);}template<class...T>void Msg(T...){}struct{const char*Params="";}Core;
namespace xray::render::probe{
struct Fvector{float x=0,y=0,z=1;void set(const Fvector&v){*this=v;}void set(float a,float b,float c){x=a;y=b;z=c;}float square_magnitude(){return x*x+y*y+z*z;}void normalize(){float n=std::sqrt(square_magnitude());x/=n;y/=n;z/=n;}float dotproduct(const Fvector&v){return x*v.x+y*v.y+z*v.z;}void crossproduct(const Fvector&a,const Fvector&b){set(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);}float distance_to(const Fvector&v){return std::sqrt((x-v.x)*(x-v.x)+(y-v.y)*(y-v.y)+(z-v.z)*(z-v.z));}};
int builds=0;struct Matrix{void build_camera_dir(Fvector,Fvector,Fvector){++builds;}void build_projection(float,float,float,float){++builds;}void mul(Matrix,Matrix){++builds;}};
struct IRender_Light{enum{POINT=1,SPOT=2};};
struct light{Fvector direction,right{0,0,0},position;float range=10,cone=1,virtual_size=.1f;struct{float r=1,g=1,b=1;}color;struct{struct{Fvector P;float R=2;}sphere;}spatial;struct{unsigned type=2;}flags;struct{struct{Matrix view,project,combine;u32 size=128,posX=0,posY=0;bool transluent=false;}S;}X;bool webSpotInputsValid=false;float webSpotInputs[31]{};using LT=unsigned;${setter}};
struct{Fvector vCameraPosition{5,5,5},vCameraDirection;u32 dwFrame=1;}Device;
float ps_r2_ls_squality=1;int SMAP_adapt_optimal=512,SMAP_adapt_min=64,SMAP_adapt_max=1024;
struct CLight_Compute_XFORM_and_VIS{void compute_xf_spot(light*);};}
`;
 writeFileSync(join(dir,'test.cpp'),shim+source+`
int main(){using namespace xray::render::probe;light l;CLight_Compute_XFORM_and_VIS c;c.compute_xf_spot(&l);assert(builds==3);l.X.S.posX=50;l.X.S.posY=60;l.X.S.transluent=true;c.compute_xf_spot(&l);assert(builds==3&&l.X.S.posX==0&&l.X.S.posY==0&&!l.X.S.transluent);
float* fields[]={&l.direction.x,&l.direction.y,&l.direction.z,&l.right.x,&l.right.y,&l.right.z,&l.position.x,&l.position.y,&l.position.z,&l.range,&l.cone,&l.virtual_size,&l.color.r,&l.color.g,&l.color.b,&l.spatial.sphere.P.x,&l.spatial.sphere.P.y,&l.spatial.sphere.P.z,&l.spatial.sphere.R,&Device.vCameraPosition.x,&Device.vCameraPosition.y,&Device.vCameraPosition.z,&Device.vCameraDirection.x,&Device.vCameraDirection.y,&Device.vCameraDirection.z,&ps_r2_ls_squality};
for(auto p:fields){int before=builds;*p+=.05f;c.compute_xf_spot(&l);assert(builds==before+3);c.compute_xf_spot(&l);assert(builds==before+3);}int before=builds;l.set_type(1);l.set_type(2);c.compute_xf_spot(&l);assert(builds==before+3);before=builds;l.flags.type=1;c.compute_xf_spot(&l);assert(builds==before+3);before=builds;l.X.S.size+=10;c.compute_xf_spot(&l);assert(builds==before+3);}
`);const c=spawnSync('c++',['-std=c++17','-O2',join(dir,'test.cpp'),'-o',join(dir,'test')],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=spawnSync(join(dir,'test'),[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
