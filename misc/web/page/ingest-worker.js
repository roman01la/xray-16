import {migrateStockBindings} from './stock-bindings.mjs';

const CHUNK = 16 << 20;
const SKIP_DIRS = new Set([
  "bin",
  "directx",
  "helpers",
  "_appdata_",
  "appdata",
]);
const SKIP_EXT = /\.(exe|dll|pdb|txt|url|ini)$/i;

async function gameDir(root) {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(root, {
    create: true,
  });
}

async function ensureDir(base, parts) {
  let dir = base;
  for (const part of parts)
    dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function existingSize(dir, name) {
  try {
    const handle = await dir.getFileHandle(name);
    return (await handle.getFile()).size;
  } catch {
    return -1;
  }
}

async function writeBlob(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let offset = 0;
    while (offset < blob.size) {
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + CHUNK).arrayBuffer(),
      );
      access.write(bytes, { at: offset });
      offset += bytes.byteLength;
    }
    access.flush();
  } finally {
    access.close();
  }
}

async function collect(dirHandle, prefix, out) {
  for await (const [name, handle] of dirHandle.entries()) {
    const lower = name.toLowerCase();
    if (handle.kind === "directory") {
      if (!SKIP_DIRS.has(lower)) await collect(handle, [...prefix, lower], out);
    } else if (!SKIP_EXT.test(lower)) {
      out.push({ parts: prefix, name: lower, handle });
    }
  }
}

async function ingest(sourceDir, root) {
  const files = [];
  await collect(sourceDir, [], files);
  const game = await gameDir(root);
  let total = 0;
  const sized = [];
  for (const f of files) {
    const file = await f.handle.getFile();
    sized.push({ ...f, file });
    total += file.size;
  }
  // Check additional space, allowing an interrupted import to resume.
  let needed = 0;
  for (const f of sized) {
    const dir = await ensureDir(game, f.parts);
    needed += Math.max(
      0,
      f.file.size - Math.max(0, await existingSize(dir, f.name)),
    );
  }
  const { quota, usage } = await navigator.storage.estimate();
  if (quota && needed + 256 * 1024 * 1024 > quota - usage)
    throw new Error(
      "Not enough browser storage. Free space before importing this game.",
    );
  if (
    !sized.some((f) => f.parts[0] === "resources" && /\.db/i.test(f.name)) ||
    !sized.some((f) => f.parts[0] === "levels" && /\.db/i.test(f.name))
  )
    throw new Error(
      "Select the original Call of Pripyat installation folder containing resources and levels archives.",
    );
  let done = 0;
  for (const f of sized) {
    const dir = await ensureDir(game, f.parts);
    let equal = false;
    if ((await existingSize(dir, f.name)) === f.file.size) {
      // Compare chunks to avoid hashing multi-gigabyte archives in one allocation.
      const previous = await (await dir.getFileHandle(f.name)).getFile();
      equal = true;
      for (let at = 0; at < f.file.size; at += CHUNK) {
        if (
          (await sha256(previous.slice(at, at + CHUNK))) !==
          (await sha256(f.file.slice(at, at + CHUNK)))
        ) {
          equal = false;
          break;
        }
      }
    }
    if (!equal) await writeBlob(dir, f.name, f.file);
    done += f.file.size;
    postMessage({
      type: "progress",
      file: [...f.parts, f.name].join("/"),
      done,
      total,
    });
  }
  postMessage({type:'engine-progress',done:files.length,total:files.length});
  for (const sub of ["logs", "savedgames", "screenshots"])
    await ensureDir(game, ["_appdata_", sub]);
  await writeBlob(game, ".ingested", new Blob([new Date().toISOString()]));
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function removeRetired(game, retired) {
  for (const entry of retired) {
    const parts = entry.path.split("/");
    const name = parts.pop();
    let dir = game;
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
    } catch {
      continue;
    }
    const file = await dir.getFileHandle(name).then(
      (handle) => handle.getFile(),
      () => null,
    );
    if (
      file &&
      file.size === entry.size &&
      (await sha256(file)) === entry.sha256
    )
      await dir.removeEntry(name);
  }
}

// These are the complete text localizations in the hosted Call of Pripyat pack.
const gameLanguages = new Map([
  ["cs", "cze"], ["de", "ger"], ["en", "eng"], ["es", "spa"],
  ["fr", "fra"], ["it", "ita"], ["pl", "pol"], ["ru", "rus"], ["uk", "ukr"],
]);

function browserGameLanguage() {
  const preferences = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const locale of preferences) {
    const language = gameLanguages.get(locale?.split("-")[0].toLowerCase());
    if (language) return language;
  }
  return "eng";
}

async function seedUserConfig(app, useBrowserLanguage) {
  try {
    await app.getFileHandle("user.ltx");
    return;
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
  let settings = "_preset Default\n";
  if (useBrowserLanguage) {
    // A legacy or restored profile can have saves without its old user.ltx.
    const saves = await app.getDirectoryHandle("savedgames");
    let hasSave = false;
    for await (const [name, handle] of saves.entries()) {
      if (handle.kind === "file" && /\.scop$/i.test(name)) {
        hasSave = true;
        break;
      }
    }
    if (!hasSave) settings += `g_language ${browserGameLanguage()}\n`;
  }
  await writeBlob(app, "user.ltx", new Blob([settings]));
}

async function syncEngineData(root, appDirectory = '_appdata_', hosted = false) {
  const game = await gameDir(root);
  const manifest = await fetch("./engine_data.json");
  if (!manifest.ok)
    throw new Error("Cannot download engine manifest: HTTP " + manifest.status);
  const { files, retired } = await manifest.json();
  await removeRetired(game, retired);
  let checked=0;
  for (const entry of files) {
    postMessage({type:'engine-progress',done:checked++,total:files.length});
    const parts = entry.path.split("/");
    const name = parts.pop();
    const dir = await ensureDir(game, parts);
    if (entry.path === "fsgame.ltx" && (await existingSize(dir, name)) >= 0)
      continue;
    if (!entry.sha256)
      throw new Error("Engine manifest needs rebuilding with content hashes");
    if (
      (await existingSize(dir, name)) === entry.size &&
      (await sha256(await (await dir.getFileHandle(name)).getFile())) ===
        entry.sha256
    )
      continue;
    const response = await fetch("./engine/" + entry.path);
    if (!response.ok)
      throw new Error(
        "Cannot download " + entry.path + ": HTTP " + response.status,
      );
    const blob = await response.blob();
    if (blob.size !== entry.size || (await sha256(blob)) !== entry.sha256)
      throw new Error("Integrity check failed: " + entry.path);
    await writeBlob(dir, name, blob);
  }
  postMessage({type:'engine-progress',done:files.length,total:files.length});
  for (const sub of ["logs", "savedgames", "screenshots"])
    await ensureDir(game, ["_appdata_", sub]);
  const prepareConfig = async () => {
    const app = await ensureDir(game, appDirectory.split("/"));
    if (root === "stream-cop" || root.startsWith("zone-engine-preview-"))
      await seedUserConfig(app, hosted && root === "stream-cop" && appDirectory === "_appdata_");
    try {
      await migrateStockBindings(app);
    } catch (error) {
      console.warn("Could not restore alpha default keybinds. Will retry on the next launch.", error);
    }
  };
  if (navigator.locks)
    await navigator.locks.request(`xray-stock-keybinds:${root}:${appDirectory}`, prepareConfig);
  else await prepareConfig();
}

// WasmFS remembers POSIX timestamps only for the lifetime of its mount.
async function readSaveTimes(root) {
  const game = await gameDir(root);
  const app = await game.getDirectoryHandle("_appdata_");
  const saves = await app.getDirectoryHandle("savedgames");
  const entries = [];
  for await (const [name, handle] of saves.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".scop")) continue;
    try {
      const {lastModified} = await handle.getFile();
      entries.push(`${Math.floor(lastModified / 1000)}\t/opfs/${root}/_appdata_/savedgames/${name}\0`);
    } catch (error) {
      if (error.name !== "NotFoundError") console.warn("Could not read save timestamp", name, error);
    }
  }
  return new TextEncoder().encode(entries.join(""));
}

async function status() {
  const roots = [];
  for await (const [name, handle] of (
    await navigator.storage.getDirectory()
  ).entries())
    if (
      handle.kind === "directory" &&
      (await existingSize(handle, ".ingested")) >= 0
    )
      roots.push(name);
  return { roots: roots.sort() };
}

onmessage = async (e) => {
  const { id } = e.data;
  try {
    switch (e.data.type) {
      case "status":
        postMessage({ id, type: "status", ...(await status()) });
        break;
      case "ingest":
        await ingest(e.data.dir, e.data.root);
        postMessage({ id, type: "done" });
        break;
      case "sync-engine-data": {
        await syncEngineData(e.data.root, e.data.appDirectory, Boolean(e.data.pack));
        let streaming;
        if (e.data.pack) {
          const { installStreaming } = await import("./streaming.js");
          streaming = await installStreaming(e.data.pack, e.data.root, (detail) =>
            postMessage({ id, type: "stream-progress", detail }),
          );
        }
        const saveTimes = e.data.includeSaveTimes ? await readSaveTimes(e.data.root) : undefined;
        postMessage({ id, type: "done", streaming, saveTimes }, saveTimes ? [saveTimes.buffer] : []);
        break;
      }
    }
  } catch (err) {
    postMessage({ id, type: "error", error: err.message });
  }
};
