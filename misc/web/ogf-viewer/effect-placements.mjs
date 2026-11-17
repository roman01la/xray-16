import {open} from 'node:fs/promises';
import {parseLtx, payloadDecoder} from '../../../server/tools/game-configs.mjs';
import {readBytes} from './index-archives.mjs';
import {effectKey, readParticleLibrary} from './particle-library.mjs';
import {chunks, Reader} from './xray-binary.mjs';
import {readTerrainMaterials, terrainMetadataFile} from './terrain-materials.mjs';
import {environmentModifier, readEnvironmentAssets} from './environment-assets.mjs';

function graphLevels(bytes) {
  const input = new Reader(bytes);
  const version = input.u8(), count = input.u16();
  input.take(24); // Edge count, death-point count, and GUID.
  const levels = new Map();
  const levelCount = input.u8();
  for (let i = 0; i < levelCount; i++) {
    const level = input.string().toLowerCase();
    input.take(12); // Global offset. Spawn positions already use level coordinates.
    const id = input.u8();
    input.string(); // Level section name.
    input.take(16);
    levels.set(id, level);
  }
  const vertices = input.take(count * 42); // Packed CGameVertex.
  if (version < 8 || !levels.size) throw new Error('Unsupported game graph');
  return id => id < count ? levels.get(vertices[id * 42 + 24]) : undefined;
}

function spawnObject(bytes) {
  const input = new Reader(bytes);
  const packet = new Reader(input.take(input.u16()));
  if (packet.u16() !== 1) throw new Error('Invalid spawn packet');
  const section = packet.string().toLowerCase(), name = packet.string();
  packet.take(2);
  const position = packet.vec3(), angles = packet.vec3();
  packet.take(4);
  const parent = packet.u16();
  packet.take(2); // Phantom ID
  const flags = packet.u16();
  if (!(flags & 32)) return;
  const version = packet.u16();
  if (version <= 93) return;
  if (version > 120) packet.take(2);
  packet.take(2); // Script version
  packet.take(packet.u16()); // Client object data
  packet.take(2); // Spawn ID
  if (version < 112) {
    packet.take(8);
    packet.string();
    packet.take(32);
  }
  if (packet.u16() < 4) return;
  return {section, name, position, angles, parent, graph: packet.u16()};
}

async function grassMetadata(assets, read) {
  const maps = [...assets.keys()].filter(path => path.endsWith('/level.details') &&
    assets.has(path.replace(/\.details$/, '.cform'))).map(path => path.split('/')[1]);
  const passable = [];
  const entry = assets.get('gamemtl.xr');
  if (entry) {
    const materials = chunks(await read(entry)).get(0x1002);
    if (materials) {
      for (const material of chunks(materials).values()) {
        const fields = chunks(material), flags = fields.get(0x1001), main = fields.get(0x1000);
        if (flags && main && (new Reader(flags).u32() & (1 << 7))) passable.push(new Reader(main).u32());
      }
    }
  }
  return {maps, passable};
}

const archiveConfig = /^configs?\/(.*\.ltx)$/;
const meshPath = value => 'meshes/' + value.toLowerCase().replaceAll('\\', '/').replace(/^meshes\//, '');
const readConfig = new TextDecoder('windows-1251');

export async function collectEffectPlacements(game, assets) {
  const levelTextures = Object.create(null);
  for (const path of assets.keys()) {
    const match = /^levels\/([^/]+)\/(.+\.dds)$/.exec(path);
    if (match) (levelTextures[match[1]] ??= []).push(match[2]);
  }
  const result = {models: {}, maps: {}, levelTextures};
  let decoder;
  async function read(entry) {
    const file = await open(entry.path);
    try {
      const bytes = await readBytes(file, entry.start, entry.packed);
      if (entry.packed === entry.raw) return bytes;
      decoder ??= await payloadDecoder();
      return decoder.decode(bytes, entry.raw);
    } finally {
      await file.close();
    }
  }
  try {
    result.terrain = await readTerrainMaterials(assets, read);
    result.grass = await grassMetadata(assets, read);
    result.environment = await readEnvironmentAssets(assets, read);
    if (!assets.has('particles.xr')) return result;
    const library = readParticleLibrary(await read(assets.get('particles.xr')), game);
    const has = name => library.effects.has(name) || library.groups.has(name);
    const effect = value => {
      const name = value && effectKey(value);
      return has(name) ? name : undefined;
    };

    const configs = new Map();
    for (const [name, entry] of assets) {
      const config = archiveConfig.exec(name);
      if (config) {
        // Ignore values unrelated to visuals, including malformed legacy weapon descriptions.
        const text = readConfig.decode(await read(entry)).split(/\r?\n/).filter(line =>
          /^\s*(?:#include|\[|(?:visual|idle_particles|blowout_particles|particles|lights_enabled|trail_light_color|trail_light_range|idle_light|idle_light_color|idle_light_range)\s*=)/i.test(line)).join('\n');
        configs.set(config[1], {text});
      }
    }
    const spawn = assets.get('spawns/all.spawn');
    if (!configs.has('system.ltx')) return result;
    const {sections} = parseLtx(configs);
    function light(color, range) {
      const rgb = color?.split(',').map(Number);
      const distance = Number(range);
      if (rgb?.length === 3 && rgb.every(Number.isFinite) && distance > 0)
        return {color: rgb, range: distance};
    }
    const definitions = new Map();
    for (const [section, {values}] of sections) {
      const idle = effect(values.idle_particles) ?? effect(values.particles);
      const burst = effect(values.blowout_particles);
      const mesh = values.visual ? meshPath(values.visual) : undefined;
      const meshExists = values.particles && mesh && assets.has(mesh);
      const trail = values.lights_enabled === 'true' ? light(values.trail_light_color, values.trail_light_range) : undefined;
      const idleLight = values.idle_light === 'on' || values.idle_light === 'true' ?
        light(values.idle_light_color, values.idle_light_range) : undefined;
      if (meshExists && (idle || trail)) result.models[mesh] = {idle, light: trail};
      if (idle || burst)
        definitions.set(section, {idle, burst, light: idleLight ?? trail, mesh: meshExists ? mesh : undefined});
    }
    if (!spawn) return result;
    const spawnFile = chunks(await read(spawn));
    const graph = spawnFile.get(4) ?? (assets.has('game.graph') ? await read(assets.get('game.graph')) : null);
    if (!graph) return result;
    const levelOf = graphLevels(graph);
    const vertices = chunks(chunks(spawnFile.get(1)).get(1));
    for (const bytes of vertices.values()) {
      const data = chunks(chunks(bytes).get(1)).get(0);
      const object = spawnObject(data);
      if (!object || object.parent !== 65535 || !object.position.every(Number.isFinite)) continue;
      const definition = definitions.get(object.section);
      if (!definition) continue;
      const level = levelOf(object.graph);
      if (!level || !assets.has('levels/' + level + '/level')) continue;
      (result.maps[level] ??= []).push({...definition, position: object.position, angles: object.angles,
        name: object.name || object.section});
    }
    return result;
  } finally {
    await decoder?.close();
  }
}

export function viewerAsset(path) {
  return !terrainMetadataFile(path) && !environmentModifier(path) && !archiveConfig.test(path) && path !== 'spawns/all.spawn' && path !== 'game.graph' && path !== 'gamemtl.xr';
}
