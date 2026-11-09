import test from 'node:test';
import assert from 'node:assert/strict';
import {readCopLadder, readCopLevelChanger, readCopLooseItem, readCopSpaceRestrictor, readCopStaticField} from './cop-spawn.mjs';

test('loose ammo uses the original update position and remaining rounds even with zero sync items', () => {
 const spawn = Buffer.alloc(12);
 spawn[0] = 0; // Empty visual name.
 spawn[1] = 0; // Visual flags.
 spawn.writeFloatLE(0.75, 2);
 spawn.writeUInt32LE(0, 6);
 spawn.writeUInt16LE(30, 10);
 // Flags are set while the low five bits are zero in shipped CoP records.
 // The engine only skips the transform when the entire mask byte is zero.
 const update = Buffer.alloc(56);
 update[0] = 0xe0;
 update.writeFloatLE(11.25, 25);
 update.writeFloatLE(7.5, 29);
 update.writeFloatLE(-12.5, 33);
 update.writeFloatLE(1, 49);
 update[53] = 1;
 update.writeUInt16LE(14, 54);
 const item = {position: [0, 0, 0], itemStateBytes: spawn, itemUpdateBytes: update};
 assert.deepEqual(readCopLooseItem(item, {class: 'AMMO_S'}), {
  position: [11.25, 7.5, -12.5],
  state: {condition: 0.75, upgrades: [], payload: {kind: 'ammunition', rounds: 14}},
 });
 assert.throws(() => readCopLooseItem({...item, itemUpdateBytes: update.subarray(0, 55)}, {class: 'AMMO_S'}), /Truncated/);
});

test('radiation field decoding preserves authored shape and rejects scheduled or scripted state', () => {
 const sphere = Buffer.alloc(50);
 sphere[0] = 1;
 sphere.writeFloatLE(2.5, 2);
 sphere.writeFloatLE(4.25, 14);
 sphere.writeFloatLE(0.25, 19);
 sphere.writeUInt32LE(0xffffffff, 23);
 assert.deepEqual(readCopStaticField({itemStateBytes: sphere}, 'ZS_RADIO'), {
  shape: {kind: 'sphere', center: [2.5, 0, 0], radius: 4.25}, startPower: 0.25,
 });
 const box = Buffer.alloc(82);
 box.set([1, 1]);
 for (const [offset, value] of [[2, 4], [18, 5], [34, 6], [46, 8]]) box.writeFloatLE(value, offset);
 box.writeUInt32LE(0xffffffff, 55);
 assert.deepEqual(readCopStaticField({itemStateBytes: box.subarray(0, 81)}, 'Z_RADIO'), {
  shape: {kind: 'box', axes: [[4, 0, 0], [0, 5, 0], [0, 0, 6]], center: [0, 0, 8]}, startPower: 0,
 });
 sphere[49] = 1;
 assert.throws(() => readCopStaticField({itemStateBytes: sphere}, 'ZS_RADIO'), /spawn history/);
 sphere[27] = 1;
 assert.throws(() => readCopStaticField({itemStateBytes: sphere}, 'ZS_RADIO'), /timed schedule/);
});

test('travel decoding binds the destination to its graph vertex and preserves the authored gate', () => {
 const prefix = Buffer.alloc(49);
 prefix[0] = 1;
 prefix.writeFloatLE(3, 14);
 prefix.writeUInt16LE(1, 19);
 prefix.writeUInt32LE(8, 21);
 prefix.writeFloatLE(12.5, 25);
 prefix.writeFloatLE(1.25, 41);
 const lua = Buffer.from([0, 103, 111, 0]); // Disabled route with the hint "go".
 const itemStateBytes = Buffer.concat([
  prefix, Buffer.from('jupiter\0arrival\0'), Buffer.from([1]), lua, Buffer.from([lua.length, 0]),
 ]);
 const entity = {level: 'zaton', itemStateBytes, itemUpdateBytes: Buffer.alloc(0)};
 const route = readCopLevelChanger(entity, ['zaton', 'jupiter']);
 assert.deepEqual(route.destination, {
  level: 'jupiter', graphPoint: 'arrival', graphVertex: 1, levelVertex: 8,
  position: [12.5, 0, 0], rotation: [0, 1.25, 0],
 });
 assert.equal(route.enabled, false);
 assert.equal(route.silent, true);
 assert.equal(route.hint, 'go');
 assert.throws(() => readCopLevelChanger(entity, ['zaton', 'pripyat']), /destination/);
 itemStateBytes[itemStateBytes.length - 2] = 0;
 assert.throws(() => readCopLevelChanger(entity, ['zaton', 'jupiter']), /script marker/);
});

test('scripted travel entry decodes stock restrictor shapes and rejects extra state', () => {
 const bytes = Buffer.alloc(51);
 bytes.set([1, 1]);
 for (const [offset, value] of [[2, 4], [18, 5], [34, 6], [46, 8]]) bytes.writeFloatLE(value, offset);
 bytes[50] = 3;
 const entity = {section: 'space_restrictor', itemStateBytes: bytes, itemUpdateBytes: Buffer.alloc(0)};
 assert.deepEqual(readCopSpaceRestrictor(entity), {
  shapes: [{kind: 'box', axes: [[4, 0, 0], [0, 5, 0], [0, 0, 6]], center: [0, 0, 8]}],
  restrictorType: 3,
 });
 assert.throws(() => readCopSpaceRestrictor({...entity, itemStateBytes: Buffer.concat([bytes, Buffer.of(0)])}));
 assert.throws(() => readCopSpaceRestrictor({...entity, itemUpdateBytes: Buffer.of(0)}));
});

test('authored ladder boxes retain half-extents and the material name', () => {
 const box = Buffer.alloc(50);
 box.set([1, 1]);
 for (const [offset, value] of [[2, 13.75], [18, 0.015625], [34, 0.5]]) box.writeFloatLE(value, offset);
 const material = 'materials\\fake_ladders_woods';
 const entity = {section: 'climable_object', itemStateBytes: Buffer.concat([box, Buffer.from(material + '\0')]), itemUpdateBytes: Buffer.alloc(0)};
 assert.deepEqual(readCopLadder(entity), {halfExtents: [13.75, 0.015625, 0.5], material});
 entity.itemStateBytes.writeFloatLE(0, 18);
 assert.deepEqual(readCopLadder(entity).halfExtents, [13.75, 0, 0.5]);
 entity.itemStateBytes.writeFloatLE(1, 6);
 assert.throws(() => readCopLadder(entity), /ladder box/);
});
