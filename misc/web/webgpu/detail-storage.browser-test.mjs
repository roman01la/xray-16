// Copy beside the staged backend and call verifyDetailReuse() in a WebGPU browser.
// Test-only: not included in the production distribution.
import {GPUFrontend} from './backend.js';
import {DetailStorage} from './detail-storage.js';
export async function verifyDetailReuse(){
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
 const device=await adapter.requestDevice();device.pushErrorScope('validation');
 const canvas=new OffscreenCanvas(8,8),r=new GPUFrontend(canvas,device,canvas.getContext('webgpu'));
 const arena=new DetailStorage(r,{maxPageRecords:8192});
 // Exercise multi-window logic without allocating hundreds of MB on the test GPU.
 arena.device=new Proxy(device,{get(target,key){if(key==='limits')return {maxStorageBufferBindingSize:65536};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const records=new Float32Array(8192*16);for(let i=0;i<records.length;i++)records[i]=i+1;
 const source=device.createBuffer({size:records.byteLength/2,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
 device.queue.writeBuffer(source,0,records.subarray(0,4096*16));arena.pages=[{gpu:source,capacity:4096,free:[]}];arena.bytes=source.size;
 const token={},readbacks=[];
 function snapshot(count,expected=records.slice(0,count*16)){
  r.endPass();const read=device.createBuffer({size:count*64,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  r.enc().copyBufferToBuffer(r.info(token).gpu,0,read,0,count*64);readbacks.push({read,count,expected});
 }
 arena.gatherRanges(token,new Uint32Array([0,1500,0,0,1500,551,1500,0]),2051,true);snapshot(2051);
 // Updating ranges submits prior readers; parameter offsets must preserve the
 // previous dispatch's length even though the same group is reused.
 arena.gatherRanges(token,new Uint32Array([0,1500,0,0,1500,549,1500,0]),2049,true);snapshot(2049);
 if(arena.metrics.bindGroups!==3)throw Error('Counts changed without growth but bind groups were recreated');
 r.uniformOffset=r.uniformBuffer.size;
 arena.gatherRanges(token,new Uint32Array([0,1500,0,0,1500,549,1500,0]),2049,false);snapshot(2049);
 arena.grow(arena.pages[0],8192);
 device.queue.writeBuffer(arena.pages[0].gpu,0,records);
 arena.gatherRanges(token,new Uint32Array([0,1500,0,0,1500,549,1500,0]),2049,false);snapshot(2049);
 if(arena.metrics.bindGroups!==6)throw Error('Source page replacement did not invalidate groups');
 // A wider range buffer and output allocation must invalidate the group too.
 arena.gatherRanges(token,new Uint32Array([0,2000,0,0,2000,2000,2000,0,4000,1000,4000,0]),5000,true);snapshot(5000);
 // Patch across a 1024-record output-window boundary, leaving all other rows intact.
 const expected=records.slice(0,5000*16);
 expected.set(records.subarray(6000*16,6100*16),1000*16);
 expected.set(records.subarray(7000*16,7020*16),4000*16);
 arena.gatherRanges(token,new Uint32Array([6000,100,1000,0,7000,20,4000,0]),5000,true,true);snapshot(5000,expected.slice());
 expected.set(records.subarray(3000*16,3010*16),4500*16);
 arena.gatherRanges(token,new Uint32Array([3000,10,4500,0]),5000,true,true);snapshot(5000,expected.slice());
 r.flush();let checked=0;
 for(const {read,count,expected} of readbacks){await read.mapAsync(GPUMapMode.READ);const got=new Float32Array(read.getMappedRange());for(let i=0;i<count*16;i++){if(got[i]!==expected[i])throw Error(`Gather mismatch at ${i}: ${got[i]} != ${expected[i]}`);checked++;}read.unmap();read.destroy();}
 const error=await device.popErrorScope();device.destroy();if(error)throw Error(error.message);
 return {passed:true,checkedFloatValues:checked,readbacks:readbacks.length,bindGroups:arena.metrics.bindGroups};
}
