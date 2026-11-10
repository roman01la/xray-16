// Fail closed when Emscripten changes its generated loader. Applied only to the
// separately staged multiplayer engine, after native WebGPU staging.
export function attachMultiplayerLoader(source) {
  const replace=(needle,value)=>{
    if(source.split(needle).length!==2)throw new Error('Multiplayer loader hook missing or ambiguous: '+needle);
    source=source.replace(needle,value);
  };
  replace('await installWebGPUBackend(msgData.shaderCompilerPort,msgData.gpuDiagnosticsChannel);createWasm();',
    'await installWebGPUBackend(msgData.shaderCompilerPort,msgData.gpuDiagnosticsChannel);if(msgData.zonePort)installDormantEngineBridge(globalThis,msgData.zonePort,{epoch:msgData.zoneEpoch,contract:msgData.zoneContract,content:msgData.zoneContent,nativeMovement:msgData.zoneNativeMovement,getHeap:()=>HEAPU8});createWasm();');
  replace('worker.postMessage({cmd:1,handlers,wasmMemory,wasmModule,shaderCompilerPort,gpuDiagnosticsChannel:globalThis.__xrayGPUDiagnosticsChannel},[shaderCompilerPort])',
    'const zonePort=Module["zoneBridge"]?.createPort();worker.postMessage({cmd:1,handlers,wasmMemory,wasmModule,shaderCompilerPort,gpuDiagnosticsChannel:globalThis.__xrayGPUDiagnosticsChannel,zonePort,zoneEpoch:Module["zoneEpoch"],zoneContract:Module["zoneContract"],zoneContent:Module["zoneContent"],zoneNativeMovement:Module["zoneNativeMovement"]},[shaderCompilerPort,...(zonePort?[zonePort]:[])])');
  return "import {installDormantEngineBridge} from './pthread-bridge.mjs';\n"+source;
}
