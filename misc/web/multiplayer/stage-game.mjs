// One multiplayer-capable engine, with its bridge dormant in single player.
import {copyFile,cp,rm,symlink,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {stageBrowserMenu} from './stage-browser-menu.mjs';
import {stageBrowserSounds} from './stage-browser-sounds.mjs';
const repo=resolve(import.meta.dirname,'../../..'),[engineArg,outputArg,packArg]=process.argv.slice(2);
if(!engineArg||!outputArg||(!packArg&&!process.env.XRAY_COP_GAME_DIR))
  throw Error('Usage: stage-game.mjs ENGINE_ARTIFACTS OUTPUT PACK (or set XRAY_COP_GAME_DIR)');
const output=resolve(outputArg),web=join(output,'engine-preview');
execFileSync(process.execPath,[join(import.meta.dirname,'stage.mjs'),resolve(engineArg),output],{stdio:'inherit'});
// Use a separate override tree so native/old SP distributions remain intact.
if((await lstat(join(output,'engine'))).isSymbolicLink())await rm(join(output,'engine'));await cp(join(repo,'misc/web/dist/engine-assets'),join(output,'engine'),{recursive:true});
await stageBrowserMenu(web,packArg);
if(packArg)await stageBrowserSounds(web,resolve(packArg));
for(const [source,target] of [['game.html','index.html'],['game-ui.mjs','game-ui.mjs'],['singleplayer-ui.mjs','singleplayer-ui.mjs'],['public-ui.mjs','public-ui.mjs']])await copyFile(join(repo,'server/web',source),join(web,target));
if(packArg){try{await symlink(resolve(packArg),join(output,'pack'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}}
console.log('Unified browser game:',web);
