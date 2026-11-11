import {filterWGSL} from './grass-gpu-filter.js';
export async function verifyGrassFilter(){
 const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
 device.pushErrorScope('validation');
 const pipeline=device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:filterWGSL}),entryPoint:'main'}});
 let checked=0;
 // Odd counts exercise inactive lanes; negative scale/rotation, wind and translated
 // light volumes exercise conservative planes and world-space transformed bounds.
 for(const n of [1,63,64,65,257])for(const wind of [0,2]){
  const input=new Float32Array(n*16),center=[.1,1,-.2],extent=[.3,1,.4],expected=[];
  const m=[.25,0,0,0,0,.25,0,0,0,0,1,0,-.25,.25,0,1];
  for(let i=0;i<n;i++){
   const angle=i*.2,scale=i%2?1.2:-.7,c=Math.cos(angle)*scale,s=Math.sin(angle)*scale;
   const rows=[[c,0,s,(i%17)-8],[0,scale,0,(i%7)-3],[-s,0,c,i*.1],[i,1,2,3]];
   rows.forEach((row,j)=>input.set(row,i*16+j*4));
   const position=rows.slice(0,3).map(r=>r[3]+r.slice(0,3).reduce((v,x,k)=>v+x*center[k],0));
   const size=rows.slice(0,3).map(r=>r.slice(0,3).reduce((v,x,k)=>v+Math.abs(x)*extent[k],0));
   const height=rows[1].slice(0,3).reduce((v,x,k)=>v+Math.abs(x)*(Math.abs(center[k])+extent[k]),0);
   size[0]+=height*wind+.05;size[1]+=.05;size[2]+=height*wind+.05;
   if(position[0]+size[0]>=-3&&position[0]-size[0]<=5&&position[1]+size[1]>=-5&&position[1]-size[1]<=3)expected.push(i);
  }
  const make=(size,usage)=>device.createBuffer({size,usage});
  const source=make(input.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),output=make(input.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
  const args=make(20,GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC),params=make(128,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const read=make(input.byteLength+256,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
  const bytes=new ArrayBuffer(128),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(m);f.set(center,16);f.set(extent,20);f[24]=wind;u[28]=n;
  device.queue.writeBuffer(source,0,input);device.queue.writeBuffer(args,0,new Uint32Array([12,0,3,7,0]));device.queue.writeBuffer(params,0,bytes);
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[source,output,args,params].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(n/64));pass.end();encoder.copyBufferToBuffer(args,0,read,0,20);encoder.copyBufferToBuffer(output,0,read,256,input.byteLength);device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);const data=read.getMappedRange(),actualArgs=new Uint32Array(data,0,5),rows=new Float32Array(data,256),actual=[];
  if(actualArgs[0]!==12||actualArgs[2]!==3||actualArgs[3]!==7||actualArgs[4]!==0)throw Error('Indirect draw arguments changed');
  for(let i=0;i<actualArgs[1];i++){
   const id=rows[i*16+12];actual.push(id);
   for(let k=0;k<16;k++)if(rows[i*16+k]!==input[id*16+k])throw Error('Compacted record changed');
  }
  actual.sort((a,b)=>a-b);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('GPU/CPU culling mismatch: '+JSON.stringify({n,wind,actual,expected}));
  checked+=n;read.unmap();for(const b of [source,output,args,params,read])b.destroy();
 }
 const error=await device.popErrorScope();device.destroy();if(error)throw error;
 return {passed:true,instancesChecked:checked,cases:10};
}
