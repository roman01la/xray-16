// Generate a server-only loose-placement manifest from an explicit review list.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {readGameFiles} from './game-configs.mjs';
import {readCopSpawns, readCopLooseItem} from './cop-spawn.mjs';

const [game, catalogPath, authoredPath, reviewPath, output] = process.argv.slice(2);
if (!game || !catalogPath || !authoredPath || !reviewPath || !output) {
 throw Error('Usage: export-loose-loot.mjs GAME_DIR ITEM_CATALOG AUTHORED_LOOT APPROVAL_JSON OUTPUT_JSON');
}
const outputPath = resolve(output);
if ([catalogPath, authoredPath, reviewPath].some(path => resolve(path) === outputPath) ||
    outputPath.startsWith(resolve(game) + '/')) throw Error('Export to a separate file outside the game installation');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const [files, catalogBytes, authoredBytes, reviewBytes] = await Promise.all([
 readGameFiles(game, ['spawns/all.spawn']),
 readFile(catalogPath), readFile(authoredPath), readFile(reviewPath),
]);
const source = files.get('spawns/all.spawn');
const catalog = JSON.parse(catalogBytes), authored = JSON.parse(authoredBytes), review = JSON.parse(reviewBytes);
const itemCatalogSha256 = hash(catalogBytes);
if (catalog.schema !== 1 || authored.schema !== 1 || review.schema !== 1 ||
    authored.spawn?.sha256 !== source.sha256 || review.spawnSha256 !== source.sha256 ||
    authored.itemCatalogSha256 !== itemCatalogSha256) throw Error('Loose loot input revisions do not match');
if (!/^[a-z0-9_]+$/.test(review.level ?? '') || !Array.isArray(review.spawnIds) || !review.spawnIds.length ||
    review.spawnIds.length > 8192 || new Set(review.spawnIds).size !== review.spawnIds.length ||
    review.spawnIds.some(id => !Number.isInteger(id) || id < 0 || id > 65535)) throw Error('Invalid review list');

const spawns = new Map(readCopSpawns(source.data).map(e => [e.spawnId, e]));
const candidates = new Map(authored.ground.map(e => [e.spawnId, e]));
const placements = [];
for (const id of [...review.spawnIds].sort((a, b) => a - b)) {
 const candidate = candidates.get(id);
 const entity = spawns.get(id);
 if (!candidate || candidate.classification !== 'review-one-time' || candidate.reasons.length ||
     !entity || entity.level !== review.level || entity.section !== candidate.section ||
     entity.name !== candidate.name || entity.ini.trim() || entity.customDataLength ||
     entity.parent !== 65535 || entity.storyId !== 0xffffffff || entity.spawnStoryId !== 0xffffffff) {
  throw Error('Placement is unavailable or conditional: ' + id);
 }
 const config = catalog.sections[entity.section]?.values;
 if (!config || /^(true|on|yes|1)$/i.test(config.quest_item ?? '')) throw Error('Missing or quest item: ' + id);
 const {position, state} = readCopLooseItem(entity, config);
 placements.push({spawnId: id, section: entity.section, name: entity.name, position, rotation: entity.rotation, state});
}

const manifest = {
 schema: 1, level: review.level, spawnSha256: source.sha256, itemCatalogSha256,
 authoredLootSha256: hash(authoredBytes), reviewSha256: hash(reviewBytes), placements,
};
const bytes = JSON.stringify(manifest) + '\n';
await mkdir(dirname(outputPath), {recursive: true});
await writeFile(outputPath, bytes);
console.log(JSON.stringify({output: outputPath, sha256: hash(bytes), placements: placements.length}, null, 2));
