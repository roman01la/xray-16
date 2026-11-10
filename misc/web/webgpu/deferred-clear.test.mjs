import test from 'node:test';import assert from 'node:assert/strict';
import {GPUFrontend} from './backend.js';import {EngineFormat as F} from './engine-formats.js';
function fixture(){
 const color={},depth={},other={},passes=[];const r=Object.create(GPUFrontend.prototype);
 Object.assign(r,{objects:new WeakMap([color,depth,other].map(t=>[t,{gpu:{createView:()=>({token:t})},views:new Map(),format:t===depth?'depth24plus-stencil8':'rgba8unorm',mips:1}])),state:{colorMask:15,depthWrite:true,stencilMask:0xffffffff,clearColor:[0,0,0,0],clearDepth:1,clearStencil:0},occlusion:{set:{},resume(){},suspend(){}},attachments:()=>({colors:[{texture:color}],depth:{texture:depth},key:'main'}),enc:()=>({beginRenderPass(d){passes.push(d);return {end(){}}}})});
 return {r,color,depth,other,passes};
}
test('color and depth clears fold into their first drawing pass without losing values',()=>{
 const {r,color,depth,passes}=fixture();r.clearNativeTarget(color,F.COLOR_BUFFER_BIT,1,0.5,0,1,1,0);r.clearNativeTarget(depth,F.DEPTH_BUFFER_BIT|F.STENCIL_BUFFER_BIT,0,0,0,0,0.25,7);
 assert.equal(passes.length,0);r.begin();assert.equal(passes.length,1);assert.equal(r.pendingClears.size,0);
 assert.deepEqual(passes[0].colorAttachments[0].clearValue,[1,0.5,0,1]);assert.equal(passes[0].colorAttachments[0].loadOp,'clear');assert.equal(passes[0].depthStencilAttachment.depthClearValue,0.25);assert.equal(passes[0].depthStencilAttachment.stencilClearValue,7);
});
test('sampling flushes a named clear, unrelated texture access does not',()=>{
 const {r,color,other,passes}=fixture();r.clearNativeTarget(color,F.COLOR_BUFFER_BIT,1,0,0,1,1,0);r.view(other);assert.equal(passes.length,0);r.view(color,0,0,'2d',true);assert.equal(passes.length,1);assert.equal(r.pendingClears.size,0);
});
test('cached material dependencies flush pending sampled textures',()=>{
 const {r,color,passes}=fixture();r.textures=[new Map([[F.TEXTURE_2D,color]])];r.clearNativeTarget(color,F.COLOR_BUFFER_BIT,1,0,0,1,1,0);r.cachedMaterial({materialDependencies:[{unit:0}]});assert.equal(passes.length,1);
});
test('different mip use and explicit drains retain standalone clear semantics',()=>{
 const {r,color,passes}=fixture();r.clearNativeTarget(color,F.COLOR_BUFFER_BIT,1,0,0,1,1,0);r.attachments=()=>({colors:[{texture:color,level:1}],depth:null,key:'mip'});r.begin();assert.equal(passes.length,2);assert.equal(passes[0].colorAttachments[0].loadOp,'clear');assert.equal(passes[1].colorAttachments[0].loadOp,'load');
});
test('successive same-texture aspect clears preserve earlier aspect contents',()=>{
 const {r,depth,passes}=fixture();r.clearNativeTarget(depth,F.DEPTH_BUFFER_BIT,0,0,0,0,0.25,0);r.clearNativeTarget(depth,F.STENCIL_BUFFER_BIT,0,0,0,0,1,9);assert.equal(passes.length,1);r.begin();assert.equal(passes[1].depthStencilAttachment.depthLoadOp,'load');assert.equal(passes[1].depthStencilAttachment.stencilClearValue,9);
});
