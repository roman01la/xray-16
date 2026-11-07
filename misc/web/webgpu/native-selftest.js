import {EngineFormat} from './engine-formats.js';
// Exercises rare UI/partial-clear paths on tiny offscreen targets, with GPU readback.
export async function validateNativeGPU(r) {
  const saved={state:{...r.state},fbo:r.fbo,readFbo:r.readFbo,ui:r.nativeUI};
  const textures=[],readbacks=[];
  const target=(format)=>{
    const token={};r.allocateNativeTexture(token,EngineFormat.TEXTURE_2D,1,format,4,4,1);textures.push(token);
    r.fbo={};r.info(r.fbo).attachments=new Map();return token;
  };
  const read=(token,depth=false)=>{
    r.validateNativeFramebuffer();
    r.endPass();
    const b=r.device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    r.enc().copyTextureToBuffer({texture:r.info(token).gpu,aspect:depth?'depth-only':'all'},{buffer:b,bytesPerRow:256},[4,4,1]);
    readbacks.push(b);r.flush();return b;
  };
  r.flushNativeStates?.();r.flushNativeBindings?.();r.flushNativeUniforms?.();r.endPass();
  r.device.pushErrorScope('validation');
  let errorPromise, setupError;
  try {
    const color=target(EngineFormat.RGBA8);
    r.clearNativeTarget(color,EngineFormat.COLOR_BUFFER_BIT,0,0,0,1,1,0);
    r.clearNativeRects(color,false,[1,0,0,1],1,[[1,1,3,3]]);read(color);
    const depth=target(EngineFormat.DEPTH_COMPONENT32F);
    r.clearNativeTarget(depth,EngineFormat.DEPTH_BUFFER_BIT,0,0,0,0,1,0);
    r.clearNativeRects(depth,true,[0,0,0,0],0.25,[[1,1,3,3]]);read(depth,true);
    const ui=target(EngineFormat.RGBA8);
    r.clearNativeTarget(ui,EngineFormat.COLOR_BUFFER_BIT,0,0,0,1,1,0);
    const font={};r.allocateNativeTexture(font,EngineFormat.TEXTURE_2D,1,EngineFormat.RGBA8,1,1,1);textures.push(font);
    r.uploadNativeTexture(font,EngineFormat.TEXTURE_2D,0,1,1,1,EngineFormat.RGBA,EngineFormat.UNSIGNED_BYTE,false,new Uint8Array([255,255,255,255]));
    const data=new ArrayBuffer(80),view=new DataView(data);
    [[0,0],[4,0],[4,4],[0,4]].forEach(([x,y],n)=>{
      view.setFloat32(n*20,x,true);view.setFloat32(n*20+4,y,true);
      view.setFloat32(n*20+8,0.5,true);view.setFloat32(n*20+12,0.5,true);view.setUint32(n*20+16,0xff00ff00,true);
    });
    r.beginNativeUIList(new Uint8Array(data),new Uint8Array(new Uint16Array([0,1,2,2,3,0]).buffer),2,[0,0,4,4,1,1]);
    r.drawNativeUI(font,6,0,0,[0,0,2,2]);r.endNativeUIList();read(ui);
    const streamed=target(EngineFormat.RGBA8);
    r.clearNativeTarget(streamed,EngineFormat.COLOR_BUFFER_BIT,0,0,0,1,1,0);
    for(let side=0;side<2;side++) {
      for(let n=0;n<4;n++)view.setUint32(n*20+16,side?0xff00ff00:0xff0000ff,true);
      r.beginNativeUIList(new Uint8Array(data),new Uint8Array(new Uint16Array([0,1,2,2,3,0]).buffer),2,[0,0,4,4,1,1]);
      r.drawNativeUI(font,6,0,0,[side*2,0,2,4]);r.endNativeUIList();
    }
    read(streamed);
  } catch (error) { setupError=error; } finally {
    r.endNativeUIList();r.endPass();r.fbo=saved.fbo;r.readFbo=saved.readFbo;
    Object.assign(r.state,saved.state);r.nativeUI=saved.ui;r.pipelineStateKey=null;
    errorPromise=r.device.popErrorScope();
  }
  try {
    const error=await errorPromise;if(setupError)throw setupError;if(error)throw Error(error.message);
    await Promise.all(readbacks.map(b=>b.mapAsync(GPUMapMode.READ)));
    const color=new Uint8Array(readbacks[0].getMappedRange());
    const depth=new DataView(readbacks[1].getMappedRange());
    const ui=new Uint8Array(readbacks[2].getMappedRange());
    const streamed=new Uint8Array(readbacks[3].getMappedRange());
    for(let y=0;y<4;y++)for(let x=0;x<4;x++){
      const inside=x>=1&&x<3&&y>=1&&y<3,offset=y*256+x*4;
      if(color[offset] !== (inside?255:0) || color[offset+3]!==255)throw Error('Color rectangle readback mismatch');
      if(depth.getFloat32(offset,true)!==(inside?0.25:1))throw Error('Depth rectangle readback mismatch');
      if(streamed[offset] !== (x<2?255:0) || streamed[offset+1] !== (x>=2?255:0))throw Error('Streamed draw data was overwritten before submission');
      if(ui[offset+1]!== (x<2&&y>=2?255:0))throw Error('ImGui clipping/readback mismatch');
    }
    return {passed:true,checks:['color rectangle preserves outside pixels','depth rectangle preserves outside pixels','native ImGui geometry, texture, projection and clipping','successive streamed draws retain distinct geometry data'],pixelsChecked:64};
  } finally {
    for(const b of readbacks){if(b.mapState==='mapped')b.unmap();b.destroy();}
    for(const t of textures)r.info(t).gpu.destroy();
  }
}
