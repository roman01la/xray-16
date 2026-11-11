// Stock four-layer terrain: omit only exact-zero contributions. Unknown layouts
// fall back unchanged; explicit gradients preserve mip selection in divergent flow.
export function skipZeroTerrainLayers(meta){
 const names=['s_dt_r','s_dt_g','s_dt_b','s_dt_a','s_dn_r','s_dn_g','s_dn_b','s_dn_a'];
 if(!names.every(name=>meta.activeUniforms?.some(u=>u.name===name)))return false;
 let source=meta.stages.frag;
 const normalized=/let\s+(\w+)\s*=\s*\((\w+)\s*\/\s*vec4\(dot\(\2,/.exec(source);
 if(!normalized)return false;
 const weight=normalized[1];let changed=0;
 for(let i=0;i<names.length;i++){
  const binding=meta.samplers.findIndex(s=>s.name===names[i])*2+1;
  const declaration=new RegExp('@binding\\('+binding+'\\)\\s*var\\s+(\\w+):\\s*texture_2d').exec(source);if(!declaration)return false;
  const texture=declaration[1];
  const re=new RegExp('let\\s+(\\w+)\\s*=\\s*textureSample(Bias)?\\('+texture+',\\s*(\\w+),\\s*(\\w+)(?:,\\s*(\\w+))?\\);');
  const sample=re.exec(source);if(!sample)return false;
  const [,value,bias,sampler,uv,biasValue]=sample;if(bias&&!biasValue)return false;
  const gradScale=bias?' * exp2('+biasValue+')':'';
  const replacement=`let xr_dx_${i}=dpdx(${uv})${gradScale};let xr_dy_${i}=dpdy(${uv})${gradScale};\n    var ${value}=vec4<f32>(0);\n    if(${weight}.${'xyzw'[i%4]} != 0){${value}=textureSampleGrad(${texture},${sampler},${uv},xr_dx_${i},xr_dy_${i});}`;
  source=source.replace(re,replacement);changed++;
 }
 if(changed!==8)return false;
 meta.stages={...meta.stages,frag:source};meta.key+=':terrain-zero-layers-v1';meta.terrainZeroLayers=true;return true;
}
