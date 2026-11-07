// Stage an explicitly selected experimental build without touching SP dist.
import {readFile,writeFile,mkdir,copyFile,cp,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {attachMultiplayerLoader} from './loader-hooks.mjs';
const repo=resolve(import.meta.dirname,'../../..');
const [engineArg,outputArg]=process.argv.slice(2);
if(!engineArg||!outputArg)throw Error('Usage: stage.mjs BUILD_ARTIFACTS OUTPUT_PARENT');
const engine=resolve(engineArg),output=resolve(outputArg),production=join(repo,'misc/web/dist');
if(output===production||output.startsWith(production+'/'))throw Error('Multiplayer output must be outside single-player dist');
const caps=JSON.parse(await readFile(join(engine,'capabilities.json'),'utf8'));
if(caps.mode!=='multiplayer-development'||caps.bridgeAbi!==1)throw Error('Not a compatible experimental engine');
const raw=join(output,'raw'),web=join(output,'engine-preview');await mkdir(raw,{recursive:true});
await cp(join(repo,'misc/web/page'),raw,{recursive:true});
for(const name of ['xr_3da.js','xr_3da.wasm'])await copyFile(join(engine,name),join(raw,name));
const loader=join(raw,'xr_3da.js');await writeFile(loader,(await readFile(loader,'utf8')).replaceAll('proto,null,','proto,0,'));
await copyFile(join(production,'engine_data.json'),join(raw,'engine_data.json'));
await copyFile(join(repo,'misc/web/streaming/chunk-reader.mjs'),join(raw,'chunk-reader.mjs'));
try{await symlink(join(production,'engine-assets'),join(output,'engine'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
execFileSync(process.execPath,[join(repo,'misc/web/webgpu/stage.mjs')],{env:{...process.env,XRAY_WEB_DIST_INPUT:raw,XRAY_WEB_OUTPUT:web},stdio:'inherit'});
for(const name of ['access-test.html','access-test.mjs','owned-state.mjs','outbox.mjs','identity.mjs','network-faults.mjs','combat-scenario.mjs','combat-test.html','combat-test.mjs','lifecycle.mjs','load-test.html','load-test.mjs','prediction.mjs','content.mjs','client.mjs','protocol.mjs','contract.mjs','contract.json','engine-bridge.mjs','engine-abi.mjs','pthread-bridge.mjs','storage.mjs','engine-preview.mjs'])await copyFile(join(import.meta.dirname,name),join(web,name));
await copyFile(join(import.meta.dirname,'engine-preview.html'),join(web,'index.html'));
await copyFile(join(engine,'capabilities.json'),join(web,'capabilities.json'));
await writeFile(join(web,'xr_3da.js'),attachMultiplayerLoader(await readFile(join(web,'xr_3da.js'),'utf8')));
await copyFile(join(repo,'server/prediction/target/wasm32-unknown-unknown/release/zone_prediction.wasm'),join(web,'zone_prediction.wasm'));
console.log('Isolated multiplayer engine preview:',web);
