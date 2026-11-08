const hashPattern = /^[a-f0-9]{64}$/;
const cacheName = 'xray-release-files-v1';
const base = new URL('./', import.meta.url);
const contentTypes = {
  js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm',
  json: 'application/json', css: 'text/css', html: 'text/html',
};

function cacheKey(origin, sha256) {
  return `${origin}/.xray-cache/release-files/${sha256}`;
}

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

export async function cacheReleaseFiles(base, files, cache, report, fetcher = fetch) {
  const remaining = [...new Map([...files].map(entry => [entry[1].sha256, entry])).values()];
  const total = remaining.length;
  let completed = 0;
  report(0, total);
  async function install() {
    while (remaining.length) {
      const [path, {sha256, size}] = remaining.pop();
      const key = cacheKey(base.origin, sha256);
      if (!await cache.match(key)) {
        const url = new URL(path.split('/').map(encodeURIComponent).join('/'), base);
        const response = await fetcher(url);
        if (!response.ok) throw Error(`Could not download ${path} (HTTP ${response.status})`);
        const bytes = await response.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== size || actual !== sha256) throw Error(`Release file failed verification: ${path}`);
        await cache.put(key, new Response(bytes));
      }
      report(++completed, total);
    }
  }
  try {
    await Promise.all(Array.from({length: 6}, install));
  } catch (error) {
    remaining.length = 0;
    if (error.name === 'QuotaExceededError') throw Error('There is not enough browser storage for this game update. Free space and retry.');
    throw error;
  }
}

async function loadFiles() {
  const response = await fetch(new URL('release-files.json', base));
  if (!response.ok) throw Error('Could not read the game release');
  return validateReleaseFiles(await response.json());
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) {
  let manifest, preparation;
  const files = () => manifest ??= loadFiles().catch(error => { manifest = undefined; throw error; });
  const listeners = new Set();
  self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
  self.addEventListener('message', event => {
    if (event.data !== 'prepare-release' || !event.ports[0]) return;
    const port = event.ports[0];
    listeners.add(port);
    preparation ??= (async () => {
      const index = await files(), cache = await caches.open(cacheName);
      await cacheReleaseFiles(base, index, cache, (done, total) => {
        for (const listener of listeners) listener.postMessage({done, total});
      });
    })().finally(() => { preparation = undefined; });
    event.waitUntil(preparation.then(
      () => port.postMessage({ready: true}),
      error => port.postMessage({error: error.message}),
    ).finally(() => { listeners.delete(port); port.close(); }));
  });
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
    const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
    if (['', 'index.html', 'game-ui.mjs', 'release-cache.mjs', 'release-files.json'].includes(path)) return;
    event.respondWith((async () => {
      const file = (await files()).get(path);
      if (!file) return new Response('Unknown game release file', {status: 404});
      const cached = await (await caches.open(cacheName)).match(cacheKey(base.origin, file.sha256));
      if (!cached) return new Response('Game release data is missing. Reload to repair it.', {status: 503});
      return new Response(cached.body, {headers: {
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
  await new Promise((resolve, reject) => {
    const {port1, port2} = new MessageChannel();
    port1.onmessage = ({data}) => {
      if (data.ready || data.error) {
        port1.close();
        if (data.error) reject(Error(data.error)); else resolve();
      } else report(data.done, data.total);
    };
    workers.controller.postMessage('prepare-release', [port2]);
  });
}
