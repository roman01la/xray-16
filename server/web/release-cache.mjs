import {ARCHIVE_CHUNKS, LEGACY_CHUNKS, LEGACY_RELEASE, RELEASE_FILES, migrateLegacyCache, openInstallStore, sha256} from './opfs-store.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const base = new URL('./', import.meta.url);
const contentTypes = {
  js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm',
  json: 'application/json', css: 'text/css', html: 'text/html',
};

export function validateReleaseFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      Object.keys(files).length > 4096) throw Error('Invalid game release');
  for (const [path, file] of Object.entries(files)) {
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..') ||
        /[\\\u0000-\u001f]/.test(path) || !hashPattern.test(file?.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024)
      throw Error('Invalid game release file');
  }
  return new Map(Object.entries(files));
}

export async function cacheReleaseFiles(base, files, store, report, fetcher = fetch) {
  const remaining = [...new Map([...files].map(entry => [entry[1].sha256, entry])).values()];
  const total = remaining.length;
  let completed = 0;
  report(0, total);
  let failure;
  async function install() {
    while (!failure && remaining.length) {
      try {
        const [path, {sha256:hash, size}] = remaining.pop();
        const existing = await store.get(hash);
        if (existing?.size !== size) {
          const url = new URL(path.split('/').map(encodeURIComponent).join('/'), base);
          const response = await fetcher(url);
          if (!response.ok) throw Error(`Could not download ${path} (HTTP ${response.status})`);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== size || await sha256(bytes) !== hash)
            throw Error(`Release file failed verification: ${path}`);
          await store.put(hash, bytes);
        }
        report(++completed, total);
      } catch (error) {
        failure ||= error;
      }
    }
  }
  await Promise.all(Array.from({length: 6}, install));
  if (failure?.name === 'QuotaExceededError')
    throw Error('There is not enough browser storage for this game update. Close any older game tabs or free space, then retry.');
  if (failure) throw failure;
}

async function loadFiles() {
  const response = await fetch(new URL('release-files.json', base));
  if (!response.ok) throw Error('Could not read the game release');
  return validateReleaseFiles(await response.json());
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
  let manifest, preparation, releaseStore;
  const store = () => releaseStore ??= openInstallStore(RELEASE_FILES).catch(error => {
    releaseStore = undefined;
    throw error;
  });
  const files = () => manifest ??= loadFiles().catch(error => { manifest = undefined; throw error; });
  const listeners = new Set();
  self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('message', event => {
    if (event.data !== 'prepare-release' || !event.ports[0]) return;
    const port = event.ports[0];
    listeners.add(port);
    const report = (done, total, label) => {
      for (const listener of listeners) listener.postMessage({done, total, label});
    };
    preparation ??= navigator.locks.request('xray-opfs-release-install', async () => {
      const windows = await clients.matchAll({type:'window', includeUncontrolled:true});
      const retire = !windows.some(client => {
        const url = new URL(client.url);
        return url.origin === base.origin && !url.href.startsWith(base.href) &&
          (url.pathname.startsWith('/releases/') || url.pathname.startsWith('/engine-preview/'));
      });
      const cacheStorage = globalThis.caches;
      const validate = async (file, key) => await sha256(await file.arrayBuffer()) === key;
      const migrate = (name, store, path, label) => migrateLegacyCache({
        cacheStorage, name, store, retire, validate,
        identify:url => url.origin === base.origin ? url.pathname.match(path)?.[1] : null,
        report:(done,total) => report(done,total,label),
      });
      try {
        await migrate(LEGACY_RELEASE, await store(), /^\/\.xray-cache\/release-files\/([a-f0-9]{64})$/, 'Moving cached engine files to OPFS…');
        if (await cacheStorage?.has(LEGACY_CHUNKS)) {
          await navigator.locks.request('xray-game-pack-install', async () => {
            await migrate(LEGACY_CHUNKS, await openInstallStore(ARCHIVE_CHUNKS), /\/(?:chunks|game-chunks)\/([a-f0-9]{64})\.bin$/, 'Moving installed game data to OPFS…');
          });
        }
        await cacheReleaseFiles(base, await files(), await store(), (done,total) => report(done,total,'Checking game engine files…'));
        return retire;
      } catch (error) {
        if(error.name === 'QuotaExceededError')
          throw Error('There is not enough space to move the game to OPFS. Close older game tabs or free space, then retry.');
        throw error;
      }
    }).finally(() => { preparation = undefined; });
    event.waitUntil(preparation.then(
      retireLegacy => port.postMessage({ready:true, retireLegacy}),
      error => port.postMessage({error:error.message}),
    ).finally(() => { listeners.delete(port); port.close(); }));
  });
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
    const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
    if (['', 'index.html', 'game-ui.mjs', 'release-cache.mjs', 'opfs-store.mjs', 'release-files.json', 'favicon.ico'].includes(path)) return;
    event.respondWith((async () => {
      const file = (await files()).get(path);
      if (!file) return new Response('Unknown game release file', {status: 404});
      const cached = await (await store()).get(file.sha256);
      if (cached?.size !== file.size) return new Response('Game release data is missing. Reload to repair it.', {status: 503});
      return new Response(cached, {headers: {
        'Content-Type': contentTypes[path.split('.').at(-1)] ?? 'application/octet-stream',
        'Content-Length': String(file.size),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      }});
    })());
  });
}

export async function preparePublishedRelease(report) {
  const workers = navigator.serviceWorker;
  if (!workers) throw Error('This browser needs service workers enabled to store the game.');
  const scriptURL = new URL('release-cache.mjs', base).href;
  await workers.register(scriptURL, {type: 'module', scope: base.href});
  if (workers.controller?.scriptURL !== scriptURL) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Game storage worker did not start. Reload to retry.')); }, 15000);
      const cleanup = () => { clearTimeout(timer); workers.removeEventListener('controllerchange', ready); };
      const ready = () => { if (workers.controller?.scriptURL === scriptURL) { cleanup(); resolve(); } };
      workers.addEventListener('controllerchange', ready);
      ready();
    });
  }
  return new Promise((resolve, reject) => {
    const {port1, port2} = new MessageChannel();
    port1.onmessage = ({data}) => {
      if (data.ready || data.error) {
        port1.close();
        if (data.error) reject(Error(data.error)); else resolve(data.retireLegacy);
      } else report(data.done, data.total, data.label);
    };
    workers.controller.postMessage('prepare-release', [port2]);
  });
}
