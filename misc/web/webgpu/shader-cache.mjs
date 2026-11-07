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

export function createShaderStore({cacheStorage = globalThis.caches, fetchProgram = globalThis.fetch,
  compile, baseURL = import.meta.url, report = () => {}}) {
  const memory = new Map(), pending = new Map();
  let cachePromise,legacyIndex;
  const cache = () => cachePromise ||= cacheStorage.open(SHADER_CACHE_VERSION).catch(error => {
    report({cacheWarning:String(error)}); return null;
  });
  async function load(request) {
    const key = shaderKey(request);
    if (memory.has(key)) return memory.get(key);
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const url = new URL('./shaders/' + key + '.json', baseURL).href;
      const cacheKey=shaderCacheKey(baseURL,key),storage = await cache();
      const cached=async candidate=>{
        try {
          const hit=await storage?.match(candidate);
          return hit?validateProgram(await hit.json(),key):null;
        }catch(error){report({cacheWarning:String(error)});await storage?.delete(candidate).catch(()=>{});return null;}
      };
      let hit=await cached(cacheKey);
      if(!hit && storage){
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
          hit=await cached(candidate);if(!hit)continue;
          try{await storage.put(cacheKey,new Response(JSON.stringify(hit)));}catch(error){report({cacheWarning:String(error)});}
          break;
        }
      }
      if(hit){memory.set(key,hit);report({source:'cache',key});return hit;}
      let value, source;
      try {
        const response = await fetchProgram(url);
        if (response.ok) { value = validateProgram(await response.json(), key); source = 'package'; }
        else if (response.status !== 404) report({packageWarning:'HTTP ' + response.status, key});
      } catch (error) { report({packageWarning:String(error), key}); }
      if (!value) { value = validateProgram(await compile(request), key); source = 'compiled'; }
      // Identical content identity and persistence for offline/runtime producers.
      try { await storage?.put(cacheKey, new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}})); }
      catch (error) { report({cacheWarning:String(error)}); }
      memory.set(key, value); report({source, key}); return value;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  return {load};
}
