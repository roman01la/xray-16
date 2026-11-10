// Procedural, redistributable test volume. Never modifies game archives or a
// user's profile; the caller explicitly seeds these files in an isolated OPFS.
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function createFluidFixture({map='zaton',center=[254.9,18.1,497.5],size=[4,4,4],type='Fog',obstacle=true}={}) {
 if(!/^[a-z0-9_]+$/.test(map)||!['Fog','Fire'].includes(type)||center.length!==3||size.length!==3||
   !center.every(Number.isFinite)||!size.every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid fluid fixture');
 const profile='environment\\fog\\webgpu_validation.ltx';
 const line=Buffer.from(profile+'\r\n');
 const data=Buffer.alloc(6+line.length+64+4+(obstacle?64:0));let offset=0;
 data.writeUInt16LE(3,offset);offset+=2;data.writeUInt32LE(1,offset);offset+=4;line.copy(data,offset);offset+=line.length;
 const matrix=(scale,position)=>{const values=[scale[0],0,0,0,0,scale[1],0,0,0,0,scale[2],0,...position,1];for(const value of values){data.writeFloatLE(value,offset);offset+=4;}};
 matrix(size,center);data.writeUInt32LE(obstacle?1:0,offset);offset+=4;
 if(obstacle)matrix([size[0]*.18,size[1]*.6,size[2]*.6],[center[0]+size[0]*.22,center[1],center[2]]);
 const config=`[volume]
Type = ${type}
EmittersNum = 2
Hemi = 1
ConfinementScale = 0.06
Decay = 0.994
GravityBuoyancy = ${type==='Fire'?'0.001':'0'}

[emitter00]
Type = SimpleGaussian
Position = 35, 50, 35
Radius = 0.15
Sigma = 1
FlowDirection = 0, -1, 0
FlowSpeed = 0.4
Density = 1
ApplyDensity = 1
ApplyImpulse = 1

[emitter01]
Type = SimpleDraught
WorldPosition = ${center.join(', ')}
Radius = 0.23
Sigma = 1
FlowDirection = 0.5, 0, 0
FlowSpeed = 0.2
Density = 0
ApplyDensity = 0
ApplyImpulse = 1
DraughtPeriod = 10
DraughtPhase = 0
DraughtAmp = 0.5
`;
 return {map,center,size,type,files:[
  {path:`gamedata/levels/${map}/level.fog_vol`,base64:data.toString('base64')},
  {path:'gamedata/configs/environment/fog/webgpu_validation.ltx',base64:Buffer.from(config).toString('base64')}
 ]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [output,...args]=process.argv.slice(2);if(!output)throw Error('Usage: fluid-fixture.mjs OUTPUT.json [--map=zaton] [--center=x,y,z] [--size=x,y,z] [--type=Fog|Fire]');
 const options={};for(const arg of args){const match=/^--(map|center|size|type)=(.+)$/.exec(arg);if(!match)throw Error('Invalid fixture option');options[match[1]]=['center','size'].includes(match[1])?match[2].split(',').map(Number):match[2];}
 await writeFile(output,JSON.stringify(createFluidFixture(options),null,2));console.log('Wrote isolated fluid fixture:',output);
}

// Seed before clicking the engine's Launch button. This is a private browser
// profile helper; never apply it to a user's normal profile or production data.
export async function seedFluidFixture(page,fixture) {
 const [x,y,z]=fixture.center;
 const script=`function main()\n if db.actor then db.actor:set_actor_position(vector():set(${x},${y-1.5},${z-1})); db.actor:set_actor_direction(0); log1("FLUID_FIXTURE_CAMERA") end\nend\n`;
 const files=[...fixture.files,{path:'gamedata/scripts/webgpu_fluid_probe.script',base64:Buffer.from(script).toString('base64')}];
 if(files.some(f=>!/^gamedata\/[a-z0-9_/.]+$/i.test(f.path)||f.path.includes('..')))throw Error('Unsafe fixture path');
 await page.evaluate(`(async()=>{
  const root=await navigator.storage.getDirectory();const game=await root.getDirectoryHandle('stream-cop',{create:true});
  for(const file of ${JSON.stringify(files)}){const parts=file.path.split('/');let dir=game;for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create:true});const writer=await(await dir.getFileHandle(parts.at(-1),{create:true})).createWritable();await writer.write(Uint8Array.from(atob(file.base64),x=>x.charCodeAt(0)));await writer.close();}
  const app=await game.getDirectoryHandle('_appdata_',{create:true});const handle=await app.getFileHandle('user.ltx',{create:true});const old=await(await handle.getFile()).text();const writer=await handle.createWritable();await writer.write(old+'\\nr3_volumetric_smoke on\\nbind_console run_script webgpu_fluid_probe kEND\\n');await writer.close();
 })()`,true);
}
