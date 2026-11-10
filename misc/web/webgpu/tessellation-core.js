import {tessellationPatterns} from './tessellation-patterns.js';
export const TessellationMethod = Object.freeze({PN:1,HM:2,PN_HM:3});
export function tessellationFactor(lod) {
  if (!Number.isFinite(lod)) throw Error('Non-finite tessellation LOD');
  const factor=Math.max(1,Math.min(7,Math.ceil(Math.max(0,lod)**5*8)));
  return 2**Math.ceil(Math.log2(factor));
}
export function tessellationPattern(factor) {
  const pattern=tessellationPatterns[factor];
  if (!pattern) throw Error('Unsupported stock tessellation factor');
  return pattern;
}
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const scale=(a,k)=>a.map(x=>x*k);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const weighted=(vectors,weights)=>vectors.reduce((s,v,i)=>add(s,scale(v,weights[i])),[0,0,0]);
const normalized=(n,fallback=[0,0,1])=>{const d=Math.sqrt(dot(n,n));return d>1e-12?scale(n,1/d):fallback.slice();};
// CPU oracle for the original archived tess.h math. Used by GPU validation,
// never to subdivide geometry during a game frame.
export function pnPatch(positions,normals) {
  const n=normals.map(x=>normalized(x));
  const edges=[[0,1],[1,0],[1,2],[2,1],[2,0],[0,2]].map(([i,j])=>
    scale(sub(add(scale(positions[i],2),positions[j]),scale(n[i],dot(sub(positions[j],positions[i]),n[i]))),1/3));
  const average=scale(edges.reduce(add,[0,0,0]),1/6),center=scale(positions.reduce(add,[0,0,0]),1/3);
  const edgeNormals=[[0,1],[1,2],[2,0]].map(([i,j])=>{
    const edge=sub(positions[j],positions[i]),sum=add(n[i],n[j]),length=dot(edge,edge);
    return normalized(length>1e-20?sub(sum,scale(edge,2*dot(edge,sum)/length)):sum,n[i]);
  });
  return {positions,normals,edges,center:add(average,scale(sub(average,center),.5)),edgeNormals};
}
export function evaluatePatch(patch,barycentric,{method=1,shadow=false,height=0,detailHeight=.5,detail=false,detailBump=false}={}) {
  const original=barycentric.slice(),minimum=Math.min(...original);let b=original.slice();
  if (!shadow&&minimum!==0&&1/3-minimum>.01&&minimum<.1) {
    const k=(1/3)/(1/3-minimum);b=b.map(x=>1/3+(x-1/3)*k);
  }
  const [v,u,w]=b,linear=weighted(patch.positions,[w,u,v]);let position=linear.slice();
  let normal=normalized(weighted(patch.normals,[w,u,v]));
  if (method&1) {
    const [b210,b120,b021,b012,b102,b201]=patch.edges;
    position=weighted([...patch.positions,b210,b120,b201,b021,b102,b012,patch.center],
      [w*w*w,u*u*u,v*v*v,3*w*w*u,3*w*u*u,3*w*w*v,3*u*u*v,3*w*v*v,3*u*v*v,6*w*u*v]);
    normal=weighted([...patch.normals,...patch.edgeNormals],[w*w,u*u,v*v,w*u,u*v,w*v]);
  }
  if ((method&2)&&detail) position=add(position,scale(normal,(height+(detailBump?(detailHeight-.5)*.2:0))*.07));
  if (!shadow&&minimum===0) position=linear;
  return {position,normal,barycentric:b};
}
export function patchCulled(patch,method) {
  return method===1&&patch.positions.every(p=>p[2]>5)&&
    patch.normals.every(n=>normalized(n)[2]>.1)&&patch.edgeNormals.every(n=>n[2]>.1);
}
