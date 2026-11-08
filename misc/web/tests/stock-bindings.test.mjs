import assert from 'node:assert/strict';
import test from 'node:test';
import {migrateStockBindings,restoreAlphaQuickSlots} from '../page/stock-bindings.mjs';

const alpha = 'default_controls\r\nbind quick_use_1 kLBRACKET\r\nbind quick_use_2 kF2\r\nbind quick_use_3 kRBRACKET\r\n';
const stock = alpha.replace('kLBRACKET','kF1').replace('kRBRACKET','kF3');

test('restores both alpha quick slots and preserves all other config bytes', async () => {
  const suffix = Buffer.from([59,32,0x81,0xff,0x0d,0x0a]);
  const config = Buffer.concat([Buffer.from(alpha),suffix]);
  const result = await restoreAlphaQuickSlots(config).arrayBuffer();
  assert.deepEqual(Buffer.from(result),Buffer.concat([Buffer.from(stock),suffix]));
});

test('leaves custom, conflicting and already restored keybinds intact', () => {
  for (const config of [
    stock,
    alpha.replace('kLBRACKET','kK'),
    alpha+'bind inventory kF1\r\n',
    alpha+'bind_sec inventory kF3\r\n',
    alpha+'unbind quick_use_3\r\n',
    alpha+'bind quick_use_1 kO\r\n',
    alpha.replace('default_controls\r\n',''),
  ]) assert.equal(restoreAlphaQuickSlots(Buffer.from(config)),null);
});

test('migration runs once per browser profile and later custom brackets survive', async () => {
  const files = new Map([['user.ltx',new Blob([alpha])]]);
  const app = {async getFileHandle(name,{create=false}={}) {
    if (!files.has(name)) {
      if (!create) throw new DOMException('Missing file','NotFoundError');
      files.set(name,new Blob());
    }
    return {
      async getFile() {return files.get(name);},
      async createWritable() {
        let pending;
        return {async write(blob) {pending=blob;},async close() {files.set(name,pending);}};
      },
    };
  }};
  await migrateStockBindings(app);
  assert.equal(await files.get('user.ltx').text(),stock);
  files.set('user.ltx',new Blob([alpha]));
  await migrateStockBindings(app);
  assert.equal(await files.get('user.ltx').text(),alpha);
});
