import { shaderKey } from './shader-key.js';

// Source keys stay identical to offline packages. Namespace invalidates compiled
// data when toolchain, reflection or uniform ABI changes, regardless of origin.
export const SHADER_CACHE_VERSION = 'xray-shaders-v3-shaderc2026.1-naga26-packing1-r1';
// ABI version remains in the CacheStorage namespace; release path is irrelevant.
export const shaderCacheKey=(baseURL,key)=>new URL('/.xray-cache/shaders/'+key+'.json',baseURL).href;
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

export function createShaderStore({cacheStorage = globalThis.caches, fetchProgram = globalThis.fetch,
  fetchManifest, compile, baseURL = import.meta.url, report = () => {}}) {
  const memory = new Map(), pending = new Map(), preloadedSources=new Map();
  let cachePromise,legacyIndex,manifestPromise,packagePrepared=false;
  const packageURL=key=>new URL('./shaders/'+key+'.json',baseURL).href;
  const packageResponse=program=>new Response(JSON.stringify(program),{headers:{'Content-Type':'application/json'}});
  const cache = () => cachePromise ||= cacheStorage.open(SHADER_CACHE_VERSION).catch(error => {
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
  async function cachedProgram(storage,key,strict=false) {
    if(!storage)return null;
    const url=packageURL(key),cacheKey=shaderCacheKey(baseURL,key);
    const cached=async candidate=>{
      try {
        const hit=await storage.match(candidate);
        return hit?validateProgram(await hit.json(),key):null;
      }catch(error){report({cacheWarning:String(error)});await storage.delete(candidate).catch(()=>{});return null;}
    };
    const current=await cached(cacheKey);
    if(current)return current;
    legacyIndex ||= Promise.resolve().then(async()=>{
      const index=new Map();
      for(const entry of await storage.keys?.()||[]){
        const candidate=new URL(entry.url),match=candidate.pathname.match(/\/shaders\/([a-f0-9]{64})\.json$/);
        if(match){const id=candidate.origin+'/'+match[1];if(!index.has(id))index.set(id,[]);index.get(id).push(entry.url);}
      }
      return index;
    }).catch(()=>new Map());
    const legacy=(await legacyIndex).get(new URL(baseURL).origin+'/'+key)||[];
    for(const candidate of new Set([url,...legacy])){
      const hit=await cached(candidate);
      if(!hit)continue;
      try{await storage.put(cacheKey,packageResponse(hit));}
      catch(error){if(strict)throw shaderStorageError(error);report({cacheWarning:String(error)});}
      return hit;
    }
    return null;
  }
  async function preload() {
    const keys=await packagedKeys();
    if(!keys)throw Error('The packaged shader manifest could not load. Reload to try again.');
    const storage=await cache();
    if(!storage)throw shaderStorageError();
    const remaining=keys.values();
    let failure;
    await Promise.all(Array.from({length:8},async()=>{
      while(!failure) {
        const {done,value:key}=remaining.next();
        if(done)return;
        try {
          let program=await cachedProgram(storage,key,true);
          preloadedSources.set(key,program?'cache':'package');
          if(!program){
            const response=await fetchProgram(packageURL(key));
            if(!response.ok)throw Error('Cannot load packaged shader: HTTP '+response.status);
            program=validateProgram(await response.json(),key);
            try{await storage.put(shaderCacheKey(baseURL,key),packageResponse(program));}
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
      const storage = await cache(), hit=await cachedProgram(storage,key);
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
      try { await storage?.put(shaderCacheKey(baseURL,key),packageResponse(value)); }
      catch (error) { report({cacheWarning:String(error)}); }
      memory.set(key, value); report({source, key}); return value;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  return {load,preload};
}
