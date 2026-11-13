// Injected only into the isolated profiling browser, after ordinary benchmarks.
export function installGpuPassProbe(maxEncoders = 120) {
  const renderer = globalThis.__xrayWebGPU;
  if (!renderer?.device?.features.has('timestamp-query')) return false;
  const device=renderer.device, queue=device.queue;
  const create=device.createCommandEncoder, submit=queue.submit, view=renderer.view, present=renderer.presentNative;
  const views=new WeakMap(), buffers=new WeakMap(), pending=new Set(), samples=[], errors=[];
  let encoders=0, skipped=0, frame=0;
  renderer.presentNative=function(...args){const result=present.apply(this,args);frame++;return result;};
  const describe=token=>{
    const info=renderer.info(token);
    return info?`${info.width}x${info.height} ${info.format} ${info.samples||1}x`:null;
  };
  for(const token of renderer.handles.textures){
    if(!token)continue;
    const info=renderer.info(token);
    for(const cached of info?.views?.values()??[])views.set(cached,describe(token));
  }
  renderer.view=function(token,...args){const result=view.call(this,token,...args);views.set(result,describe(token));return result;};
  device.createCommandEncoder=function(...args){
    const encoder=create.apply(this,args);
    if(encoders++>=maxEncoders)return encoder;
    const query=device.createQuerySet({type:'timestamp',count:512});
    const entries=[];
    for(const [method,kind] of [['beginRenderPass','render'],['beginComputePass','compute']]){
      const begin=encoder[method];
      encoder[method]=function(descriptor={}){
        if(descriptor.timestampWrites||entries.length>=256){skipped++;return begin.call(this,descriptor);}
        const index=entries.length;
        const item={kind,frame,shadowCascade:renderer.nativeShadowCascade|0,label:descriptor.label??'',
          colors:descriptor.colorAttachments?.map(a=>a?views.get(a.view)??'canvas/other':null),
          depth:views.get(descriptor.depthStencilAttachment?.view),
          draws:0,instances:0,dispatches:0,programs:[]};
        entries.push(item);
        const pass=begin.call(this,{...descriptor,timestampWrites:{querySet:query,beginningOfPassWriteIndex:index*2,endOfPassWriteIndex:index*2+1}});
        for(const name of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect']){
          if(!pass[name])continue;
          const draw=pass[name];
          pass[name]=function(...args){
            item.draws++;
            if(name==='draw'||name==='drawIndexed')item.instances+=args[1]??1;
            const program=renderer.programs.get(renderer.program)?.meta?.key;
            if(program&&!item.programs.includes(program))item.programs.push(program);
            return draw.apply(this,args);
          };
        }
        if(pass.dispatchWorkgroups){const dispatch=pass.dispatchWorkgroups;pass.dispatchWorkgroups=function(...args){item.dispatches++;return dispatch.apply(this,args);};}
        return pass;
      };
    }
    const finish=encoder.finish;
    encoder.finish=function(...args){
      if(!entries.length){query.destroy();return finish.apply(this,args);}
      const size=entries.length*16;
      const resolved=device.createBuffer({size,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      encoder.resolveQuerySet(query,0,entries.length*2,resolved,0);
      encoder.copyBufferToBuffer(resolved,0,read,0,size);
      const buffer=finish.apply(this,args);
      buffers.set(buffer,{query,resolved,read,entries});return buffer;
    };
    return encoder;
  };
  queue.submit=function(commands){
    const list=[...commands];submit.call(this,list);
    for(const buffer of list){
      const sample=buffers.get(buffer);if(!sample)continue;buffers.delete(buffer);
      const task=(async()=>{
        try{
          await sample.read.mapAsync(GPUMapMode.READ);
          const timestamps=new BigUint64Array(sample.read.getMappedRange());
          for(let i=0;i<sample.entries.length;i++) {
            const start=timestamps[i*2],end=timestamps[i*2+1];
            // Some Metal empty/clear-only passes leave a timestamp unwritten.
            // Keep the raw values for diagnosis, but exclude invalid durations.
            const valid=start>0n && end>=start;
            samples.push({...sample.entries[i],startNs:String(start),endNs:String(end),
              gpuMs:valid?Number(end-start)/1e6:null});
          }
          sample.read.unmap();
        }catch(error){errors.push(String(error));}
        finally{sample.query.destroy();sample.resolved.destroy();sample.read.destroy();}
      })();pending.add(task);task.finally(()=>pending.delete(task));
    }
  };
  globalThis.__stopGpuPassProbe=async()=>{
    device.createCommandEncoder=create;queue.submit=submit;renderer.view=view;renderer.presentNative=present;
    await Promise.all([...pending]);
    delete globalThis.__stopGpuPassProbe;
    return {samples,errors,sampledEncoders:Math.min(encoders,maxEncoders),skipped,
      note:'Isolated pass timestamps exclude CPU gaps and copy commands outside passes. Profiling overhead is excluded from headline benchmarks.'};
  };
  return true;
}
