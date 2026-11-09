// Export the stock ALife ladder geometry used by the character movement code.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readGameFiles} from './game-configs.mjs';
import {readCopSpawns, readCopLadder} from './cop-spawn.mjs';

const [game, output] = process.argv.slice(2);
if (!game || !output) throw Error('Usage: export-ladders.mjs GAME_DIR OUTPUT_JSON');
const destination = resolve(output), source = resolve(game);
if (destination === source || destination.startsWith(source + '/')) throw Error('Export outside the game installation');
const files = await readGameFiles(source, ['spawns/all.spawn']);
const spawn = files.get('spawns/all.spawn');
const levels = {};
for (const entity of readCopSpawns(spawn.data).filter(e => e.section === 'climable_object')) {
 const {spawnId, level, position, rotation, storyId, spawnStoryId, customDataLength, ini, parent} = entity;
 if (storyId !== 0xffffffff || spawnStoryId !== 0xffffffff || customDataLength || ini.trim() || parent !== 0xffff) {
  throw Error(`Unknown stock ladder placement ${spawnId}`);
 }
 (levels[level] ??= []).push({spawnId, position, rotation, ...readCopLadder(entity)});
}
if (!Object.keys(levels).length) throw Error('No original campaign ladders');
await writeFile(destination, JSON.stringify({schema: 1, spawnSha256: spawn.sha256, levels}, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(levels).map(([level, ladders]) => [level, ladders.length]))));
