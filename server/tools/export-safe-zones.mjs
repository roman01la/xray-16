// Export the reviewed permanent hubs from CoP's original no-weapon restrictors.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readCopSpawns, readCopSpaceRestrictor} from './cop-spawn.mjs';
import {readGameFiles} from './game-configs.mjs';

const hubs = [
 {level: 'zaton', name: 'zat_a2_sr_noweap'},
 {level: 'jupiter', name: 'jup_a6_sr_noweap'},
 {level: 'pripyat', name: 'pri_a16_sr_noweap'},
];
const [game, output, ...collisions] = process.argv.slice(2);
if (!game || !output || collisions.length !== hubs.length) {
 throw Error('Usage: export-safe-zones.mjs GAME_DIR OUTPUT_JSON ZATON_COLLISION JUPITER_COLLISION PRIPYAT_COLLISION');
}
if (resolve(output) === resolve(game) || resolve(output).startsWith(resolve(game) + '/')
 || collisions.some(path => resolve(path) === resolve(output))) throw Error('Export to a separate file outside the game installation');

const scripts = hubs.map(({level, name}) => `configs/scripts/${level}/${name}.ltx`);
const files = await readGameFiles(game, ['spawns/all.spawn', ...scripts]);
const spawn = files.get('spawns/all.spawn');
const entities = readCopSpawns(spawn.data);
const zones = await Promise.all(hubs.map(async ({level, name}, index) => {
 const matches = entities.filter(entity => entity.level === level && entity.name === name);
 const [entity] = matches;
 const script = files.get(scripts[index]);
 const logic = script.data.toString('latin1');
 const collision = JSON.parse(await readFile(collisions[index], 'utf8'));
 if (collision.format !== 'xray-collision-v1' || collision.level !== level || !/^[a-f0-9]{64}$/.test(collision.sha256)) {
  throw Error('Invalid collision manifest for ' + level);
 }
 const cfg = scripts[index].slice('configs/'.length).replaceAll('/', '\\');
 if (matches.length !== 1 || entity.section !== 'space_restrictor' || entity.parent !== 65535
  || entity.customDataLength !== 0 || !entity.ini.split(/\r?\n/).some(line => line.trim() === 'cfg = ' + cfg)
  || !/^\[sr_no_weapon@wait\]\s*on_actor_outside\s*=/m.test(logic)) {
  throw Error('Unknown stock hub restriction ' + name);
 }
 const {shapes, restrictorType} = readCopSpaceRestrictor(entity);
 if (restrictorType !== 2) throw Error('Unknown stock restrictor type for ' + name);
 const {position, rotation, spawnId} = entity;
 return {level, name, spawnId, collisionSha256: collision.sha256, scriptSha256: script.sha256, position, rotation, shapes};
}));

await writeFile(output, JSON.stringify({schema: 1, spawnSha256: spawn.sha256, zones}, null, 2) + '\n');
