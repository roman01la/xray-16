import { shaderKey } from './shader-key.js';

// Source keys stay identical to offline packages. Namespace invalidates compiled
// data when toolchain, reflection or uniform ABI changes, regardless of origin.
export const SHADER_CACHE_VERSION = 'xray-shaders-v3-shaderc2026.1-naga26-packing1-r1';
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
  let cachePromise;
  const cache = () => cachePromise ||= cacheStorage.open(SHADER_CACHE_VERSION).catch(error => {
    report({cacheWarning:String(error)}); return null;
  });
  async function load(request) {
    const key = shaderKey(request);
    if (memory.has(key)) return memory.get(key);
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const url = new URL('./shaders/' + key + '.json', baseURL).href;
      const storage = await cache();
      try {
        const hit = await storage?.match(url);
        if (hit) {
          const value = validateProgram(await hit.json(), key);
          memory.set(key, value); report({source:'cache', key}); return value;
        }
      } catch (error) {
        report({cacheWarning:String(error)});
        await storage?.delete(url).catch(() => {});
      }
      let value, source;
      try {
        const response = await fetchProgram(url);
        if (response.ok) { value = validateProgram(await response.json(), key); source = 'package'; }
        else if (response.status !== 404) report({packageWarning:'HTTP ' + response.status, key});
      } catch (error) { report({packageWarning:String(error), key}); }
      if (!value) { value = validateProgram(await compile(request), key); source = 'compiled'; }
      // Identical URL, schema, persistence and memory path for either producer.
      try { await storage?.put(url, new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}})); }
      catch (error) { report({cacheWarning:String(error)}); }
      memory.set(key, value); report({source, key}); return value;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  return {load};
}
