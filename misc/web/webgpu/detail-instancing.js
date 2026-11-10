// The stock detail shaders consume four vec4 rows selected by the geometry's
// batch index. Native detail geometry has one copy (index zero); WebGPU supplies
// those same rows as per-instance attributes, preserving every shader equation.
export function installDetailInstancing(meta) {
  if (meta.detailInstancing) return true;
  const array = meta.uniforms.find(u => u.name === "array" && u.type === "vec4" && u.count === 244);
  if (!array) return false;
  if (meta.attributes.some(a => ![3,8].includes(a.location)))
    throw Error("Unexpected detail vertex declaration");
  let source = meta.stages.vert;
  const group = array.group || 0;
  const declaration = new RegExp("@group\\("+group+"\\)\\s+@binding\\(0\\)\\s+var<uniform>\\s+(\\w+):\\s*(\\w+);").exec(source);
  if (!declaration) throw Error("Detail uniform block is missing");
  const [,variable,type] = declaration;
  const structure = new RegExp("struct "+type+" \\{([\\s\\S]*?)\\}").exec(source);
  const fields = [...structure[1].matchAll(/(?:@align\(\d+\)\s+@size\(\d+\)\s+)?(\w+)\s*:\s*([^\n]+),/g)];
  const uniforms = meta.uniforms.filter(u => (u.group || 0) === group);
  const member = fields[uniforms.indexOf(array)];
  if (!member || !/^array<vec4<f32>,\s*244>$/.test(member[2].trim()))
    throw Error("Detail array reflection does not match WGSL");
  const access = new RegExp("\\b"+variable+"\\."+member[1]+"\\b", "g");
  if (!access.test(source)) throw Error("Detail array is not used by the vertex shader");
  source = source.replace(access, "xr_detail_rows");
  const entry = /(@vertex\s+fn main\()([^\n]*)(\)\s*->[^\{]+\{)/;
  if (!entry.test(source)) throw Error("Unsupported detail vertex entry point");
  const parameters = [0,1,2,3].map(i => `@location(${12+i}) xr_detail_${i}: vec4<f32>`).join(", ");
  source = source.replace(entry, (_all,head,args,tail) => head+args+", "+parameters+tail+
    "\n    xr_detail_rows = array<vec4<f32>, 4>(xr_detail_0, xr_detail_1, xr_detail_2, xr_detail_3);");
  meta.stages = {...meta.stages, vert:"var<private> xr_detail_rows: array<vec4<f32>, 4>;\n"+source};
  meta.attributes = [...meta.attributes, ...[0,1,2,3].map(i => ({name:"xr_detail_"+i,location:12+i,type:35666,size:1}))];
  meta.key += ":detail-instances-v1";
  meta.detailInstancing = true;
  return true;
}
