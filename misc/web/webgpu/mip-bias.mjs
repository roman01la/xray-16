// GLSL has a sampler LOD bias; WebGPU exposes it on sampling instructions.
// Operate on preprocessed GLSL so aliases and conditional branches are resolved.
export function applyMipBias(source) {
  if (!/uniform\s+vec4\s+xr_webgpu_mip_bias\s*;/.test(source)) return source;
  const samplers = new Set([...source.matchAll(/uniform\s+sampler(?:2D|3D|Cube)\s+(\w+)\s*;/g)].map(m=>m[1]));
  const edits = [];
  const wrap = (start,end,suffix) => { edits.push([start,'('],[end,')'+suffix]); };
  for (const m of source.matchAll(/\b(texture|textureProj|textureGrad)\s*\(/g)) {
    let depth=1, start=m.index+m[0].length, i=start;
    const args=[];
    for (;i<source.length;i++) {
      const c=source[i];
      if(c==='(')depth++;
      else if(c===')'&&--depth===0){args.push([start,i]);break;}
      if(c===','&&depth===1){args.push([start,i]);start=i+1;}
    }
    if(depth||!samplers.has(source.slice(...args[0]).trim()))continue;
    if(m[1]==='textureGrad') {
      if(args.length!==4)throw Error('Unexpected textureGrad arguments');
      for(const [a,b] of args.slice(2))wrap(a,b,' * exp2(xr_webgpu_mip_bias.x)');
    } else if(args.length===2) edits.push([i,', xr_webgpu_mip_bias.x']);
    else if(args.length===3)wrap(...args[2],' + xr_webgpu_mip_bias.x');
    else throw Error('Unexpected texture sampling arguments');
  }
  edits.sort((a,b)=>b[0]-a[0]);
  for(const [at,text] of edits)source=source.slice(0,at)+text+source.slice(at);
  return source;
}
