import {chunks, Reader} from './xray-binary.mjs';

const terrainThm = /^textures\/(terrain\/[^/]+)\.thm$/;
const shadersFile = 'shaders.xr';
const associationsFile = 'textures/textures.ltx';
const normalize = name => name.trim().replaceAll('\\', '/').toLowerCase();

export function terrainMetadataFile(path) {
  return path === shadersFile || path === associationsFile || terrainThm.test(path);
}

// CBlender_BmmD stores version 3's RGBA detail layer names as four string64
// texture properties. Read the tagged properties after the packed descriptor.
function terrainShaders(bytes) {
  const result = Object.create(null);
  const definitions = chunks(bytes).get(2);
  if (!definitions) return result;

  for (const definition of chunks(definitions).values()) {
    if (definition.length < 176 || definition.subarray(0, 8).toString('ascii') !== ' dloDmmB') continue;
    const descriptor = new Reader(definition);
    descriptor.take(8);
    const name = normalize(descriptor.string());
    const properties = definition.subarray(176);
    const layers = [];
    for (const channel of 'RGBA') {
      const tag = Buffer.from('\x03\0\0\0R2-' + channel + '\0', 'latin1');
      const offset = properties.indexOf(tag);
      if (offset < 0 || offset + tag.length + 64 > properties.length) break;
      const field = properties.subarray(offset + tag.length, offset + tag.length + 64);
      const end = field.indexOf(0);
      if (end < 1) break;
      layers.push(normalize(field.subarray(0, end).toString('latin1')));
    }
    if (layers.length === 4) result[name] = layers;
  }
  return result;
}

function terrainAssociations(bytes) {
  const result = Object.create(null);
  let association = false;
  for (const line of bytes.toString('latin1').split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) association = section[1].toLowerCase() === 'association';
    if (!association) continue;
    const entry = /^\s*(terrain\\[^=]+)=\s*([^,]+),\s*([\d.]+)/i.exec(line);
    if (entry) {
      const [, name, detail, scale] = entry;
      if (Number.isFinite(+scale) && +scale > 0) result[normalize(name)] = {detail: normalize(detail), scale: +scale};
    }
  }
  return result;
}

export async function readTerrainMaterials(assets, read) {
  const shaderEntry = assets.get(shadersFile), associations = assets.get(associationsFile);
  const shaders = shaderEntry ? terrainShaders(await read(shaderEntry)) : Object.create(null);
  const textures = associations ? terrainAssociations(await read(associations)) : Object.create(null);
  for (const [path, entry] of assets) {
    const match = terrainThm.exec(path);
    if (!match) continue;
    const detailData = chunks(await read(entry)).get(0x0815);
    if (!detailData) continue;
    const reader = new Reader(detailData);
    const detail = normalize(reader.string()), scale = reader.f32();
    if (detail && Number.isFinite(scale) && scale > 0) textures[match[1]] = {detail, scale};
  }
  return {shaders, textures};
}
