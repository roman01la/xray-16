// Compute equivalents of X-Ray's fluid_advect*, fluid_vorticity, confinement,
// Gaussian emitter, divergence, Jacobi and projection pixel shaders.
export const fluidKernelSource = `
struct Params { dims:vec4u, counts:vec4u, step:vec4f, clock:vec4f, gridToWorld:mat4x4f, worldToGrid:mat4x4f };
struct Emitter { position:vec4f, flow:vec4f, options:vec4f, draught:vec4f };
struct Obstacle { transform:mat4x4f, center:vec4f, angular:vec4f, linear:vec4f };
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var linearSampler:sampler;
@group(0) @binding(2) var velocity:texture_3d<f32>;
@group(0) @binding(3) var density:texture_3d<f32>;
@group(0) @binding(4) var auxiliary:texture_3d<f32>;
@group(0) @binding(5) var divergence:texture_3d<f32>;
@group(0) @binding(6) var obstacles:texture_3d<f32>;
@group(0) @binding(7) var output:texture_storage_3d<rgba16float,write>;
@group(0) @binding(8) var<storage,read> emitters:array<Emitter>;
@group(0) @binding(9) var<storage,read> boxes:array<Obstacle>;
const directions=array<vec3i,6>(vec3i(-1,0,0),vec3i(1,0,0),vec3i(0,-1,0),vec3i(0,1,0),vec3i(0,0,-1),vec3i(0,0,1));
fn cell(p:vec3i)->vec3i{return clamp(p,vec3i(0),vec3i(u.dims.xyz)-1);}
fn uv(p:vec3i)->vec3f{return (vec3f(p)+.5)/vec3f(u.dims.xyz);}
fn solid(p:vec3i)->bool{return textureLoad(obstacles,cell(p),0).w>.9;}
fn occupied(p:vec3i)->bool{return textureLoad(obstacles,cell(p),0).w>0.0;}
fn backtrace(p:vec3i)->vec3f{return uv(p)-u.step.x*u.clock.y*textureLoad(velocity,p,0).xyz/vec3f(u.dims.xyz);}
fn outside(p:vec3u)->bool{
 if(any(p>=u.dims.xyz)){return true;}
 // Original DrawSlices covers only cells 1..dim-2; preserve its zero border.
 if(any(p==vec3u(0))||any(p==u.dims.xyz-vec3u(1))){textureStore(output,vec3i(p),vec4f(0));return true;}
 return false;
}
@compute @workgroup_size(4,4,4) fn obstacle(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);var value=vec4f(0);
 for(var i=0u;i<u.counts.x;i++){
  let point=(vec3f(p)+vec3f(.5,.5,0))/vec3f(u.dims.xyz);
  let box=boxes[i];let q=box.transform*vec4f(point,1);
  if(all(abs(q.xyz)<=vec3f(.5))){
   let world=(u.gridToWorld*vec4f(point,1)).xyz;
   let worldVelocity=cross(box.angular.xyz,world-box.center.xyz)+box.linear.xyz;
   let m=box.transform;let dims=vec3f(u.dims.xyz);
   let scale=vec3f(length(vec3f(m[0].x,m[1].x,m[2].x)/dims),length(vec3f(m[0].y,m[1].y,m[2].y)/dims),length(vec3f(m[0].z,m[1].z,m[2].z)/dims));
   let interior=all((vec3f(.5)-abs(q.xyz))/max(scale,vec3f(1e-20))>vec3f(1.73));
   value=select(vec4f((u.worldToGrid*vec4f(worldVelocity,0)).xyz*dims,1),vec4f(0,0,0,.5),interior);
  }
 }
 if(u.counts.z==0u){let fixed=textureLoad(obstacles,p,0);if(fixed.w>0.0){value=fixed;}}
 textureStore(output,p,value);
}
@compute @workgroup_size(4,4,4) fn advect(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);var d=0.0;
 if(!occupied(p)){d=textureSampleLevel(density,linearSampler,backtrace(p),0).x;if(u.counts.y!=0u){d=clamp(d-.006,0.0,5.0);}}
 textureStore(output,p,vec4f(d,0,0,0));
}
@compute @workgroup_size(4,4,4) fn correct(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);var d=0.0;
 if(!occupied(p)){
  let b=backtrace(p);let original=textureSampleLevel(density,linearSampler,b,0).x;
  if(u.counts.y!=0u){
   var low=1e10;var high=-1e10;let corner=vec3i(floor(b*vec3f(u.dims.xyz)-.5));
   for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){let v=textureLoad(density,cell(corner+vec3i(x,y,z)),0).x;low=min(low,v);high=max(high,v);}}}
   d=original+.5*(textureLoad(density,p,0).x-textureLoad(auxiliary,p,0).x);
   d=clamp(clamp(d,low,high)*u.step.y-.006,0.0,5.0);
  }else{
   d=original;
   if(all(id>=vec3u(4))&&all(id+4u<u.dims.xyz)){d=1.5*original-.5*textureSampleLevel(auxiliary,linearSampler,b,0).x;}
   d=clamp(d,0.0,1.0)*u.step.y;
  }
 }
 textureStore(output,p,vec4f(d,0,0,0));
}
@compute @workgroup_size(4,4,4) fn advect_velocity(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);let b=backtrace(p);var v=textureSampleLevel(velocity,linearSampler,b,0).xyz;
 v.y+=textureSampleLevel(density,linearSampler,b,0).x*u.step.w;textureStore(output,p,vec4f(v,0));
}
@compute @workgroup_size(4,4,4) fn curl(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);
 let l=textureLoad(velocity,cell(p+directions[0]),0);let r=textureLoad(velocity,cell(p+directions[1]),0);
 let b=textureLoad(velocity,cell(p+directions[2]),0);let t=textureLoad(velocity,cell(p+directions[3]),0);
 let d=textureLoad(velocity,cell(p+directions[4]),0);let a=textureLoad(velocity,cell(p+directions[5]),0);
 textureStore(output,p,vec4f(.5*vec3f(t.z-b.z-a.y+d.y,a.x-d.x-r.z+l.z,r.y-l.y-t.x+b.x),0));
}
@compute @workgroup_size(4,4,4) fn confine(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);var magnitude:array<f32,6>;
 for(var i=0;i<6;i++){magnitude[i]=length(textureLoad(auxiliary,cell(p+directions[i]),0).xyz);}
 let eta=normalize(.5*vec3f(magnitude[1]-magnitude[0],magnitude[3]-magnitude[2],magnitude[5]-magnitude[4])+vec3f(.001));
 let v=textureLoad(velocity,p,0).xyz+u.step.x*u.step.z*cross(eta,textureLoad(auxiliary,p,0).xyz);
 textureStore(output,p,vec4f(v,0));
}
fn random(seed:u32)->f32{
 var x=seed;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);
 return f32(x)/4294967295.0;
}
fn emission(p:vec3i,initial:vec3f,isVelocity:bool)->vec3f{
 var value=initial;if(occupied(p)){return value;}
 for(var i=0u;i<u.dims.w;i++){
  let e=emitters[i];if((isVelocity&&e.options.z==0.0)||(!isVelocity&&e.options.y==0.0)){continue;}
  var center=e.position.xyz;var color=e.flow.xyz;
  if(isVelocity){
   if(e.options.w!=0.0){color*=1.0+e.draught.z*sin((u.clock.x+e.draught.y)*6.28318530718/max(.0001,e.draught.x));}
   let seed=bitcast<u32>(u.clock.x)+i*3u;center+=(vec3f(random(seed),random(seed+1u),random(seed+2u))-vec3f(.5))*5.0;
  }else{let modulation=1.5*((sin(u.clock.x*1.5+2.09439510239)*.5+.5)*e.draught.w+1.0-e.draught.w);color=vec3f(e.flow.w*modulation);}
  let c=vec3f(p)+vec3f(.5,.5,0);let distance=length(c-center)*e.position.w;
  let alpha=exp(-distance*distance/.5);
  color+=length(vec4f(color,select(1.0,0.0,isVelocity)))*sin(color*10.0+c*5.0)*.2;
  value=mix(value,color,alpha);
 }
 return value;
}
@compute @workgroup_size(4,4,4) fn emit_density(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);let d=emission(p,vec3f(textureLoad(density,p,0).x),false).x;textureStore(output,p,vec4f(d,0,0,0));
}
@compute @workgroup_size(4,4,4) fn emit_velocity(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);textureStore(output,p,vec4f(emission(p,textureLoad(velocity,p,0).xyz,true),0));
}
@compute @workgroup_size(4,4,4) fn divergence_field(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);var v:array<vec3f,6>;
 for(var i=0;i<6;i++){let q=cell(p+directions[i]);v[i]=textureLoad(velocity,q,0).xyz;if(solid(q)){v[i]=textureLoad(obstacles,q,0).xyz;}}
 textureStore(output,p,vec4f(.5*(v[1].x-v[0].x+v[3].y-v[2].y+v[5].z-v[4].z),0,0,0));
}
@compute @workgroup_size(4,4,4) fn jacobi(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);let center=textureLoad(auxiliary,p,0).x;var sum=0.0;
 for(var i=0;i<6;i++){let q=cell(p+directions[i]);sum+=select(textureLoad(auxiliary,q,0).x,center,solid(q));}
 textureStore(output,p,vec4f((sum-textureLoad(divergence,p,0).x)/6.0,0,0,0));
}
@compute @workgroup_size(4,4,4) fn project(@builtin(global_invocation_id) id:vec3u){
 if(outside(id)){return;}let p=vec3i(id);if(solid(p)){textureStore(output,p,vec4f(textureLoad(obstacles,p,0).xyz,0));return;}
 let center=textureLoad(auxiliary,p,0).x;var pressure:array<f32,6>;var mask=vec3f(1);var boundaryVelocity=vec3f(0);
 for(var i=0;i<6;i++){let q=cell(p+directions[i]);pressure[i]=textureLoad(auxiliary,q,0).x;if(solid(q)){pressure[i]=center;let axis=i/2;mask[axis]=0;boundaryVelocity[axis]=textureLoad(obstacles,q,0)[axis];}}
 let gradient=.5*vec3f(pressure[1]-pressure[0],pressure[3]-pressure[2],pressure[5]-pressure[4]);
 textureStore(output,p,vec4f(mask*(textureLoad(velocity,p,0).xyz-gradient)+boundaryVelocity,0));
}
`;
export const fluidKernelBindings={obstacle:[0,6,7,9],advect:[0,1,2,3,6,7],correct:[0,1,2,3,4,6,7],advect_velocity:[0,1,2,3,7],curl:[0,2,7],confine:[0,2,4,7],emit_density:[0,3,6,7,8],emit_velocity:[0,2,6,7,8],divergence_field:[0,2,6,7],jacobi:[0,4,5,6,7],project:[0,2,4,6,7]};
