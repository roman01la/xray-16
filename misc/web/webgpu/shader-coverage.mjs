// Run locally against private capture exports. Report never includes shader sources.
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {shaderKey} from './shader-key.js';
import {compileProgram} from './compiler-core.mjs';
import {SHADER_CACHE_VERSION,validateProgram} from './shader-cache.mjs';
import {createWasmToolchain} from './wasm-toolchain.mjs';
import {describeShaderRequest} from './shader-capture.mjs';

const artifactName = /^[a-f0-9]{64}\.json$/;
const defaultPackage = resolve(fileURLToPath(new URL('./shaders/',import.meta.url)));
const namePattern = /^[a-z0-9_-]{1,64}$/i;

function checkedRecord(record) {
  const {request,key,inManifest,outcome} = record ?? {};
  if (!request?.sources || typeof request.sources.frag !== 'string' ||
      typeof request.sources.vert !== 'string' || Object.keys(request.sources).length !== 2 ||
      !Array.isArray(request.attributes) || request.attributes.length ||
      typeof inManifest !== 'boolean' || !['loaded','error'].includes(outcome) ||
      shaderKey(request) !== key) {
    throw Error('Malformed native shader capture record');
  }
  return record;
}

export function compareCaptures(captures, packagedKeys) {
  const byKey = new Map(), runs = new Map();
  for (const capture of captures) {
    if (capture.version !== 1 || capture.compiler !== SHADER_CACHE_VERSION ||
        !namePattern.test(capture.run?.id ?? '') || !Array.isArray(capture.records) ||
        runs.has(capture.run.id)) throw Error('Invalid, duplicate or incompatible shader capture');
    const run = capture.run;
    const summary = {...run, requested:0, missing:0, recordedMissing:0, failures:0, options:[]};
    runs.set(run.id, summary);
    const seen = new Set(), options = new Set();
    for (const record of capture.records) {
      const {key,request,inManifest,outcome} = checkedRecord(record);
      if (seen.has(key)) throw Error('Duplicate key in capture '+run.id);
      seen.add(key);
      if (!byKey.has(key)) byKey.set(key, {request,stages:describeShaderRequest(request),runs:[],recordedInManifest:false,loaded:false});
      const group = byKey.get(key);
      group.runs.push(run.id);
      group.recordedInManifest ||= inManifest;
      group.loaded ||= outcome === 'loaded';
      for (const stage of Object.values(group.stages)) for (const option of stage.options) options.add(option);
      summary.requested++;
      summary.missing += Number(!packagedKeys.has(key));
      summary.recordedMissing += Number(!inManifest);
      summary.failures += Number(outcome === 'error');
    }
    summary.options = [...options].sort();
  }
  const missing = [];
  for (const key of [...byKey.keys()].sort()) {
    if (packagedKeys.has(key)) continue;
    const {stages,loaded,recordedInManifest,runs} = byKey.get(key);
    missing.push({key,stages,loaded,recordedInManifest,runs:runs.sort()});
  }
  return {
    report:{version:1, compiler:SHADER_CACHE_VERSION, packageKeys:packagedKeys.size,
      requestedKeys:byKey.size, missingKeys:missing.length,
      runs:[...runs.values()].sort((a,b)=>a.id.localeCompare(b.id)), missing},
    byKey,
  };
}

async function main() {
  const {values,positionals} = parseArgs({
    options:{package:{type:'string'},report:{type:'string'},replay:{type:'string'},check:{type:'boolean'}},
    allowPositionals:true,
  });
  if (!positionals.length)
    throw Error('Usage: node shader-coverage.mjs capture.json [...] [--package DIR] [--report FILE] [--replay DIR] [--check]');
  const packaged = await realpath(resolve(values.package ?? defaultPackage));
  const keys = new Set();
  for (const name of (await readdir(packaged)).sort()) {
    if (!artifactName.test(name)) continue;
    const key = name.slice(0,-5);
    validateProgram(JSON.parse(await readFile(join(packaged,name),'utf8')),key);
    keys.add(key);
  }
  if (!keys.size) throw Error('Shader package directory has no artifacts');
  const captures = await Promise.all(positionals.map(async file=>JSON.parse(await readFile(file,'utf8'))));
  const {report,byKey} = compareCaptures(captures,keys);
  if (values.replay) {
    const output = resolve(values.replay);
    await mkdir(output,{recursive:true});
    const dest = await realpath(output);
    if (dest === packaged || dest === await realpath(defaultPackage))
      throw Error('Replay output must be separate from the selected and checked-in shader packages');
    let toolchain;
    let passed = 0;
    const failures = [];
    for (const {key,loaded} of report.missing) {
      // A failed engine request is diagnostic only, never a promotion candidate.
      if (!loaded) {
        failures.push({key,error:'No successful engine load recorded'});
        continue;
      }
      try {
        toolchain ??= await createWasmToolchain({nagaBytes:await readFile(new URL('./compiler-wasm/naga.wasm',import.meta.url))});
        const program = validateProgram(await compileProgram(byKey.get(key).request,toolchain),key);
        await writeFile(join(dest,key+'.json'),JSON.stringify(program));
        passed++;
      } catch (error) { failures.push({key,error:String(error)}); }
    }
    report.replay = {passed,failures};
    if (failures.length) process.exitCode = 1;
  }
  if (values.report) await writeFile(resolve(values.report),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({package:report.packageKeys,requested:report.requestedKeys,
    missing:report.missingKeys,runs:report.runs.map(({options,...run})=>run),replay:report.replay&&{
      passed:report.replay.passed,failures:report.replay.failures.length}},null,2));
  if (values.check && (report.missingKeys || report.runs.some(run=>run.failures))) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
