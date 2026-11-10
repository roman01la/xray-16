import test from 'node:test';
import assert from 'node:assert/strict';
import {tessellationFactor,tessellationPattern,pnPatch,evaluatePatch,patchCulled} from './tessellation-core.js';
const close=(a,b,epsilon=1e-6)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<epsilon,`${a} != ${b}`));
test('stock factors use reference topology, bounded through factor eight',()=>{
 assert.equal(tessellationFactor(0),1);assert.equal(tessellationFactor(1),8);assert.equal(tessellationFactor(3),8);
 assert.throws(()=>tessellationFactor(NaN));
 for(const [factor,vertices,triangles] of [[1,3,1],[2,7,6],[4,19,24],[8,61,96]]) {
  const {points,indices}=tessellationPattern(factor);assert.equal(points.length,vertices);assert.equal(indices.length,triangles*3);
  points.forEach(p=>{assert.ok(p.every(n=>n>=0&&n<=1));close([p.reduce((a,b)=>a+b)],[1]);});
  const edges=new Map();let area=0;
  for(let i=0;i<indices.length;i+=3){const t=indices.slice(i,i+3);assert.ok(t.every(n=>n<vertices));
   const [a,b,c]=t.map(n=>points[n]);const cross=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
   assert.ok(cross<0);area-=cross/2;
   for(let j=0;j<3;j++){const key=[t[j],t[(j+1)%3]].sort((a,b)=>a-b).join(':');edges.set(key,(edges.get(key)||0)+1);}}
  close([area],[.5]);assert.ok([...edges.values()].every(n=>n===1||n===2));
 }
});
test('PN planar positions, original color edge lock, and distinct shadow displacement',()=>{
 const p=pnPatch([[0,0,0],[1,0,0],[0,1,0]],[[0,0,1],[0,0,1],[0,0,1]]);
 close(evaluatePatch(p,[1/3,1/3,1/3]).position,[1/3,1/3,0]);
 close(evaluatePatch(p,[.5,.5,0],{method:2,detail:true,height:1}).position,[.5,.5,0]);
 close(evaluatePatch(p,[.5,.5,0],{method:2,detail:true,height:1,shadow:true}).position,[.5,.5,.07]);
 close(evaluatePatch(p,[1/3,1/3,1/3],{method:2,height:1}).position,[1/3,1/3,0]);
 close(evaluatePatch(p,[1/3,1/3,1/3],{method:2,detail:true,detailBump:true,height:1,detailHeight:1}).position,[1/3,1/3,.077]);
});
test('near-edge snapping, degenerate controls, PN back-face gate',()=>{
 const p=pnPatch([[0,0,6],[1,0,6],[0,1,6]],[[0,0,1],[0,0,1],[0,0,1]]);
 assert.equal(patchCulled(p,1),true);assert.equal(patchCulled(p,3),false);
 close([Math.min(...evaluatePatch(p,[.05,.45,.5]).barycentric)],[0]);
 close(evaluatePatch(p,[.05,.45,.5],{shadow:true}).barycentric,[.05,.45,.5]);
 const d=pnPatch([[0,0,0],[0,0,0],[0,0,0]],[[0,0,0],[0,0,0],[0,0,0]]);
 assert.ok(evaluatePatch(d,[1/3,1/3,1/3]).position.every(Number.isFinite));
});
