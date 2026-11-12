// Build unencrypted archives from the inventoried Trilogy extraction for local testing.
import {readFile, writeFile, mkdir, open} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {crc32} from 'node:zlib';

const [researchArg, outputArg, language = 'eng'] = process.argv.slice(2);
if (!researchArg || !outputArg || !['eng', 'rus', 'ukr'].includes(language))
  throw Error('Usage: prepare-cs.mjs RESEARCH_DIR OUTPUT_DIR [eng|rus|ukr]');
const research = resolve(researchArg), output = resolve(outputArg);
if (output === research || output.startsWith(join(research, 'extracted') + '/'))
  throw Error('Output must not overwrite extraction');

const localization = {eng:'xenglish', rus:'xrussian', ukr:'xukrainian'};
const languages = ['eng', 'ukr'];
if (!languages.includes(language)) languages.push(language);
const selected = new Map();
for (const archive of JSON.parse(await readFile(join(research, 'inventory.json'), 'utf8'))) {
  for (const file of archive.files) {
    const match = /^[^/]+\/stalker2\/(resources|levels|Localization|patches)\/([^/]+)\.db[0-9]*\.unpack\/(.+)$/.exec(file.path);
    if (!match) continue;
    const [, group, source, relative] = match;
    let name = relative.toLowerCase();
    if (group === 'Localization') {
      const locale = Object.keys(localization).find(key => localization[key] === source);
      if (!languages.includes(locale)) continue;
      if (name.startsWith('sounds/')) {
        if (locale !== 'ukr') continue;
      }
      else if (!name.startsWith('configs/text/') && locale !== language) continue;
    }
    if (name.startsWith('configs/text/') && !languages.includes(name.split('/')[2])) continue;
    if (name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(name))
      throw Error('Unsafe asset path: ' + file.path);
    const priority = group === 'patches' ? ({xpatch_08:8, xpatch_10:10})[source] : group === 'Localization' ? 20 : 0;
    if (priority === undefined) throw Error('Unknown patch archive: ' + source);
    const old = selected.get(name);
    if (old && old.priority === priority) throw Error('Duplicate asset: ' + name);
    if (!old || priority > old.priority) selected.set(name, {...file, priority});
  }
}
// Clear Sky embeds the game graph in all.spawn.
for (const name of ['configs/system.ltx', 'configs/game.ltx', 'spawns/all.spawn', 'levels/marsh/level'])
  if (!selected.has(name)) throw Error('Missing required Clear Sky asset: ' + name);
if (![...selected.keys()].some(name => name.startsWith(`configs/text/${language}/`)))
  throw Error('Missing requested language: ' + language);

const groups = new Map();
for (const [name, source] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
  const parts = name.split('/');
  const category = ['configs', 'scripts', 'shaders'].includes(parts[0]) ? 'configs' :
    ['textures', 'sounds', 'meshes', 'anims'].includes(parts[0]) ? parts[0] : 'misc';
  const group = parts[0] === 'levels' ? `levels/${parts[1]}.db` : `resources/${category}.db`;
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push({name, source});
}
function chunk(id, bytes) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(id);
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
function entry(name, size, crc, offset) {
  const encoded = Buffer.from(name.replaceAll('/', '\\'), 'latin1');
  const record = Buffer.alloc(18 + encoded.length);
  record.writeUInt16LE(16 + encoded.length);
  record.writeUInt32LE(size, 2);
  record.writeUInt32LE(size, 6);
  record.writeUInt32LE(crc >>> 0, 10);
  encoded.copy(record, 14);
  record.writeUInt32LE(offset, 14 + encoded.length);
  return record;
}
const sources = [];
await mkdir(join(output, 'patches'), {recursive:true});
for (const [group, files] of [...groups].sort()) {
  const path = join(output, group);
  await mkdir(dirname(path), {recursive:true});
  const header = chunk(666, Buffer.from('[header]\r\nauto_load = true\r\nentry_point = gamedata\r\n'));
  const size = files.reduce((total, file) => total + file.source.bytes, 0);
  if (size + header.length + 8 >= 0xffffffff) throw Error('Archive too large: ' + group);
  const dataHeader = Buffer.alloc(8);
  dataHeader.writeUInt32LE(size, 4);
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(header);
    await handle.writeFile(dataHeader);
    let offset = header.length + 8;
    const table = [], folders = new Set();
    for (const {name, source} of files) {
      const bytes = await readFile(join(research, 'extracted', source.path));
      if (bytes.length !== source.bytes) throw Error('Extraction size mismatch: ' + source.path);
      const parts = name.split('/');
      for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join('/') + '/');
      table.push(entry(name, bytes.length, crc32(bytes), offset));
      await handle.writeFile(bytes);
      offset += bytes.length;
      sources.push({name, source:source.path, bytes:source.bytes});
    }
    await handle.writeFile(chunk(1, Buffer.concat([...folders].sort().map(name => entry(name, 0, 0, 0)).concat(table))));
  } finally {
    await handle.close();
  }
  console.log(group, files.length, 'files', size, 'bytes');
}
await writeFile(join(output, 'cs-source-manifest.json'), JSON.stringify({game:'cs', language, languages, voiceLanguage:'ukr', experimental:true, sources}, null, 2) + '\n');
