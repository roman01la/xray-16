import test from 'node:test';
import assert from 'node:assert/strict';
import {readCopLooseItem} from './cop-spawn.mjs';

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
