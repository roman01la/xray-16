// Bootstrap-only checks: no engine imports, game downloads, or persistent writes.
const memory64Module = new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,7,1,2]);
const requiredGPUFeatures = ['texture-compression-bc', 'texture-compression-bc-sliced-3d'];

export async function checkGameCompatibility(env = globalThis) {
 const missing = [];
 const nav = env.navigator;
 if (!env.isSecureContext) missing.push('A secure connection (HTTPS or localhost)');
 if (!env.crossOriginIsolated || typeof env.SharedArrayBuffer !== 'function')
  missing.push('Shared memory for engine threads (cross-origin isolation)');
 try {
  if (!env.WebAssembly.validate(memory64Module)) throw Error('unsupported');
  // Probe only one 64 KiB page, not the engine’s multi-gigabyte reservation.
  new env.WebAssembly.Memory({initial:1n, maximum:2n, shared:true, address:'i64'});
 } catch { missing.push('64-bit WebAssembly memory (Memory64)'); }
 if (typeof env.Worker !== 'function') missing.push('Web Workers');
 if (typeof env.OffscreenCanvas !== 'function' ||
     typeof env.HTMLCanvasElement?.prototype?.transferControlToOffscreen !== 'function')
  missing.push('Offscreen canvas rendering');
 if (!nav?.serviceWorker) missing.push('Service workers for offline game storage');
 if (typeof nav?.locks?.request !== 'function') missing.push('Web Locks for safe game storage');
 if (typeof nav?.storage?.getDirectory !== 'function' ||
     typeof env.FileSystemFileHandle?.prototype?.createWritable !== 'function') {
  missing.push('Local game file storage (OPFS writable streams)');
 } else {
  try { await nav.storage.getDirectory(); }
  catch { missing.push('Access to local game storage (check browser privacy/storage settings)'); }
 }
 if (!nav?.gpu) missing.push('WebGPU graphics');
 else {
  try {
   const adapter = await nav.gpu.requestAdapter({powerPreference:'high-performance'});
   if (!adapter) missing.push('An available WebGPU graphics adapter (check hardware acceleration)');
   else for (const feature of requiredGPUFeatures)
    if (!adapter.features.has(feature)) missing.push('GPU texture support: ' + feature);
  } catch { missing.push('Access to a WebGPU graphics adapter (check hardware acceleration)'); }
 }
 return missing;
}

let checked;
export function requireGameCompatibility() {
 return checked ??= (async () => {
  let timer;
  try {
   const missing = await Promise.race([
    checkGameCompatibility(),
    new Promise((_, reject) => { timer=setTimeout(() => reject(Error('Browser compatibility check timed out. Check browser graphics/storage settings and reload.')), 15000); }),
   ]);
   if (missing.length) throw Error('This browser cannot run the game. Missing: ' + missing.join('; ') + '. Try an up-to-date desktop Chrome or Edge with hardware acceleration enabled.');
  } catch (error) {
   error.compatibilityFailure = true;
   throw error;
  } finally { clearTimeout(timer); }
 })();
}

export function showCompatibilityFailure(error, doc = document) {
 doc.querySelector('#boot-status').textContent = error.message;
 const detail=doc.querySelector('#load-detail');
 if (detail) detail.textContent='No engine or game assets were downloaded. Existing saves and downloaded data have been kept.';
 const meter=doc.querySelector('#load-progress');if(meter){meter.hidden=true;meter.style.display='none';}
 const start=doc.querySelector('#start-game');if(start)start.disabled=true;
 const retry=doc.querySelector('#retry');if(retry){retry.hidden=false;retry.textContent='Check again';retry.onclick=()=>location.reload();}
}
