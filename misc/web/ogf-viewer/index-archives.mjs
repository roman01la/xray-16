import {open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {levelFile} from './catalog.mjs';
import {terrainMetadataFile} from './terrain-materials.mjs';
import {environmentModifier, environmentSound} from './environment-assets.mjs';

const archiveGroups = ['levels', 'resources', 'patches'];

export async function readBytes(handle, offset, size) {
  const bytes = Buffer.allocUnsafe(size);
  let received = 0;
  while (received < size) {
    const {bytesRead} = await handle.read(bytes, received, size - received, offset + received);
    if (!bytesRead) throw new Error('Truncated X-Ray archive');
    received += bytesRead;
  }
  return bytes;
}

async function indexArchive(path, decoder, assets, expectedSize, metadata) {
  const file = await open(path);
  try {
    const {size} = await file.stat();
    if (expectedSize !== undefined && size !== expectedSize) throw new Error('Archive size differs from deployed pack: ' + path);
    for (let offset = 0; offset < size;) {
      const chunk = await readBytes(file, offset, 8);
      const id = chunk.readUInt32LE(0), length = chunk.readUInt32LE(4);
      if (offset + 8 + length > size) throw new Error('Invalid chunk in ' + path);
      if ((id & 0x7fffffff) === 1) {
        if (length > 32 * 1024 * 1024) throw new Error('Oversized archive index in ' + path);
        const bytes = await readBytes(file, offset + 8, length);
        const table = id >>> 31 ? decoder.decode(bytes) : bytes;
        for (let at = 0; at < table.length;) {
          if (at + 18 > table.length) throw new Error('Truncated archive index in ' + path);
          const end = at + 2 + table.readUInt16LE(at);
          if (end < at + 18 || end > table.length) throw new Error('Invalid archive index in ' + path);
          const name = table.toString('latin1', at + 14, end - 4).replaceAll('\\', '/').toLowerCase();
          if (/\.(?:ogf|dds|omf)$/.test(name) || levelFile.test(name) || name === 'particles.xr' || environmentSound(name) ||
              metadata && (terrainMetadataFile(name) || environmentModifier(name) || /^(?:configs?\/.*\.ltx|spawns\/all\.spawn|game\.graph|gamemtl\.xr)$/.test(name))) {
            const raw = table.readUInt32LE(at + 2), packed = table.readUInt32LE(at + 6);
            const start = table.readUInt32LE(end - 4);
            if (start + packed > size) throw new Error('Invalid archive entry ' + name);
            assets.set(name, {path, start, raw, packed});
          }
          at = end;
        }
      }
      offset += 8 + length;
    }
  } finally {
    await file.close();
  }
}

export async function indexGame(root, decoder, archiveSizes, metadata = false) {
  const assets = new Map();
  // Later archives override earlier entries, matching the game's patch order.
  for (const group of archiveGroups) {
    const directory = join(root, group);
    const names = archiveSizes ? [...archiveSizes.keys()].filter(path => path.startsWith(group + '/'))
      .map(path => path.slice(group.length + 1)) : await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.filter(name => /\.db\d*$/i.test(name)).sort())
      await indexArchive(join(directory, name), decoder, assets, archiveSizes?.get(group + '/' + name), metadata);
  }
  const meshes = [...assets.keys()].filter(path => path.endsWith('.ogf')).sort();
  if (!meshes.length) throw new Error('No mesh entries found in ' + root);
  const motions = [...assets.keys()].filter(path => path.endsWith('.omf')).sort();
  const maps = [...assets.keys()].filter(path => path.endsWith('/level') &&
    levelFile.test(path) && assets.has(path + '.geom')).sort();
  return {assets, meshes, motions, maps};
}
