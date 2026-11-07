import {bindOwnedState} from './owned-state.mjs';
import {DurableOutbox} from './outbox.mjs';
import {loadIdentity} from './identity.mjs';
import {faultOptions} from './network-faults.mjs';
import {runCombatScenario} from './combat-scenario.mjs';
import {validateWorld} from './content.mjs';
import {ZoneClient} from './client.mjs';
import {createPthreadBridge} from './pthread-bridge.mjs';
import {prepareMultiplayerStorage} from './storage.mjs';
import {prepareStreaming,streamingConfig} from './streaming.js';
import {startShaderCompiler} from './shader-compiler-client.mjs';
const $=id=>document.getElementById(id),log=s=>{$('log').textContent=(String($('log').textContent)+s+'\n').slice(-30000);$('log').scrollTop=$('log').scrollHeight;};
let client,bridge,peer,stopped=false;
const checkActive=()=>{if(stopped)throw Error("Preview disconnected");};
const stop=()=>{stopped=true;peer?.close();bridge?.close();client?.close();$('peer').disabled=true;$('combat').disabled=true;$('status').textContent='Disconnected';};
$('disconnect').onclick=stop;
addEventListener('blur',()=>{if(client){client.inputActive=false;client.setInput({});}});
addEventListener('focus',()=>{if(client){client.setInput({});client.inputActive=true;}});addEventListener('pagehide',stop,{once:true});
const wait=async (fn,ms=10000)=>{const start=performance.now();while(!fn()){checkActive();if(performance.now()-start>ms)throw Error('Engine report timed out');await new Promise(r=>setTimeout(r,25));}};
let report=null;
$('peer').onclick=async()=>{
  const baseline=report?.entities;
  $('peer').disabled=true;
  try {
    peer=new ZoneClient();await peer.connect({identitySecret:client.principalId?(await loadIdentity('test-peer')).secret:null,contract:client.contract,impairment:client.impairment});
    await wait(()=>report?.entities===baseline+1);log('PASS · C++ registry sees local player, test peer and NPC');
    peer.close();await wait(()=>report?.entities===baseline);log('PASS · C++ registry removes disconnected peer');
  }catch(e){log('FAIL · '+e.message);}finally{peer?.close();$('peer').disabled=client.closed;}
};
$('combat').onclick=async()=>{
  $('combat').disabled=true;$('peer').disabled=true;
  try{
    peer=new ZoneClient();await peer.connect({identitySecret:client.principalId?(await loadIdentity('test-peer')).secret:null,contract:client.contract,impairment:client.impairment});
    await runCombatScenario(client,peer,{until:wait,log,phase:s=>{$('combat-status').textContent=s;}});
  }catch(e){$('combat-status').textContent='FAIL · '+e.message;log(e.stack||e.message);}
  finally{peer?.close();client?.setInput({});$('combat').disabled=client.closed;$('peer').disabled=client.closed;}
};
const mapPreview=new URLSearchParams(location.search).get('map')==='zaton';
try {
  const capabilities=await (await fetch('./capabilities.json')).json();
  if(capabilities.mode!=='multiplayer-development'||capabilities.bridgeAbi!==1||capabilities.actorAdapter!==false)throw Error('Wrong engine capability manifest for bridge preview');
  if(mapPreview && capabilities.mapPreview!==true)throw Error('Engine does not support map preview');
  const slot=new URLSearchParams(location.search).get('slot')||'default';
  if(!/^[a-z0-9_-]{1,24}$/.test(slot))throw Error('Invalid preview slot');
  const root='zone-engine-preview-'+slot,worker=new Worker('./ingest-worker.js',{type:'module'});
  $('status').textContent='Preparing isolated engine assets…';
  try {await new Promise((resolve,reject)=>{worker.onmessage=({data})=>{if(data.id!==1)return;data.type==='error'?reject(Error(data.error)):resolve();};worker.onerror=e=>reject(Error(e.message));worker.postMessage({id:1,type:'sync-engine-data',root});});}finally{worker.terminate();}
  checkActive();
  const pack=new URLSearchParams(location.search).get('stream');if(!pack)throw Error('A same-origin streaming pack URL is required');
  const streamed=await prepareStreaming(pack,root),opfs=await navigator.storage.getDirectory();
  const layout=await prepareMultiplayerStorage(opfs,root),dir=await opfs.getDirectoryHandle(root);
  const handle=await dir.getFileHandle(layout.configName),original=await (await handle.getFile()).text(),writer=await handle.createWritable();
  await writer.write(streamingConfig(original));await writer.close();
  checkActive();
  $('status').textContent='Connecting to Rust server…';
  const worldResponse=await fetch('/world.json',{cache:'no-store'});if(!worldResponse.ok)throw Error('Cannot read server world');
  const worldData=await worldResponse.json(),world=await validateWorld(worldData);
  const identity=worldData.persistence?await loadIdentity(slot):null;
  if(world.content && !mapPreview)throw Error('Zaton server requires map=zaton');
  client=new ZoneClient();await client.connect({contract:world.contract,identitySecret:identity?.secret,impairment:faultOptions(location.search)});
  if(identity&&client.principalId!==identity.principalId)throw Error('Engine session identity mismatch');
  if(identity){
    $('transfer').disabled=false;
    $('principal').textContent=identity.principalId;log('Persistent principal: '+identity.principalId);client.outbox=new DurableOutbox(identity);
    client.ownedState=bindOwnedState(client,identity,{onError:error=>log('Owned-state refresh pending: '+error.message)});
    client.ownedState.addEventListener('snapshot',event=>log('Owned-state generation '+event.detail.generation+': '+event.detail.entities.length+' records'));
    client.outbox.flush().then(items=>{if(items.length)log('Recovered durable outcomes: '+items.filter(i=>i.result!==null).length+'; awaiting consumer acknowledgement');}).catch(error=>log('Durable recovery pending: '+error.message));
  }checkActive();

  const showWeapon=s=>{$('weapon').textContent=`Ammo ${s.ammo} / ${s.reserve}${s.reloadReadyTick!==null?' · reloading':''}`;};
  client.addEventListener('weapon',event=>showWeapon(event.detail));if(client.weapon)showWeapon(client.weapon);
  client.addEventListener('view',event=>{$('crosshair').hidden=!event.detail;});
  client.addEventListener('action-result',event=>log('Action: '+JSON.stringify(event.detail)));
  if(mapPreview)$('description').textContent=world.content?'Zaton · WASD move · Shift sprint · Space jump · C crouch · V first-person · Mouse aim · F / click fire · R reload · Enter respawn · server authority + shared Rust prediction':'Zaton map-view test · synthetic server movement with visual ground projection';
  if(client.impairment)$('description').textContent+=` · TEST: ${client.impairment.delayMs} ms each way, ${client.impairment.loss*100}% state loss`;
  const epoch=crypto.randomUUID();
  bridge=createPthreadBridge(client,{epoch,onError:e=>log(e.message),onApplied:value=>{report=value;$('persistent').textContent=[...client.lifecycle.entries.values()].filter(e=>e.persistentId&&client.snapshot?.entities.some(v=>v.id===e.id)).map(e=>e.persistentId+' → '+e.id).join(', ');$('status').textContent=`C++ tick ${value.tick} · ${value.entities} entities · ${client.lifecycle.entries.size} metadata${value.prediction?` · prediction ${value.prediction.active?'active':value.prediction.ready?'authority fallback':'warming'} · replay ${value.prediction.replays}`:''}`;const local=client.snapshot?.entities.find(e=>e.id===client.playerId);if(local)$('health').textContent=`Health ${local.health}`;if(local)$('status').textContent+=` · ${local.flags&4?'crouched':'standing'} · ${local.flags&2?'grounded':'airborne'}`;}});
  client.addEventListener('disconnected',()=>{$('status').textContent='Disconnected';$('persistent').textContent='';$('health').textContent='Health —';$('weapon').textContent='';$('peer').disabled=true;$('combat').disabled=true;$('transfer').disabled=true;});
  $('status').textContent='Loading engine…';
  await startShaderCompiler();checkActive();
  const {default:createModule}=await import('./xr_3da.js');
  await createModule({canvas:$('canvas'),zoneBridge:bridge,zoneEpoch:epoch,zoneContract:client.contract,zoneContent:world.content,
    arguments:['-nosplash','-nointro','-nogameintro',...(mapPreview?['-zone_map_preview','-noprefetch','-start','server(zaton/single)','client(localhost)']:['-zone_bridge_only']),'-fsltx',layout.configPath,'-stream_mount',streamed.mount],print:log,printErr:log});
  await wait(()=>report!==null,180000);$('peer').disabled=false;$('combat').disabled=!world.content;
  log('PASS · real engine application pthread validated a Rust server snapshot');
} catch(e){const cancelled=stopped;stop();if(!cancelled){$('status').textContent='Failed: '+e.message;log(e.stack||e.message);}}

$('transfer').onclick=async()=>{
 try{
  if(!client?.ownedState||client.ownedState.stale)throw Error('Owned state unavailable');
  const ids=new Set([...client.lifecycle.entries.values()].map(e=>e.persistentId));
  const entity=client.ownedState.snapshot().entities.find(e=>ids.has(e.id));
  if(!entity)throw Error('No owned visible persistent fixture');
  const item=await client.outbox.enqueue('transfer',{entityId:entity.id,expectedRevision:entity.revision,recipient:$('recipient').value});
  const result=(await client.outbox.flush()).find(i=>i.command.requestId===item.command.requestId);
  if(result.result.status!=='committed')throw Error('Transfer '+result.result.status);
  await client.ownedState.refresh();
  if(client.ownedState.snapshot().entities.some(e=>e.id===entity.id))throw Error('Transferred ownership still present');
  if(![...client.lifecycle.entries.values()].some(e=>e.persistentId===entity.id))throw Error('Ownership changed visibility');
  await client.outbox.acknowledge(item.command.requestId);log('PASS · durable scene transfer; ownership refreshed, scene retained');
 }catch(error){log('FAIL · '+error.message);}
};
