// One multiplayer-capable engine, with its bridge dormant in single player.
import {readFile,writeFile,mkdir,copyFile,cp,rm,symlink,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'../../..'),[engineArg,outputArg,packArg]=process.argv.slice(2);
if(!engineArg||!outputArg)throw Error('Usage: stage-game.mjs ENGINE_ARTIFACTS OUTPUT [PACK]');
const output=resolve(outputArg),web=join(output,'engine-preview');
execFileSync(process.execPath,[join(import.meta.dirname,'stage.mjs'),resolve(engineArg),output],{stdio:'inherit'});
// Use a separate override tree so native/old SP distributions remain intact.
if((await lstat(join(output,'engine'))).isSymbolicLink())await rm(join(output,'engine'));await cp(join(repo,'misc/web/dist/engine-assets'),join(output,'engine'),{recursive:true});
const scriptPath='gamedata/scripts/ui_main_menu.script';
const script=await readFile(join(repo,'res',scriptPath),'utf8')+'\n'+await readFile(join(import.meta.dirname,'browser-menu.script'),'utf8');
await mkdir(join(output,'engine/gamedata/scripts'),{recursive:true});await writeFile(join(output,'engine',scriptPath),script);
const manifest=JSON.parse(await readFile(join(web,'engine_data.json'),'utf8'));
manifest.files=manifest.files.filter(f=>f.path!==scriptPath);
manifest.files.push({path:scriptPath,size:Buffer.byteLength(script),sha256:createHash('sha256').update(script).digest('hex')});
await writeFile(join(web,'engine_data.json'),JSON.stringify(manifest));
for(const [source,target] of [['game.html','index.html'],['game-ui.mjs','game-ui.mjs'],['singleplayer-ui.mjs','singleplayer-ui.mjs'],['public-ui.mjs','public-ui.mjs']])await copyFile(join(repo,'server/web',source),join(web,target));
if(packArg){try{await symlink(resolve(packArg),join(output,'pack'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}}
console.log('Unified browser game:',web);
