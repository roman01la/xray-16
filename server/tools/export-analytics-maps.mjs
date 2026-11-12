// Export original map artwork and world bounds for the analytics dashboard.
import {readGameFiles} from './game-configs.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const [game,source,output] = process.argv.slice(2);
if (!['cop','soc'].includes(game) || !source || !output)
  throw Error('Usage: export-analytics-maps.mjs cop|soc GAME_DATA OUTPUT');

function sections(bytes) {
  const result = new Map();
  let section;
  for (const raw of bytes.toString('latin1').split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    const heading = /^\[([^\]]+)\]/.exec(line);
    if (heading) { section = {}; result.set(heading[1].toLowerCase(),section); }
    else if (section && line && !line.startsWith('#')) {
      const [key,...value] = line.split('=');
      section[key.trim().toLowerCase()] = value.join('=').trim();
    }
  }
  return result;
}

const configName = game === 'soc' ? 'config/game_maps_single.ltx' : 'configs/game_maps_single.ltx';
const config = sections((await readGameFiles(resolve(source),[configName])).get(configName).data);
const names = Object.keys(config.get('level_maps_single'));
const levelPaths = names.map(name => `levels/${name}/level.ltx`);
const levels = await readGameFiles(resolve(source),levelPaths,{includeLevels:true});
const maps = {};
for (const name of names) {
  const level = sections(levels.get(`levels/${name}/level.ltx`).data).get('level_map');
  const campaign = config.get(name);
  const metadata = level?.bound_rect ? {...level,...campaign} : campaign;
  if (!metadata?.bound_rect || !metadata.texture) {
    maps[name] = {bounds:null,image:null};
    continue;
  }
  const bounds = metadata.bound_rect.split(',').map(Number);
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2]<=bounds[0] || bounds[3]<=bounds[1])
    throw Error('Invalid world bounds for '+name);
  maps[name] = {bounds,texture:'textures/'+metadata.texture.replaceAll('\\','/').toLowerCase()+'.dds',image:name+'.webp'};
}
const images = await readGameFiles(resolve(source),Object.values(maps).filter(map=>map.texture).map(map => map.texture),{includeLevels:true});
const scratch = await mkdtemp(join(tmpdir(),'xray-analytics-maps-'));
try {
  await mkdir(output,{recursive:true});
  for (const [name,map] of Object.entries(maps)) {
    if (!map.texture) continue;
    const file = join(scratch,name+'.dds');
    await writeFile(file,images.get(map.texture).data);
    execFileSync('magick',[file,'-resize','1536x1536>','-quality','85',join(output,map.image)]);
    delete map.texture;
  }
  await writeFile(join(output,'maps.json'),JSON.stringify(maps));
  console.log('Exported',names.length,game,'maps');
} finally { await rm(scratch,{recursive:true,force:true}); }
