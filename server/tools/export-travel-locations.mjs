// Export stock campaign travel volumes and arrival points for server-side review.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readGameFiles} from './game-configs.mjs';
import {readCopSpawnGraph, readCopLevelChanger, readCopSpaceRestrictor} from './cop-spawn.mjs';

const [game, output] = process.argv.slice(2);
if (!game || !output) throw Error('Usage: export-travel-locations.mjs GAME_DIR OUTPUT_JSON');
const destination = resolve(output), source = resolve(game);
if (destination === source || destination.startsWith(source + '/')) throw Error('Export outside the game installation');
const underpassControl = 'configs/scripts/underpass/pas_b400_sr_control.ltx';
const liftConfig = {
 pripyat: {name: 'pri_b306_ph_button', path: 'pripyat/pri_b306_ph_button.ltx', teleport: 'pri_b306_actor_lc_walk'},
 labx8: {name: 'labx8_physic_object_0003', path: 'labx8/lx8_lift_button.ltx', teleport: 'lx8_actor_walk:lx8_actor_look'},
};
const generatorPath = 'pripyat/pri_b306_sr_generator.ltx';
const buttonVisual = 'dynamics/equipment_cache/equipment_box_01_case';
const buttonModel = 'meshes/' + buttonVisual + '.ogf';
const scriptsPath = path => 'configs/scripts/' + path;
const files = await readGameFiles(game, ['spawns/all.spawn', underpassControl, scriptsPath(generatorPath), buttonModel,
 ...Object.values(liftConfig).map(spec => scriptsPath(spec.path))]);
const spawn = files.get('spawns/all.spawn');
const {entities, vertexLevels} = readCopSpawnGraph(spawn.data);
const control = files.get(underpassControl);
const stockControl = control.data.toString('latin1');
const exits = entities.filter(e => e.level === 'jupiter_underground' && e.name === 'pas_b400_sr_exit');
const changers = entities.filter(e => e.level === 'jupiter_underground' && e.section === 'level_changer');
if (exits.length !== 1 || changers.length !== 1 || changers[0].name !== 'pas_b400_level_changer'
 || !stockControl.includes('=actor_in_zone(pas_b400_sr_exit)} sr_idle@disable')
 || !stockControl.includes('=teleport_actor(pas_b400_actor_exit)')) throw Error('Unknown stock underpass exit logic');
const exit = exits[0];
if (exit.parent !== 0xffff || exit.storyId !== 0xffffffff || exit.spawnStoryId !== 0xffffffff
 || exit.customDataLength !== 0 || !/^\[story_object\]\s*story_id\s*=\s*pas_b400_fwd\s*$/.test(exit.ini)) {
 throw Error('Unknown stock underpass exit restrictor');
}
function scriptedObject(level, name, section, path) {
 const matches = entities.filter(e => e.level === level && e.name === name);
 const entity = matches[0];
 if (matches.length !== 1 || entity.section !== section || entity.parent !== 0xffff
  || entity.storyId !== 0xffffffff || entity.spawnStoryId !== 0xffffffff || entity.customDataLength !== 0
  || !entity.ini.split(/\r?\n/).some(line => line.trim() === 'cfg = scripts\\' + path.replaceAll('/', '\\'))) {
  throw Error('Unknown stock interaction ' + name);
 }
 return entity;
}
const liftButtons = new Map();
const model = files.get(buttonModel), headerSize = model.data.readUInt32LE(4);
if (model.data.readUInt32LE(0) !== 1 || headerSize !== 44 || model.data[8] !== 4) throw Error('Unknown stock lift button model header');
const modelCenter = [0, 1, 2].map(i => {
 const min = model.data.readFloatLE(12 + i * 4), max = model.data.readFloatLE(24 + i * 4);
 if (!(min <= max) || !Number.isFinite(min) || !Number.isFinite(max)) throw Error('Invalid stock lift button model bounds');
 return (min + max) / 2;
});
for (const [level, spec] of Object.entries(liftConfig)) {
 const entity = scriptedObject(level, spec.name, 'physic_object', spec.path);
 const script = files.get(scriptsPath(spec.path)), text = script.data.toString('latin1');
 const visual = entity.itemStateBytes.toString('latin1').split('\0', 1)[0].replaceAll('\\', '/');
 if (!text.includes('=actor_has_item(zat_a23_labx8_key)') || !text.includes('=teleport_actor(' + spec.teleport + ')')
  || !text.includes('on_use = ph_idle@teleport') || visual !== buttonVisual
  || (level === 'pripyat' && !text.includes('+pri_b306_lift_generator_started'))) {
  throw Error('Unknown stock lift logic ' + level);
 }
 liftButtons.set(level, {spawnId: entity.spawnId, position: entity.position, rotation: entity.rotation,
  modelCenter, modelSha256: model.sha256, controlSha256: script.sha256});
}
const generatorEntity = scriptedObject('pripyat', 'pri_b306_sr_generator', 'space_restrictor', generatorPath);
const generatorLogic = files.get(scriptsPath(generatorPath));
const generatorText = generatorLogic.data.toString('latin1');
if (!generatorText.includes('run_tutorial(pri_b306_generator)') || !generatorText.includes('+pri_b306_lift_generator_started')) {
 throw Error('Unknown stock lift generator logic');
}
const generator = {spawnId: generatorEntity.spawnId, position: generatorEntity.position, rotation: generatorEntity.rotation,
 controlSha256: generatorLogic.sha256, ...readCopSpaceRestrictor(generatorEntity)};
const routes = entities.filter(e => e.section === 'level_changer').map(entity => {
 const {spawnId, name, level, position, rotation, storyId, spawnStoryId, customDataLength, ini, parent} = entity;
 const route = readCopLevelChanger(entity, vertexLevels);
 const liftButton = (level === 'pripyat' && route.destination.level === 'labx8') ||
  (level === 'labx8' && route.destination.level === 'pripyat') ? liftButtons.get(level) : undefined;
 const entry = entity === changers[0] ? {
  spawnId: exit.spawnId, name: exit.name, position: exit.position, rotation: exit.rotation,
  controlSha256: control.sha256, ...readCopSpaceRestrictor(exit),
 } : undefined;
 return {
  spawnId, name, level, position, rotation, storyId, spawnStoryId, customDataLength, ini, parent,
  ...route, entry, liftButton,
 };
});
if (!routes.length) throw Error('No original campaign travel locations');
if (routes.filter(route => route.liftButton).length !== 2) throw Error('Missing stock lift routes');
await writeFile(destination, JSON.stringify({schema: 1, spawnSha256: spawn.sha256, routes, generator}, null, 2) + '\n');
console.log(JSON.stringify({routes: routes.length, levels: [...new Set(vertexLevels)].sort()}));
