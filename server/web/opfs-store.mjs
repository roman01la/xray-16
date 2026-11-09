export const INSTALL_DIRECTORY = 'xray-install-v1';
export const ARCHIVE_CHUNKS = 'game-chunks';
export const ARCHIVE_DESCRIPTORS = 'game-archives';
export const RELEASE_FILES = 'release-files';
export const LEGACY_CHUNKS = 'xray-game-chunks-v1';
export const LEGACY_DESCRIPTORS = 'xray-game-archives-v1';
export const LEGACY_RELEASE = 'xray-release-files-v1';

const missing = error => {
  if (error.name !== 'NotFoundError') throw error;
  return null;
};

export async function openInstallStore(name, storage = navigator.storage, rootName = INSTALL_DIRECTORY) {
  const root = await (await storage.getDirectory()).getDirectoryHandle(rootName, {create:true});
  const directory = await root.getDirectoryHandle(name, {create:true});
  const handle = key => directory.getFileHandle(key).catch(missing);
  return {
    handle,
    async get(key) {
      const file = await handle(key);
      return file && file.getFile().catch(missing);
    },
    async put(key, bytes) {
      const file = await directory.getFileHandle(key, {create:true});
      // Closing commits the staged write. Readers of immutable keys can keep
      // using the old file if a repair is interrupted.
      const writer = await file.createWritable();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    },
  };
}

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// CacheStorage is used only to import data from the previous installer. Move
// each entry after committing its replacement, so migration can resume and
// needs room for only a few chunks when no older release is open.
export async function migrateLegacyCache({cacheStorage, name, store, identify, validate, retire, report = () => {}}) {
  if (!await cacheStorage?.has(name)) return;
  const cache = await cacheStorage.open(name);
  const keys = await cache.keys();
  const byFile = new Map();
  for (const request of keys) {
    const key = identify(new URL(request.url));
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(request);
  }
  const remaining = byFile.entries();
  let completed = 0, failure;
  report(0, keys.length);
  await Promise.all(Array.from({length:4}, async () => {
    while (!failure) {
      const {done, value} = remaining.next();
      if (done) return;
      try {
        const [key, aliases] = value;
        if (key) {
          const current = await store.get(key);
          if (!current || !await validate(current, key)) {
            for (const request of aliases) {
              const bytes = await (await cache.match(request))?.blob();
              if (bytes && await validate(bytes, key)) {
                await store.put(key, bytes);
                break;
              }
            }
          }
        }
        if (retire) for (const request of aliases) await cache.delete(request);
        completed += aliases.length;
        report(completed, keys.length);
      } catch (error) {
        failure ||= error;
      }
    }
  }));
  if (failure) throw failure;
  if (retire) await cacheStorage.delete(name);
}
