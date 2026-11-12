// Stage the SoC engine data without CoP's gameplay/menu patches.
import {readFile,writeFile,copyFile,cp,mkdir,symlink,readdir,rename} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readGameFiles} from '../../../server/tools/game-configs.mjs';
import {hideDesktopExitButton} from './stage-browser-menu.mjs';
import {patchSocAbort,patchSocBasicVideoScript,patchSocGameplayOptions,patchSocOptionsLayout,patchSocOptionsScript,patchSocTaskManager,patchSocVideoOptions} from './soc-compat.mjs';
const repo=resolve(import.meta.dirname,'../../..');
const [engineArg,outputArg,gameArg,packArg]=process.argv.slice(2);
if(!engineArg||!outputArg||!gameArg||!packArg)throw Error('Usage: stage-soc.mjs ENGINE_BIN OUTPUT NORMALIZED_GAME PACK');
const output=resolve(outputArg),raw=join(output,'raw'),engine=join(output,'engine'),web=join(output,'soc');
await mkdir(raw,{recursive:true});await mkdir(engine,{recursive:true});
await cp(join(repo,'misc/web/page'),raw,{recursive:true});
for(const name of ['xr_3da.js','xr_3da.wasm'])await copyFile(join(resolve(engineArg),name),join(raw,name));
await copyFile(join(repo,'misc/web/streaming/chunk-reader.mjs'),join(raw,'chunk-reader.mjs'));
const files=[];
async function asset(path,bytes){
  await mkdir(dirname(join(engine,path)),{recursive:true});await writeFile(join(engine,path),bytes);
  files.push({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
let config=await readFile(join(repo,'res/fsgame.ltx'),'utf8');
config=config.replace('configs\\','config\\');
await asset('fsgame.ltx',Buffer.from(config));
await asset('gamedata/config/openxray.ltx',Buffer.from('[compatibility]\ngame_mode = soc\ndefault_to_slot = true\nminus_one_slot_ordering = true\n[lua_scripting]\nallow_escape_sequences = false\n'));
async function shaders(dir,prefix){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(entry.isDirectory())await shaders(join(dir,entry.name),prefix+'/'+entry.name);
    else await asset(prefix+'/'+entry.name,await readFile(join(dir,entry.name)));
  }
}
await shaders(join(repo,'res/gamedata/shaders'),'gamedata/shaders');
const taskPath='scripts/task_manager.script',videoPath='scripts/ui_mm_opt_video_adv.script';
const globalsPath='scripts/_g.script';
const optionsPath='config/ui/ui_mm_opt.xml';
const optionsScript='scripts/ui_mm_opt_main.script';
const gameplayOptions='scripts/ui_mm_opt_gameplay.script';
const basicVideoScript='scripts/ui_mm_opt_video.script';
const menuPath='config/ui/ui_mm_main.xml';
const menuScript='scripts/ui_main_menu.script';
const source=await readGameFiles(resolve(gameArg),[taskPath,videoPath,globalsPath,optionsPath,optionsScript,gameplayOptions,basicVideoScript,menuPath,menuScript]);
await asset('gamedata/'+globalsPath,patchSocAbort(source.get(globalsPath).data));
await asset('gamedata/'+taskPath,patchSocTaskManager(source.get(taskPath).data));
await asset('gamedata/'+videoPath,patchSocVideoOptions(source.get(videoPath).data));
await asset('gamedata/'+optionsPath,patchSocOptionsLayout(source.get(optionsPath).data));
await asset('gamedata/'+gameplayOptions,patchSocGameplayOptions(source.get(gameplayOptions).data));
const gameSource=JSON.parse(await readFile(join(gameArg,'soc-source-manifest.json'),'utf8'));
const retailLabels={
  fra:['Langue','Limite FPS en jeu'],
  ita:['Lingua','Limite FPS in gioco'],
  spa:['Idioma','Límite de FPS en el juego'],
};
const knownLanguages=['cze','eng','ger','pol','rus','ukr',...Object.keys(retailLabels)];
const languages=knownLanguages.filter(language=>gameSource.sources.some(({name})=>
  name.startsWith(`config/text/${language}/`) && name.endsWith('.xml'))).sort();
for (const language of languages) {
  const path = `text/${language}/openxray.xml`;
  const captions = retailLabels[language];
  const sourceLanguage = captions ? 'eng' : language;
  const strings = await readFile(join(repo, 'res/gamedata/configs', `text/${sourceLanguage}/openxray.xml`), 'latin1');
  const entries = ['ui_mm_localization','ui_mm_fps_limit',...languages].map((id,i)=>{
    if(captions && i<captions.length)return `<string id="${id}"><text>${captions[i]}</text></string>`;
    const entry=strings.match(new RegExp(`<string id="${id}">[\\s\\S]*?<\\/string>`))?.[0];
    if(!entry)throw Error(`Missing SoC settings translation: ${language}/${id}`);
    return entry;
  });
  const declaration = strings.match(/^<\?xml[^\n]*\?>/)?.[0] ?? '';
  await asset('gamedata/config/'+path, Buffer.from(`${declaration}\n<string_table>\n${entries.join('\n')}\n</string_table>\n`, 'latin1'));
}
await asset('gamedata/'+optionsScript,patchSocOptionsScript(source.get(optionsScript).data));
await asset('gamedata/'+basicVideoScript,patchSocBasicVideoScript(source.get(basicVideoScript).data));
const menu=source.get(menuPath).data.toString('latin1');
const browserMenu=hideDesktopExitButton(menu);
if (browserMenu===menu) throw Error('No desktop exit button found in '+menuPath);
await asset('gamedata/'+menuPath,Buffer.from(browserMenu,'latin1'));
await asset('gamedata/'+menuScript,Buffer.concat([source.get(menuScript).data,Buffer.from('\n'),
  await readFile(join(import.meta.dirname,'browser-menu.script'))]));
const localization={languages,fallback:languages.includes('eng')?'eng':gameSource.language};
await writeFile(join(raw,'engine_data.json'),JSON.stringify({gameId:'soc',files,retired:[],localization}));
await writeFile(join(raw,'index.html'),(await readFile(join(raw,'index.html'),'utf8')).replace('<!doctype html>','<!doctype html>\n<html data-game="soc">'));
execFileSync(process.execPath,[join(repo,'misc/web/webgpu/stage.mjs')],{env:{...process.env,XRAY_WEB_DIST_INPUT:raw,XRAY_WEB_OUTPUT:web,XRAY_WEB_GAME_ID:'soc'},stdio:'inherit'});
await copyFile(join(repo,'src/xr_3da/stalker_soc.ico'),join(web,'favicon.ico'));
await rename(join(web,'index.html'),join(web,'developer.html'));
const webShell=join(repo,'server/web');
for(const name of ['compatibility.mjs','game-ui.mjs','singleplayer-ui.mjs','analytics-client.mjs','analytics-movement.mjs','crash-reporter.mjs','release-cache.mjs'])
  await copyFile(join(webShell,name),join(web,name));
await copyFile(join(webShell,'startup-wallpaper-soc.webp'),join(web,'startup-wallpaper.webp'));
const page=(await readFile(join(webShell,'game.html'),'utf8'))
  .replace('data-game="cop"','data-game="soc"')
  .replaceAll('Call of Pripyat','Shadow of Chernobyl')
  .replace('/app/41700/STALKER_Call_of_Pripyat/','/app/4500/');
await writeFile(join(web,'index.html'),page);
try{await symlink(resolve(packArg),join(output,'pack'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
console.log('Local SoC:',web,'?stream=/pack/pack.json');
