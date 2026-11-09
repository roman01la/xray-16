// Export the stock anomaly binders' first layer and their authored patrol points.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readCopPatrolPoints, readCopSpawnGraph} from './cop-spawn.mjs';
import {configPath, parseLtx, readGameFiles} from './game-configs.mjs';

const [game, catalogPath, output, ...extra] = process.argv.slice(2);
if (!game || !catalogPath || !output || extra.length) {
 throw Error('Usage: export-artefact-sites.mjs GAME_DIR ITEM_CATALOG OUTPUT_JSON');
}
if (resolve(output) === resolve(catalogPath) || resolve(output).startsWith(resolve(game) + '/')) {
 throw Error('Export to a separate file outside the game installation');
}
const [files, catalogBytes] = await Promise.all([readGameFiles(game, ['spawns/all.spawn']), readFile(catalogPath)]);
const catalog = JSON.parse(catalogBytes);
if (catalog.schema !== 1 || catalog.entry !== 'system.ltx') throw Error('Invalid item catalog');
const source = files.get('spawns/all.spawn');
const {entities, vertexLevels} = readCopSpawnGraph(source.data);
const binders = entities.filter(entity => entity.section === 'anomal_zone');
const entries = binders.map(entity => {
 const path = /^\s*cfg\s*=\s*(\S+\.ltx)\s*$/m.exec(entity.ini)?.[1];
 if (!path) throw Error('Missing anomaly binder configuration: ' + entity.spawnId);
 return configPath('configs/' + path);
});
const filesByPath = await readGameFiles(game, entries);
const configs = new Map([...filesByPath].map(([name, file]) => [name, {text: file.data.toString('latin1')}]));
const list = value => value ? value.split(',').map(entry => entry.trim()) : [];
const key = /^[a-zA-Z0-9_]+$/;
const paths = new Set();
const sites = [], excluded = [];
for (const [i, binder] of binders.entries()) {
 const entry = entries[i];
 const {sections} = parseLtx(configs, entry);
 const base = sections.get('anomal_zone')?.values;
 if (!base) throw Error('Missing anomaly definition: ' + entry);
 const config = {...base, ...sections.get('layer_1')?.values};
 const cap = Number(config.max_artefacts ?? 3);
 if (!Number.isInteger(cap) || cap < 0 || cap > 8) throw Error('Invalid anomaly artefact cap: ' + entry);
 const {spawnId, level, name} = binder;
 if (!cap || binder.storyId !== 0xffffffff || binder.spawnStoryId !== 0xffffffff || binder.parent !== 65535) {
  excluded.push({spawnId, name, reason: cap ? 'story or parent state' : 'zero stock cap'});
  continue;
 }
 const ways = list(config.artefact_ways);
 const sectionsList = list(config.artefacts);
 const start = list(config.start_artefact).at(-1) ?? null;
 // Without campaign info portions, the stock coefficient condition selects coeff.
 const weights = list(config.coeff).map(Number);
 if (config.coeffs_section || !ways.length || ways.some(way => !key.test(way)) || new Set(ways).size !== ways.length ||
     !sectionsList.length || new Set(sectionsList).size !== sectionsList.length ||
     (weights.length && (weights.length !== sectionsList.length || weights.some(weight => !Number.isInteger(weight) || weight < 0 || weight > 1000)))) {
  throw Error('Unsupported artefact spawn configuration: ' + entry);
 }
 for (const section of start ? [...sectionsList, start] : sectionsList) {
  const item = catalog.sections[section]?.values;
  if (!key.test(section) || !['ARTEFACT', 'SCRPTART'].includes(item?.class) ||
      ![1, 2, 3].includes(Number(item.af_rank)) || (item.quest_item && !['false','off','0','no'].includes(item.quest_item))) {
   throw Error('Non-repeatable or unsupported artefact: ' + section);
  }
 }
 ways.forEach(way => paths.add(way));
 const choices = sectionsList.map((section, index) => ({section, weight: weights.some(Boolean) ? weights[index] : 1}));
 sites.push({spawnId, name, level, cap, start, choices, ways});
}
const points = readCopPatrolPoints(source.data, paths, vertexLevels);
for (const site of sites) {
 site.ways = site.ways.map(name => ({name, points: points.get(name).map(point => {
  if (point.level && point.level !== site.level) throw Error('Cross-level artefact path ' + name);
  return point.position;
 })}));
}
const manifest = {schema: 1, spawnSha256: source.sha256,
 itemCatalogSha256: createHash('sha256').update(catalogBytes).digest('hex'), sites, excluded};
await writeFile(output, JSON.stringify(manifest) + '\n');
console.log(JSON.stringify({sites: sites.length, paths: points.size, excluded: excluded.length}));
