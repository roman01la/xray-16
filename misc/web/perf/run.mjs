import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,open,copyFile,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {launchChrome} from './cdp.mjs';
import {analyzeRun} from './analyze.mjs';
import {installGpuPassProbe} from './gpu-pass-probe.mjs';
import {installQueueProbe} from './queue-probe.mjs';
import {verifyGrassFilter} from '../webgpu/detail-shadow-filter.browser-test.mjs';
import {filterWGSL} from '../webgpu/detail-shadow-filter.js';

const {values:args}=parseArgs({options:{
  url:{type:'string'},game:{type:'string',default:'cop'},profile:{type:'string'},output:{type:'string'},
  checkpoint:{type:'string'},save:{type:'string'},'saved-slot':{type:'string'},'new-game':{type:'boolean',default:false},config:{type:'string'},scenario:{type:'string'},
  symbols:{type:'string'},'symbols-wasm':{type:'string'},chrome:{type:'string'},
  duration:{type:'string',default:'15'},repeats:{type:'string',default:'3'},warmup:{type:'string',default:'10'},
  trace:{type:'string',default:'15'},'keep-cap':{type:'boolean',default:false},
  'verify-grass-filter':{type:'boolean',default:false},
  'queue-probe':{type:'boolean',default:false},
  'engine-args':{type:'string',default:''},
}});
if(!args.url||!args.profile||!args.output||!['cop','soc','cs'].includes(args.game)||(!args.checkpoint&&!args.save&&!args['new-game']&&!args['saved-slot']))
  throw Error('Supply --url --game cop|soc|cs --profile --output and --checkpoint JSON, --save FILE or --new-game. See misc/web/perf/README.md.');
const seconds=(key,min,max)=>{const value=Number(args[key]);if(!Number.isFinite(value)||value<min||value>max)throw Error(`Invalid --${key}`);return value;};
const duration=seconds('duration',2,120)*1000,traceDuration=seconds('trace',2,120)*1000;
const warmup=seconds('warmup',1,120)*1000,repeats=seconds('repeats',1,10);
if(!Number.isInteger(repeats))throw Error('Repeats must be an integer.');
const hash=value=>createHash('sha256').update(value).digest('hex');
const scenario=args.scenario?JSON.parse(await readFile(args.scenario,'utf8')):{};
const viewport=scenario.viewport??{width:1920,height:1080};
if(![viewport.width,viewport.height].every(v=>Number.isInteger(v)&&v>=320&&v<=8192))throw Error('Invalid viewport.');
if(scenario.game && scenario.game!==args.game)throw Error('Scenario belongs to another game.');
if(scenario.setupLua!==undefined && (typeof scenario.setupLua!=='string'||scenario.setupLua.length>32000))throw Error('Invalid setupLua.');
const action=scenario.action;
if(action && (action.type!=='holdKey'||!Number.isInteger(action.keyCode)||typeof action.key!=='string'||typeof action.code!=='string'))
  throw Error('An action must be holdKey with key, code and keyCode.');
let config='',save;
if(args.checkpoint){const checkpoint=JSON.parse(await readFile(args.checkpoint,'utf8'));config=checkpoint.config??'';save=Buffer.from(checkpoint.save,'base64');}
if(args.save)save=await readFile(args.save);
if(args.config)config=await readFile(args.config,'utf8');
if(save&&(save.length<13||save.readUInt32LE(0)!==0xffffffff||save.readUInt32LE(4)<7))throw Error('Invalid X-Ray saved game.');
config=config.replace(/\r\n/g,'\n')+'\n'+[
  ...(scenario.settings??[]),
  ...(scenario.bindings??[]),
  ...(!args['keep-cap']?['rs_v_sync off','rs_fps_limit 501','rs_fps_limit_in_menu 501']:[]),
  `vid_mode ${viewport.width}x${viewport.height}`,'rs_stats off',
  'bind_console run_script xray_perf_probe kEND','',
].join('\n');
const output=resolve(args.output);
await mkdir(output,{recursive:true});
try{await stat(join(output,'run.json'));throw Error('Output already contains a run. Choose another directory.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const log=createWriteStream(join(output,'chrome.log'),{flags:'a'});
const url=new URL(args.url);url.searchParams.set('autostart','0');url.searchParams.set('diagnostics','1');
let chrome,cdp,page,activeTrace=false,held=false,interrupted=false;
const sessions=new Map(),setupTasks=new Set(),exceptions=[],profileWarnings=[],benchmarks=[];
const run={environment:{game:args.game,scenarioHash:hash(JSON.stringify(scenario)),checkpointHash:save?hash(save):'new-game',configHash:hash(config),viewport,
  url:url.href,created:new Date().toISOString(),uncapped:!args['keep-cap'],durationMs:duration,repeats,traceDurationMs:traceDuration,engineArgs:args['engine-args']},benchmarks,exceptions,profileWarnings};
const evaluate=expression=>cdp.evaluate(expression,page);
const sendPage=(method,params={})=>cdp.send(method,params,page);
const stop=()=>{interrupted=true;};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
async function check(){
  if(interrupted)throw Error('Run interrupted.');
  const state=await evaluate('({crash:globalThis.perfCrash,errors:globalThis.perfErrors,tail:globalThis.perfLines?.slice(-5)})');
  if(state.crash)throw Error('Game crashed: '+JSON.stringify(state.crash));
  if(state.errors?.length)throw Error('Renderer reported an error: '+state.errors.join('\n'));
}
async function waitUntil(label,expression,timeout=1200000){
  const start=Date.now();let lastReport=0;
  while(Date.now()-start<timeout){
    await check();if(await evaluate(expression))return;
    if(Date.now()-lastReport>10000){console.log(label,await evaluate("document.querySelector('#boot-status')?.textContent"));lastReport=Date.now();}
    await sleep(500);
  }
  throw Error(label+' timed out.');
}
async function wait(milliseconds){
  const until=Date.now()+milliseconds;
  while(Date.now()<until){await sleep(Math.min(1000,until-Date.now()));await check();}
}
async function key(type,key='End',code='End',keyCode=35){await sendPage('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:keyCode});}
async function setAction(on){
  if(!action)return;
  await key(on?'rawKeyDown':'keyUp',action.key,action.code,action.keyCode);held=on;
}
async function resetScene(){
  const previous=await evaluate("globalThis.perfLines.filter(l=>l.includes('XRAY_PERF_READY')).length");
  await key('rawKeyDown');
  try{await waitUntil('Setting scene',`globalThis.perfLines.filter(l=>l.includes('XRAY_PERF_READY')).length>${previous}`,90000);}
  finally{await key('keyUp');}
  await wait(1000);
}
async function screenshot(name){
  const image=await sendPage('Page.captureScreenshot',{format:'png'});
  await writeFile(join(output,name),Buffer.from(image.data,'base64'));
}
try{
  chrome=await launchChrome({binary:args.chrome??process.env.CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',profile:args.profile,log,viewport});
  cdp=chrome.cdp;
  run.environment.profile=chrome.profile;
  run.environment.browser=await cdp.send('Browser.getVersion');
  const system=await cdp.send('SystemInfo.getInfo');
  run.environment.system=system;
  run.environment.gpu={devices:system.gpu.devices,renderer:system.gpu.auxAttributes?.glRenderer};
  if(/swiftshader|llvmpipe|software rasterizer/i.test(JSON.stringify(run.environment.gpu)))throw Error('Chrome selected software rendering. Hardware GPU measurement is required.');
  cdp.on('Target.attachedToTarget',({sessionId,targetInfo})=>{
    sessions.set(sessionId,targetInfo);
    const task=(async()=>{
      await cdp.send('Runtime.enable',{},sessionId).catch(()=>{});
      await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId).catch(()=>{});
    })();
    setupTasks.add(task);task.finally(()=>setupTasks.delete(task));
  });
  cdp.on('Target.detachedFromTarget',({sessionId})=>sessions.delete(sessionId));
  cdp.on('Runtime.exceptionThrown',(event,sessionId)=>exceptions.push({sessionId,message:event.exceptionDetails.exception?.description??event.exceptionDetails.text}));
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  page=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  sessions.set(page,{type:'page',targetId,url:url.href});
  await sendPage('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await cdp.send('Target.activateTarget',{targetId});
  await sendPage('Page.enable');await sendPage('Network.enable');
  await sendPage('Emulation.setFocusEmulationEnabled',{enabled:true});
  await sendPage('Network.setBlockedURLs',{urls:['*/analytics/event','*/crash-report','*/cloud-saves','*/cloud-saves/*']});
  await sendPage('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false});
  await sendPage('Page.addScriptToEvaluateOnNewDocument',{source:`
    globalThis.perfKeys=[];addEventListener('keydown',e=>perfKeys.push([e.key,e.code,e.keyCode,document.activeElement?.id]),true);
    globalThis.perfLines=[];globalThis.perfLogEvents=[];globalThis.perfLogSerial=0;globalThis.perfSamples=[];globalThis.perfBenchmarks=[];globalThis.perfErrors=[];
    addEventListener('xray-engine-log',({detail})=>{perfLines.push(detail);perfLogEvents.push({line:detail,serial:++perfLogSerial});if(perfLines.length>3000){perfLines.shift();perfLogEvents.shift();}});
    addEventListener('xray-crash',({detail})=>{globalThis.perfCrash=detail;});
    globalThis.perfChannel=new BroadcastChannel('xray-webgpu');
    perfChannel.onmessage=({data})=>{
      if(data.benchmark)perfBenchmarks.push(data.benchmark);
      if(data.fps){perfSamples.push({...data,recorded:performance.now()});if(perfSamples.length>500)perfSamples.shift();}
      if(data.lastError)perfErrors.push(data.lastError);
    };`});
  await sendPage('Page.navigate',{url:url.href});
  await waitUntil('Installing game',"document.querySelector('#launch')?.disabled===false");
  if(await evaluate('document.documentElement.dataset.game')!==args.game)throw Error('URL opened a different game.');
  if(args['saved-slot']){
    if(!/^[a-zA-Z0-9 _-]{1,100}$/.test(args['saved-slot']))throw Error('Invalid saved slot.');
    const encoded=await evaluate(`(async()=>{
      const root=await navigator.storage.getDirectory(),game=await root.getDirectoryHandle('stream-${args.game}'),dir=await(await game.getDirectoryHandle('_appdata_')).getDirectoryHandle('savedgames');
      let handle;for(const extension of ['.scop','.sav']){try{handle=await dir.getFileHandle(${JSON.stringify(args['saved-slot'])}+extension);break;}catch{}}
      if(!handle)throw Error('Checkpoint slot was not found');
      const bytes=new Uint8Array(await(await handle.getFile()).arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
    })()`);
    save=Buffer.from(encoded,'base64');run.environment.checkpointHash=hash(save);
    await writeFile(join(output,'checkpoint.json'),JSON.stringify({config,save:encoded}));
  }

  const wasmURL=new URL('xr_3da.wasm',url).href;
  run.environment.wasmHash=await evaluate(`(async()=>{const r=await fetch(${JSON.stringify(wasmURL)});if(!r.ok)throw Error('Cannot read engine');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await r.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');})()`);
  if(args.symbols){
    const wasmPath=args['symbols-wasm']??join(dirname(resolve(args.symbols)),'xr_3da.wasm');
    if(hash(await readFile(wasmPath))!==run.environment.wasmHash)throw Error('Symbol source Wasm does not match the loaded engine.');
    await copyFile(args.symbols,join(output,'wasm.symbols'));run.environment.symbols=true;
  }
  const setup=`function main()
    if not db.actor then return end
    if not _G.__xray_perf_position then _G.__xray_perf_position=db.actor:position() end
    db.actor:set_actor_position(_G.__xray_perf_position)
    ${scenario.setupLua??''}
    ${!args['keep-cap']?'get_console():execute("rs_v_sync off") get_console():execute("rs_fps_limit 501")':''}
    get_console():execute("cfg_save")
    ${args['new-game']?'if not _G.__xray_perf_saved then get_console():execute("save perfbench") _G.__xray_perf_saved=true end':''}
    local p=db.actor:position()
    log1(string.format("XRAY_PERF_READY map=%s x=%.4f y=%.4f z=%.4f",level.name(),p.x,p.y,p.z))
  end\n`;
  await evaluate(`(async()=>{
    const root=await navigator.storage.getDirectory(),game=await root.getDirectoryHandle('stream-${args.game}',{create:true});
    const app=await game.getDirectoryHandle('_appdata_',{create:true}),saves=await app.getDirectoryHandle('savedgames',{create:true});
    const write=async(dir,name,bytes)=>{const stream=await(await dir.getFileHandle(name,{create:true})).createWritable();await stream.write(bytes);await stream.close();};
    await write(app,'user.ltx',${JSON.stringify(config)});
    const saved=${JSON.stringify(save?.toString('base64')??null)};
    if(saved)await write(saves,${JSON.stringify(args.game==='soc'?'perfbench.sav':'perfbench.scop')},Uint8Array.from(atob(saved),x=>x.charCodeAt(0)));
    const scripts=await(await game.getDirectoryHandle('gamedata',{create:true})).getDirectoryHandle('scripts',{create:true});
    await write(scripts,'xray_perf_probe.script',${JSON.stringify(setup)});
    document.querySelector('#extra-args').value=${JSON.stringify((args['new-game']?'-start server(all/single/alife/new) client(localhost)':'-start server(perfbench/single/alife/load) client(localhost)')+' '+args['engine-args'])};
    document.querySelector('#launch').click();
  })()`);
  await waitUntil('Loading checkpoint',"document.querySelector('#start-game')?.disabled===false");
  await evaluate("document.querySelector('#start-game').click();document.querySelector('#canvas').focus();perfChannel.postMessage({command:'profile',enabled:false});perfChannel.postMessage({command:'queue-audit',enabled:false});");
  await sendPage('Input.dispatchMouseEvent',{type:'mousePressed',x:viewport.width/2,y:viewport.height/2,button:'left',clickCount:1});
  await sendPage('Input.dispatchMouseEvent',{type:'mouseReleased',x:viewport.width/2,y:viewport.height/2,button:'left',clickCount:1});
  await wait(warmup);
  await resetScene();
  const canvas=await evaluate("({width:document.querySelector('#canvas').width,height:document.querySelector('#canvas').height,visibility:document.visibilityState})");
  run.environment.canvas=canvas;
  if(canvas.width!==viewport.width||canvas.height!==viewport.height||canvas.visibility!=='visible')throw Error('Actual render resolution or tab visibility differs from the requested test.');
  run.environment.scene=await evaluate("perfLines.filter(l=>l.includes('XRAY_PERF_READY')).at(-1)");
  await writeFile(join(output,'requested-settings.ltx'),config);
  let effective=await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),game=await root.getDirectoryHandle('stream-${args.game}'),app=await game.getDirectoryHandle('_appdata_');return (await(await app.getFileHandle('user.ltx')).getFile()).text();})()`);
  effective=effective.replace(/\r/g,'');
  await writeFile(join(output,'effective-settings.ltx'),effective);
  if(!args['keep-cap'] && (!/^rs_v_sync off$/m.test(effective)||!/^rs_fps_limit 501$/m.test(effective)))throw Error('The game did not apply the uncapped benchmark settings.');
  const effectiveValues=new Map(effective.split('\n').map(line=>{const space=line.indexOf(' ');return [line.slice(0,space),line.slice(space+1).trim()];}));
  for(const setting of scenario.settings??[]){
    const space=setting.indexOf(' '),name=setting.slice(0,space),expected=setting.slice(space+1);
    if(name==='_preset')continue;
    const actual=effectiveValues.get(name);
    if(actual!==expected && !(actual!==undefined && Number.isFinite(Number(expected)) && Number(actual)===Number(expected)))
      throw Error('Setting was not applied: '+name+' expected '+expected+' received '+actual);
  }
  if(args['new-game']){
    const saved=await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),game=await root.getDirectoryHandle('stream-${args.game}'),dir=await(await game.getDirectoryHandle('_appdata_')).getDirectoryHandle('savedgames');const handle=await dir.getFileHandle(${JSON.stringify(args.game==='soc'?'perfbench.sav':'perfbench.scop')});const bytes=new Uint8Array(await(await handle.getFile()).arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);})()`);
    await writeFile(join(output,'checkpoint.json'),JSON.stringify({config:effective,save:saved}));
    run.environment.checkpointHash=hash(Buffer.from(saved,'base64'));
  }
  await screenshot('scene-before.png');
  const renderers=await Promise.all([...sessions].filter(([,target])=>target.type==='worker').map(async([sessionId])=>{
    try{
      const result=await cdp.send('Runtime.evaluate',{expression:'Boolean(globalThis.__xrayWebGPU)',returnByValue:true},sessionId,2000);
      return result.result?.value?sessionId:null;
    }catch{return null;}
  }));
  const rendererSession=renderers.find(Boolean);
  console.log('Hardware and scene ready. Measuring untraced frame times.');
  for(let repeat=0;repeat<repeats;repeat++){
    const variant=scenario.benchmarkVariants?.[repeat % scenario.benchmarkVariants.length];
    if(variant){
      if(!rendererSession)throw Error('Renderer variant requires a running renderer worker.');
      await cdp.evaluate(variant.rendererExpression,rendererSession);
    }
    await resetScene();await wait(warmup);
    const id=`run-${repeat}`;
    await evaluate(`perfChannel.postMessage({command:'benchmark',id:${JSON.stringify(id)},durationMs:${duration}})`);
    await setAction(true);
    await waitUntil('Benchmark',`perfBenchmarks.some(b=>b.id===${JSON.stringify(id)})`,duration+20000);
    await setAction(false);
    const benchmark=await evaluate(`perfBenchmarks.find(b=>b.id===${JSON.stringify(id)})`);
    if(benchmark.validationErrors)throw Error('GPU validation errors invalidate the benchmark.');
    if(variant){
      benchmark.variant=variant.label;
      await evaluate("perfSamples=[];perfChannel.postMessage({command:'profile',enabled:true})");
      await setAction(true);await wait(3500);await setAction(false);
      benchmark.detailedSamples=await evaluate('perfSamples.slice(1)');
      await evaluate("perfChannel.postMessage({command:'profile',enabled:false})");
    }
    benchmarks.push(benchmark);console.log(JSON.stringify({repeat:repeat+1,...benchmark,detailedSamples:undefined}));
  }
  await resetScene();await wait(warmup);
  await evaluate("perfSamples=[];perfChannel.postMessage({command:'profile',enabled:true})");
  await setAction(true);await wait(5000);await setAction(false);
  run.detailedSamples=await evaluate('perfSamples.slice(1)');
  await evaluate("perfChannel.postMessage({command:'profile',enabled:false})");
  await wait(2000);
  if(rendererSession){
    run.shadowCounts=await cdp.evaluate('(async()=>await globalThis.__xrayWebGPU.grassShadowFilter?.counts()??null)()',rendererSession);
    run.shadowState=await cdp.evaluate('({entries:globalThis.__xrayWebGPU.grassShadowFilter?.entries.size??0,enabled:globalThis.__xrayWebGPU.nativeGrassShadowFilterEnabled,metrics:globalThis.__xrayWebGPU.grassShadowFilter?.metrics})',rendererSession);
    run.detailStorage=await cdp.evaluate('({metrics:globalThis.__xrayWebGPU.detailArena?.metrics,bytes:globalThis.__xrayWebGPU.detailArena?.bytes,heapBytes:globalThis.__xrayWebGPU.detailArena?.words?.byteLength,audit:globalThis.__xrayWebGPU.detailAudit})',rendererSession);
    if(run.detailStorage.audit?.errors?.length)throw Error(run.detailStorage.audit.errors.join('\n'));
  }
  if(rendererSession && await cdp.evaluate(`(${installGpuPassProbe.toString()})()`,rendererSession)){
    console.log('Measuring isolated render/compute pass GPU timestamps.');
    await setAction(true);await wait(4000);await setAction(false);
    run.gpuPasses=await cdp.evaluate('__stopGpuPassProbe()',rendererSession);
  }
  if(rendererSession && args['verify-grass-filter']){
    run.grassFilterFixture=await cdp.evaluate(`(async()=>{const filterWGSL=${JSON.stringify(filterWGSL)};return (${verifyGrassFilter.toString()})();})()`,rendererSession);
  }
  await resetScene();await wait(2000);
  await Promise.all([...setupTasks]);
  const profiling=[];
  for(const [sessionId,target] of sessions){
    if(interrupted)throw Error('Run interrupted.');
    try{
      await cdp.send('Profiler.enable',{},sessionId);
      await cdp.send('Profiler.setSamplingInterval',{interval:1000},sessionId);
      await cdp.send('Profiler.start',{},sessionId);
      profiling.push({sessionId,target});
    }catch(error){profileWarnings.push({target,error:error.message});}
  }
  const {categories}=await cdp.send('Tracing.getCategories');
  const selected=[...new Set([...['devtools.timeline','v8','blink.user_timing','toplevel','gpu','gpu.*','viz','cc','disabled-by-default-gpu.service','disabled-by-default-gpu.device','disabled-by-default-dawn','disabled-by-default-dawn.*','disabled-by-default-devtools.timeline'],...categories.filter(name=>['devtools.timeline','v8','blink.user_timing','toplevel','gpu','viz','cc'].includes(name)||/^disabled-by-default-(gpu|dawn|devtools.timeline)/.test(name))])];
  run.trace={categories:selected,availableGpuCategories:categories.filter(name=>/gpu|dawn/i.test(name))};
  if(rendererSession && args['queue-probe'])await cdp.evaluate(`(${installQueueProbe.toString()})()`,rendererSession);
  const traceDone=cdp.waitFor('Tracing.tracingComplete',traceDuration+120000);
  await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'gzip',
    bufferUsageReportingInterval:1000,traceConfig:{recordMode:'recordAsMuchAsPossible',traceBufferSizeInKb:131072,includedCategories:selected}});
  activeTrace=true;
  console.log('Recording CPU profiles and Chrome GPU trace.');
  await setAction(true);await wait(traceDuration);await setAction(false);
  await cdp.send('Tracing.end');activeTrace=false;
  if(rendererSession && args['queue-probe'])run.queueProbe=await cdp.evaluate('__stopQueueProbe()',rendererSession);
  const complete=await traceDone;
  Object.assign(run.trace,complete);delete run.trace.stream;
  const file=await open(join(output,'trace.json.gz'),'w');
  try{for(;;){const chunk=await cdp.send('IO.read',{handle:complete.stream,size:1048576});await file.write(Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8'));if(chunk.eof)break;}}
  finally{await file.close();await cdp.send('IO.close',{handle:complete.stream});}
  for(let index=0;index<profiling.length;index++){
    const {sessionId,target}=profiling[index];
    try{const {profile}=await cdp.send('Profiler.stop',{},sessionId);await writeFile(join(output,`${index}-${target.type}.cpuprofile.json`),JSON.stringify({target,profile}));}
    catch(error){profileWarnings.push({target,error:error.message});}
  }
  await screenshot('scene-after.png');
  run.validationResults=[];
  for(const [index,step] of (scenario.validationSteps??[]).entries()){
    console.log('Validating',step.label);
    if(step.rendererExpression)await cdp.evaluate(step.rendererExpression,rendererSession);
    const serial=await evaluate('perfLogSerial');
    await key('rawKeyDown',step.key,step.code,step.keyCode);
    try{
      await waitUntil(step.label,`perfLogEvents.some(e=>e.serial>${serial} && e.line.includes(${JSON.stringify(step.waitForLog)}))`,120000);
    }finally{await key('keyUp',step.key,step.code,step.keyCode);}
    await wait(step.settleMs??3000);
    await screenshot(`validation-${index}.png`);
    const state=await cdp.evaluate('({metrics:globalThis.__xrayWebGPU.detailArena?.metrics,audit:globalThis.__xrayWebGPU.detailAudit})',rendererSession);
    if(state.audit?.errors?.length)throw Error(state.audit.errors.join('\n'));
    run.validationResults.push({label:step.label,state});
  }
  run.logs=await evaluate('perfLines');
  run.telemetry=await evaluate('perfSamples');
  if(run.trace.dataLossOccurred)throw Error('Chrome dropped trace data. Shorten --trace and retry.');
  if(!profiling.length)throw Error('No CPU profiles were captured.');
  run.complete=true;
}catch(error){
  run.complete=false;run.error=error.stack;process.exitCode=1;
  console.error(error.message);
  if(cdp&&page){
    if(held)await setAction(false).catch(()=>{});
    if(activeTrace)await cdp.send('Tracing.end').catch(()=>{});
    await screenshot('failure.png').catch(()=>{});
    run.logs=await evaluate('globalThis.perfLines??[]').catch(()=>[]);
    run.keys=await evaluate('globalThis.perfKeys??[]').catch(()=>[]);
  }
}finally{
  await writeFile(join(output,'run.json'),JSON.stringify(run,null,2));
  await chrome?.close();log.end();
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
if(run.complete){const report=await analyzeRun(output);console.log(JSON.stringify({output,benchmark:report.benchmark,gpuTraceEvents:report.trace.gpuEvents,profiles:report.profiles.length}));}
