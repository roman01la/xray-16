import {shaderKey} from './shader-key.js';
import {SHADER_CACHE_VERSION} from './shader-cache.mjs';

const directoryName = 'xray-shader-capture-v1';
const namePattern = /^[a-z0-9_-]{1,64}$/i;
const keyPattern = /^[a-f0-9]{64}$/;

function safeName(value) {
  if (!namePattern.test(value ?? '')) throw Error('Invalid shader capture name');
  return value;
}

async function runDirectory(storage, id, create = false) {
  const root = await storage.getDirectory();
  const captures = await root.getDirectoryHandle(directoryName, {create});
  return captures.getDirectoryHandle(safeName(id), {create});
}

async function writeJSON(directory, name, value) {
  const handle = await directory.getFileHandle(name, {create:true});
  const stream = await handle.createWritable();
  try {
    await stream.write(JSON.stringify(value));
    await stream.close();
  } catch (error) {
    await stream.abort().catch(()=>{});
    throw error;
  }
}

async function readJSON(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  return JSON.parse(await file.text());
}

export function describeShaderRequest(request) {
  return Object.fromEntries(Object.entries(request.sources).map(([stage, source]) => {
    const lines = source.split('\n', 64);
    const label = lines.find(line => /^\/\/ .+\.(ps|vs)\w*$/.test(line))?.slice(3) ?? null;
    const options = lines.filter(line => /^#define\s+(SMAP_size|SUN_QUALITY|SUN_SHAFTS_QUALITY|SSAO_QUALITY|SSR_(?:QUALITY|HALF_DEPTH|JITTER)|SKIN_[\w]+|USE_DOF|USE_SOFT_PARTICLES|USE_SOFT_WATER)\b/.test(line))
      .map(line => line.replace(/\s+/g, ' ').trim());
    return [stage, {label,options}];
  }));
}

export async function openShaderCapture(options, storage = globalThis.navigator.storage) {
  const id = safeName(options.get('shaderCapture'));
  const run = {id};
  for (const [name, field] of [['shaderMap','map'],['shaderPreset','preset'],['shaderScenario','scenario']]) {
    if (options.has(name)) run[field] = safeName(options.get(name));
  }
  const directory = await runDirectory(storage, id, true);
  const requestDirectory = await directory.getDirectoryHandle('requests', {create:true});
  const metadata = {version:1, compiler:SHADER_CACHE_VERSION, run};
  let previous;
  try { previous = await readJSON(directory, 'run.json'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
  if (previous && JSON.stringify(previous) !== JSON.stringify(metadata))
    throw Error('Shader capture run ID was already used with different settings');
  await writeJSON(directory, 'run.json', metadata);
  const captured = new Set();
  return {
    async load(store, request) {
      const key = shaderKey(request);
      if (captured.has(key)) return store.load(request);
      const inManifest = await store.hasPackaged(key);
      const record = {key, inManifest, stages:describeShaderRequest(request), request};
      let program;
      try { program = await store.load(request); }
      catch (error) {
        await writeJSON(requestDirectory, key+'.json', {...record, outcome:'error', error:String(error)});
        throw error;
      }
      await writeJSON(requestDirectory, key+'.json', {...record, outcome:'loaded'});
      captured.add(key);
      return program;
    },
  };
}

export async function readShaderCapture(id, storage = globalThis.navigator.storage) {
  const directory = await runDirectory(storage, id);
  const metadata = await readJSON(directory, 'run.json');
  const requests = await directory.getDirectoryHandle('requests');
  const names = [];
  for await (const [name, handle] of requests.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json') || !keyPattern.test(name.slice(0,-5)))
      throw Error('Invalid shader capture entry '+name);
    names.push(name);
  }
  const records = [];
  for (const name of names.sort()) records.push(await readJSON(requests, name));
  return {...metadata, records};
}
