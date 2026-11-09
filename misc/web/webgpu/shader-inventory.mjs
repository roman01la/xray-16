// Inventory stock CoP shader inputs without extracting the game archives.
import {open,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {archiveIndexDecoder} from '../streaming/archive-index.mjs';

const campaignMaps = ['zaton','jupiter','jupiter_underground','pripyat','labx8'];
const archiveGroups = ['resources','levels','localization','patches'];
const readLimit = 32 * 1024 * 1024;

async function read(handle,offset,size) {
  if (size > readLimit) throw Error('Shader inventory range exceeds limit');
  const data = Buffer.alloc(size);
  for (let cursor=0;cursor<size;) {
    const {bytesRead} = await handle.read(data,cursor,size-cursor,offset+cursor);
    if (!bytesRead) throw Error('Truncated shader inventory input');
    cursor += bytesRead;
  }
  return data;
}

async function* chunks(handle,offset,size) {
  const end = offset + size;
  while (offset < end) {
    if (end-offset < 8) throw Error('Truncated chunk header');
    const header = await read(handle,offset,8);
    const type = header.readUInt32LE(0);
    const length = header.readUInt32LE(4);
    offset += 8;
    if (offset+length > end) throw Error('Chunk extends past its container');
    yield {type:type & 0x7fffffff, compressed:Boolean(type >>> 31), offset, size:length};
    offset += length;
  }
}

function* tableEntries(table,size) {
  for (let at=0;at<table.length;) {
    if (at+18 > table.length) throw Error('Truncated archive table');
    const end = at + 2 + table.readUInt16LE(at);
    if (end < at+18 || end > table.length) throw Error('Invalid archive table entry');
    const rawSize = table.readUInt32LE(at+2), packedSize = table.readUInt32LE(at+6);
    const offset = table.readUInt32LE(end-4);
    if (offset+packedSize > size) throw Error('Invalid archive entry range');
    const name = table.toString('latin1',at+14,end-4).replaceAll('\\','/').toLowerCase();
    if (packedSize) yield {name,offset,size:rawSize,compressed:rawSize!==packedSize};
    at = end;
  }
}

function strings(data) {
  const result = [];
  for (let at=0;at<data.length;) {
    const end = data.indexOf(0,at);
    if (end < 0) throw Error('Unterminated material string');
    result.push(data.toString('latin1',at,end));
    at = end+1;
  }
  return result;
}

async function findChunk(handle,entry,type) {
  if (entry.compressed) throw Error('Compressed inventory input '+(entry.name??entry.type));
  for await (const chunk of chunks(handle,entry.offset,entry.size)) {
    if (chunk.type === type) {
      if (chunk.compressed) throw Error('Compressed inventory chunk '+type);
      return chunk;
    }
  }
}

async function levelMaterials(handle,entry) {
  const chunk = await findChunk(handle,entry,2); // fsL_SHADERS
  if (!chunk || chunk.size < 4) throw Error('Missing level materials '+entry.name);
  const data = await read(handle,chunk.offset,chunk.size);
  const materials = strings(data.subarray(4));
  if (data.readUInt32LE(0) !== materials.length) throw Error('Level material count differs');
  return materials.filter(Boolean);
}

async function modelMaterials(handle,entry,model) {
  model.visuals++;
  for await (const chunk of chunks(handle,entry.offset,entry.size)) {
    if (chunk.type === 2) { // OGF_TEXTURE
      if (chunk.compressed) throw Error('Compressed model material');
      const [texture,shader] = strings(await read(handle,chunk.offset,chunk.size));
      if (!shader || texture === undefined) throw Error('Invalid model material');
      model.materials.push(shader+'/'+texture);
    }
    if (chunk.type === 9) { // OGF_CHILDREN
      if (chunk.compressed) throw Error('Compressed embedded visuals');
      for await (const child of chunks(handle,chunk.offset,chunk.size)) {
        if (child.compressed) throw Error('Compressed embedded visual');
        await modelMaterials(handle,child,model);
      }
    }
  }
}

async function particleMaterials(handle,entry) {
  const effects = await findChunk(handle,entry,3); // PS_CHUNK_SECONDGEN
  const groups = await findChunk(handle,entry,4); // PS_CHUNK_THIRGEN
  if (!effects || !groups) throw Error('Missing particle definitions');
  const result = {effects:0,groups:0,materials:[],effectNames:[]};
  for await (const effect of chunks(handle,effects.offset,effects.size)) {
    result.effects++;
    const name = await findChunk(handle,effect,2); // PED_CHUNK_NAME
    if (!name) throw Error('Missing particle effect name');
    result.effectNames.push(strings(await read(handle,name.offset,name.size))[0]);
    const sprite = await findChunk(handle,effect,7); // PED_CHUNK_SPRITE
    if (!sprite) continue;
    const [shader,texture] = strings(await read(handle,sprite.offset,sprite.size));
    if (!shader || texture === undefined) throw Error('Invalid particle material');
    result.materials.push(shader+'/'+texture);
  }
  result.effectNames.sort();
  for await (const group of chunks(handle,groups.offset,groups.size)) result.groups++;
  return result;
}

function uniqueMaterials(pairs) {
  return [...new Set(pairs)].sort();
}

async function shaderSources(directory) {
  const sources = {vertex:[],fragment:[],blenders:[]};
  for (const entry of await readdir(directory,{recursive:true,withFileTypes:true})) {
    if (!entry.isFile() || !/\.(vs|ps|s)$/.test(entry.name)) continue;
    const path = join(entry.parentPath,entry.name).slice(directory.length+1);
    sources[path.endsWith('.vs')?'vertex':path.endsWith('.ps')?'fragment':'blenders'].push(path);
  }
  for (const paths of Object.values(sources)) paths.sort();
  return sources;
}

async function inventory(game,overlay) {
  const groups = await readdir(game);
  const decoder = await archiveIndexDecoder(), handles = [], entries = new Map();
  try {
    for (const name of archiveGroups) {
      const group = groups.find(folder=>folder.toLowerCase()===name);
      if (!group) continue;
      for (const file of (await readdir(join(game,group))).sort()) {
        if (!/\.db[0-9]*$/i.test(file)) continue;
        const handle = await open(join(game,group,file),'r');
        handles.push(handle);
        const {size} = await handle.stat();
        for await (const chunk of chunks(handle,0,size)) {
          if (chunk.type !== 1) continue; // archive file table
          const bytes = await read(handle,chunk.offset,chunk.size);
          const table = chunk.compressed ? decoder.decode(bytes) : bytes;
          for (const entry of tableEntries(table,size)) entries.set(entry.name,{...entry,handle});
        }
      }
    }
    const maps = {}, models = [], textureMetadata = [], weather = [], presets = [], skipped = [];
    const shaders = {library:false,...await shaderSources(join(overlay,'shaders','gl'))};
    let particles;
    for (const [name,entry] of [...entries].sort(([a],[b])=>a.localeCompare(b,'en'))) {
      const path = name.replace(/^gamedata\//,'');
      const map = path.match(/^levels\/([^/]+)\/level$/)?.[1];
      if (map && campaignMaps.includes(map)) {
        maps[map] = await levelMaterials(entry.handle,entry);
      } else if (path.endsWith('.ogf')) {
        if (entry.compressed) { skipped.push(path); continue; }
        const model = {path,visuals:0,materials:[]};
        await modelMaterials(entry.handle,entry,model);
        models.push(model);
      } else if (path === 'particles.xr') {
        particles = await particleMaterials(entry.handle,entry);
      } else if (path === 'shaders.xr') {
        shaders.library = true;
      } else if (/\.thm$/.test(path)) {
        textureMetadata.push(path);
      } else if (/^configs\/environment\/.*\.ltx$/.test(path)) {
        weather.push(path);
      } else if (/^configs\/rspec_.*\.ltx$/.test(path)) {
        presets.push(path);
      }
    }
    if (campaignMaps.some(map=>!maps[map]) || !particles || !shaders.library)
      throw Error('Stock Call of Pripyat shader inputs are incomplete');
    const levelPairs = uniqueMaterials(Object.values(maps).flat());
    const modelPairs = uniqueMaterials(models.flatMap(model=>model.materials));
    const particlePairs = uniqueMaterials(particles.materials);
    return {version:1,summary:{
      maps:Object.fromEntries(campaignMaps.map(map=>[map,maps[map].length])),
      levelPairs:levelPairs.length, levelBlenders:new Set(levelPairs.map(pair=>pair.split('/')[0])).size,
      models:models.length, modelVisuals:models.reduce((count,model)=>count+model.visuals,0),
      modelPairs:modelPairs.length, particleEffects:particles.effects,
      particleGroups:particles.groups, particlePairs:particlePairs.length,
      textureMetadata:textureMetadata.length, weatherConfigs:weather.length, presets:presets.length,
      shaderSources:Object.fromEntries(['vertex','fragment','blenders'].map(stage=>[stage,shaders[stage].length])),
      skipped:skipped.length,
    },maps,models,particles:{...particles,materials:particlePairs},shaders,textureMetadata,weather,presets,skipped};
  } finally {
    await Promise.all(handles.map(handle=>handle.close()));
    await decoder.close();
  }
}

const {values,positionals} = parseArgs({allowPositionals:true,options:{output:{type:'string'},overlay:{type:'string'}}});
if (positionals.length !== 1)
  throw Error('Usage: node shader-inventory.mjs OWNED_GAME [--overlay STAGED_GAMEDATA] [--output PRIVATE_JSON]');
const result = await inventory(resolve(positionals[0]),resolve(values.overlay??join(import.meta.dirname,'../../../res/gamedata')));
if (values.output) await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result.summary,null,2));
