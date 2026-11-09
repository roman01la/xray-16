// Host-side export of timing metadata from an owned Call of Pripyat installation.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configPath,readGameFiles} from './game-configs.mjs';

const motionChunk=14, parameterChunk=15, referencesChunk=19, references2Chunk=24;
const reloadAlias=/^(?:anm|anim)_(?:reload(?:_|$)|open(?:_|$)|close(?:_|$)|add_cartridge(?:_|$))/;
const f32=Math.fround;
const quantizer=f32(655.35);
const samplePeriod=f32(1/30);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function chunks(bytes) {
 const result=new Map();
 for(let start=0;start<bytes.length;) {
  if(start+8>bytes.length)throw Error('Truncated OGF chunk header');
  const id=bytes.readUInt32LE(start),size=bytes.readUInt32LE(start+4);
  const end=start+8+size;
  if(end>bytes.length||result.has(id))throw Error('Invalid OGF chunk');
  result.set(id,bytes.subarray(start+8,end));
  start=end;
 }
 return result;
}

function reader(bytes) {
 let position=0;
 const take=size=>{
  const start=position;position+=size;
  if(position>bytes.length)throw Error('Truncated motion metadata');
  return start;
 };
 const string=terminated=>{
  const start=position;
  while(position<bytes.length&&!terminated(bytes[position]))position++;
  const end=position;
  take(1);
  return bytes.toString('latin1',start,end);
 };
 return {
  u16:()=>bytes.readUInt16LE(take(2)),
  u32:()=>bytes.readUInt32LE(take(4)),
  float:()=>bytes.readFloatLE(take(4)),
  zstr:()=>string(byte=>byte===0),
  skip:take,
  skipLine(){
   string(byte=>byte===13||byte===10);
   while(bytes[position]===13||bytes[position]===10)take(1);
  },
  done:()=>position===bytes.length,
 };
}

function meshPath(value,extension) {
 const name=configPath(value.replace(/^"|"$/g,''));
 return 'meshes/'+(name.endsWith(extension)?name:name+extension);
}

function motionSources(path,model) {
 const refs=model.get(references2Chunk);
 if(refs) {
  const read=reader(refs),count=read.u32();
  if(count>256)throw Error('Too many motion references in '+path);
  const paths=Array.from({length:count},()=>meshPath(read.zstr(),'.omf'));
  if(!read.done())throw Error('Trailing motion references in '+path);
  return paths;
 }
 const legacy=model.get(referencesChunk);
 if(legacy)return reader(legacy).zstr().split(',').map(name=>meshPath(name.trim(),'.omf'));
 return [path];
}

function readMotionCycles(model) {
 const parameterBytes=model.get(parameterChunk),motionBytes=model.get(motionChunk);
 if(!parameterBytes||!motionBytes)throw Error('Missing OGF motion definitions');
 const params=reader(parameterBytes),version=params.u16(),partitions=params.u16();
 if(version>4||partitions>64)throw Error('Unsupported motion metadata version or partitions');
 for(let part=0;part<partitions;part++) {
  params.zstr();
  const bones=params.u16();
  for(let i=0;i<bones;i++){params.zstr();params.skip(4);}
 }
 const count=params.u16(),motions=chunks(motionBytes);
 if(count>=0x3fff||!motions.has(0)||reader(motions.get(0)).u32()!==count)throw Error('Motion count mismatch');
 const cycles=new Map();
 for(let i=0;i<count;i++) {
  const name=params.zstr().toLowerCase(),flags=params.u32();
  params.skip(4); // bone or partition and motion index
  const rawSpeed=params.float();
  if(!Number.isFinite(rawSpeed))throw Error('Invalid motion speed for '+name);
  const quantized=Math.max(0,Math.min(65535,Math.floor(f32(rawSpeed*quantizer))));
  params.skip(12); // power, accrue and falloff
  if(version===4) {
   const marks=params.u32();
   if(marks>1024)throw Error('Too many marks in '+name);
   for(let mark=0;mark<marks;mark++){params.skipLine();params.skip(params.u32()*8);}
  }
  if(!motions.has(i+1))throw Error('Missing motion samples for '+name);
  const sample=reader(motions.get(i+1));
  if(sample.zstr().toLowerCase()!==name)throw Error('Motion sample name mismatch for '+name);
  const frames=sample.u32();
  if(!(flags&1)&&!cycles.has(name))cycles.set(name,{frames,speed:f32(quantized/quantizer),stopAtEnd:!!(flags&2)});
 }
 if(!params.done())throw Error('Trailing motion parameters');
 return cycles;
}

function timingForAlias(value,cycles) {
 const [base,,speedText]=value.split(',');
 const aliasSpeed=f32(speedText?Number(speedText):1);
 if(!base||!(aliasSpeed>0)||!Number.isFinite(aliasSpeed))throw Error('Invalid HUD alias '+value);
 const clips={};
 for(let variant=0;variant<=8;variant++) {
  const name=variant?base+variant:base,cycle=cycles.get(name);
  if(!cycle)continue;
  const speed=f32(cycle.speed*aliasSpeed);
  if(!cycle.stopAtEnd||!cycle.frames||!(speed>0))throw Error('Reload motion does not finish: '+name);
  const duration=Math.floor(f32(0.5+f32(f32(1000*f32(cycle.frames*samplePeriod))/speed)));
  if(duration<1||duration>30000)throw Error('Reload motion duration out of range: '+name);
  clips[name]=duration;
 }
 if(!Object.keys(clips).length)throw Error('HUD alias has no motion cycle: '+base);
 return {durationMs:Math.max(...Object.values(clips)),clips};
}

async function exportReloadTimings(game,catalogBytes) {
 const {schema,sections}=JSON.parse(catalogBytes);
 if(schema!==1||!sections?.actor_hud?.values?.visual)throw Error('Expected a Call of Pripyat item catalog');
 const weapons={},huds=new Map(),actors=new Map();
 for(const [name,{values}] of Object.entries(sections)) {
  if(values.player_hud_section) {
   const section=values.player_hud_section,visual=sections[section]?.values?.visual;
   if(!visual)throw Error('Missing hands visual for '+section);
   actors.set(section,meshPath(visual,'.ogf'));
  }
  if(name.startsWith('mp_')||!values.inv_weight||!values.inv_name||!values.ammo_class||!values.hud
    ||values.class==='WP_KNIFE'||values.class==='WP_BINOC')continue;
  const hud=sections[values.hud]?.values;
  if(!hud?.item_visual&&!hud?.visual)throw Error('Missing weapon HUD for '+name);
  const aliases=Object.entries(hud).filter(([key])=>reloadAlias.test(key));
  if(!aliases.length)throw Error('Weapon has no reload HUD aliases: '+name);
  const model=hud.item_visual?null:meshPath(hud.visual,'.ogf');
  weapons[name]=values.hud;
  huds.set(values.hud,{aliases,model});
 }
 actors.set('actor_hud',meshPath(sections.actor_hud.values.visual,'.ogf'));
 const models=await readGameFiles(game,[...actors.values(),...[...huds.values()].flatMap(hud=>hud.model?[hud.model]:[])]);
 const modelChunks=new Map([...models].map(([path,file])=>[path,chunks(file.data)]));
 const refs=new Map([...modelChunks].map(([path,model])=>[path,motionSources(path,model)]));
 const referenced=[...new Set([...refs.values()].flat())].filter(path=>!models.has(path));
 const omfs=referenced.length?await readGameFiles(game,referenced):new Map();
 const allFiles=new Map([...models,...omfs]),cyclesBySource=new Map(),cyclesByModel=new Map();
 for(const [path,paths] of refs) {
  const cycles=new Map();
  for(const source of paths) {
   if(!cyclesBySource.has(source))cyclesBySource.set(source,readMotionCycles(modelChunks.get(source)??chunks(omfs.get(source).data)));
   // ID_Cycle_Safe starts at the last loaded motion slot.
   for(const [name,cycle] of cyclesBySource.get(source))cycles.set(name,cycle);
  }
  cyclesByModel.set(path,cycles);
 }
 const profiles=[],actorProfiles={};
 for(const [actor,path] of actors) {
  const profile={};
  for(const [hud,{aliases,model}] of huds) {
   try {
    const cycles=cyclesByModel.get(model??path);
    profile[hud]=Object.fromEntries(aliases.map(([key,value])=>[key,timingForAlias(value,cycles)]));
   } catch(error){throw Error(actor+'/'+hud+': '+error.message,{cause:error});}
  }
  const signature=JSON.stringify(profile);
  let index=profiles.findIndex(candidate=>JSON.stringify(candidate)===signature);
  if(index<0){index=profiles.length;profiles.push(profile);}
  actorProfiles[actor]=index;
 }
 return {schema:1,catalogSha256:sha256(catalogBytes),sources:[...allFiles].map(([path,file])=>({path,sha256:file.sha256})),
  weapons,actorProfiles,profiles};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [game,catalog,output]=process.argv.slice(2);
 if(!game||!catalog||!output)throw Error('Usage: export-reload-timings.mjs GAME_DIR CATALOG_JSON OUTPUT_JSON');
 if(resolve(output).startsWith(resolve(game)+'/'))throw Error('Export outside the game installation');
 const timing=await exportReloadTimings(game,await readFile(catalog));
 await mkdir(dirname(resolve(output)),{recursive:true});
 await writeFile(output,JSON.stringify(timing)+'\n');
 console.log(JSON.stringify({output:resolve(output),weapons:Object.keys(timing.weapons).length,
  handsProfiles:Object.keys(timing.actorProfiles).length,distinctProfiles:timing.profiles.length,sources:timing.sources.length},null,2));
}
