import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {open, readdir, stat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {parseArgs} from 'node:util';
import {archiveIndexDecoder} from '../streaming/archive-index.mjs';
import {payloadDecoder} from '../../../server/tools/game-configs.mjs';

const {values} = parseArgs({options: {
  soc: {type: 'string'}, cs: {type: 'string'}, cop: {type: 'string'},
  dist: {type: 'string', default: 'build/ogf-viewer'},
  port: {type: 'string', default: '8465'},
}});
const gameNames = {soc: 'Shadow of Chernobyl', cs: 'Clear Sky', cop: 'Call of Pripyat'};
const archiveGroups = ['levels', 'resources', 'patches'];
const maxAssetBytes = 64 * 1024 * 1024;
const maxLevelBytes = 256 * 1024 * 1024;
const levelFile = /^levels\/([^/]+)\/level(?:\.geom)?$/;

async function readBytes(handle, offset, size) {
  const bytes = Buffer.allocUnsafe(size);
  let received = 0;
  while (received < size) {
    const {bytesRead} = await handle.read(bytes, received, size - received, offset + received);
    if (!bytesRead) throw new Error('Truncated X-Ray archive');
    received += bytesRead;
  }
  return bytes;
}

async function indexArchive(path, decoder, assets) {
  const file = await open(path);
  try {
    const {size} = await file.stat();
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
          if (/\.(?:ogf|dds|omf)$/.test(name) || levelFile.test(name)) {
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

async function indexGame(root, decoder) {
  const assets = new Map();
  // Later archives override earlier entries, matching the game's patch order.
  for (const group of archiveGroups) {
    const directory = join(root, group);
    const names = await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.filter(name => /\.db\d*$/i.test(name)).sort())
      await indexArchive(join(directory, name), decoder, assets);
  }
  const meshes = [...assets.keys()].filter(path => path.endsWith('.ogf')).sort();
  if (!meshes.length) throw new Error('No mesh entries found in ' + root);
  const motions = [...assets.keys()].filter(path => path.endsWith('.omf')).sort();
  const maps = [...assets.keys()].filter(path => path.endsWith('/level') &&
    levelFile.test(path) && assets.has(path + '.geom')).sort();
  return {assets, meshes, motions, maps};
}

function resolveMotions(game, model, reference) {
  const name = reference.trim().replaceAll('\\', '/').toLowerCase().replace(/\.omf$/, '');
  if (!name || name.startsWith('/') || name.split('/').includes('..')) return [];
  const level = /^levels\/[^/]+\//.exec(model)?.[0];
  const paths = level ? [level + name, 'meshes/' + name] : ['meshes/' + name];
  if (name.endsWith('/*')) {
    const directories = paths.map(path => path.slice(0, -1));
    return game.motions.filter(path => directories.some(dir => path.startsWith(dir) &&
      !path.slice(dir.length).includes('/')));
  }
  const match = paths.map(path => path + '.omf').find(path => game.assets.has(path));
  return match ? [match] : [];
}

const games = new Map();
if (!Object.keys(gameNames).some(id => values[id]))
  throw new Error('Pass --soc, --cs or --cop with the path to an installed game archive directory.');
const decoder = await archiveIndexDecoder();
try {
  for (const id of Object.keys(gameNames)) {
    if (!values[id]) continue;
    const game = await indexGame(resolve(values[id]), decoder);
    games.set(id, game);
    console.log(gameNames[id] + ': ' + game.meshes.length + ' meshes, ' + game.maps.length + ' maps');
  }
} finally {
  await decoder.close();
}

let decompress;
async function fetchAsset(entry) {
  if (!entry.raw || entry.raw > maxAssetBytes || entry.packed > maxAssetBytes)
    throw new Error('Asset exceeds the viewer’s 64 MiB limit');
  const file = await open(entry.path);
  let data;
  try {
    data = await readBytes(file, entry.start, entry.packed);
  } finally {
    await file.close();
  }
  if (entry.raw === entry.packed) return data;
  decompress ??= payloadDecoder();
  return (await decompress).decode(data, entry.raw);
}

const staticFiles = new Map(Object.entries({
  '/': 'text/html; charset=utf-8',
  '/viewer.css': 'text/css; charset=utf-8',
  '/viewer.mjs': 'text/javascript',
  '/renderer.mjs': 'text/javascript',
  '/dds.mjs': 'text/javascript',
  '/ogf.mjs': 'text/javascript',
  '/ogf.wasm': 'application/wasm',
}));
const dist = resolve(values.dist);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url, 'http://localhost');
  const game = games.get(url.searchParams.get('game'));
  try {
    if (url.pathname === '/api/games') {
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(
        [...games].map(([id, {meshes}]) => ({id, name: gameNames[id], count: meshes.length}))));
    } else if (url.pathname === '/api/catalog' && game) {
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(game.meshes));
    } else if (url.pathname === '/api/maps' && game) {
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(game.maps));
    } else if (url.pathname === '/api/motions' && game) {
      const model = url.searchParams.get('model');
      const refs = url.searchParams.getAll('ref');
      if (!model?.endsWith('.ogf') || !game.assets.has(model) || refs.length > 512) {
        response.writeHead(400).end();
        return;
      }
      const sources = refs.map(reference => ({reference, paths: resolveMotions(game, model, reference)}));
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(sources));
    } else if (url.pathname === '/api/asset' && game) {
      const path = url.searchParams.get('path');
      const entry = game.assets.get(path);
      if (!entry) {
        response.writeHead(404).end();
        return;
      }
      if (levelFile.test(path) && entry.raw === entry.packed && entry.raw > 0 && entry.raw <= maxLevelBytes) {
        const stream = createReadStream(entry.path, {start: entry.start, end: entry.start + entry.raw - 1});
        response.on('close', () => stream.destroy());
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': entry.raw});
        stream.on('error', () => response.destroy()).pipe(response);
      } else {
        const data = await fetchAsset(entry);
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': data.length}).end(data);
      }
    } else if (staticFiles.has(url.pathname)) {
      const path = join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      const {size} = await stat(path);
      response.writeHead(200, {'Content-Type': staticFiles.get(url.pathname), 'Content-Length': size});
      createReadStream(path).on('error', () => response.destroy()).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error.message);
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end('Could not read the game asset');
  }
});
server.on('close', () => { void decompress?.then(decoder => decoder.close()); });
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log('X-Ray Model Viewer: http://127.0.0.1:' + server.address().port);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close());
