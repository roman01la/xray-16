import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {enableShaderPipelineProbe,pressShaderKey,readStockScenario,runStockPhases,seedShaderSettings,stageShaderActorProbe} from './shader-stock-scenario.mjs';
import {SHADER_CACHE_VERSION} from './shader-cache.mjs';
import {INSTALL_DIRECTORY} from '../../../server/web/opfs-store.mjs';

// Local developer integration sweep. Sources remain in the private output folder.
const {values,positionals}=parseArgs({
 options:{maps:{type:'string'},presets:{type:'string'},port:{type:'string'},
  scenario:{type:'string'},'pipeline-probe':{type:'boolean'},'fresh-shader-cache':{type:'boolean'},'stock-game':{type:'string'}},
 allowPositionals:true,
});
if(positionals.length!==2)
 throw Error('Usage: node shader-sweep.mjs STAGED_PARENT PRIVATE_OUTPUT [--maps LIST] [--presets LIST] [--scenario FILE] [--stock-game DIR] [--pipeline-probe] [--fresh-shader-cache] [--port 8264]');
const [root,trial]=positionals.map(value=>resolve(value));
const repo=resolve(import.meta.dirname,'../../..');
const profile=join(trial,'chrome'),captures=join(trial,'captures');
const previewPort=Number(values.port??8264);
if(![previewPort].every(port=>Number.isInteger(port)&&port>1023&&port<=65535))
 throw Error('Invalid sweep ports');
const origin='http://127.0.0.1:'+previewPort;
const stock=values.scenario?await readStockScenario(resolve(values.scenario)):null;
const pipelineProbe=values['pipeline-probe']??false;
const mapNames=['zaton','jupiter','pripyat','jupiter_underground','labx8'];
const presetNames=['Default','Minimum','Low','High','Extreme'];
const singleplayerMap=stock?.map??'zaton';
const names=values.maps?values.maps.split(','):[singleplayerMap];
const presets=values.presets?values.presets.split(','):['Default'];
if(!names.every(name=>mapNames.includes(name))||!presets.every(name=>presetNames.includes(name)))
 throw Error('Invalid map or preset selection');
if(names.some(name=>name!==singleplayerMap))throw Error('The stock route starts in '+singleplayerMap);
const maps=names.map(map=>({map}));
await mkdir(trial,{recursive:true,mode:0o700});
await mkdir(profile,{recursive:true,mode:0o700});
await mkdir(captures,{recursive:true,mode:0o700});
await rm(join(profile,'DevToolsActivePort'),{force:true});
await writeFile(join(root,'shader-sweep.html'),'<!doctype html><title>Private shader sweep setup</title>');
if(pipelineProbe)await enableShaderPipelineProbe(root);
await stageShaderActorProbe(root,values['stock-game'],stock);
const chromePath=process.env.XRAY_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function start(exe,args,label,options={}){
 const child=spawn(exe,args,{...options,stdio:['ignore','pipe','pipe']});
 const log=createWriteStream(join(trial,label+'.log'),{flags:'a',mode:0o600});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 child.on('close',()=>log.end());
 child.on('error',error=>console.error(error.message));
 return child;
}
function stop(child){
 child.kill();
 child.stdout.destroy();
 child.stderr.destroy();
 child.unref();
}
async function poll(label,fn,timeout=120000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(350);}
 throw Error('Timed out waiting for '+label);
}
async function alive(url){
 try{return (await fetch(url)).ok;}catch{return false;}
}
const server=start(process.execPath,[join(repo,'misc/web/serve.mjs'),root,String(previewPort)],'preview');
const chrome=start(chromePath,[
 '--headless=new','--remote-debugging-port=0','--enable-unsafe-webgpu','--disable-background-networking',
 '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
 '--disable-component-update','--no-first-run','--no-default-browser-check','--window-size=960,680','--disk-cache-size=2097152000',`--user-data-dir=${profile}`,'about:blank'
],'chrome');
async function openTab(port){
 const endpoint='http://127.0.0.1:'+port+'/json/';
 const target=await(await fetch(endpoint+'new?about:blank',{method:'PUT'})).json();
 const socket=new WebSocket(target.webSocketDebuggerUrl), pending=new Map();
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let id=0;
 socket.addEventListener('message',({data})=>{
  const msg=JSON.parse(data), answer=pending.get(msg.id);
  if(!answer)return; pending.delete(msg.id);clearTimeout(answer.timer);
  if(msg.error)answer.reject(Error(msg.error.message));else answer.resolve(msg.result);
 });
 const send=(method,params={})=>new Promise((resolve,reject)=>{
  const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timed out '+method));},40000);
  pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));
 });
 return {
  send,
  async evaluate(expression,awaitPromise=false){
   const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});
   if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   return result.result.value;
  },
  async close(){socket.close();await fetch(endpoint+'close/'+target.id,{signal:AbortSignal.timeout(3000)}).catch(()=>{});}
 };
}
const results=[];
let clearShaderCache=values['fresh-shader-cache']??false;
const exportCapture=(page,id)=>page.evaluate(`(async()=> (await import('/engine-preview/shader-capture.mjs')).readShaderCapture(${JSON.stringify(id)}))()`,true);
async function toggleStockUI(page) {
 await page.evaluate(`document.querySelector('#canvas').focus()`);
 for (const [letter,code] of [['I',73],['I',73],['P',80],['P',80]]) {
  await pressShaderKey(page,'Key'+letter,letter.toLowerCase(),code);
  await sleep(500);
 }
}
try {
 await poll('preview HTTP',()=>alive(origin+'/shader-sweep.html'),15000);
 const port=await poll('Chrome debugger',async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},15000);
 for(const {map} of maps){
   for(const preset of presets){
    const scenario=stock?.name??'stock-singleplayer';
    const id=[map,preset.toLowerCase(),Date.now()].join('-');
    const page=await openTab(port);
    console.log('Running '+map+' '+preset+' '+id);
    try{
     await page.send('Page.enable');
     await page.send('Page.navigate',{url:origin+'/shader-sweep.html'});
     await poll('setup document',()=>page.evaluate(`location.pathname==='/shader-sweep.html'&&!!document.body`),15000);
     if(clearShaderCache){
      await page.evaluate(`(async()=>{
       const root=await navigator.storage.getDirectory();
       try {
        const install=await root.getDirectoryHandle(${JSON.stringify(INSTALL_DIRECTORY)});
        await install.removeEntry(${JSON.stringify(SHADER_CACHE_VERSION)},{recursive:true});
       } catch(error) { if(error.name!=='NotFoundError')throw error; }
       await globalThis.caches?.delete(${JSON.stringify(SHADER_CACHE_VERSION)});
      })()`,true);
      clearShaderCache=false;
     }
     const configPath=['stream-cop','_appdata_'];
     await seedShaderSettings(page,configPath,preset,stock);
     const params=new URLSearchParams({diagnostics:'1',stream:'/pack/pack.json',shaderCapture:id,shaderMap:map,shaderPreset:preset.toLowerCase(),shaderScenario:scenario,
      autostart:'0'});
     await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.sweepLog=[];
      addEventListener('xray-engine-log',({detail:line})=>{if(/shader|loading level|synchronization|preset|rspec|fatal|error/i.test(line)){sweepLog.push(line);if(sweepLog.length>100)sweepLog.shift();}});
      ${pipelineProbe?`globalThis.shaderPipelineChannel=new BroadcastChannel('xray-webgpu');
      shaderPipelineChannel.onmessage=({data})=>{if(data.shaderPipelineProbe)globalThis.shaderPipelineSnapshot=data.shaderPipelineProbe;};`:''}`});
     await page.send('Page.navigate',{url:origin+'/engine-preview/?'+params});
     {
      await poll('stock launcher',()=>page.evaluate(`location.search.includes('autostart=0')&&document.querySelector('#game')?.value==='stream-cop'&&document.querySelector('#launch')?.disabled===false`),60000);
      const campaign=stock?.savedGame?stock.savedGame.slot+'/single/alife/load':'all/single/alife/new';
      await page.evaluate(`document.querySelector('#extra-args').value=${JSON.stringify('-start server('+campaign+') client(localhost)')};document.querySelector('#launch').click()`);
      await poll('stock game ready',()=>page.evaluate("document.querySelector('#start-game')?.disabled===false"),240000);
      await page.evaluate("document.querySelector('#start-game').click()");
     }
     await poll(map+' WebGPU render',async()=>{
      const info=await page.evaluate(`({status:document.querySelector('#status')?.textContent,stats:document.querySelector('#browser-diagnostics')?.textContent,synced:document.querySelector('#boot')?.hidden&&document.querySelector('#log')?.textContent?.includes('End of synchronization'),engineError:(globalThis.sweepLog??[]).find(line=>line.includes('worker sent an error!'))})`).catch(()=>null);
      if(info?.status?.startsWith('Failed:')||info?.engineError)throw Error(info.engineError??info.status);
      if(info?.synced&&info?.stats?.includes('WebGPU validation errors 0')&&Number.parseFloat(info.stats)>0)return info;
     },240000);
     await toggleStockUI(page);
     const initialPipelines=await page.evaluate('globalThis.shaderPipelineSnapshot??null');
     const phases=stock?await runStockPhases(page,stock,poll):[];
     await sleep(2000);
     const capture=await exportCapture(page,id);
     if(!capture?.records?.length)throw Error('No shader requests recorded');
     await writeFile(join(captures,id+'.json'),JSON.stringify(capture),{mode:0o600});
     const options=[...new Set(capture.records.flatMap(({stages})=>Object.values(stages).flatMap(({options})=>options)))].sort();
     if(stock?.requiredDefines.some(define=>!options.includes(define))||
        stock?.absentDefines.some(define=>options.includes(define)))
      throw Error('Captured programs do not match the requested renderer options');
     const compiler=await page.evaluate(`(()=>{const {compiled,package:packaged,cache,errors}=globalThis.__xrayShaderCompilerStatus;return {compiled,packaged,cache,errors};})()`);
     const render=await page.evaluate(`document.querySelector('#browser-diagnostics')?.textContent`);
     if(!render?.includes('WebGPU validation errors 0'))throw Error('WebGPU validation failed during capture');
     const pipelines=await page.evaluate('globalThis.shaderPipelineSnapshot??null');
     if(pipelineProbe&&!(pipelines?.pipelines>0))throw Error('No WebGPU pipeline counters received');
     const result={map,preset,scenario,id,complete:true,keys:capture.records.length,missing:capture.records.filter(record=>!record.inManifest).length,
      errors:capture.records.filter(record=>record.outcome!=='loaded').length,options,compiler,render,
      ...(stock?{phases}:{}),...(pipelineProbe?{initialPipelines,pipelines}:{})};
     results.push(result);
     await writeFile(join(trial,'results.json'),JSON.stringify(results,null,2),{mode:0o600});
     console.log(JSON.stringify(result));
    } catch(error) {
     const diagnostic=await page.evaluate(`({status:document.querySelector('#status')?.textContent,boot:document.querySelector('#boot-status')?.textContent,stats:document.querySelector('#browser-diagnostics')?.textContent,log:globalThis.sweepLog??[],tail:document.querySelector('#log')?.textContent?.slice(-4000)})`).catch(()=>null);
     const capture=await exportCapture(page,id).catch(()=>null);
     if(capture?.records?.length)
      await writeFile(join(captures,id+'.json'),JSON.stringify(capture),{mode:0o600});
     const result={map,preset,scenario,id,complete:false,keys:capture?.records?.length??0,error:error.message};
     results.push(result);
     await writeFile(join(trial,id+'-failure.json'),JSON.stringify(diagnostic,null,2),{mode:0o600});
     await writeFile(join(trial,'results.json'),JSON.stringify(results,null,2),{mode:0o600});
     console.error(JSON.stringify(result));
    } finally {await page.close();}
   }
 }
} finally {stop(chrome);stop(server);}
if(results.some(result=>!result.complete))process.exitCode=1;
