// Copy beside a staged backend. Run in an isolated WebGPU browser.
import {GPUFrontend} from './backend.js';import {EngineFormat as F} from './engine-formats.js';
export async function verifyDeferredClears(){
 const adapter=await navigator.gpu.requestAdapter();const device=await adapter.requestDevice();device.pushErrorScope('validation');
 const canvas=new OffscreenCanvas(8,8),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
 const make=()=>{const token={};Object.assign(r.info(token),{gpu:device.createTexture({size:[8,8],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING}),format:'rgba8unorm',views:new Map(),width:8,height:8,mips:1});return token;};
 const a=make(),b=make();let checked=0;
 const read=async(token,expected)=>{r.flushPendingClears();r.endPass();const read=device.createBuffer({size:256*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});r.enc().copyTextureToBuffer({texture:r.info(token).gpu},{buffer:read,bytesPerRow:256},[8,8]);r.flush();await read.mapAsync(GPUMapMode.READ);const data=new Uint8Array(read.getMappedRange());for(let y=0;y<8;y++)for(let x=0;x<8;x++)for(let c=0;c<4;c++){if(data[y*256+x*4+c]!==expected[c])throw Error('Clear pixel mismatch');checked++;}read.unmap();read.destroy();};
 r.attachments=()=>({colors:[{texture:a}],depth:null,key:'a'});
 r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,1,0,0,1,1,0);r.begin();r.endPass();await read(a,[255,0,0,255]);
 r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,0,1,0,1,1,0);r.copyNativeTexture(a,b,8,8);await read(b,[0,255,0,255]);
 r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,0,0,1,1,1,0);r.view(a,0,0,'2d',true);await read(a,[0,0,255,255]);
 r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,1,0,1,1,1,0);r.flush();await read(a,[255,0,255,255]);
 r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,1,1,0,1,1,0);r.clearNativeTarget(a,F.COLOR_BUFFER_BIT,0,1,1,1,1,0);r.begin();r.endPass();await read(a,[0,255,255,255]);
 const error=await device.popErrorScope();device.destroy();if(error)throw Error(error.message);return {passed:true,checkedBytes:checked,cases:5};
}
