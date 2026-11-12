import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { migrateStockBindings } from "../page/stock-bindings.mjs";
import {
  validateBackup,
  encodeBytes,
  decodeBytes,
} from "../page/save-format.js";
test("save backups preserve binary bytes and reject traversal, duplicates and invalid base64", () => {
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  assert.deepEqual(decodeBytes(encodeBytes(bytes)), bytes);
  const backup = {
    format: "openxray-saves-v1",
    files: [{ name: "test.scop", data: encodeBytes(bytes) }],
  };
  assert.equal(validateBackup(backup), backup);
  for (const name of ["../test.scop", "a/b.scop", "a\\b.scop", "test.txt"])
    assert.throws(() =>
      validateBackup({ ...backup, files: [{ name, data: "AAAA" }] }),
    );
  assert.throws(() =>
    validateBackup({ ...backup, files: [...backup.files, ...backup.files] }),
  );
  assert.throws(() =>
    validateBackup({ ...backup, files: [{ name: "test.scop", data: "bad!" }] }),
  );
});
test("engine sync replaces same-size stale files and refuses corrupt or failed downloads", async () => {
  const source = await readFile(
    new URL("../page/ingest-worker.js", import.meta.url),
    "utf8",
  );
  const digest = async (blob) =>
    Buffer.from(
      await webcrypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ).toString("hex");
  const expected = new Blob(["new!"]);
  for (const mode of ["valid", "corrupt", "http"]) {
    let content = new Blob(["old!"]),
      writes = 0,
      response;
    const handle = {
      getFile: async () => content,
      createSyncAccessHandle: async () => ({
        truncate() {
          writes++;
        },
        write(bytes) {
          content = new Blob([bytes]);
          return bytes.length;
        },
        flush() {},
        close() {},
      }),
    };
    const dir = {
      getDirectoryHandle: async () => dir,
      getFileHandle: async () => handle,
    };
    const context = vm.createContext({
      Blob,
      Uint8Array,
      crypto: webcrypto,
      migrateStockBindings,
      navigator: { storage: { getDirectory: async () => dir } },
      postMessage: (r) => (response = r),
      fetch: async (path) =>
        path.endsWith(".json")
          ? {
              ok: true,
              json: async () => ({
                retired: [],
                files: [
                  {
                    path: "shader.glsl",
                    size: 4,
                    sha256: await digest(expected),
                  },
                ],
              }),
            }
          : {
              ok: mode !== "http",
              status: 503,
              blob: async () =>
                mode === "corrupt" ? new Blob(["oops"]) : expected,
            },
    });
    // Supply the worker's module dependency alongside its browser globals.
    vm.runInContext(source.replace("import {migrateStockBindings} from './stock-bindings.mjs';", ""), context);
    await context.onmessage({
      data: { id: 1, type: "sync-engine-data", root: "cop" },
    });
    assert.equal(response.type, mode === "valid" ? "done" : "error");
    assert.equal(writes, mode === "valid" ? 1 : 0);
    assert.equal(await content.text(), mode === "valid" ? "new!" : "old!");
  }
});

test("campaign settings are seeded once in each game's own app-data directory", async () => {
  const source = await readFile(new URL("../page/ingest-worker.js", import.meta.url), "utf8");
  const files = new Map();
  const directory = (path) => ({
    async getDirectoryHandle(name) { return directory(`${path}/${name}`); },
    async *entries() {
      for (const key of files.keys()) {
        const name = key.slice(path.length + 1);
        if (key.startsWith(path + "/") && !name.includes("/"))
          yield [name, { kind: "file" }];
      }
    },
    async getFileHandle(name, { create = false } = {}) {
      const key = `${path}/${name}`;
      if (!files.has(key)) {
        if (!create) throw new DOMException("Missing file", "NotFoundError");
        files.set(key, "");
      }
      return {
        async getFile() { return new Blob([files.get(key)]); },
        async createSyncAccessHandle() {
          return {
            truncate() { files.set(key, ""); },
            write(bytes) { files.set(key, new TextDecoder().decode(bytes)); },
            flush() {},
            close() {},
          };
        },
      };
    },
  });
  const context = vm.createContext({
    Blob,
    Uint8Array,
    migrateStockBindings,
    navigator: {
      storage: { getDirectory: async () => directory("") },
      locks: { request: async (key, prepare) => prepare() },
    },
    fetch: async () => ({ ok: true, json: async () => ({ files: [], retired: [] }) }),
    postMessage: () => {},
  });
  vm.runInContext(source.replace("import {migrateStockBindings} from './stock-bindings.mjs';", ""), context);
  context.navigator.languages = ["ja-JP", "pl-PL", "en-US"];
  for (const root of ["stream-cop", "stream-soc"]) {
    const config = `/${root}/_appdata_/user.ltx`;
    await context.syncEngineData(root, undefined, true);
    assert.equal(files.get(config), root === "stream-cop" ? "_preset Default\ng_language pol\n" : "_preset Default\n");
    const custom = "_preset Low\r\nvid_mode 1280x720\r\nrs_fps_limit 100\r\nrs_v_sync off\r\ng_language ukr\r\n";
    files.set(config, custom);
    await context.syncEngineData(root, undefined, true);
    assert.equal(files.get(config), custom);
  }
  assert.equal(files.has("/zone-engine-preview-public/_appdata_/user.ltx"), false);

  const config = "/stream-cop/_appdata_/user.ltx";
  const save = "/stream-cop/_appdata_/savedgames/Quicksave.SCOP";
  files.delete(config);
  files.set(save, "legacy save");
  await context.syncEngineData("stream-cop", undefined, true);
  assert.equal(files.get(config), "_preset Default\n");
  assert.equal(files.get(save), "legacy save");

  files.delete(config);
  files.delete(save);
  context.navigator.languages = ["ja-JP", "zh-Hant"];
  await context.syncEngineData("stream-cop", undefined, true);
  assert.equal(files.get(config), "_preset Default\ng_language eng\n");

  context.navigator.languages = [];
  context.navigator.language = "uk-UA";
  await context.syncEngineData("stream-cop", undefined, true);
  assert.equal(files.get(config), "_preset Default\ng_language eng\n");

  files.delete(config);
  await context.syncEngineData("stream-cop", undefined, true);
  assert.equal(files.get(config), "_preset Default\ng_language ukr\n");
});
