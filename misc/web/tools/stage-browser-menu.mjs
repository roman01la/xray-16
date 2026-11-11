import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,open,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readGameFiles} from '../../../server/tools/game-configs.mjs';
import {validateDescriptor} from '../streaming/chunk-reader.mjs';

const repo=resolve(import.meta.dirname,'../../..');
const menuLayouts=['configs/ui/ui_mm_main.xml','configs/ui/ui_mm_main_16.xml'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function hideNetworkMenuButtons(source) {
  return source.replace(/^[ \t]*<btn\b(?=[^>]*\bname\s*=\s*["'](?:btn_net_game|btn_multiplayer)["'])[^>]*\/>[ \t]*\r?\n/gm,'');
}

async function readPackedLayouts(pack) {
  const source=await mkdtemp(join(tmpdir(),'xray-menu-'));
  try {
    const manifest=JSON.parse(await readFile(join(pack,'pack.json'),'utf8'));
    const archives=manifest.files.filter(({path})=>
      path==='resources/configs.db'||/^patches\/[a-z0-9_-][a-z0-9_.-]*\.db[0-9]*$/.test(path));
    if(!archives.some(({path})=>path==='resources/configs.db'))throw Error('CoP pack is missing resources/configs.db');
    await Promise.all(['resources','patches'].map(group=>mkdir(join(source,group))));
    for(const {path,size} of archives) {
      const descriptor=validateDescriptor(JSON.parse(await readFile(join(pack,path+'.json'),'utf8')));
      if(descriptor.size!==size)throw Error('Menu source archive size differs from pack: '+path);
      const output=await open(join(source,path),'wx');
      try {
        let remaining=size;
        for(const hash of descriptor.chunks) {
          const data=await readFile(join(pack,'chunks',hash+'.bin'));
          if(data.length!==Math.min(remaining,descriptor.chunkBytes)||sha256(data)!==hash)
            throw Error('Invalid menu source archive chunk: '+path);
          await output.writeFile(data);
          remaining-=data.length;
        }
      } finally {await output.close();}
    }
    return await readGameFiles(source,menuLayouts);
  } finally {await rm(source,{recursive:true,force:true});}
}

export async function stageBrowserMenu(frontend,pack,gameDir=process.env.XRAY_COP_GAME_DIR) {
  const layouts=gameDir?await readGameFiles(gameDir,menuLayouts):await readPackedLayouts(pack);
  const scriptPath='gamedata/scripts/ui_main_menu.script';
  const script=Buffer.concat([
    await readFile(join(repo,'res',scriptPath)),
    Buffer.from('\n'),
    await readFile(join(import.meta.dirname,'browser-menu.script')),
  ]);
  const files=new Map([[scriptPath,script]]);
  for(const [path,{data}] of layouts) {
    const source=data.toString('latin1');
    const filtered=source.replace(/^[ \t]*<btn\b(?=[^>]*\bname\s*=\s*["']btn_quit["'])[^>]*\/>[ \t]*\r?\n/gm,'');
    if(source===filtered)throw Error('No desktop exit button found in '+path);
    files.set('gamedata/'+path,Buffer.from(hideNetworkMenuButtons(filtered),'latin1'));
  }
  const manifestPath=join(frontend,'engine_data.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.files=manifest.files.filter(({path})=>!files.has(path));
  for(const [path,bytes] of files) {
    const output=join(frontend,'engine',path);
    await mkdir(dirname(output),{recursive:true});
    await writeFile(output,bytes);
    manifest.files.push({path,size:bytes.length,sha256:sha256(bytes)});
  }
  await writeFile(manifestPath,JSON.stringify(manifest));
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [frontend,pack]=process.argv.slice(2);
  if(!frontend||(!pack&&!process.env.XRAY_COP_GAME_DIR))
    throw Error('Usage: stage-browser-menu.mjs FRONTEND PACK (or set XRAY_COP_GAME_DIR)');
  await stageBrowserMenu(frontend,pack);
}
