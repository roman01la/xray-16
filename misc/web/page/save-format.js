export function validateBackup(value) {
  if (
    value?.format !== "openxray-saves-v1" ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 500
  )
    throw Error("Not an OpenXRay save backup");
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (
      !file || typeof file.name !== "string" ||
      !/^[^\\/\x00-\x1f]{1,160}\.(scop|dds)$/i.test(file.name) ||
      names.has(file.name.toLowerCase())
    )
      throw Error("Invalid or duplicate save filename");
    if (
      typeof file.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      )
    )
      throw Error("Invalid save data");
    names.add(file.name.toLowerCase());
    total += file.data.length;
    if (total > 128 * 1024 * 1024) throw Error("Save backup exceeds 128 MB");
  }
  return value;
}
export function encodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export const decodeBytes = (data) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

export async function openSaveDirectory(root, create = false) {
  if (typeof root !== "string" || !root || root === "." || root === ".." || /[\\/\x00-\x1f]/.test(root)) throw Error("Select a game first.");
  let directory = await navigator.storage.getDirectory();
  for (const name of [root, "_appdata_", "savedgames"])
    directory = await directory.getDirectoryHandle(name, { create });
  return directory;
}

export async function prepareSaveBackup(directory, gameId = "cop") {
  const files = [];
  let totalBytes = 0;
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !/\.(scop|dds)$/i.test(name)) continue;
    const file = await handle.getFile();
    totalBytes += file.size;
    if (totalBytes > 96 * 1024 * 1024)
      throw Error("Save backup exceeds 96 MB of files. Export a smaller save collection.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    files.push({ name, data: encodeBytes(bytes), sha256: await saveDigest(bytes) });
  }
  if (!files.length) throw Error("There are no single-player saves to download yet.");

  const created = new Date().toISOString();
  const backup = validateBackup({ format: "openxray-saves-v1", gameId, created, files });
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
  if (blob.size > 128 * 1024 * 1024) throw Error("Save backup exceeds 128 MB including metadata. Export a smaller save collection.");
  return {
    filename: `openxray-${gameId}-saves-${created.slice(0, 10)}.json`,
    blob,
    count: files.length,
  };
}

async function saveDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

const IMPORT_JOURNAL = ".xray-save-import.json";
export const saveLockName = (root) => `xray-saved-games:${root}`;
const saveStem = (name) => name.replace(/\.(scop|dds)$/i, "").toLowerCase();

// Validate and decode the whole document before creating anything in OPFS.
export async function readSaveBackup(file, gameId = "cop") {
  if (!file || file.size > 128 * 1024 * 1024) throw Error("Backup exceeds 128 MB");
  const backup = validateBackup(JSON.parse(await file.text()));
  if ((backup.gameId ?? "cop") !== gameId) throw Error("This save backup belongs to another game.");
  const files = [];
  for (const { name, data, sha256 } of backup.files) {
    const bytes = decodeBytes(data);
    // Older exported backups have no digest and remain supported.
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
        await saveDigest(bytes) !== sha256)) throw Error(`Save checksum failed: ${name}`);
    files.push({ name, bytes });
  }
  if (!files.some(({ name }) => /\.scop$/i.test(name))) throw Error("Backup contains no saved games");
  for (const { name, bytes } of files) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (/\.scop$/i.test(name)) {
      // Match X-Ray's save header checks, and bound the decompression allocation.
      if (bytes.length < 13 || view.getUint32(0, true) !== 0xffffffff ||
          view.getUint32(4, true) < 7 || !view.getUint32(8, true) ||
          view.getUint32(8, true) > 256 * 1024 * 1024)
        throw Error(`Invalid saved game: ${name}`);
    } else if (bytes.length < 128 || view.getUint32(0, true) !== 0x20534444 ||
               view.getUint32(4, true) !== 124) {
      throw Error(`Invalid save thumbnail: ${name}`);
    }
  }
  return files;
}

async function writeFile(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}

// Only newly created names enter the journal. Existing saves are never replaced.
// A tab/browser interruption rolls the import back at the next game startup.
export async function recoverSaveImport(directory) {
  let handle;
  try { handle = await directory.getFileHandle(IMPORT_JOURNAL); }
  catch (error) { if (error.name === "NotFoundError") return; throw error; }
  const file = await handle.getFile();
  // Creating the journal handle precedes its atomic write. A crash there
  // leaves an empty journal but cannot have started writing any save files.
  if (!file.size) { await directory.removeEntry(IMPORT_JOURNAL); return; }
  if (file.size > 128 * 1024) throw Error("Invalid save import recovery record");
  const pending = JSON.parse(await file.text());
  validateBackup({ format: "openxray-saves-v1", files: pending.names?.map(name => ({ name, data: "" })) });
  if (pending.format !== "openxray-save-import-v1") throw Error("Invalid save import recovery record");
  for (const name of pending.names) {
    try { await directory.removeEntry(name); }
    catch (error) { if (error.name !== "NotFoundError") throw error; }
  }
  await directory.removeEntry(IMPORT_JOURNAL);
}

export async function restoreSaveBackup(directory, files) {
  await recoverSaveImport(directory);
  const existing = new Set();
  for await (const [name] of directory.entries()) existing.add(saveStem(name));
  const saves = new Set(files.filter(f => /\.scop$/i.test(f.name)).map(f => saveStem(f.name)));
  const planned = files.filter(f => saves.has(saveStem(f.name)) && !existing.has(saveStem(f.name)));
  const imported = new Set(planned.filter(f => /\.scop$/i.test(f.name)).map(f => saveStem(f.name))).size;
  if (!planned.length) return { imported: 0, skipped: saves.size };
  try {
    await writeFile(directory, IMPORT_JOURNAL, JSON.stringify({
      format: "openxray-save-import-v1", names: planned.map(f => f.name),
    }));
  } catch (error) {
    // No save files have been touched if journal creation itself fails.
    try { await directory.removeEntry(IMPORT_JOURNAL); } catch {}
    throw error;
  }
  try {
    for (const { name, bytes } of planned) await writeFile(directory, name, bytes);
    await directory.removeEntry(IMPORT_JOURNAL);
  } catch (error) {
    try { await recoverSaveImport(directory); }
    catch { throw Error("Import was interrupted. Keep this backup and reload before playing to finish recovery."); }
    throw error;
  }
  return { imported, skipped: saves.size - imported };
}

export async function importSaveBackup(root, file) {
  const files = await readSaveBackup(file, root === "stream-soc" ? "soc" : "cop");
  if (!navigator.locks) throw Error("Save import needs a browser with Web Locks support.");
  return navigator.locks.request(saveLockName(root), { ifAvailable: true }, async lock => {
    if (!lock) throw Error("Close other game tabs before importing saves.");
    return restoreSaveBackup(await openSaveDirectory(root, true), files);
  });
}

export async function acquireSaveSession(root) {
  if (!navigator.locks) return () => {};
  return new Promise((resolve, reject) => {
    navigator.locks.request(saveLockName(root), { ifAvailable: true }, async lock => {
      if (!lock) throw Error("This game's saves are open in another tab. Close it and retry.");
      await recoverSaveImport(await openSaveDirectory(root, true));
      await new Promise(release => resolve(release));
    }).catch(reject);
  });
}
