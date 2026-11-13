// Draw records snapshot the ends of the three append-only state streams.
// Each 16-word record ends with an instance-buffer handle and instance count.
// Resource/query boundaries drain records before mutating their handles or bytes.
export function installNativeQueues(renderer, heap, pointers, handles, onBatch = () => {}) {
  const [uniformStart, uniformLength, stateStart, stateLength, bindingStart, bindingLength, drawStart, drawLength] = pointers.map(n=>Number(n)/4);
  let draining = false;
  const consume = (h, uniformFrom, uniformTo, stateFrom, stateTo, bindingFrom, bindingTo) => {
    if(uniformTo > uniformFrom) renderer.consumeUniformBatch(h.words,h.floats,h.ints,uniformStart+uniformFrom,uniformTo-uniformFrom,handles.programs);
    if(stateTo > stateFrom) renderer.consumeStateBatch(h.words,stateStart+stateFrom,stateTo-stateFrom,h.floats,handles.framebuffers,handles.textures);
    if(bindingTo > bindingFrom) renderer.consumeBindingBatch(h.words,bindingStart+bindingFrom,bindingTo-bindingFrom,handles.textures,handles.samplers);
  };
  renderer.flushNativeDraws = () => {
    if(draining) return;
    const h=heap(), w=h.words, count=w[drawLength];
    if(!count) return;
    if(count%16) throw Error('Invalid native draw batch');
    draining=true;
    try {
      let uniformFrom=0, stateFrom=0, bindingFrom=0;
      for(let n=drawStart;n<drawStart+count;n+=16) {
        const uniformTo=w[n+10], stateTo=w[n+11], bindingTo=w[n+12];
        if(uniformTo<uniformFrom || stateTo<stateFrom || bindingTo<bindingFrom ||
           uniformTo>w[uniformLength] || stateTo>w[stateLength] || bindingTo>w[bindingLength])
          throw Error('Invalid draw state boundary');
        consume(h,uniformFrom,uniformTo,stateFrom,stateTo,bindingFrom,bindingTo);
        uniformFrom=uniformTo; stateFrom=stateTo; bindingFrom=bindingTo;
        renderer.tessellationFactor=w[n+13];
        renderer.submitDraw(handles.vaos[w[n]],handles.buffers[w[n+1]],handles.buffers[w[n+2]],w[n+3],handles.programs[w[n+4]],w[n+5],w[n+6],w[n+7],w[n+8],w[n+9]|0,w[n+14]?handles.buffers[w[n+14]]:null,w[n+15]);
      }
      consume(h,uniformFrom,w[uniformLength],stateFrom,w[stateLength],bindingFrom,w[bindingLength]);
      w[drawLength]=w[uniformLength]=w[stateLength]=w[bindingLength]=0;
      onBatch(count/16);
    } finally { draining=false; }
  };
  renderer.flushNativeUniforms = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[uniformLength]; if(n){renderer.consumeUniformBatch(h.words,h.floats,h.ints,uniformStart,n,handles.programs);h.words[uniformLength]=0;} };
  renderer.flushNativeStates = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[stateLength]; if(n){renderer.consumeStateBatch(h.words,stateStart,n,h.floats,handles.framebuffers,handles.textures);h.words[stateLength]=0;} };
  renderer.flushNativeBindings = () => { renderer.flushNativeDraws(); if(draining)return; const h=heap(),n=h.words[bindingLength]; if(n){renderer.consumeBindingBatch(h.words,bindingStart,n,handles.textures,handles.samplers);h.words[bindingLength]=0;} };
}
