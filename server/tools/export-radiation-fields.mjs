// Export stock continuously active fields from CoP's ALife graph.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {configPath, parseLtx, readGameFiles} from './game-configs.mjs';
import {readCopSpawns, readCopStaticField} from './cop-spawn.mjs';

const [game, catalogPath, level, output, mode, ...extra] = process.argv.slice(2);
if (!game || !catalogPath || !/^[a-z0-9_]+$/.test(level ?? '') || !output || (mode && !['--all','--electra'].includes(mode)) || extra.length) {
 throw Error('Usage: export-radiation-fields.mjs GAME_DIR ITEM_CATALOG LEVEL OUTPUT_JSON [--all|--electra]');
}
if (resolve(output) === resolve(catalogPath) || resolve(output).startsWith(resolve(game) + '/')) {
 throw Error('Export to a separate file outside the game installation');
}
const [files, catalogBytes] = await Promise.all([
 readGameFiles(game, ['spawns/all.spawn']), readFile(catalogPath),
]);
const catalog = JSON.parse(catalogBytes);
if (catalog.schema !== 1 || catalog.entry !== 'system.ltx') throw Error('Invalid item catalog');
const source = files.get('spawns/all.spawn');
const fields = [];
const hitTypes = mode ? ['radiation', 'chemical_burn', 'light_burn', 'telepatic'] : ['radiation'];
const entities = readCopSpawns(source.data).filter(entity => entity.level === level);
function readPlacement(entity, config, multiple) {
 if (entity.ini.trim() || entity.customDataLength || entity.parent !== 65535 ||
     entity.storyId !== 0xffffffff || entity.spawnStoryId !== 0xffffffff) {
  throw Error('Field needs scripted-state review: ' + entity.spawnId);
 }
 const {spawnId, section, position, rotation} = entity;
 return {spawnId, section, position, rotation, ...readCopStaticField(entity, config.class, multiple)};
}
for (const entity of entities) {
 const config = catalog.sections[entity.section]?.values;
 if (!hitTypes.includes(config?.hit_type) || !['Z_RADIO', 'ZS_RADIO'].includes(config.class)) continue;
 fields.push(readPlacement(entity, config, Boolean(mode)));
}
if (!fields.length) throw Error('No authored fields for ' + level);
async function anomalyLayerState() {
 const binders = entities.filter(entity => entity.section === 'anomal_zone');
 const entries = binders.map(entity => {
  const path = /^\s*cfg\s*=\s*(\S+\.ltx)\s*$/m.exec(entity.ini)?.[1];
  if (!path) throw Error('Missing anomaly binder configuration: ' + entity.spawnId);
  return configPath('configs/' + path);
 });
 const governed = new Map();
 if (entries.length) {
  const configs = await readGameFiles(game, entries);
  const ltx = new Map([...configs].map(([name, file]) => [name, {text: file.data.toString('latin1')}]));
  for (const entry of entries) {
   const {sections} = parseLtx(ltx, entry);
   const layers = Number(sections.get('anomal_zone')?.values.layers_count ?? 1);
   if (!Number.isInteger(layers) || layers < 1 || layers > 16) throw Error('Invalid anomaly layer count: ' + entry);
   if (layers === 1) continue; // Stock binder only toggles mines for layered placements.
   const managed = new Set(), active = new Set();
   for (let layer = 1; layer <= layers; layer++) {
    const mineSection = sections.get('layer_' + layer)?.values.mines_section;
    if (!mineSection) continue;
    const names = sections.get(mineSection)?.values;
    if (!names) throw Error('Missing anomaly mine layer: ' + entry);
    for (const name of Object.keys(names)) {
     managed.add(name);
     if (layer === 1) active.add(name);
    }
   }
   for (const name of managed) {
    if (governed.has(name)) throw Error('Multiple binders control anomaly mine ' + name);
    governed.set(name, active.has(name));
   }
  }
 }
 return governed;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {schema: mode === '--electra' ? 4 : mode ? 2 : 1, level, spawnSha256: source.sha256, itemCatalogSha256: sha256(catalogBytes), fields};
let counts = {};
if (mode === '--electra') {
 const governed = await anomalyLayerState();
 const scientific = catalog.sections.detector_scientific?.values;
 if (scientific?.class !== 'DET_SCIE') throw Error('Missing stock Svarog definition');
 const detectable = new Set();
 for (let index = 1; scientific['zone_class_' + index]; ++index) {
  detectable.add(scientific['zone_class_' + index]);
 }
 if (!detectable.size) throw Error('Missing stock Svarog anomaly classes');
 const mines = [], detectorZones = [];
 let dormant = 0, detectorDormant = 0;
 for (const entity of entities) {
  const electra = /^zone_mine_electric_(weak|average|strong)$/.test(entity.section);
  const marker = detectable.has(entity.section);
  if (!electra && !marker) continue;
  const config = catalog.sections[entity.section]?.values;
  if (!['ZS_MBALD', 'ZS_GALAN', 'ZS_MINCE'].includes(config?.class) ||
      (electra && (config.class !== 'ZS_MBALD' || config.hit_type !== 'shock'))) {
   throw Error('Unsupported detectable anomaly definition: ' + entity.section);
  }
  if (governed.get(entity.name) === false) {
   dormant += Number(electra);
   detectorDormant += Number(marker);
   continue;
  }
  const placement = readPlacement(entity, config, true);
  if (electra) mines.push(placement);
  if (marker) detectorZones.push(placement);
 }
 manifest.reactiveMines = mines;
 manifest.detectorZones = detectorZones;
 counts = {electra: mines.length, dormant, detectorZones: detectorZones.length, detectorDormant};
}
const bytes = JSON.stringify(manifest) + '\n';
await writeFile(output, bytes);
console.log(JSON.stringify({fields: fields.length, ...counts, sha256: sha256(bytes)}));
