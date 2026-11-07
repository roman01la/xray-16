import { createWasmToolchain } from './wasm-toolchain.mjs';
import { compileProgram } from './compiler-core.mjs';
import { createShaderStore } from './shader-cache.mjs';

const ports = new Set();
const stats = {ready:false, compiled:0, package:0, cache:0, errors:0};
function report(event) {
  if (event.source) stats[event.source]++;
  self.postMessage({type:'stats', ...stats, ...event});
}
// Initialize once at page startup, then sleep in the event loop between jobs.
// Catch startup failure immediately so every connecting client receives it.
const ready = createWasmToolchain().then(toolchain => {
  stats.ready = true;
  return {store:createShaderStore({compile:request => compileProgram(request, toolchain), report})};
}).catch(error => ({error:String(error.stack || error)}));
let jobs = Promise.resolve();
ready.then(({error}) => self.postMessage({type:error ? 'error' : 'ready',error,...stats}));
self.onmessage = ({data}) => {
  if (data.type !== 'connect') return;
  const port = data.port;
  ports.add(port);
  port.start();
  ready.then(({error}) => port.postMessage({type:error ? 'error' : 'ready', error, ...stats}));
  port.onmessage = ({data}) => {
    if (data.type === 'disconnect') { ports.delete(port); port.close(); return; }
    if (data.type !== 'load') return;
    // Both WASM toolchains use reusable output storage, so jobs are serialized.
    jobs = jobs.then(async () => {
      const state = new Int32Array(data.response, 0, 4);
      try {
        const {store, error} = await ready;
        if (error) throw Error(error);
        const result = await store.load(data.request);
        finish(1, JSON.stringify(result));
      } catch (error) {
        stats.errors++;
        finish(2, String(error.stack || error));
      }
      function finish(status, text) {
        let bytes = new TextEncoder().encode(text);
        if (bytes.length > data.response.byteLength - 16) {
          status = 2; bytes = new TextEncoder().encode('Shader compiler response exceeds shared buffer capacity');
        }
        new Uint8Array(data.response, 16, bytes.length).set(bytes);
        Atomics.store(state, 1, bytes.length);
        Atomics.store(state, 0, status);
        Atomics.notify(state, 0);
      }
    });
  };
};
