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
  if (!root) throw Error("Select a game first.");
  let directory = await navigator.storage.getDirectory();
  for (const name of [root, "_appdata_", "savedgames"])
    directory = await directory.getDirectoryHandle(name, { create });
  return directory;
}

export async function prepareSaveBackup(directory) {
  const files = [];
  let totalBytes = 0;
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !/\.(scop|dds)$/i.test(name)) continue;
    const file = await handle.getFile();
    totalBytes += file.size;
    if (totalBytes > 96 * 1024 * 1024)
      throw Error("Save backup exceeds 96 MB of files. Export a smaller save collection.");
    files.push({ name, data: encodeBytes(new Uint8Array(await file.arrayBuffer())) });
  }
  if (!files.length) throw Error("There are no single-player saves to download yet.");

  const created = new Date().toISOString();
  const backup = validateBackup({ format: "openxray-saves-v1", created, files });
  return {
    filename: "openxray-saves-" + created.slice(0, 10) + ".json",
    blob: new Blob([JSON.stringify(backup)], { type: "application/json" }),
    count: files.length,
  };
}
