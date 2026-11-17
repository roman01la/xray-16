import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {open, stat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {parseArgs} from 'node:util';
import {archiveIndexDecoder} from '../streaming/archive-index.mjs';
import {payloadDecoder} from '../../../server/tools/game-configs.mjs';
import {gameNames, levelFile, maxAssetBytes, maxLevelBytes, resolveMotions} from './catalog.mjs';
import {indexGame, readBytes} from './index-archives.mjs';
import {collectEffectPlacements, viewerAsset} from './effect-placements.mjs';

const {values} = parseArgs({options: {
  soc: {type: 'string'}, cs: {type: 'string'}, cop: {type: 'string'},
  dist: {type: 'string', default: 'build/ogf-viewer'},
  port: {type: 'string', default: '8465'},
}});
const games = new Map();
if (!Object.keys(gameNames).some(id => values[id]))
  throw new Error('Pass --soc, --cs or --cop with the path to an installed game archive directory.');
const decoder = await archiveIndexDecoder();
try {
  for (const id of Object.keys(gameNames)) {
    if (!values[id]) continue;
    const game = await indexGame(resolve(values[id]), decoder, undefined, true);
    try {
      game.placements = await collectEffectPlacements(id, game.assets);
    } catch (error) {
      console.warn(gameNames[id] + ' placements: ' + error.message);
    }
    for (const path of game.assets.keys()) if (!viewerAsset(path)) game.assets.delete(path);
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
  '/viewer-source.mjs': 'text/javascript',
  '/particle-library.mjs': 'text/javascript',
  '/particle-runtime.mjs': 'text/javascript',
  '/particle-renderer.mjs': 'text/javascript',
  '/xray-binary.mjs': 'text/javascript',
  '/environment-runtime.mjs': 'text/javascript',
  '/environment-renderer.mjs': 'text/javascript',
  '/sun-shadow.mjs': 'text/javascript',
  '/grass-viewer.mjs': 'text/javascript',
  '/grass-worker.mjs': 'text/javascript',
  '/grass-data.mjs': 'text/javascript',
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
    } else if (url.pathname === '/api/placements' && game) {
      response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(game.placements ?? {models: {}, maps: {}}));
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
