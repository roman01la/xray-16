// Rewrite compiled uniform structs and reflection together. Original member
// identifiers remain stable; each block gets explicit 16-byte field alignment.
const frame = new Set(['m_V','m_P','m_VP','m_invV','timers','eye_position','eye_direction','eye_normal','fog_plane','fog_params','fog_color','L_sun_color','L_sun_dir_w','L_sun_dir_e','L_ambient','L_hemi_color','screen_res']);
const material = new Set(['L_material','hemi_cube_pos_faces','hemi_cube_neg_faces','dt_params','detail_params']);
export function packUniforms(program) {
  if(program.uniformPacking === 1) return program;
  const active = new Set(program.activeUniforms.map(u=>u.name.replace(/\[0\]$/,'')));
  const original = program.uniforms;
  const sizes=[0,0,0];
  const selected=original.map((u,index)=>({ ...u,index,group:frame.has(u.name)?1:material.has(u.name)?2:0 })).filter(u=>active.has(u.name));
  for(const u of selected){u.offset=sizes[u.group];sizes[u.group]+=u.stride*u.count;}
  for(const [stage,source] of Object.entries(program.stages)) {
    const declaration=/@group\(0\)\s+@binding\(0\)\s+var<uniform>\s+(\w+):\s*(\w+);/.exec(source);
    if(!declaration) continue;
    const [,variable,type]=declaration;
    const pattern=new RegExp('struct '+type+' \\{([\\s\\S]*?)\\}');
    const structure=pattern.exec(source);
    if(!structure)throw Error('Missing uniform structure');
    const members=[...structure[1].matchAll(/^\s*(\w+)\s*:\s*([^\n]+),\s*$/gm)];
    if(members.length!==original.length)throw Error('Uniform member/reflection mismatch '+program.key);
    let result=source.replace(pattern,'').replace(declaration[0],'');
    let declarations='';
    for(let group=0;group<3;group++) {
      const fields=selected.filter(u=>u.group===group);
      if(!fields.length)continue;
      const newType=type+'_block'+group,newVariable=variable+'_block'+group;
      declarations+='struct '+newType+' {\n'+fields.map(u=>'    @align(16) @size('+u.stride*u.count+') '+members[u.index][1]+': '+members[u.index][2]+',').join('\n')+'\n}\n';
      declarations+='@group('+group+') @binding(0) var<uniform> '+newVariable+': '+newType+';\n';
      for(const u of fields) result=result.replace(new RegExp('\\b'+variable+'\\.'+members[u.index][1]+'\\b','g'),newVariable+'.'+members[u.index][1]);
    }
    if(new RegExp('\\b'+variable+'\\b').test(result))throw Error('Unsupported aggregate uniform access '+program.key);
    program.stages[stage]=declarations+result;
  }
  program.uniforms=selected.map(({index,...u})=>u);
  program.uniformGroups=sizes.map(bytes=>({bytes:Math.max(16,bytes)}));
  program.uniformBytes=Math.max(16,sizes[0]);
  program.uniformPacking=1;
  return program;
}
