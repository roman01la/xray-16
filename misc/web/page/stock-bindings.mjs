const migration = '.stock-keybinds-v1';

export function restoreAlphaQuickSlots(bytes) {
  // One decoded code unit per byte lets us replace only the ASCII key names.
  const text = new TextDecoder('windows-1252').decode(bytes);
  if (!/^[ \t]*default_controls[ \t]*\r?$/im.test(text) ||
      /^[ \t]*(?:bind|bind_sec|bind_console)[ \t]+[^;\r\n]*[ \t]kf[13](?=[ \t;\r]|$)/im.test(text) ||
      /^[ \t]*unbind[ \t]+quick_use_[13](?=[ \t;\r]|$)/im.test(text)) return null;

  const bindings = [...text.matchAll(/^[ \t]*bind[ \t]+quick_use_([13])[ \t]+(\w+)(?=[ \t]*(?:;|\r?$))/dgim)];
  if (bindings.length !== 2 || !bindings.some(([,slot,key]) => slot === '1' && key.toLowerCase() === 'klbracket') ||
      !bindings.some(([,slot,key]) => slot === '3' && key.toLowerCase() === 'krbracket')) return null;

  const parts = [];
  let offset = 0;
  for (const binding of bindings) {
    const [start, end] = binding.indices[2];
    parts.push(bytes.subarray(offset, start), `kF${binding[1]}`);
    offset = end;
  }
  return new Blob([...parts, bytes.subarray(offset)]);
}

async function openOptional(app, name) {
  try { return await app.getFileHandle(name); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

export async function migrateStockBindings(app) {
  if (await openOptional(app, migration)) return;
  const config = await openOptional(app, 'user.ltx');
  if (config) {
    const file = await config.getFile();
    const restored = file.size <= 128 * 1024 && restoreAlphaQuickSlots(new Uint8Array(await file.arrayBuffer()));
    if (restored) {
      const writer = await config.createWritable();
      try { await writer.write(restored); await writer.close(); }
      catch (error) { await writer.abort().catch(() => {}); throw error; }
    }
  }
  await app.getFileHandle(migration, {create: true});
}
