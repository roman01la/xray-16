import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const namePattern=/^[a-z0-9_-]{1,40}$/;
const phaseKeys=[
 {binding:'kINSERT',key:'Insert',code:45},
 {binding:'kHOME',key:'Home',code:36},
 {binding:'kPGUP',key:'PageUp',code:33},
 {binding:'kEND',key:'End',code:35},
 {binding:'kPGDN',key:'PageDown',code:34},
];
const validCommands=commands=>Array.isArray(commands)&&commands.every(
 command=>typeof command==='string'&&command.length>0&&command.length<1000&&!/[\r\n\0]/.test(command));

export async function readStockScenario(file) {
 const {name,map,save,settings=[],phases=[],requiredDefines=[],absentDefines=[]}=JSON.parse(await readFile(file,'utf8'));
 if(!namePattern.test(name??'')||!namePattern.test(map??'')||!validCommands(settings)||
    !Array.isArray(phases)||phases.length>phaseKeys.length||!validCommands(requiredDefines)||!validCommands(absentDefines))
  throw Error('Invalid private stock shader scenario');
 const actions=phases.map((phase,index)=>{
  if(!namePattern.test(phase.name??'')||!validCommands(phase.commands)||
     (phase.lua!==undefined&&(typeof phase.lua!=='string'||!phase.lua.length||phase.lua.length>16000))||
     (phase.actorUpdate!==undefined&&(phase.actorUpdate!==true||!phase.lua||phase.commands.length))||
     !validCommands(phase.expect)||!phase.expect.length)
   throw Error('Invalid stock shader phase');
  return {...phase,key:phaseKeys[index],script:'xray_shader_sweep_'+index};
 });
 let savedGame;
 if(save!==undefined){
  const path=resolve(dirname(file),save),slot=basename(path,'.scop');
  if(!namePattern.test(slot)||!path.endsWith('.scop'))throw Error('Invalid stock checkpoint name');
  savedGame={slot,data:(await readFile(path)).toString('base64')};
 }else if(map!=='zaton'){
  throw Error('A non-Zaton stock route needs a saved game');
 }
 return {name,map,savedGame,settings,actions,requiredDefines,absentDefines};
}

export async function seedShaderSettings(page,path,preset,scenario) {
 const settings=['_preset '+preset,...(scenario?.settings??[])];
 const files=[],scripts=[];
 for(const action of scenario?.actions??[]){
  if(!action.actorUpdate){
   const config=action.script+'.ltx';
   settings.push('bind_console cfg_load '+config+' '+action.key.binding);
   const commands=action.lua?[...action.commands,'run_script '+action.script]:action.commands;
   files.push([config,commands.join('\n')+'\n']);
  }
  if(action.lua)scripts.push([action.script+'.script','function main()\n'+action.lua+'\nend\n']);
 }
 files.push(['user.ltx',settings.join('\n')+'\n']);
 await page.evaluate(`(async()=>{
  const root=await navigator.storage.getDirectory();
  const [assetRoot,...appPath]=${JSON.stringify(path)};
  const game=await root.getDirectoryHandle(assetRoot,{create:true});
  let dir=game;
  for(const name of appPath)dir=await dir.getDirectoryHandle(name,{create:true});
  const write=async(dir,name,value)=>{const writer=await(await dir.getFileHandle(name,{create:true})).createWritable();await writer.write(value);await writer.close();};
  for(const [name,data] of ${JSON.stringify(files)})await write(dir,name,data);
  const save=${JSON.stringify(scenario?.savedGame??null)};
  if(save)await write(await dir.getDirectoryHandle('savedgames',{create:true}),save.slot+'.scop',Uint8Array.from(atob(save.data),x=>x.charCodeAt(0)));
  const scripts=${JSON.stringify(scripts)};
  if(scripts.length){
   const scriptDirectory=await(await game.getDirectoryHandle('gamedata',{create:true})).getDirectoryHandle('scripts',{create:true});
   for(const [name,data] of scripts)await write(scriptDirectory,name,data);
  }
 })()`,true);
}

export async function pressShaderKey(page,code,key,windowsVirtualKeyCode) {
 const event={code,key,windowsVirtualKeyCode};
 await page.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...event});
 await sleep(100);
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',...event});
}

export async function runStockPhases(page,scenario,poll) {
 const completed=[];
 for(const action of scenario.actions){
  if(!action.actorUpdate)await pressShaderKey(page,action.key.key,action.key.key,action.key.code);
  const evidence=await poll(action.name,()=>page.evaluate(`(()=>{
   const lines=(globalThis.sweepLog??[]).concat(document.querySelector('#log')?.textContent.split(String.fromCharCode(10))??[]);
   const found=${JSON.stringify(action.expect)}.map(expected=>lines.find(line=>line.includes(expected)));
   if(${action.waitForSync===true}){
    const log=document.querySelector('#log')?.textContent??'';
    const marker=${JSON.stringify(action.expect[0])};
    if(log.lastIndexOf(marker)<0||log.lastIndexOf('End of synchronization')<log.lastIndexOf(marker))return null;
   }
   return found.every(Boolean)?found:null;
  })()`),action.waitForSync===true?90000:15000);
  await sleep(800);
  const pipelines=await page.evaluate('globalThis.shaderPipelineSnapshot??null');
  completed.push({name:action.name,evidence,pipelines});
 }
 return completed;
}

// Read the user's original actor binder and install a one-shot hook in the
// isolated stage when a stock cutscene prevents a console key from reaching it.
export async function stageShaderActorProbe(stage,game,scenario) {
 const actions=scenario?.actions.filter(action=>action.actorUpdate)??[];
 if(!actions.length)return;
 if(actions.length!==1||!game)throw Error('An actor probe requires one actor phase and --stock-game');
 const client=await readFile(join(stage,'engine-preview','shader-compiler-client.mjs'),'utf8');
 if(!client.includes('const shaderCaptureBuild = true;'))throw Error('Actor probe requires a private capture stage');
 const {readGameFiles}=await import('../../../server/tools/game-configs.mjs');
 const asset='scripts/bind_stalker.script';
 const stock=(await readGameFiles(game,[asset])).get(asset).data.toString('latin1');
 const update='function actor_binder:update(delta)';
 if(stock.split(update).length!==2)throw Error('Stock actor update hook changed');
 const {script}=actions[0];
 const code=stock.replace(update,`local shader_sweep_start,shader_sweep_done
${update}
  if not shader_sweep_done and db.actor and level.name() == "${scenario.map}" then
    shader_sweep_start = shader_sweep_start or time_global()
    if time_global() - shader_sweep_start >= 3000 then
      shader_sweep_done = true
      ${script}.main()
    end
  end
`);
 const path='gamedata/'+asset,bytes=Buffer.from(code,'latin1');
 const engine=join(stage,'engine-preview');
 const file=join(engine,'engine',path);
 await mkdir(dirname(file),{recursive:true});
 await writeFile(file,bytes);
 const manifestPath=join(engine,'engine_data.json');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 manifest.files=manifest.files.filter(entry=>entry.path!==path);
 manifest.files.push({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 await writeFile(manifestPath,JSON.stringify(manifest));
}

// Instrument the staged developer copy only. The stock renderer and shader
// package do not depend on the probe, and it collects counts rather than code.
export async function enableShaderPipelineProbe(stage) {
 const path=join(stage,'engine-preview','backend.js');
 const client=await readFile(join(stage,'engine-preview','shader-compiler-client.mjs'),'utf8');
 if(!client.includes('const shaderCaptureBuild = true;'))throw Error('Pipeline probe requires a private capture stage');
 let code=await readFile(path,'utf8');
 if(code.includes('const shaderPipelinePrograms = new Set();'))return;
 for(const [hook,instrumented] of [
  ['let telemetryChannel, telemetryAdapter;','let telemetryChannel, telemetryAdapter;\nconst shaderPipelinePrograms = new Set();\nlet shaderPipelineConversions = 0;'],
  ['p.vertexVariants.set(conversionKey, vertexModule);','p.vertexVariants.set(conversionKey, vertexModule);\n              shaderPipelineConversions++;'],
  ['this.pipelineCache.set(key, pipe);','this.pipelineCache.set(key, pipe);\n          shaderPipelinePrograms.add(p.key);'],
  ['diagnostics.directDrawsEnabled = true;','diagnostics.directDrawsEnabled = true;\n      diagnostics.shaderPipelineProbe = {pipelines:this.pipelineCache.size,programs:shaderPipelinePrograms.size,vertexConversions:shaderPipelineConversions};'],
 ]){
  if(code.split(hook).length!==2)throw Error('Pipeline probe hook changed: '+hook);
  code=code.replace(hook,instrumented);
 }
 await writeFile(path,code);
}
