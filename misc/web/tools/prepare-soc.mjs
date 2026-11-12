// Normalize the inventoried trilogy extraction into explicit, unencrypted
// X-Ray archives for a LOCAL SoC compatibility probe. No original files change.
import {readFile,writeFile,mkdir,open,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {crc32} from 'node:zlib';

const [researchArg,outputArg,language='ukr',localeDir]=process.argv.slice(2);
if(!researchArg||!outputArg||!['eng','rus','ukr'].includes(language))
  throw Error('Usage: prepare-soc.mjs RESEARCH_DIR OUTPUT_DIR [eng|rus|ukr] [LOCALIZATION_TEXT_DIRECTORY]');
const research=resolve(researchArg),output=resolve(outputArg);
if(output===research||output.startsWith(join(research,'extracted')+'/'))throw Error('Output must not overwrite extraction');
// Explicit research baseline: base archives, optional Russian localization,
// ascending patches, then Ukrainian localization when requested. Do not include
// optional mods or Windows binaries. Version/campaign fidelity needs validation.
const suffixes=[...'012345678',...(language==='eng'?[]:['9']),...'abcd',...(language==='ukr'?['u']:[])];
const rank=new Map(suffixes.map((s,i)=>[`gamedata.db${s}.unpack`,i]));
const selected=new Map();
for(const archive of JSON.parse(await readFile(join(research,'inventory.json'),'utf8'))){
  for(const file of archive.files){
    const match=/^[^/]+\/stalker1\/(gamedata\.db[0-9a-z]\.unpack)\/(.+)$/.exec(file.path);
    if(!match||!rank.has(match[1]))continue;
    const name=match[2].toLowerCase();
    if(name.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f]/.test(name))throw Error('Unsafe asset path');
    if(/^levels\/(?:testers_|mp_)/.test(name))continue;
    const old=selected.get(name),priority=rank.get(match[1]);
    if(old&&old.priority===priority)throw Error('Duplicate asset in archive: '+name);
    if(!old||priority>old.priority)selected.set(name,{...file,priority});
  }
}
if(localeDir){
  const root=resolve(localeDir);
  for(const folder of await readdir(root,{withFileTypes:true})){
    const locale=folder.name==='esp'?'spa':folder.name;
    if(!folder.isDirectory()||!['cze','eng','fra','ger','ita','pol','spa'].includes(locale))continue;
    const directory=join(root,folder.name);
    const names=(await readdir(directory,{withFileTypes:true}))
      .filter(file=>file.isFile()&&/^[a-z0-9_.-]+\.xml$/.test(file.name)&&file.name!=='openxray.xml')
      .map(file=>file.name);
    for(const required of ['ui_st_mm.xml','stable_dialogs_escape.xml','stable_task_manager.xml'])
      if(!names.includes(required))throw Error(`Missing SoC text: ${locale}/${required}`);
    for(const file of names){
      const name=`config/text/${locale}/${file}`;
      if(selected.has(name))throw Error('Duplicate SoC localization file: '+name);
      const path=join(directory,file);
      // CoP and the shared font manager use spa. Retail Spanish uses esp.
      const raw=await readFile(path);
      const data=locale==='spa'?Buffer.from(raw.toString('latin1').replaceAll('text\\esp\\','text\\spa\\'),'latin1'):raw;
      selected.set(name,{path,bytes:data.length,data});
    }
  }
}
for(const name of ['config/system.ltx','config/game.ltx','game.graph','spawns/all.spawn','levels/l01_escape/level'])
  if(!selected.has(name))throw Error('Missing required SoC asset: '+name);
if (![...selected.keys()].some(name=>name.startsWith(`config/text/${language}/`)&&name.endsWith('.xml')))
  throw Error('Requested localization is absent from supplied assets: '+language);
const groups=new Map();
for(const [name,source] of [...selected].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const parts=name.split('/');
  const group=source.data?'localization/retail_text.db':parts[0]==='levels'?`levels/${parts[1]}.db`:
    `resources/${['config','scripts','shaders'].includes(parts[0])?'configs':
      ['textures','sounds','meshes','anims'].includes(parts[0])?parts[0]:'misc'}.db`;
  if(!groups.has(group))groups.set(group,[]);
  groups.get(group).push({name,source});
}
function chunk(id,bytes){const h=Buffer.alloc(8);h.writeUInt32LE(id);h.writeUInt32LE(bytes.length,4);return Buffer.concat([h,bytes]);}
function entry(name,size,crc,offset){
  const n=Buffer.from(name.replaceAll('/','\\'),'latin1'),b=Buffer.alloc(18+n.length);
  b.writeUInt16LE(16+n.length);b.writeUInt32LE(size,2);b.writeUInt32LE(size,6);b.writeUInt32LE(crc>>>0,10);n.copy(b,14);b.writeUInt32LE(offset,14+n.length);return b;
}
await mkdir(join(output,'patches'),{recursive:true});
const sources=[];
for(const [group,files] of [...groups].sort()){
  const path=join(output,group);await mkdir(dirname(path),{recursive:true});
  const header=chunk(666,Buffer.from('[header]\r\nauto_load = true\r\nentry_point = gamedata\r\n','latin1'));
  const size=files.reduce((n,f)=>n+f.source.bytes,0);
  if(size+header.length+8>=0xffffffff)throw Error('Archive too large: '+group);
  const dataHeader=Buffer.alloc(8);dataHeader.writeUInt32LE(size,4);
  const handle=await open(path,'wx');
  try{
    await handle.writeFile(header);await handle.writeFile(dataHeader);
    let offset=header.length+8;const table=[],folders=new Set();
    for(const {name,source} of files){
      const bytes=source.data??await readFile(join(research,'extracted',source.path));
      if(bytes.length!==source.bytes)throw Error('Extraction mismatch: '+source.path);
      const parts=name.split('/');for(let i=1;i<parts.length;i++)folders.add(parts.slice(0,i).join('/')+'/');
      table.push(entry(name,bytes.length,crc32(bytes),offset));
      await handle.writeFile(bytes);offset+=bytes.length;
      sources.push({name,source:source.data?name:source.path,bytes:source.bytes});
    }
    await handle.writeFile(chunk(1,Buffer.concat([...folders].sort().map(n=>entry(n,0,0,0)).concat(table))));
  }finally{await handle.close();}
  console.log(group,files.length,'files',size,'bytes');
}
await writeFile(join(output,'soc-source-manifest.json'),JSON.stringify({game:'soc',language,archiveOrder:suffixes,experimental:true,sources},null,2)+'\n');
