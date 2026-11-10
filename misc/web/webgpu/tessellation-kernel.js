// Faithful PN/HM surface equations shared by the compute implementation and
// deterministic GPU tests. Caller supplies xr_tess_height(tc,detail):f32.
export const tessellationFunctions = `
struct XRTessVertex {
 clip: vec4<f32>, tc: vec4<f32>, position: vec4<f32>,
 m1: vec4<f32>, m2: vec4<f32>, m3: vec4<f32>, detail: vec4<f32>, hemi: vec4<f32>,
}
struct XRTessPatch {
 b210:vec3<f32>, b120:vec3<f32>, b021:vec3<f32>, b012:vec3<f32>, b102:vec3<f32>, b201:vec3<f32>, center:vec3<f32>,
 n110:vec3<f32>, n011:vec3<f32>, n101:vec3<f32>,
}
fn xr_tess_normal(n:vec3<f32>)->vec3<f32> {
 let length2=dot(n,n);if(length2<1e-20){return vec3<f32>(0,0,1);}return n*inverseSqrt(length2);
}
fn xr_tess_control(a:vec3<f32>,b:vec3<f32>,n:vec3<f32>)->vec3<f32>{return (2*a+b-dot(b-a,n)*n)/3;}
fn xr_tess_edge_normal(a:vec3<f32>,b:vec3<f32>,na:vec3<f32>,nb:vec3<f32>)->vec3<f32>{
 let e=b-a;let length2=dot(e,e);let sum=na+nb;
 if(length2<1e-20){return xr_tess_normal(sum);}return xr_tess_normal(sum-2*dot(e,sum)/length2*e);
}
fn xr_tess_patch(a:XRTessVertex,b:XRTessVertex,c:XRTessVertex)->XRTessPatch {
 let p0=a.position.xyz;let p1=b.position.xyz;let p2=c.position.xyz;
 let n0=xr_tess_normal(vec3<f32>(a.m1.z,a.m2.z,a.m3.z));
 let n1=xr_tess_normal(vec3<f32>(b.m1.z,b.m2.z,b.m3.z));
 let n2=xr_tess_normal(vec3<f32>(c.m1.z,c.m2.z,c.m3.z));
 var p:XRTessPatch;
 p.b210=xr_tess_control(p0,p1,n0);p.b120=xr_tess_control(p1,p0,n1);
 p.b021=xr_tess_control(p1,p2,n1);p.b012=xr_tess_control(p2,p1,n2);
 p.b102=xr_tess_control(p2,p0,n2);p.b201=xr_tess_control(p0,p2,n0);
 let e=(p.b210+p.b120+p.b021+p.b012+p.b102+p.b201)/6;let v=(p0+p1+p2)/3;
 p.center=e+(e-v)/2;
 p.n110=xr_tess_edge_normal(p0,p1,n0,n1);p.n011=xr_tess_edge_normal(p1,p2,n1,n2);p.n101=xr_tess_edge_normal(p2,p0,n2,n0);
 return p;
}
fn xr_tess_culled(a:XRTessVertex,b:XRTessVertex,c:XRTessVertex,p:XRTessPatch,method:u32)->bool {
 return method==1u&&min(a.position.z,min(b.position.z,c.position.z))>5&&
 xr_tess_normal(vec3<f32>(a.m1.z,a.m2.z,a.m3.z)).z>0.1&&
 xr_tess_normal(vec3<f32>(b.m1.z,b.m2.z,b.m3.z)).z>0.1&&
 xr_tess_normal(vec3<f32>(c.m1.z,c.m2.z,c.m3.z)).z>0.1&&min(p.n110.z,min(p.n011.z,p.n101.z))>0.1;
}
fn xr_tess_evaluate(a:XRTessVertex,b:XRTessVertex,c:XRTessVertex,p:XRTessPatch,original:vec3<f32>,method:u32,flags:u32)->XRTessVertex {
 let shadow=(flags&1u)!=0u;let minimum=min(original.x,min(original.y,original.z));var bary=original;
 if(!shadow&&minimum!=0&&1.0/3.0-minimum>0.01&&minimum<0.1){bary=mix(vec3<f32>(1.0/3.0),original,(1.0/3.0)/(1.0/3.0-minimum));}
 let u=bary.y;let v=bary.x;let w=bary.z;var o:XRTessVertex;
 o.clip=a.clip*w+b.clip*u+c.clip*v;o.tc=a.tc*w+b.tc*u+c.tc*v;o.position=a.position*w+b.position*u+c.position*v;
 o.m1=a.m1*w+b.m1*u+c.m1*v;o.m2=a.m2*w+b.m2*u+c.m2*v;o.m3=a.m3*w+b.m3*u+c.m3*v;
 o.detail=a.detail*w+b.detail*u+c.detail*v;o.hemi=a.hemi*w+b.hemi*u+c.hemi*v;
 let linear=o.position.xyz;var pos=linear;var normal=xr_tess_normal(vec3<f32>(o.m1.z,o.m2.z,o.m3.z));
 if((method&1u)!=0u){
  pos=a.position.xyz*w*w*w+b.position.xyz*u*u*u+c.position.xyz*v*v*v+
   p.b210*3*w*w*u+p.b120*3*w*u*u+p.b201*3*w*w*v+p.b021*3*u*u*v+p.b102*3*w*v*v+p.b012*3*u*v*v+p.center*6*w*u*v;
  normal=vec3<f32>(a.m1.z,a.m2.z,a.m3.z)*w*w+vec3<f32>(b.m1.z,b.m2.z,b.m3.z)*u*u+
   vec3<f32>(c.m1.z,c.m2.z,c.m3.z)*v*v+p.n110*w*u+p.n011*u*v+p.n101*w*v;
 }
 if((method&2u)!=0u&&(flags&2u)!=0u){pos+=normal*xr_tess_height(o.tc.xy,o.detail.xy)*0.07;}
 if(!shadow&&minimum==0){pos=linear;}
 o.position=vec4<f32>(pos,o.position.w);return o;
}
`;
// Standalone control-point evaluator; also used to test production surface math
// independently of vertex-format decoding and native draw integration.
export const tessellationValidationKernel = tessellationFunctions + `
struct Params { projection:mat4x4<f32>, values:vec4<u32>, heights:vec4<f32>, }
@group(0) @binding(0) var<storage,read> control:array<XRTessVertex>;
@group(0) @binding(1) var<storage,read> samples:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> result:array<XRTessVertex>;
@group(0) @binding(3) var<uniform> params:Params;
fn xr_tess_height(tc:vec2<f32>,detail:vec2<f32>)->f32 {
 return params.heights.x+select(0.0,(params.heights.y-0.5)*0.2,(params.values.z&4u)!=0u);
}
var<workgroup> xr_patch:XRTessPatch;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){
 let base=group.x*3u;let a=control[base];let b=control[base+1u];let c=control[base+2u];
 if(lane==0u){xr_patch=xr_tess_patch(a,b,c);}workgroupBarrier();
 if(lane>=params.values.x){return;}
 var value=xr_tess_evaluate(a,b,c,xr_patch,samples[lane].xyz,params.values.y,params.values.z);
 value.clip=params.projection*vec4<f32>(value.position.xyz,1);
 if(xr_tess_culled(a,b,c,xr_patch,params.values.y)){value.clip=vec4<f32>(2,2,2,1);}
 result[group.x*params.values.x+lane]=value;
}`;
