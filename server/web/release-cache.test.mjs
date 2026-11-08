import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {cacheReleaseFiles, validateReleaseFiles} from './release-cache.mjs';

const record = bytes => ({sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes)});

test('an update keeps the same engine binaries and fetches only the changed release file', async () => {
  const stored = new Map(), requests = [];
  const cache = {match: async key => stored.get(key), put: async (key, value) => stored.set(key, value)};
  const versions = [
    {'xr_3da.wasm': 'engine bytes', 'compiler/tool.wasm': 'compiler bytes', 'main.js': 'version 1'},
    {'xr_3da.wasm': 'engine bytes', 'compiler/tool.wasm': 'compiler bytes', 'main.js': 'version 2'},
  ];
  for (const [i, files] of versions.entries()) {
    requests.length = 0;
    const base = new URL(`https://game.example/releases/${i}/`);
    const manifest = validateReleaseFiles(Object.fromEntries(Object.entries(files).map(([path, body]) => [path, record(body)])));
    let last;
    await cacheReleaseFiles(base, manifest, cache, (...progress) => last = progress, async url => {
      const name = url.pathname.slice(base.pathname.length);
      requests.push(name);
      return new Response(files[name]);
    });
    assert.deepEqual(requests.sort(), i === 0 ? Object.keys(files).sort() : ['main.js']);
    assert.deepEqual(last, [3, 3]);
  }
});

test('an invalid response is never installed, and encoded asset paths stay inside the release', async () => {
  const base = new URL('https://game.example/releases/one/');
  const files = validateReleaseFiles({'engine/room #1.json': record('expected')});
  const cache = {match: async () => undefined, put: async () => assert.fail('corrupt asset was stored')};
  await assert.rejects(cacheReleaseFiles(base, files, cache, () => {}, async url => {
    assert.equal(url.href, `${base.href}engine/room%20%231.json`);
    return new Response('bad data');
  }), /failed verification/);
  assert.throws(() => validateReleaseFiles({'../outside.js': record('x')}), /Invalid game release/);
});
