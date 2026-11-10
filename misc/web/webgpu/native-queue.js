// Draw records snapshot the ends of the three append-only state streams.
// Each 16-word record ends with an instance-buffer handle and instance count.
// Resource/query boundaries drain records before mutating their handles or bytes.
export function installNativeQueues(renderer, heap, pointers, handles, onBatch = () => {}) {
  const [uniformStart, uniformLength, stateStart, stateLength, bindingStart, bindingLength, drawStart, drawLength] = pointers.map(n=>Number(n)/4);
  let draining = false;
  const consume = (h, from, to) => {
    if(to[0] > from[0]) renderer.consumeUniformBatch(h.words,h.floats,h.ints,uniformStart+from[0],to[0]-from[0],handles.programs);
    if(to[1] > from[1]) renderer.consumeStateBatch(h.words,stateStart+from[1],to[1]-from[1],h.floats,handles.framebuffers,handles.textures);
    if(to[2] > from[2]) renderer.consumeBindingBatch(h.words,bindingStart+from[2],to[2]-from[2],handles.textures,handles.samplers);
  };
  renderer.flushNativeDraws = () => {
    if(draining) return;
    const h=heap(), w=h.words, count=w[drawLength];
    if(!count) return;
    if(count%16) throw Error('Invalid native draw batch');
    draining=true;
    try {
      let previous=[0,0,0];
      for(let n=drawStart;n<drawStart+count;n+=16) {
        const end=[w[n+10],w[n+11],w[n+12]];
        if(end.some((v,i)=>v<previous[i]) || end[0]>w[uniformLength] || end[1]>w[stateLength] || end[2]>w[bindingLength]) throw Error('Invalid draw state boundary');
        consume(h,previous,end); previous=end;
        renderer.tessellationFactor=w[n+13];
        renderer.submitDraw(handles.vaos[w[n]],handles.buffers[w[n+1]],handles.buffers[w[n+2]],w[n+3],handles.programs[w[n+4]],w[n+5],w[n+6],w[n+7],w[n+8],w[n+9]|0,w[n+14]?handles.buffers[w[n+14]]:null,w[n+15]);
      }
      consume(h,previous,[w[uniformLength],w[stateLength],w[bindingLength]]);
      w[drawLength]=w[uniformLength]=w[stateLength]=w[bindingLength]=0;
      onBatch(count/16);
    } finally { draining=false; }
  };
  renderer.flushNativeUniforms = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[uniformLength]; if(n){renderer.consumeUniformBatch(h.words,h.floats,h.ints,uniformStart,n,handles.programs);h.words[uniformLength]=0;} };
  renderer.flushNativeStates = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[stateLength]; if(n){renderer.consumeStateBatch(h.words,stateStart,n,h.floats,handles.framebuffers,handles.textures);h.words[stateLength]=0;} };
  renderer.flushNativeBindings = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[bindingLength]; if(n){renderer.consumeBindingBatch(h.words,bindingStart,n,handles.textures,handles.samplers);h.words[bindingLength]=0;} };
}
