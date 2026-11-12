import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {cacheReleaseFiles, validateReleaseFiles} from './release-cache.mjs';
import {migrateLegacyCache, sha256} from './opfs-store.mjs';

const record = bytes => ({sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes)});

test('every published bootstrap dependency bypasses the installed-game service worker', () => {
  const handlers = new Map();
  class ServiceWorkerGlobalScope { static [Symbol.hasInstance]() { return true; } }
  const self = new ServiceWorkerGlobalScope();
  self.addEventListener = (type, handler) => handlers.set(type,handler);
  const source = readFileSync(new URL('./release-cache.mjs',import.meta.url),'utf8')
    .replace(/^import .*;$/m,'').replaceAll('export ','')
    .replaceAll('import.meta.url',JSON.stringify('https://game.example/releases/version/release-cache.mjs'));
  vm.runInNewContext(source,{URL,ServiceWorkerGlobalScope,self});
  const publisher = readFileSync(new URL('../tools/publish-web.py',import.meta.url),'utf8');
  const names = [...publisher.match(/bootstrap=\{([^}]+)\}/)[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
  assert.ok(names.includes('game-ui.mjs'));
  assert.ok(names.includes('release-cache.mjs'));
  for (const name of names) handlers.get('fetch')({
    request:{method:'GET',url:'https://game.example/releases/version/'+name},
    respondWith:()=>assert.fail('Bootstrap dependency was intercepted: '+name),
  });
});

test('an update keeps the same engine binaries and fetches only the changed release file', async () => {
  const stored = new Map(), requests = [];
  const cache = {get: async key => stored.get(key), put: async (key, value) => stored.set(key, new Blob([value]))};
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
  const cache = {get: async () => undefined, put: async () => assert.fail('corrupt asset was stored')};
  await assert.rejects(cacheReleaseFiles(base, files, cache, () => {}, async url => {
    assert.equal(url.href, `${base.href}engine/room%20%231.json`);
    return new Response('bad data');
  }), /failed verification/);
  assert.throws(() => validateReleaseFiles({'../outside.js': record('x')}), /Invalid game release/);
});


test('migration verifies data before retiring legacy keys and safely resumes after failure', async () => {
  const name='previous-install', valid=record('asset').sha256;
  const url=`https://game.example/packs/old/chunks/${valid}.bin`;
  const legacy=new Map([[url,new Blob(['asset'])]]);
  const opfs=new Map();
  let fail=true, retired=false;
  const cacheStorage={has:async()=>!retired,delete:async()=>{retired=true;},open:async()=>({
    keys:async()=>[...legacy.keys()].map(url=>({url})),
    match:async ({url})=>new Response(legacy.get(url)),
    delete:async ({url})=>legacy.delete(url),
  })};
  const options={cacheStorage,name,retire:true,store:{
    get:async key=>opfs.get(key),
    put:async (key,file)=>{if(fail)throw Error('disk full');opfs.set(key,file);},
  },identify:url=>url.pathname.match(/\/([a-f0-9]{64})\.bin$/)?.[1],
  validate:async (file,key)=>await sha256(await file.arrayBuffer())===key};
  await assert.rejects(migrateLegacyCache(options),/disk full/);
  assert.ok(legacy.has(url));
  assert.equal(retired,false);
  fail=false;
  await migrateLegacyCache({...options,retire:false});
  assert.equal(await opfs.get(valid).text(),'asset');
  assert.ok(legacy.has(url),'an older open tab can still read legacy data');
  await migrateLegacyCache(options);
  assert.equal(legacy.size,0);
  assert.equal(retired,true);
});
