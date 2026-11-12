// Local Clear Sky probe using the shared browser engine and renderer.
import {readFile, writeFile, copyFile, cp, mkdir, symlink, readlink, unlink, readdir, rename} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readGameFiles} from '../../../server/tools/game-configs.mjs';
import {hideDesktopExitButton, hideNetworkMenuButtons} from './stage-browser-menu.mjs';
import {patchCsBasicVideo, patchCsAdvancedVideo, patchCsOptionsScript,
  patchCsOptionsLayout, patchCsSoundOptions, patchCsGameplayOptions} from './cs-compat.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const [engineArg, outputArg, gameArg, packArg] = process.argv.slice(2);
if (!engineArg || !outputArg || !gameArg || !packArg)
  throw Error('Usage: stage-cs.mjs ENGINE_BIN OUTPUT NORMALIZED_GAME PACK');
const output = resolve(outputArg), raw = join(output, 'raw'), web = join(output, 'cs');
await mkdir(raw, {recursive:true});
await cp(join(repo, 'misc/web/page'), raw, {recursive:true});
for (const name of ['xr_3da.js', 'xr_3da.wasm'])
  await copyFile(join(resolve(engineArg), name), join(raw, name));
await copyFile(join(repo, 'misc/web/streaming/chunk-reader.mjs'), join(raw, 'chunk-reader.mjs'));
const files = [];
async function asset(path, bytes) {
  const destination = join(output, 'engine', path);
  await mkdir(dirname(destination), {recursive:true});
  await writeFile(destination, bytes);
  files.push({path, size:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')});
}
await asset('fsgame.ltx', await readFile(join(repo, 'res/fsgame.ltx')));
await asset('gamedata/configs/openxray.ltx', Buffer.from('[compatibility]\ngame_mode = cs\n'));
async function shaders(directory, prefix) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await shaders(path, prefix + '/' + entry.name);
    else await asset(prefix + '/' + entry.name, await readFile(path));
  }
}
await shaders(join(repo, 'res/gamedata/shaders'), 'gamedata/shaders');
const source = JSON.parse(await readFile(join(resolve(gameArg), 'cs-source-manifest.json'), 'utf8'));
const patches = new Map([
  ['scripts/ui_mm_opt_video.script', patchCsBasicVideo],
  ['scripts/ui_mm_opt_video_adv.script', patchCsAdvancedVideo],
  ['scripts/ui_mm_opt_main.script', patchCsOptionsScript],
  ['scripts/ui_mm_opt_sound.script', patchCsSoundOptions],
  ['scripts/ui_mm_opt_gameplay.script', patchCsGameplayOptions],
  ['configs/ui/ui_mm_opt.xml', patchCsOptionsLayout],
  ['configs/ui/ui_mm_opt_16.xml', patchCsOptionsLayout],
]);
const menus = ['configs/ui/ui_mm_main.xml', 'configs/ui/ui_mm_main_16.xml'];
const paths = [...patches.keys(), ...menus, 'scripts/ui_main_menu.script'];
const resources = await readGameFiles(resolve(gameArg), paths);
for (const [path, patch] of patches)
  await asset('gamedata/' + path, patch(resources.get(path).data));
for (const path of menus) {
  const menu = resources.get(path).data.toString('latin1');
  const browserMenu = hideDesktopExitButton(menu);
  if (browserMenu === menu) throw Error('Clear Sky desktop exit button was not found: ' + path);
  await asset('gamedata/' + path, Buffer.from(hideNetworkMenuButtons(browserMenu), 'latin1'));
}
await asset('gamedata/scripts/ui_main_menu.script', Buffer.concat([
  resources.get('scripts/ui_main_menu.script').data, Buffer.from('\n'),
  await readFile(join(import.meta.dirname, 'browser-menu.script')),
]));
for (const language of source.languages ?? [source.language]) {
  const strings = await readFile(join(repo, 'res/gamedata/configs/text', language, 'openxray.xml'), 'latin1');
  const labels = ['ui_mm_fps_limit', 'ui_mm_window_mode', 'st_opt_windowed', 'st_opt_fullscreen', 'ui_mm_localization', 'eng', 'ukr'].map(id => {
    const entry = strings.match(new RegExp(`<string id="${id}">[\\s\\S]*?<\\/string>`))?.[0];
    if (!entry) throw Error('Missing Clear Sky browser option label: ' + id);
    return entry;
  });
  const declaration = strings.match(/^<\?xml[^\n]*\?>/)?.[0] ?? '';
  await asset(`gamedata/configs/text/${language}/openxray.xml`,
    Buffer.from(`${declaration}\n<string_table>\n${labels.join('\n')}\n</string_table>\n`, 'latin1'));
}
const localization = {languages:source.languages ?? [source.language], fallback:source.language};
await writeFile(join(raw, 'engine_data.json'), JSON.stringify({gameId:'cs', files, retired:[], localization}));
const html = (await readFile(join(raw, 'index.html'), 'utf8'))
  .replace('<!doctype html>', '<!doctype html>\n<html data-game="cs">')
  .replace('<title>OpenXRay Web</title>', '<title>Clear Sky browser compatibility test</title>');
await writeFile(join(raw, 'index.html'), html);
execFileSync(process.execPath, [join(repo, 'misc/web/webgpu/stage.mjs')], {
  env:{...process.env, XRAY_WEB_DIST_INPUT:raw, XRAY_WEB_OUTPUT:web, XRAY_WEB_GAME_ID:'cs'},
  stdio:'inherit',
});
await copyFile(join(repo, 'src/xr_3da/stalker_cs.ico'), join(web, 'favicon.ico'));
await rename(join(web, 'index.html'), join(web, 'developer.html'));
const webShell = join(repo, 'server/web');
for (const name of ['compatibility.mjs', 'game-ui.mjs', 'singleplayer-ui.mjs', 'analytics-client.mjs',
  'analytics-movement.mjs', 'crash-reporter.mjs', 'release-cache.mjs'])
  await copyFile(join(webShell, name), join(web, name));
await copyFile(join(webShell, 'startup-wallpaper-cs.webp'), join(web, 'startup-wallpaper.webp'));
const page = (await readFile(join(webShell, 'game.html'), 'utf8'))
  .replace('data-game="cop"', 'data-game="cs"')
  .replaceAll('Call of Pripyat', 'Clear Sky')
  .replace('/app/41700/STALKER_Call_of_Pripyat/', '/app/20510/');
await writeFile(join(web, 'index.html'), page);
for (const [target, name] of [[join(output, 'engine'), 'engine'], [resolve(packArg), '../pack']]) {
  const path = join(web, name);
  try { await symlink(target, path, 'dir'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readlink(path);
    if (resolve(dirname(path), existing) !== target) {
      await unlink(path);
      await symlink(target, path, 'dir');
    }
  }
}
console.log('Local Clear Sky:', web, '?stream=/pack/pack.json&autostart=0');
