import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {archiveIndexDecoder} from '../streaming/archive-index.mjs';
import {gameNames} from './catalog.mjs';
import {indexGame, readBytes} from './index-archives.mjs';
import {collectEffectPlacements, viewerAsset} from './effect-placements.mjs';

const {values} = parseArgs({options: {
  output: {type: 'string', default: 'build/hosted-viewer'},
  'published-assets': {type: 'string'},
  lzo: {type: 'string'},
  ...Object.fromEntries(Object.keys(gameNames).flatMap(game =>
    [game, game + '-pack'].map(key => [key, {type: 'string'}]))),
}});
if (!values['published-assets'] || !values.lzo)
  throw new Error('Pass --published-assets and --lzo with the staged game assets and LZO source directory.');

const output = resolve(values.output);
const source = import.meta.dirname;
const viewer = join(output, 'viewer');
const packPattern = /^\/packs\/[a-f0-9]{64}\/pack\.json$/;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function verifyArchive(root, metadata, file) {
  const descriptor = await readJson(join(metadata, file.path + '.json'));
  if (descriptor.size !== file.size || descriptor.chunkBytes !== 16 * 1024 * 1024 ||
      descriptor.chunks?.length !== Math.ceil(file.size / descriptor.chunkBytes))
    throw new Error('Invalid deployed archive descriptor: ' + file.path);
  const handle = await open(join(root, file.path));
  try {
    let offset = 0;
    for (const hash of descriptor.chunks) {
      const bytes = await readBytes(handle, offset, Math.min(descriptor.chunkBytes, file.size - offset));
      if (createHash('sha256').update(bytes).digest('hex') !== hash)
        throw new Error('Local archive does not match deployed bytes: ' + file.path + ' at ' + offset);
      offset += bytes.length;
    }
  } finally {
    await handle.close();
  }
}

await mkdir(viewer, {recursive: true});
const games = {};
const decoder = await archiveIndexDecoder();
try {
  for (const game of Object.keys(gameNames)) {
    const root = values[game] && resolve(values[game]), pack = values[game + '-pack'];
    if (!root && !pack) continue;
    if (!root || !packPattern.test(pack)) throw new Error('Pass a game directory and deployed pack URL for ' + game);
    const packFile = join(values['published-assets'], pack.slice(1));
    const manifest = await readJson(packFile);
    if (manifest.format !== 'xray-stream-pack-v1') throw new Error('Invalid deployed pack for ' + game);
    const files = new Map(manifest.files.map(file => [file.path, file]));
    const {assets, maps, meshes, motions} = await indexGame(root, decoder,
      new Map(manifest.files.map(file => [file.path, file.size])), true);
    const archives = [...new Set([...assets.values()].map(entry => entry.path))].map(path => relative(root, path));
    const ids = new Map(archives.map((path, index) => [path, index]));
    for (const path of archives) await verifyArchive(root, resolve(packFile, '..'), files.get(path));
    const placements = await collectEffectPlacements(game, assets);
    for (const path of assets.keys()) if (!viewerAsset(path)) assets.delete(path);
    const index = game + '.json';
    games[game] = {pack, index, placements: game + '-placements.json'};
    await writeFile(join(viewer, games[game].placements), JSON.stringify(placements));
    await writeFile(join(viewer, index), JSON.stringify({
      archives, maps, meshes, motions,
      assets: [...assets].map(([name, {path, start, raw, packed}]) => [name, ids.get(relative(root, path)), start, raw, packed]),
    }));
    console.log(game + ': verified ' + archives.length + ' archives, ' + meshes.length + ' meshes, ' + maps.length + ' maps');
  }
} finally {
  await decoder.close();
}
if (!Object.keys(games).length) throw new Error('Provide at least one game and pack.');

execFileSync(process.execPath, [join(source, 'build.mjs'), viewer], {
  env: {...process.env, XRAY_VIEWER_LZO: resolve(values.lzo)}, stdio: 'inherit',
});
await Promise.all([
  writeFile(join(viewer, 'games.json'), JSON.stringify(games)),
  copyFile(join(source, 'hosted-source.mjs'), join(viewer, 'viewer-source.mjs')),
  copyFile(join(source, 'catalog.mjs'), join(viewer, 'catalog.mjs')),
  copyFile(join(source, '../streaming/chunk-reader.mjs'), join(viewer, 'chunk-reader.mjs')),
  copyFile(join(source, '../../../server/web/opfs-store.mjs'), join(viewer, 'opfs-store.mjs')),
  writeFile(join(output, '_redirects'), '/viewer /viewer/ 308\n/viewer/ /viewer/index.html 200\n'),
  writeFile(join(output, '_headers'), '/viewer/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n'),
]);
