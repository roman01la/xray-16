import {ChunkReader} from './chunk-reader.mjs';
import {gameNames, levelFile, maxAssetBytes, maxLevelBytes, resolveMotions} from './catalog.mjs';

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the viewer archive index.');
  return response.json();
}

function decompress(wasm, packed, length) {
  const input = wasm._malloc(packed.byteLength);
  const output = wasm._malloc(length);
  const size = wasm._malloc(4);
  try {
    if (!input || !output || !size) throw new Error('Could not allocate archive decompression buffers.');
    wasm.HEAPU8.set(packed, input);
    const heap = new DataView(wasm.HEAPU8.buffer);
    heap.setUint32(size, length, true);
    if (wasm._lzo1x_decompress_safe(input, packed.byteLength, output, size, 0) !== 0 ||
        heap.getUint32(size, true) !== length)
      throw new Error('Invalid compressed game asset.');
    return wasm.HEAPU8.slice(output, output + length).buffer;
  } finally {
    wasm._free(size);
    wasm._free(output);
    wasm._free(input);
  }
}

export function createAssetSource(wasm) {
  let indexes, active, reader;
  const catalogs = new Map();

  async function gameCatalog(game) {
    if (!catalogs.has(game)) {
      const {pack, index} = indexes[game];
      const data = await readJson(new URL(index, import.meta.url));
      const base = new URL(pack, location.origin);
      const archives = data.archives.map(path => new URL(path, base).href);
      const assets = new Map(data.assets.map(([path, archive, start, raw, packed]) =>
        [path, {path: archives[archive], start, raw, packed}]));
      catalogs.set(game, {...data, assets});
    }
    return catalogs.get(game);
  }

  return {
    async games() {
      indexes = await readJson(new URL('./games.json', import.meta.url));
      return Object.keys(indexes).map(id => ({id, name: gameNames[id]}));
    },
    async catalog(game, maps, signal) {
      const data = await gameCatalog(game);
      signal?.throwIfAborted();
      if (active !== game) {
        active = game;
        reader = new ChunkReader({gameId: game, budget: 128 * 1024 * 1024});
      }
      return maps ? data.maps : data.meshes;
    },
    async placements(game, signal) {
      const data = await readJson(new URL(indexes[game].placements, import.meta.url));
      signal?.throwIfAborted();
      return data;
    },
    async motions(game, model, refs, signal) {
      const data = await gameCatalog(game);
      signal?.throwIfAborted();
      return refs.map(reference => ({reference, paths: resolveMotions(data, model, reference)}));
    },
    async asset(game, path, signal) {
      const data = catalogs.get(game);
      const entry = data?.assets.get(path);
      const limit = levelFile.test(path) && entry?.raw === entry?.packed ? maxLevelBytes : maxAssetBytes;
      if (!entry || !entry.raw || !entry.packed || entry.raw > limit || entry.packed > limit)
        throw new Error('Could not read ' + path + ' from the game archive.');
      signal?.throwIfAborted();
      if (active !== game) throw new Error('The viewer game changed.');
      const bytes = new Uint8Array(entry.packed);
      const received = await reader.read(entry.path, entry.start, entry.packed, (part, offset) => {
        signal?.throwIfAborted();
        bytes.set(part, offset);
      });
      if (received !== entry.packed) throw new Error('Truncated game asset: ' + path);
      return entry.raw === entry.packed ? bytes.buffer : decompress(wasm, bytes, entry.raw);
    },
    orderTextures(game, textures, path) {
      const assets = catalogs.get(game).assets;
      return textures.sort((a, b) => {
        const left = assets.get(path(a)), right = assets.get(path(b));
        if (!left || !right) return Number(!left) - Number(!right);
        return left.path.localeCompare(right.path) || left.start - right.start;
      });
    },
  };
}
