import {EngineFormat as G} from './engine-formats.js';
import {tessellationFunctions} from './tessellation-kernel.js';
const names=['clip','tc','position','m1','m2','m3','detail','hemi'];
const semantic={v2p_bumped_tcdh:'tc',v2p_bumped_position:'position',v2p_bumped_M1:'m1',v2p_bumped_M2:'m2',v2p_bumped_M3:'m3',v2p_bumped_tcdbump:'detail',v2p_bumped_lmh:'hemi',xr_v2p_8:'tc',xr_v2p_9:'position',xr_v2p_10:'m1',xr_v2p_11:'m2',xr_v2p_12:'m3',xr_v2p_13:'detail',xr_v2p_14:'hemi'};
function sourceIO(meta) {
 const source=meta.stages.vert,entry=/@vertex\s+fn main\(([^\n]*)\)\s*->\s*(\w+)\s*\{/.exec(source);
 if(!entry)throw Error('Unsupported tessellated vertex entry');
 const structure=new RegExp('struct '+entry[2]+' \\{([\\s\\S]*?)\\}').exec(source);
 if(!structure)throw Error('Missing tessellated vertex outputs');
 const fields=[...structure[1].matchAll(/@(builtin|location)\((\w+)\)\s+(\w+):\s*(vec[234]<f32>|f32),/g)].map(([,kind,loc,name,type])=>({kind,loc,name,type}));
 const roles=new Map();for(const f of fields) {
  const role=f.kind==='builtin'&&f.loc==='position'?'clip':Object.keys(semantic).map(n=>[n,meta.varyings?.[n]]).find(([,loc])=>String(loc)===f.loc)?.[0];
  if(!role)throw Error('Unknown tessellated output semantic at '+f.loc);
  roles.set(role==='clip'?'clip':semantic[role],f);
 }
 for(const role of ['clip','tc','position','m1','m2','m3'])if(!roles.has(role))throw Error('Missing tessellation input '+role);
 return {source,entry,structure,fields,roles};
}
const widen=(value,type)=>type==='vec4<f32>'?value:type==='vec3<f32>'?`vec4<f32>(${value},0)`:type==='vec2<f32>'?`vec4<f32>(${value},0,0)`:`vec4<f32>(${value},0,0,0)`;
const narrow=(value,type)=>type==='vec4<f32>'?value:value+({ 'vec3<f32>':'.xyz','vec2<f32>':'.xy',f32:'.x'}[type]);
function decodeAttribute(attr,type) {
 if(!attr||attr.divisor)throw Error('Unsupported tessellation source attribute');
 const n=Number(type.match(/vec(\d)/)?.[1]||1),bytes=[G.BYTE,G.UNSIGNED_BYTE].includes(attr.type)?1:[G.SHORT,G.UNSIGNED_SHORT,G.HALF_FLOAT].includes(attr.type)?2:4;
 const stride=attr.stride||attr.size*bytes,values=[];
 for(let i=0;i<n;i++) {
  if(i>=attr.size){values.push(i===3?'1.0':'0.0');continue;}
  const address=`(index*${stride}u+${attr.offset+i*bytes}u-xr_params.draw.w)`;
  let raw=bytes===4?`xr_vertices[${address}/4u]`:`((xr_vertices[${address}/4u] >> ((${address}%4u)*8u)) & ${bytes===1?255:65535}u)`;
  let value;
  if(attr.type===G.FLOAT)value=`bitcast<f32>(${raw})`;
  else if(attr.type===G.HALF_FLOAT)value=`unpack2x16float(${raw}).x`;
  else {
   const signed=[G.BYTE,G.SHORT,G.INT].includes(attr.type);
   if(signed)raw=bytes===4?`bitcast<i32>(${raw})`:`(bitcast<i32>(${raw} << ${32-bytes*8}u) >> ${32-bytes*8}u)`;
   value=`f32(${raw})`;
   if(attr.normalized)value=signed?`max(-1.0,${value}/${2**(bytes*8-1)-1}.0)`:`(${value}/${2**(bytes*8)-1}.0)`;
  }
  values.push(value);
 }
 return n===1?values[0]:`${type}(${values.join(',')})`;
}
export function createTessellationShaders(meta,geometry,indexFormat) {
 const {source,entry,structure,fields,roles}=sourceIO(meta),group=meta.uniformGroups?.length||1;
 if(group>3)throw Error('Tessellation exceeds WebGPU bind group limit');
 const params=[...entry[1].matchAll(/@(location|builtin)\((\w+)\)\s+(\w+):\s*(vec[234]<f32>|f32|u32)/g)];
 const args=params.map(([,kind,loc,,type])=>{
  if(kind==='builtin'){if(loc!=='vertex_index')throw Error('Unsupported vertex builtin '+loc);return 'index';}
  return decodeAttribute(geometry.attrs.get(Number(loc)),type);
 });
 if(params.length!==meta.attributes.length)throw Error('Tessellation source attribute reflection mismatch');
 let compute=source.replace(entry[0],`fn xr_source_main(${params.map(([, , ,name,type])=>`${name}:${type}`).join(',')}) -> ${entry[2]} {`)
  .replace(/@(builtin|location|interpolate|invariant)\([^)]*\)\s*/g,'');
 const vertexStruct=structure[0];
 const render=vertexStruct+`\n@vertex fn main(${fields.map((f,i)=>`@location(${i}) row${i}:vec4<f32>`).join(',')}) -> ${entry[2]} {return ${entry[2]}(${fields.map((f,i)=>narrow('row'+i,f.type)).join(',')});}`;
 const vertexLayout={arrayStride:128,stepMode:'vertex',attributes:fields.map((f,i)=>({shaderLocation:i,offset:names.indexOf([...roles].find(([,v])=>v===f)[0])*16,format:'float32x4'}))};
 // Source vertex shader retains all stock transform/skinning/tangent math.
 compute+=`\n${tessellationFunctions}
struct XRTessParams { projection:mat4x4<f32>, draw:vec4<u32>, surface:vec4<u32>, }
@group(${group}) @binding(0) var<storage,read> xr_vertices:array<u32>;
@group(${group}) @binding(1) var<storage,read> xr_indices:array<u32>;
@group(${group}) @binding(2) var<storage,read> xr_samples:array<vec4<f32>>;
@group(${group}) @binding(3) var<storage,read_write> xr_output:array<XRTessVertex>;
@group(${group}) @binding(4) var<storage,read_write> xr_output_indices:array<u32>;
@group(${group}) @binding(5) var<uniform> xr_params:XRTessParams;
@group(${group}) @binding(6) var<storage,read> xr_pattern:array<u32>;
fn xr_read_index(at:u32)->u32 { return ${indexFormat==='uint16'?'(xr_indices[at/2u] >> ((at%2u)*16u)) & 65535u':'xr_indices[at]'}; }
fn xr_read_vertex(index:u32)->XRTessVertex {let v=xr_source_main(${args.join(',')});return XRTessVertex(${names.map(role=>roles.has(role)?widen('v.'+roles.get(role).name,roles.get(role).type):'vec4<f32>(0)').join(',')});}
`;
 const bump=meta.samplers.findIndex(s=>s.name==='s_bumpX'),detail=meta.samplers.findIndex(s=>s.name==='s_detailBumpX');
 let height='return 0.0;';
 if(meta.tessellation.method&2 && meta.tessellation.detail) {
  if(bump<0)throw Error('Height-map tessellation requires authored bump texture');
  compute+=`@group(0) @binding(${1+bump*2}) var xr_height_texture:texture_2d<f32>;\n@group(0) @binding(${2+bump*2}) var xr_height_sampler:sampler;\n`;
  height='var h=textureSampleLevel(xr_height_texture,xr_height_sampler,tc,0.0).a;';
  if(meta.tessellation.detailBump){if(detail<0)throw Error('Missing tessellation detail bump');compute+=`@group(0) @binding(${1+detail*2}) var xr_detail_texture:texture_2d<f32>;\n@group(0) @binding(${2+detail*2}) var xr_detail_sampler:sampler;\n`;height+='h+=(textureSampleLevel(xr_detail_texture,xr_detail_sampler,dt,0.0).a-0.5)*0.2;';}
  height+='return h;';
 }
 compute+=`fn xr_tess_height(tc:vec2<f32>,dt:vec2<f32>)->f32{${height}}
var<workgroup> xr_control:array<XRTessVertex,3>;
var<workgroup> xr_patch:XRTessPatch;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) work:vec3<u32>) {
 let patchIndex=work.x+work.y*65535u;if(patchIndex>=xr_params.draw.x){return;}
 if(lane<3u){let index=i32(xr_read_index(xr_params.draw.y+patchIndex*3u+lane))+bitcast<i32>(xr_params.draw.z);xr_control[lane]=xr_read_vertex(u32(index));}
 workgroupBarrier();if(lane==0u){xr_patch=xr_tess_patch(xr_control[0],xr_control[1],xr_control[2]);}workgroupBarrier();
 let count=xr_params.surface.x;let base=patchIndex*count;
 if(lane<count){var v=xr_tess_evaluate(xr_control[0],xr_control[1],xr_control[2],xr_patch,xr_samples[lane].xyz,xr_params.surface.z,xr_params.surface.w);
  let clip=xr_params.projection*vec4<f32>(v.position.xyz,1);v.clip=vec4<f32>(clip.x,-clip.y,(clip.z+clip.w)*0.5,clip.w);
  if(xr_tess_culled(xr_control[0],xr_control[1],xr_control[2],xr_patch,xr_params.surface.z)){v.clip=vec4<f32>(2,2,2,1);}xr_output[base+lane]=v;}
 for(var i=lane;i<xr_params.surface.y;i+=64u){xr_output_indices[patchIndex*xr_params.surface.y+i]=base+xr_pattern[i];}
}`;
 // Unused texture declarations may still exist in the translated VS; avoid
 // duplicate binding declarations when adding displacement-only resources.
 compute=compute.replace(/@group\(0\)\s+@binding\((\d+)\)\s+var\s+(\w+):\s*(texture_\w+<[^>]+>|sampler);/g,(all,binding,name)=>{
  if(!name.startsWith('xr_')&&((bump>=0&&[1+bump*2,2+bump*2].includes(+binding))||(detail>=0&&[1+detail*2,2+detail*2].includes(+binding)))) {
   if(new RegExp('\\b'+name+'\\b','g').test(source)&&source.split(new RegExp('\\b'+name+'\\b')).length>2)throw Error('Source VS already samples displacement binding');
   return '';
  }return all;
 });
 return {compute,render,vertexLayout,group};
}
