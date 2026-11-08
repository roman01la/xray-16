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

export function readCopSpawns(bytes) {
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
 return entities.sort((a, b) => a.spawnId - b.spawnId);
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
