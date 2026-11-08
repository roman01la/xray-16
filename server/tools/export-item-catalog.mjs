// Usage: node server/tools/export-item-catalog.mjs GAME_DIR OUTPUT_JSON [CONFIG_OVERLAY...]
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readGameConfigs,parseLtx} from './game-configs.mjs';
const [game,output,...overlays]=process.argv.slice(2);
if(!game||!output)throw Error('Usage: export-item-catalog.mjs GAME_DIR OUTPUT_JSON [CONFIG_OVERLAY...]');
if(resolve(output).startsWith(resolve(game)+'/'))throw Error('Export outside the game installation');
const files=await readGameConfigs(game,overlays),{sections,loaded}=parseLtx(files);
const catalog={schema:1,entry:'system.ltx',files:loaded.map(path=>({path,sha256:files.get(path).sha256})),sections:Object.fromEntries([...sections].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,section])=>[name,{source:section.source,values:Object.fromEntries(Object.entries(section.values).sort(([a],[b])=>a.localeCompare(b,'en')))}]))};
const bytes=JSON.stringify(catalog)+'\n';
await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,bytes);
const items=[...sections.values()].filter(s=>s.values.inv_weight!==undefined&&s.values.inv_name!==undefined);
console.log(JSON.stringify({output:resolve(output),sha256:createHash('sha256').update(bytes).digest('hex'),files:loaded.length,sections:sections.size,itemCandidates:items.length,bytes:Buffer.byteLength(bytes)},null,2));
