import {readFile,writeFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const quantile=(values,p)=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*p;
  const lower=Math.floor(index),weight=index-lower;
  return sorted[lower]*(1-weight)+sorted[Math.ceil(index)]*weight;
};
export function summarizeBenchmarks(benchmarks) {
  if(!benchmarks.length)throw Error('No completed benchmark windows.');
  return {runs:benchmarks.length,frames:benchmarks.reduce((sum,b)=>sum+b.frames,0),
    fps:quantile(benchmarks.map(b=>b.fps),.5),medianMs:quantile(benchmarks.map(b=>b.medianMs),.5),
    p95Ms:quantile(benchmarks.map(b=>b.p95Ms),.5),p99Ms:quantile(benchmarks.map(b=>b.p99Ms),.5),
    fpsMin:Math.min(...benchmarks.map(b=>b.fps)),fpsMax:Math.max(...benchmarks.map(b=>b.fps)),
    detailWorkPerFrame:Object.fromEntries(Object.keys(benchmarks[0].detailWork||{}).map(key=>[key,
      quantile(benchmarks.map(b=>(b.detailWork?.[key]??0)/b.frames),.5)])),
    workPerFrame:Object.fromEntries(Object.keys(benchmarks[0].work||{}).map(key=>[key,
      quantile(benchmarks.map(b=>(b.work[key]??0)/b.frames),.5)]))};
}
export function analyzeCPU(profile,symbols={}) {
  const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
  const parents=new Map();
  for(const node of profile.nodes)for(const child of node.children||[])parents.set(child,node.id);
  const name=node=>{
    const raw=node?.callFrame?.functionName||'(anonymous)';
    const index=raw.match(/wasm-function\[(\d+)\]/)?.[1];
    return index&&symbols[index]?symbols[index]:raw;
  };
  const self=new Map(),inclusive=new Map();let sampledUs=0,idleUs=0;
  for(let index=0;index<(profile.samples?.length||0);index++){
    const id=profile.samples[index],duration=profile.timeDeltas?.[index]??0;
    if(!nodes.has(id))continue;
    sampledUs+=duration;
    const label=name(nodes.get(id));
    if(['(idle)','(program)','(root)'].includes(label))idleUs+=duration;
    self.set(label,(self.get(label)||0)+duration);
    const seen=new Set();let current=id;
    while(nodes.has(current)){
      const label=name(nodes.get(current));
      if(!seen.has(label)){inclusive.set(label,(inclusive.get(label)||0)+duration);seen.add(label);}
      current=parents.get(current);
    }
  }
  const top=map=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([name,us])=>({name,ms:us/1000}));
  return {durationMs:(profile.endTime-profile.startTime)/1000,sampledMs:sampledUs/1000,idleSampleMs:idleUs/1000,
    topSelf:top(self),topInclusive:top(inclusive)};
}
export function analyzeTrace(trace) {
  const events=Array.isArray(trace)?trace:trace.traceEvents;
  if(!Array.isArray(events))throw Error('No Chrome trace events.');
  const processes=new Map(),threads=new Map(),groups=new Map(),stacks=new Map();
  let start=Infinity,end=-Infinity,gpuEvents=0;
  const span=event=>{
    const key=`${event.pid}:${event.tid}`;
    const group=groups.get(key)||{pid:event.pid,tid:event.tid,count:0,spans:[],events:new Map(),longTasks:[]};
    group.count++;group.spans.push([event.ts,event.ts+event.dur]);
    group.events.set(event.name,(group.events.get(event.name)||0)+event.dur);
    if(event.dur>=50000 && /RunTask|ThreadControllerImpl::RunTask/.test(event.name))
      group.longTasks.push({name:event.name,startMs:event.ts/1000,durationMs:event.dur/1000});
    groups.set(key,group);
  };
  for(const event of events){
    const key=`${event.pid}:${event.tid}`;
    if(event.ph==='M'){
      if(event.name==='process_name')processes.set(event.pid,event.args?.name);
      if(event.name==='thread_name')threads.set(key,event.args?.name);
      continue;
    }
    if(Number.isFinite(event.ts)){start=Math.min(start,event.ts);end=Math.max(end,event.ts+(event.dur||0));}
    if(/gpu|dawn|webgpu/i.test(event.cat||''))gpuEvents++;
    if(event.ph==='X'&&Number.isFinite(event.dur))span(event);
    else if(event.ph==='B'){
      const stack=stacks.get(key)||[];stack.push(event);stacks.set(key,stack);
    }else if(event.ph==='E'){
      const begin=stacks.get(key)?.pop();
      if(begin && event.ts>=begin.ts)span({...begin,dur:event.ts-begin.ts});
    }
  }
  const union=spans=>{
    spans.sort((a,b)=>a[0]-b[0]);let total=0,lastStart,lastEnd;
    for(const [s,e] of spans){if(lastEnd===undefined){lastStart=s;lastEnd=e;}else if(s>lastEnd){total+=lastEnd-lastStart;lastStart=s;lastEnd=e;}else lastEnd=Math.max(lastEnd,e);}
    return (total+(lastEnd===undefined?0:lastEnd-lastStart))/1000;
  };
  return {events:events.length,durationMs:Number.isFinite(start)?(end-start)/1000:0,gpuEvents,
    threads:[...groups.entries()].map(([key,g])=>({pid:g.pid,tid:g.tid,process:processes.get(g.pid),thread:threads.get(key),
      spans:g.count,tracedSpanUnionMs:union(g.spans),topInclusiveSpans:[...g.events].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([name,us])=>({name,ms:us/1000})),
      longTasks:g.longTasks.sort((a,b)=>b.durationMs-a.durationMs).slice(0,20)})).sort((a,b)=>b.tracedSpanUnionMs-a.tracedSpanUnionMs)};
}
export function compareRuns(before,after) {
  const keys=['game','scenarioHash','checkpointHash','configHash','viewport','canvas','browser','gpu'];
  const mismatches=keys.filter(key=>JSON.stringify(before.environment[key])!==JSON.stringify(after.environment[key]));
  if(mismatches.length)throw Error('Runs differ in '+mismatches.join(', '));
  const left=before.benchmark,right=after.benchmark;
  return {before:left,after:right,fpsChangePercent:(right.fps/left.fps-1)*100,
    medianChangeMs:right.medianMs-left.medianMs,p95ChangeMs:right.p95Ms-left.p95Ms,
    workChangePerFrame:Object.fromEntries(Object.keys(left.workPerFrame).map(key=>[key,(right.workPerFrame[key]||0)-left.workPerFrame[key]]))};
}
export function summarizeGpuPasses(capture) {
  if(!capture?.samples?.length)return null;
  const frameIds=capture.samples.map(sample=>sample.frame);
  const first=Math.min(...frameIds),last=Math.max(...frameIds);
  const groups=new Map();
  let invalid=0;
  for(const sample of capture.samples){
    if(!Number.isFinite(sample.gpuMs)||sample.gpuMs<0){invalid++;continue;}
    // Capture installation and the encoder limit can cut the boundary frames.
    if(sample.frame===first||sample.frame===last)continue;
    const target=JSON.stringify({kind:sample.kind,colors:sample.colors,depth:sample.depth});
    const group=groups.get(target)||new Map();
    group.set(sample.frame,(group.get(sample.frame)||0)+sample.gpuMs);
    groups.set(target,group);
  }
  return {invalidSamples:invalid,completeFrames:Math.max(0,last-first-1),
    targets:[...groups].map(([target,frames])=>({target:JSON.parse(target),
      frames:frames.size,medianMs:quantile([...frames.values()],.5),p95Ms:quantile([...frames.values()],.95)})),
    note:'Isolated profiling includes instrumentation overhead. Invalid and boundary-frame timestamps are excluded. Target totals omit frames where that target was absent. GPU pass intervals can overlap on Metal. These totals are diagnostic spans and cannot be added into a frame budget or treated as exclusive GPU execution time.'};
}
export async function analyzeRun(directory) {
  const run=JSON.parse(await readFile(join(directory,'run.json'),'utf8'));
  const symbols={};
  if(run.environment.symbols){
    const text=await readFile(join(directory,'wasm.symbols'),'utf8');
    for(const line of text.split('\n')){const colon=line.indexOf(':');if(colon>0)symbols[line.slice(0,colon)]=line.slice(colon+1);}
  }
  const profiles=[];
  for(const file of await readdir(directory))if(file.endsWith('.cpuprofile.json')){
    const saved=JSON.parse(await readFile(join(directory,file),'utf8'));
    profiles.push({file,target:saved.target,...analyzeCPU(saved.profile,symbols)});
  }
  const data=await readFile(join(directory,'trace.json.gz'));
  const trace=analyzeTrace(JSON.parse(gunzipSync(data)));
  const report={environment:run.environment,benchmark:summarizeBenchmarks(run.benchmarks),
    detailedSamples:run.detailedSamples,shadowCounts:run.shadowCounts,shadowState:run.shadowState,
    grassFilterFixture:run.grassFilterFixture,gpuPasses:summarizeGpuPasses(run.gpuPasses),trace:{...trace,dataLossOccurred:run.trace.dataLossOccurred||false,categories:run.trace.categories},profiles,
    cautions:['Benchmark windows have tracing and detailed profiling disabled.',
      'CPU profile inclusive totals overlap. Worker work can run in parallel.',
      'Trace spans include waits and scheduling. They do not measure CPU utilization.',
      'GPU trace events include CPU-side submissions. Hardware GPU timing uses the renderer timestamp-query span.']};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [directory,candidate]=process.argv.slice(2);
  if(!directory)throw Error('Usage: node analyze.mjs RUN_DIRECTORY [CANDIDATE_DIRECTORY]');
  const report=await analyzeRun(resolve(directory));
  console.log(JSON.stringify(candidate?compareRuns(report,await analyzeRun(resolve(candidate))):report,null,2));
}
