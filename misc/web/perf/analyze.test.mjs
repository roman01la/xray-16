import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCPU,analyzeTrace,summarizeBenchmarks,compareRuns,summarizeGpuPasses} from './analyze.mjs';
test('profile self samples, inclusive calls and matching Wasm symbols',()=>{
 const result=analyzeCPU({startTime:0,endTime:10000,nodes:[
  {id:1,callFrame:{functionName:'(root)'},children:[2,4]},
  {id:2,callFrame:{functionName:'wasm-function[7]'},children:[3]},
  {id:3,callFrame:{functionName:'writeBuffer'}},{id:4,callFrame:{functionName:'(idle)'}},
 ],samples:[2,3,4],timeDeltas:[1000,2000,7000]},{7:'CDetailManager::Render'});
 assert.equal(result.topInclusive.find(x=>x.name==='CDetailManager::Render').ms,3);
 assert.equal(result.topSelf.find(x=>x.name==='CDetailManager::Render').ms,1);
 assert.equal(result.idleSampleMs,7);
});
test('trace unions nested spans without double counting and supports begin/end',()=>{
 const trace={traceEvents:[
  {ph:'M',pid:1,tid:1,name:'thread_name',args:{name:'CrGpuMain'}},
  {ph:'X',pid:1,tid:1,ts:0,dur:100000,name:'RunTask',cat:'gpu'},
  {ph:'X',pid:1,tid:1,ts:10000,dur:50000,name:'Submit',cat:'gpu'},
  {ph:'B',pid:1,tid:1,ts:100000,name:'Dawn'},{ph:'E',pid:1,tid:1,ts:120000},
 ]};
 const result=analyzeTrace(trace);
 assert.equal(result.threads[0].tracedSpanUnionMs,120);
 assert.equal(result.threads[0].thread,'CrGpuMain');
 assert.equal(result.threads[0].longTasks.length,1);
 assert.equal(result.gpuEvents,2);
});
test('comparison rejects mismatched conditions and normalizes work by rendered frames',()=>{
 const a={fps:100,medianMs:10,p95Ms:15,p99Ms:20,frames:100,work:{bytes:1000}};
 const b={...a,frames:200,work:{bytes:2000}};
 assert.equal(summarizeBenchmarks([a,b]).workPerFrame.bytes,10);
 const environment={scenarioHash:'a',configHash:'b',checkpointHash:'c',viewport:{width:1920,height:1080},browser:'Chrome',gpu:'Metal'};
 const before={environment,benchmark:summarizeBenchmarks([a])};
 const after={environment,benchmark:summarizeBenchmarks([{...a,fps:110,medianMs:9}])};
 assert(Math.abs(compareRuns(before,after).fpsChangePercent-10)<1e-9);
 assert.throws(()=>compareRuns(before,{...after,environment:{...environment,configHash:'changed'}}),/configHash/);
});
test('benchmark medians interpolate both middle runs',()=>{
 const sample={fps:40,medianMs:20,p95Ms:40,p99Ms:60,frames:10};
 assert.equal(summarizeBenchmarks([sample,{...sample,fps:44}]).fps,42);
});
test('GPU pass summaries reject unwritten timestamps and partial frames',()=>{
 const sample={kind:'render',colors:['shadow'],gpuMs:2};
 const result=summarizeGpuPasses({samples:[
  {...sample,frame:0,gpuMs:100}, {...sample,frame:1}, {...sample,frame:1,gpuMs:3},
  {...sample,frame:1,gpuMs:-1000}, {...sample,frame:2,gpuMs:null},
  {...sample,frame:2,gpuMs:7}, {...sample,frame:3,gpuMs:100},
 ]});
 assert.equal(result.invalidSamples,2);
 assert.equal(result.completeFrames,2);
 assert.equal(result.targets[0].medianMs,6);
});
