// Call of Pripyat ALife spawn graph. The layouts are from
// alife_spawn_registry.cpp, graph_abstract_inline.h, server_entity_wrapper.cpp,
// xrServer_Object_Base.cpp and game_graph_space.h in this engine.
const text = new TextDecoder('windows-1251');
class Reader {
 constructor(bytes) { this.bytes = bytes; this.at = 0; }
 take(length) {
  if (length < 0 || length > this.bytes.length - this.at) throw Error('Truncated CoP spawn data');
  const start = this.at;
  this.at += length;
  return this.bytes.subarray(start, this.at);
 }
 u8() { return this.take(1)[0]; }
 u16() { return this.take(2).readUInt16LE(); }
 u32() { return this.take(4).readUInt32LE(); }
 f32() {
  const value = this.take(4).readFloatLE();
  if (!Number.isFinite(value)) throw Error('Nonfinite CoP spawn scalar');
  return value;
 }
 vector() {
  const bytes = this.take(12);
  const values = [bytes.readFloatLE(0), bytes.readFloatLE(4), bytes.readFloatLE(8)];
  if (!values.every(Number.isFinite)) throw Error('Nonfinite CoP spawn position');
  return values;
 }
 string() {
  const end = this.bytes.indexOf(0, this.at);
  if (end < 0) throw Error('Unterminated CoP spawn string');
  const value = text.decode(this.take(end - this.at));
  this.take(1);
  return value;
 }
 end() {
  if (this.at !== this.bytes.length) throw Error('Unexpected bytes in CoP spawn record');
 }
}

function chunks(bytes) {
 const reader = new Reader(bytes);
 const result = new Map();
 while (reader.at < bytes.length) {
  const id = reader.u32(), size = reader.u32();
  if (id > 0x7fffffff || result.has(id)) throw Error('Unsupported or duplicate CoP spawn chunk');
  result.set(id, reader.take(size));
 }
 return result;
}
function required(map, id) {
 const bytes = map.get(id);
 if (!bytes) throw Error('Missing CoP spawn chunk ' + id);
 return bytes;
}
function graphLevels(bytes, guid, levelCount) {
 const reader = new Reader(bytes);
 if (reader.u8() !== 10) throw Error('Unsupported CoP game graph version');
 const vertexCount = reader.u16();
 reader.take(8); // Edge and death point counts.
 if (!reader.take(16).equals(guid) || reader.u8() !== levelCount) throw Error('Mismatched CoP game graph');
 const levels = new Map();
 for (let i = 0; i < levelCount; i++) {
  const name = reader.string();
  reader.take(12); // The entity positions are already level local.
  const id = reader.u8();
  reader.string(); // Level section.
  reader.take(16); // Level graph GUID.
  if (levels.has(id) || !/^[a-z0-9_]+$/.test(name)) throw Error('Invalid CoP game graph level');
  levels.set(id, name);
 }
 const vertices = reader.take(vertexCount * 42);
 return Array.from({length: vertexCount}, (_, i) => {
  const level = levels.get(vertices[i * 42 + 24]);
  if (!level) throw Error('CoP game graph vertex has unknown level');
  return level;
 });
}

function entity(bytes, updateBytes, levels, spawnId) {
 const reader = new Reader(bytes);
 const packet = new Reader(reader.take(reader.u16()));
 reader.end();
 if (packet.u16() !== 1) throw Error('Invalid CoP entity spawn message');
 const section = packet.string(), name = packet.string();
 packet.take(2); // Legacy game ID and respawn point.
 const position = packet.vector(), rotation = packet.vector();
 packet.take(4); // Respawn time and object ID.
 const parent = packet.u16();
 packet.take(2); // Phantom ID.
 const flags = packet.u16();
 if (!(flags & (1 << 5)) || packet.u16() !== 128) throw Error('Unsupported CoP entity version');
 packet.take(4); // Game type mask and script version.
 const customDataLength = packet.u16();
 packet.take(customDataLength);
 packet.take(2); // Spawn packet's internal spawn ID. Use the graph ID for provenance.
 const stateSize = packet.u16();
 if (stateSize < 2) throw Error('Invalid CoP entity state size');
 const state = new Reader(packet.take(stateSize - 2));
 packet.end();
 const level = levels[state.u16()];
 if (!level || !/^[a-zA-Z0-9_.-]+$/.test(section)) throw Error('Invalid CoP ALife object');
 state.take(16); // Distance, direct control, level node, ALife flags.
 const ini = state.string();
 const storyId = state.u32(), spawnStoryId = state.u32();
 const update = new Reader(updateBytes);
 const packetUpdate = update.take(update.u16());
 update.end();
 if (packetUpdate.length < 2 || packetUpdate.readUInt16LE(0) !== 0) throw Error('Invalid CoP entity update message');
 return {spawnId, section, name, level, position, rotation, parent, ini, storyId, spawnStoryId, customDataLength,
  itemStateBytes: state.take(state.bytes.length - state.at), itemUpdateBytes: packetUpdate.subarray(2)};

}

export function readCopSpawnGraph(bytes) {
 const root = chunks(bytes), header = new Reader(required(root, 0));
 if (header.u32() !== 10) throw Error('Unsupported CoP ALife graph version');
 header.take(16); // ALife GUID.
 const guid = header.take(16), count = header.u32(), levelCount = header.u32();
 header.end();
 const levels = graphLevels(required(root, 4), guid, levelCount);
 const graph = chunks(required(root, 1));
 const vertexCount = new Reader(required(graph, 0));
 if (vertexCount.u32() !== count) throw Error('CoP ALife graph count mismatch');
 vertexCount.end();
 const vertices = chunks(required(graph, 1));
 if (vertices.size !== count) throw Error('CoP ALife vertex count mismatch');
 const ids = new Set();
 const entities = [];
 for (const record of vertices.values()) {
  const vertex = chunks(record), id = new Reader(required(vertex, 0));
  const spawnId = id.u16();
  id.end();
  if (ids.has(spawnId)) throw Error('Duplicate CoP ALife spawn ID');
  ids.add(spawnId);
  const wrapper = chunks(required(vertex, 1));
  entities.push(entity(required(wrapper, 0), required(wrapper, 1), levels, spawnId));
 }
 return {entities: entities.sort((a, b) => a.spawnId - b.spawnId), vertexLevels: levels};
}

export function readCopSpawns(bytes) {
 return readCopSpawnGraph(bytes).entities;
}

// CPatrolPathStorage stores each named path as a serialized CAbstractGraph.
export function readCopPatrolPoints(bytes, names, vertexLevels) {
 const storage = chunks(required(chunks(bytes), 3));
 const count = new Reader(required(storage, 0));
 const paths = chunks(required(storage, 1));
 if (count.u32() !== paths.size) throw Error('CoP patrol path count mismatch');
 count.end();
 const selected = new Map();
 for (const path of paths.values()) {
  const record = chunks(path), nameReader = new Reader(required(record, 0));
  const name = nameReader.string();
  nameReader.end();
  if (!names.has(name)) continue;
  if (selected.has(name)) throw Error('Duplicate CoP patrol path ' + name);
  const graph = chunks(required(record, 1)), pointCount = new Reader(required(graph, 0));
  const vertices = chunks(required(graph, 1));
  if (!vertices.size || pointCount.u32() !== vertices.size) throw Error('Invalid CoP patrol point count');
  pointCount.end();
  const points = [];
  for (const vertex of vertices.values()) {
   const entry = chunks(vertex), id = new Reader(required(entry, 0));
   const index = id.u32();
   id.end();
   if (index >= vertices.size || points[index]) throw Error('Invalid CoP patrol point index');
   const point = new Reader(required(entry, 1));
   const pointName = point.string(), position = point.vector();
   point.u32(); // Flags.
   const levelVertex = point.u32();
   const level = vertexLevels[point.u16()];
   point.end();
   // Some artefact paths float off the AI mesh. The stock binder places them
   // with its own graph vertices, so those points can omit graph membership.
   if (!level && levelVertex !== 0xffffffff) throw Error('CoP patrol point has unknown level: ' + name);
   points[index] = {name: pointName, position, level};
  }
  selected.set(name, points);
 }
 if (selected.size !== names.size) throw Error('Missing CoP patrol paths: ' + [...names].filter(name => !selected.has(name)).join(', '));
 return selected;
}

function readShape(state) {
 const type = state.u8();
 if (type === 0) {
  const center = state.vector(), radius = state.f32();
  if (radius <= 0) throw Error('Invalid authored sphere radius');
  return {kind: 'sphere', center, radius};
 }
 if (type === 1) {
  const axes = [state.vector(), state.vector(), state.vector()];
  return {kind: 'box', axes, center: state.vector()};
 }
 throw Error('Unknown authored collision shape');
}

export function readCopSpaceRestrictor(entity) {
 if (entity.section !== 'space_restrictor' || entity.itemUpdateBytes.length) {
  throw Error('Invalid CoP space restrictor state');
 }
 const state = new Reader(entity.itemStateBytes), count = state.u8();
 if (count < 1 || count > 16) throw Error('Invalid CoP space restrictor shape count');
 const shapes = Array.from({length: count}, () => readShape(state));
 const restrictorType = state.u8();
 if (restrictorType > 5) throw Error('Invalid CoP space restrictor type');
 state.end();
 return {shapes, restrictorType};
}

// CClimableObject::net_Spawn uses the diagonal of this local box as half-extents.
export function readCopLadder(entity) {
 if (entity.section !== 'climable_object' || entity.itemUpdateBytes.length) {
  throw Error('Invalid CoP ladder state');
 }
 const state = new Reader(entity.itemStateBytes);
 if (state.u8() !== 1) throw Error('Expected one authored ladder shape');
 const shape = readShape(state);
 if (shape.kind !== 'box' || shape.center.some(value => value !== 0)
  || shape.axes.some((axis, i) => axis.some((value, j) => i === j ? value < 0 : value !== 0))) {
  throw Error('Unsupported authored ladder box');
 }
 const halfExtents = shape.axes.map((axis, i) => axis[i]);
 // A zero thickness is valid. X-Ray gives the ladder a minimum shell width.
 if (halfExtents.filter(value => value > 0).length < 2) throw Error('Degenerate authored ladder box');
 const material = state.string();
 if (!['materials\\fake_ladders', 'materials\\fake_ladders_woods'].includes(material)) {
  throw Error('Unknown authored ladder material');
 }
 state.end();
 return {halfExtents, material};
}

// CSE_ALifeAnomalousZone v128, restricted to unowned, always-enabled fields.
export function readCopStaticField(entity, factory, multiple = false) {
 const state = new Reader(entity.itemStateBytes);
 const count = state.u8();
 if (multiple ? count < 1 || count > 16 : count !== 1) throw Error('Invalid authored field shape count');
 const shapes = Array.from({length: count}, () => readShape(state));
 if (count > 1 && shapes[0].kind !== 'sphere') throw Error('Unsupported composite field falloff');
 state.u8(); // Space restrictor type.
 const startPower = state.f32();
 if (startPower < 0 || entity.itemUpdateBytes?.length) throw Error('Invalid static field state');
 if (state.u32() !== 0xffffffff || state.u32() || state.u32() || state.u32()) {
  throw Error('Authored field is owned or has a timed schedule');
 }
 state.f32(); // Offline interactive radius.
 state.take(6); // ALife artefact spawn count and position offset.
 // se_zones.se_zone_anom appends a flag for the campaign's last artefact spawn.
 if (['ZS_RADIO', 'ZS_MBALD', 'ZS_GALAN', 'ZS_MINCE'].includes(factory) && state.u8() !== 0) {
  throw Error('Field contains campaign artefact spawn history');
 }
 state.end();
 return multiple ? {shapes, startPower} : {shape: shapes[0], startPower};
}

// CSE_ALifeLevelChanger v128 plus the stock se_level_changer Lua state.
export function readCopLevelChanger(entity, vertexLevels) {
 const state = new Reader(entity.itemStateBytes);
 const count = state.u8();
 if (!count || entity.itemUpdateBytes.length) throw Error('Invalid CoP level changer state');
 const shapes = Array.from({length: count}, () => readShape(state));
 const restrictorType = state.u8();
 const graphVertex = state.u16(), levelVertex = state.u32();
 const position = state.vector(), rotation = state.vector();
 const level = state.string(), graphPoint = state.string();
 if (level !== vertexLevels[graphVertex] || level === entity.level || !graphPoint) {
  throw Error('Invalid CoP level changer destination');
 }
 const silent = state.u8();
 const scriptStart = state.at;
 const enabled = state.u8(), hint = state.string();
 const scriptSize = state.at - scriptStart;
 if (silent > 1 || enabled > 1 || state.u16() !== scriptSize) throw Error('Invalid CoP level changer flags or script marker');
 state.end();
 return {
  shapes, restrictorType, silent: Boolean(silent), enabled: Boolean(enabled), hint,
  destination: {level, graphPoint, graphVertex, levelVertex, position, rotation},
 };
}

// The approved loose Zaton items use these CoP object factories. Require the
// complete state and update layouts so a different factory cannot silently
// turn into an item with invented default condition or ammunition.
const looseWeaponClasses = new Set(['WP_AK74', 'WP_LR300', 'WP_ASHTG']);
export function readCopLooseItem(entity, config) {
 const cls = config.class;
 const ammunition = cls === 'AMMO_S';
 const food = cls === 'S_FOOD';
 const equipment = cls === 'G_F1_S' || cls === 'G_RGD5_S';
 const weapon = looseWeaponClasses.has(cls);
 if (!ammunition && !food && !equipment && !weapon) throw Error('Unsupported loose item factory: ' + cls);
 const spawn = new Reader(entity.itemStateBytes), update = new Reader(entity.itemUpdateBytes);
 spawn.string(); // CSE_Visual model name.
 spawn.u8(); // CSE_Visual flags.
 let condition = spawn.take(4).readFloatLE();
 const upgradeCount = spawn.u32();
 if (upgradeCount > 128) throw Error('Too many authored upgrades');
 const upgrades = Array.from({length: upgradeCount}, () => spawn.string());

 let launcherRound = 0;
 let rounds = 0;
 if (ammunition) rounds = spawn.u16();
 if (weapon) {
  spawn.take(7); // Reserve, magazine, weapon state, addons and selected ammo. The update supersedes these.
  launcherRound = spawn.u8();
 }
 spawn.end();

 // CSE_ALifeItemWeaponMagazinedWGL prepends the launcher mode byte.
 const launcherMode = cls === 'WP_AK74' ? update.u8() : 0;
 if (launcherMode > 1) throw Error('Invalid authored launcher mode');
 const physics = update.u8();
 let position = entity.position;
 if (physics) {
  update.take(24); // Force and torque.
  position = update.vector();
  update.take(16); // Quaternion.
  if (!(physics & (2 << 5))) update.take(12);
  if (!(physics & (4 << 5))) update.take(12);
  if (update.u8() > 1) throw Error('Invalid CoP item physics freeze flag');
 }
 if (ammunition) rounds = update.u16();

 let payload = {kind: 'equipment'};
 if (food) payload = {kind: 'consumable', uses: Number(config.eat_portions_num)};
 if (ammunition) payload = {kind: 'ammunition', rounds};
 if (weapon) {
  condition = update.u8() / 255;
  update.u8(); // Weapon flags.
  const count = update.u16(), addonFlags = update.u8(), ammoType = update.u8();
  if (count > 1024 || addonFlags > 7) throw Error('Invalid authored weapon state');
  update.take(2); // Weapon animation and zoom state.
  const fireMode = update.u8();
  const ammo = (config.ammo_class || '').split(',').filter(Boolean);
  const selected = ammo[ammoType];
  if (!selected) throw Error('Unknown authored ammunition type');
  let cartridges = Array(count).fill(selected);
  if (cls === 'WP_ASHTG') {
   const magazineSize = update.u8();
   if (magazineSize !== count) throw Error('Missing authored shotgun cartridges');
   cartridges = Array.from({length: count}, () => ammo[update.u8()]);
   if (cartridges.includes(undefined)) throw Error('Unknown authored shotgun cartridge');
  }
  const attachments = [];
  for (const [flag, key] of [[1, 'scope'], [2, 'grenade_launcher'], [4, 'silencer']]) {
   if (!(addonFlags & flag)) continue;
   if (config[key + '_status'] === '1') continue; // Built into the original weapon model.
   const addon = config[key + '_name'];
   if (!addon || config[key + '_status'] !== '2') throw Error('Unknown authored weapon attachment');
   attachments.push(addon);
  }
  const launcherCount = launcherRound & 63;
  const launcherAmmo = (config.grenade_class || '').split(',')[launcherRound >> 6];
  if (launcherCount && !launcherAmmo) throw Error('Unknown authored launcher ammunition');
  payload = {
   kind: 'weapon', cartridges, launcher_cartridges: Array(launcherCount).fill(launcherAmmo),
   selected_ammunition: selected, attachments, fire_mode: fireMode, launcher_mode: Boolean(launcherMode),
  };
 }
 update.end();
 if (!(condition >= 0 && condition <= 1) ||
     (food && (!Number.isInteger(payload.uses) || payload.uses < 1)) ||
     (ammunition && rounds < 1)) throw Error('Invalid loose item state');
 return {position, state: {condition, upgrades, payload}};
}
