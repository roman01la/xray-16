import { shaderKey } from './shader-key.js';

// Source keys stay identical to offline packages. Namespace invalidates compiled
// data when toolchain, reflection or uniform ABI changes, regardless of origin.
export const SHADER_CACHE_VERSION = 'xray-shaders-v3-shaderc2026.1-naga26-packing1-r1';
const openOPFS = name => import('./opfs-store.mjs').then(({openInstallStore}) => openInstallStore(name));
export function validateProgram(program, key) {
  if (program?.key !== key || program.uniformPacking !== 1 ||
      !Array.isArray(program.activeUniforms) || !Array.isArray(program.attributes) ||
      typeof program.stages?.vert !== 'string' || typeof program.stages?.frag !== 'string')
    throw Error('Invalid shader artifact ' + key);
  return program;
}

function shaderStorageError(cause) {
  return new Error('Packaged shaders could not be stored. Check browser storage and retry.',{cause});
}

export function createShaderStore({openStore = openOPFS, fetchProgram = globalThis.fetch, migrate,
  fetchManifest, compile, baseURL = import.meta.url, report = () => {}}) {
  const memory = new Map(), pending = new Map(), preloadedSources=new Map();
  let storagePromise,manifestPromise,packagePrepared=false;
  const packageURL=key=>new URL('./shaders/'+key+'.json',baseURL).href;
  const store = () => storagePromise ||= Promise.resolve().then(async () => {
    const files = await openStore(SHADER_CACHE_VERSION);
    await migrate?.(files);
    return files;
  }).catch(error => {
    report({cacheWarning:String(error)}); return null;
  });
  const packagedKeys = () => manifestPromise ||= (async () => {
    if (!fetchManifest) return null;
    try {
      const response = await fetchManifest(new URL('./shader-manifest.json', baseURL));
      if (!response.ok) return null;
      const manifest = await response.json();
      if (manifest.version === 3 && Array.isArray(manifest.keys) &&
          manifest.keys.length === manifest.shaderCount &&
          manifest.keys.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)))
        return new Set(manifest.keys);
    } catch (error) { report({packageWarning:String(error)}); }
    return null;
  })();
  async function cachedProgram(storage,key) {
    try {
      const file=await storage?.get(key);
      return file?validateProgram(JSON.parse(await file.text()),key):null;
    }catch(error){report({cacheWarning:String(error)});return null;}
  }
  async function preload() {
    const keys=await packagedKeys();
    if(!keys)throw Error('The packaged shader manifest could not load. Reload to try again.');
    const storage=await store();
    if(!storage)throw shaderStorageError();
    const remaining=keys.values();
    let failure;
    await Promise.all(Array.from({length:8},async()=>{
      while(!failure) {
        const {done,value:key}=remaining.next();
        if(done)return;
        try {
          let program=await cachedProgram(storage,key);
          preloadedSources.set(key,program?'cache':'package');
          if(!program){
            const response=await fetchProgram(packageURL(key));
            if(!response.ok)throw Error('Cannot load packaged shader: HTTP '+response.status);
            program=validateProgram(await response.json(),key);
            try{await storage.put(key,JSON.stringify(program));}
            catch(error){throw shaderStorageError(error);}
          }
          memory.set(key,program);
        }catch(error){failure ||= error;}
      }
    }));
    if(failure)throw failure;
    packagePrepared=true;
  }
  async function load(request) {
    const key = shaderKey(request);
    if (memory.has(key)) {
      const source=preloadedSources.get(key);
      if(source){preloadedSources.delete(key);report({source,key});}
      return memory.get(key);
    }
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const storage = await store(), hit=await cachedProgram(storage,key);
      if(hit){memory.set(key,hit);report({source:'cache',key});return hit;}
      let value, source;
      const keys = packagePrepared?null:await packagedKeys();
      // Unpackaged variants compile locally. A missing indexed file is a
      // deployment error, but the runtime compiler can still recover.
      if (!packagePrepared && (!keys || keys.has(key))) {
        try {
          const response = await fetchProgram(packageURL(key));
          if (response.ok) { value = validateProgram(await response.json(), key); source = 'package'; }
          else if (keys || response.status !== 404) report({packageWarning:'HTTP ' + response.status, key});
        } catch (error) { report({packageWarning:String(error), key}); }
      }
      if (!value) { value = validateProgram(await compile(request), key); source = 'compiled'; }
      // Identical content identity and persistence for offline/runtime producers.
      try { await storage?.put(key,JSON.stringify(value)); }
      catch (error) { report({cacheWarning:String(error)}); }
      memory.set(key, value); report({source, key}); return value;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  return {load,preload,hasPackaged:async key=>(await packagedKeys())?.has(key)??false};
}
