// Export a reviewable inventory of authored loot from the local game archives.
// Placement IDs are ALife spawn graph vertices. They survive server restarts and
// remain distinct even when several items share the exact same coordinates.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {readGameConfigs, readGameFiles, parseLtx} from './game-configs.mjs';
import {readCopSpawns} from './cop-spawn.mjs';

const [game, catalogPath, output, ...overlays] = process.argv.slice(2);
if (!game || !catalogPath || !output) {
 throw Error('Usage: export-loot-locations.mjs GAME_DIR ITEM_CATALOG OUTPUT_JSON [CONFIG_OVERLAY...]');
}
if (resolve(output) === resolve(catalogPath) || resolve(output).startsWith(resolve(game) + '/')) {
 throw Error('Export to a separate file outside the game installation');
}
const [files, raw, catalogBytes] = await Promise.all([
 readGameConfigs(game, overlays),
 readGameFiles(game, ['spawns/all.spawn', 'scripts/treasure_manager.script', 'scripts/utils.script']),
 readFile(catalogPath),
]);
const catalog = JSON.parse(catalogBytes);
if (catalog.schema !== 1 || !catalog.sections || !Array.isArray(catalog.files)) throw Error('Invalid item catalog');
for (const {path, sha256} of catalog.files) {
 if (files.get(path)?.sha256 !== sha256) throw Error('Item catalog differs from installed configuration: ' + path);
}
const source = raw.get('spawns/all.spawn');
const entities = readCopSpawns(source.data);
const {sections, loaded} = parseLtx(files, 'misc/secrets.ltx');
const list = sections.get('list');
if (!list) throw Error('Missing original stash list');

function secretIni(entity) {
 if (!/^\s*\[secret\]/mi.test(entity.ini)) return null;
 const path = 'spawn.ltx';
 return parseLtx(new Map([[path, {text: entity.ini}]]), path).sections.get('secret').values;
}
function placement(entity) {
 const {spawnId, level, name, section, position, rotation} = entity;
 return {spawnId, level, name, section, position, rotation};
}
function isItem(section) {
 const config = catalog.sections[section]?.values;
 return config?.inv_name !== undefined && config.inv_weight !== undefined;
}
function exclusions(entity, stash) {
 const reasons = [];
 const config = catalog.sections[entity.section]?.values;
 if (/^(true|on|yes|1)$/i.test(config?.quest_item ?? '')) reasons.push('quest-item');
 if (entity.storyId !== 0xffffffff || entity.spawnStoryId !== 0xffffffff) reasons.push('story-id');
 if (entity.parent !== 0xffff) reasons.push('attached-to-another-object');
 if (entity.customDataLength) reasons.push('custom-spawn-data');
 if (!stash && entity.ini.trim()) reasons.push('spawn-script-data');
 if (!stash && /(?:^|_)b\d+(?:_|$)/i.test(entity.name)) reasons.push('story-named-placement');
 return reasons;
}
// The original treasure script consumes count and probability pairs and rolls
// per authored item position. Keep group order so differing chances survive.
function rolls(value) {
 const fields = value.split(',');
 const result = [];
 for (let i = 0; i < fields.length;) {
  const count = Number(fields[i++]);
  const originalChance = i < fields.length ? Number(fields[i++]) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isFinite(originalChance)) {
   throw Error('Invalid stash count or probability: ' + value);
  }
  // The Lua comparison against math.random() makes values outside the unit
  // interval impossible or guaranteed. Preserve the authored value as well.
  result.push({count, originalChance, chance: Math.max(0, Math.min(1, originalChance))});
 }
 return result;
}

const markers = new Map(), stashItems = new Map(), ground = [];
for (const entity of entities) {
 const secret = secretIni(entity);
 if (secret?.name) {
  const items = stashItems.get(secret.name) ?? [];
  items.push(entity);
  stashItems.set(secret.name, items);
 } else if (secret && entity.section === 'space_restrictor') {
  const existing = markers.get(entity.name) ?? [];
  existing.push(entity);
  markers.set(entity.name, existing);
 } else if (isItem(entity.section)) {
  const reasons = exclusions(entity, false);
  ground.push({...placement(entity), classification: reasons.length ? 'excluded' : 'review-one-time', reasons});
 }
}

const stashes = [];
for (const id of Object.keys(list.values).sort()) {
 const definition = sections.get(id);
 if (!definition) throw Error('Missing stash definition: ' + id);
 const items = stashItems.get(id) ?? [], anchors = markers.get(id) ?? [];
 stashItems.delete(id);
 markers.delete(id);
 const marker = anchors.length === 1 ? anchors[0] : null;
 const reasons = [];
 if (!marker) reasons.push('missing-or-ambiguous-marker');
 const conditions = {};
 for (const key of ['empty', 'refreshing']) {
  if (Object.hasOwn(definition.values, key)) conditions[key] = definition.values[key];
 }
 if (Object.keys(conditions).length) reasons.push('script-conditions');
 const placements = [], groups = [];
 for (const [section, value] of Object.entries(definition.values)) {
  if (Object.hasOwn(conditions, section)) continue;
  const authored = items.filter(item => item.section === section);
  let at = 0;
  for (const {count, chance, originalChance} of rolls(value)) {
   const members = authored.slice(at, at + count);
   groups.push({section, count, chance, originalChance, spawnIds: members.map(item => item.spawnId)});
   placements.push(...members.map(item => ({...placement(item), chance})));
   at += count;
  }
  if (at !== authored.length) reasons.push('count-mismatch:' + section);
  if (!isItem(section)) reasons.push('missing-item-definition:' + section);
 }
 if (!groups.length) reasons.push('empty-definition');
 for (const item of items) {
  if (!groups.some(group => group.section === item.section)) reasons.push('unlisted-section:' + item.section);
  if (marker && item.level !== marker.level) reasons.push('cross-level-placement');
  reasons.push(...exclusions(item, true));
 }
 const uniqueReasons = [...new Set(reasons)].sort();
 stashes.push({
  id, source: definition.source, marker: marker && placement(marker),
  classification: uniqueReasons.length ? 'review-stash' : 'shared-stash',
  reasons: uniqueReasons, conditions, groups, placements,
  unassigned: items.filter(item => !placements.some(p => p.spawnId === item.spawnId)).map(placement),
 });
}
const manifest = {
 schema: 1,
 spawn: {path: 'spawns/all.spawn', archive: source.origin, sha256: source.sha256, vertices: entities.length},
 itemCatalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
 sources: [
  ...loaded.map(path => ({path: 'configs/' + path, sha256: files.get(path).sha256})),
  ...[...raw].filter(([path]) => path.startsWith('scripts/')).map(([path, file]) => ({path, sha256: file.sha256})),
 ],
 stashes, ground,
 unmatched: {
  items: [...stashItems].map(([id, items]) => ({id, placements: items.map(placement)})),
  markers: [...markers].map(([id, items]) => ({id, placements: items.map(placement)})),
 },
};
const bytes = JSON.stringify(manifest) + '\n';
await mkdir(dirname(resolve(output)), {recursive: true});
await writeFile(output, bytes);
const eligible = stashes.filter(stash => stash.classification === 'shared-stash');
console.log(JSON.stringify({
 output: resolve(output), sha256: createHash('sha256').update(bytes).digest('hex'),
 vertices: entities.length, stashes: stashes.length, sharedStashes: eligible.length,
 sharedPositions: eligible.reduce((sum, stash) => sum + stash.placements.length, 0),
 zatonSharedStashes: eligible.filter(stash => stash.marker.level === 'zaton').length,
 groundCandidates: ground.filter(item => item.classification === 'review-one-time').length,
 excludedGround: ground.filter(item => item.classification === 'excluded').length,
}, null, 2));
