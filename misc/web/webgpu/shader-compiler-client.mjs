let connection, worker;
const shaderCaptureBuild = false;
export function startShaderCompiler() {
  return connection ||= new Promise((resolve, reject) => {
    const workerURL = new URL('./shader-compiler-worker.mjs', import.meta.url);
    if (globalThis.__xrayRetireLegacyStorage) workerURL.searchParams.set('retireLegacyStorage','1');
    if (shaderCaptureBuild) {
      const query = new URLSearchParams(globalThis.location?.search);
      for (const name of ['shaderCapture','shaderMap','shaderPreset','shaderScenario']) {
        if (query.has(name)) workerURL.searchParams.set(name, query.get(name));
      }
    }
    worker = new Worker(workerURL,
      {type:'module', name:'xray-shader-compiler'});
    const timeout = setTimeout(() => reject(Error('Shader compiler startup timed out')),120000);
    worker.onerror = event => {clearTimeout(timeout);reject(Error(event.message || 'Shader compiler worker failed'));};
    worker.onmessage = ({data}) => {
      globalThis.__xrayShaderCompilerStatus = data;
      globalThis.dispatchEvent?.(new CustomEvent('xray-shader-compiler-status',{detail:data}));
      if(data.type === 'ready') {clearTimeout(timeout);resolve(worker);}
      if(data.type === 'error') {clearTimeout(timeout);reject(Error(data.error));}
    };
  });
}
// One page-owned worker serves all engine pthreads through dedicated ports.
export function createShaderCompilerPort() {
  if (!worker) throw Error('Shader compiler worker must start before the engine');
  const {port1,port2} = new MessageChannel();
  worker.postMessage({type:'connect',port:port2},[port2]);
  return port1;
}

let compiler, response;
export async function initializeShaderCompilerClient(port) {
  if (!port) throw Error('Missing shader compiler port in engine startup');
  compiler = {port};
  await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(Error('Shader compiler connection timed out')),120000);
    port.onmessage = ({data}) => {
      if (data.type === 'ready') {clearTimeout(timeout);resolve();}
      if (data.type === 'error') {clearTimeout(timeout);reject(Error(data.error));}
    };
    port.start();
  });
}
export function loadShaderProgram(request) {
  if (!compiler) throw Error('Shader compiler client was not initialized before engine startup');
  // Only called on the engine pthread, never on the page's UI thread.
  response ||= new SharedArrayBuffer(8 * 1024 * 1024);
  const state = new Int32Array(response, 0, 4);
  Atomics.store(state, 0, 0);
  compiler.port.postMessage({type:'load', request, response});
  if (Atomics.wait(state, 0, 0, 120000) === 'timed-out') {
    // A late response must never overwrite the next request's buffer.
    response = null;
    throw Error('Shader compilation timed out');
  }
  const text = new TextDecoder().decode(new Uint8Array(response, 16, Atomics.load(state, 1)).slice());
  if (Atomics.load(state, 0) !== 1) throw Error(text);
  return JSON.parse(text);
}
