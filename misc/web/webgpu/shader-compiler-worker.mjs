import { createWasmToolchain } from './wasm-toolchain.mjs';
import { compileProgram } from './compiler-core.mjs';
import { createShaderStore, SHADER_CACHE_VERSION, validateProgram } from './shader-cache.mjs';
import { migrateLegacyCache } from './opfs-store.mjs';

const ports = new Set();
const stats = {ready:false, compiled:0, package:0, cache:0, errors:0};
function report(event) {
  if (event.source) stats[event.source]++;
  self.postMessage({type:'stats', ...stats, ...event});
}
// Initialize once at page startup, then sleep in the event loop between jobs.
// Catch startup failure immediately so every connecting client receives it.
const captureOptions = new URL(import.meta.url).searchParams;
const ready = createWasmToolchain().then(async toolchain => {
  const migrate = store => {
    const run = () => migrateLegacyCache({
      cacheStorage:globalThis.caches, name:SHADER_CACHE_VERSION, store,
      retire:captureOptions.has('retireLegacyStorage'),
      identify:url => url.origin===location.origin ? url.pathname.match(/\/shaders\/([a-f0-9]{64})\.json$/)?.[1] : null,
      async validate(file,key) {
        try { return !!validateProgram(JSON.parse(await file.text()),key); }
        catch { return false; }
      },
    });
    return navigator.locks ? navigator.locks.request('xray-opfs-shader-migration', run) : run();
  };
  const store=createShaderStore({fetchManifest:fetch, compile:request => compileProgram(request, toolchain), migrate, report});
  await store.preload();
  const capture = captureOptions.has('shaderCapture')
    ? await (await import('./shader-capture.mjs')).openShaderCapture(captureOptions)
    : null;
  stats.ready = true;
  return {store,capture};
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
        const {store, capture, error} = await ready;
        if (error) throw Error(error);
        const result = capture
          ? await capture.load(store, data.request)
          : await store.load(data.request);
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
