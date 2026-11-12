// Stage the single-player browser engine and immutable game-data descriptors.
import {copyFile,cp,mkdir,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {stageBrowserMenu} from './stage-browser-menu.mjs';
import {stageBrowserSounds} from './stage-browser-sounds.mjs';
const repo=resolve(import.meta.dirname,'../../..');
const [engineArg,outputArg,packArg]=process.argv.slice(2);
if(!engineArg||!outputArg||!packArg)throw Error('Usage: stage-game.mjs ENGINE_BIN OUTPUT PACK');
const output=resolve(outputArg),raw=join(output,'raw'),web=join(output,'engine-preview');
await mkdir(raw,{recursive:true});
await cp(join(repo,'misc/web/page'),raw,{recursive:true});
for(const name of ['xr_3da.js','xr_3da.wasm'])await copyFile(join(resolve(engineArg),name),join(raw,name));
await copyFile(join(repo,'misc/web/dist/engine_data.json'),join(raw,'engine_data.json'));
await copyFile(join(repo,'misc/web/streaming/chunk-reader.mjs'),join(raw,'chunk-reader.mjs'));
await cp(join(repo,'misc/web/dist/engine-assets'),join(output,'engine'),{recursive:true});
execFileSync(process.execPath,[join(repo,'misc/web/webgpu/stage.mjs')],{env:{...process.env,XRAY_WEB_DIST_INPUT:raw,XRAY_WEB_OUTPUT:web,XRAY_WEB_GAME_ID:'cop'},stdio:'inherit'});
await stageBrowserMenu(web,resolve(packArg));
await stageBrowserSounds(web,resolve(packArg));
await copyFile(join(repo,'src/xr_3da/stalker_cop.ico'),join(web,'favicon.ico'));
for(const name of ['compatibility.mjs','game-ui.mjs','singleplayer-ui.mjs','analytics-client.mjs','analytics-movement.mjs','crash-reporter.mjs','startup-wallpaper.webp','release-cache.mjs'])await copyFile(join(repo,'server/web',name),join(web,name));
await copyFile(join(repo,'server/web/game.html'),join(web,'index.html'));
try{await symlink(resolve(packArg),join(output,'pack'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
console.log('Single-player browser game:',web);
