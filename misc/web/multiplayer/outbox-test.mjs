import {bindOwnedState} from './owned-state.mjs';
import {loadIdentity,listEntities,transferEntity} from './identity.mjs';
import {DurableOutbox} from './outbox.mjs';import {ZoneClient} from './client.mjs';
const $=id=>document.getElementById(id),log=text=>{$('results').textContent+=text+'\n';};
let a,b,clients=[];const close=()=>{clients.forEach(c=>c.close());clients=[];};addEventListener('pagehide',close);
async function identities(){a=await loadIdentity('outbox-test-a');b=await loadIdentity('outbox-test-b');$('principals').textContent='A: '+a.principalId+'\nB: '+b.principalId;}
async function until(fn){const start=performance.now();while(!fn()){if(performance.now()-start>10000)throw Error('Notification timed out');await new Promise(r=>setTimeout(r,25));}}
async function connect(){const contract=(await (await fetch('/world.json')).json()).contract;for(const identity of [a,b]){const client=new ZoneClient();clients.push(client);await client.connect({contract,identitySecret:identity.secret});client.ownedState=bindOwnedState(client,identity);}await until(()=>clients.every(c=>c.ownershipVersion>0&&c.ownedState.ready&&!c.ownedState.stale));}
async function run(fn){for(const id of ['prepare','lose','recover'])$(id).disabled=true;$('status').textContent='Running';$('results').textContent='';try{await identities();await fn();$('status').textContent='PASS';}catch(error){$('status').textContent='FAIL';log(error.message);}finally{close();for(const id of ['prepare','lose','recover'])$(id).disabled=false;}}
$('prepare').onclick=()=>run(async()=>{log('Provision one fixture for principal A through trusted server test setup.');});
$('lose').onclick=()=>run(async()=>{
 await connect();const entity=(await listEntities(a)).entities[0];if(!entity)throw Error('Missing trusted fixture');const versions=clients.map(c=>c.ownershipVersion);
 const box=new DurableOutbox(a,{send:async(kind,command)=>{if(kind!=='transfer')throw Error('Unexpected kind');const result=await transferEntity(a,command);if(result.status!=='committed')throw Error('Transfer rejected');throw Error('Simulated lost reply after commit');}});
 const item=await box.enqueue('transfer',{entityId:entity.id,recipient:b.principalId,expectedRevision:entity.revision});
 localStorage.setItem('zone-outbox-test-expected',JSON.stringify({entityId:entity.id,revision:entity.revision+1,requestId:item.command.requestId}));
 try{await box.flush();throw Error('Reply was not lost');}catch(error){if(error.message!=='Simulated lost reply after commit')throw error;}
 if((await box.entries())[0].result!==null)throw Error('Uncertain outcome was discarded');
 await until(()=>clients.every((c,i)=>c.ownershipVersion>versions[i]));
 if((await listEntities(a)).entities.some(e=>e.id===entity.id)||!(await listEntities(b)).entities.some(e=>e.id===entity.id))throw Error('Committed ownership mismatch');
 await until(()=>!clients[0].ownedState.stale&&!clients[1].ownedState.stale&&!clients[0].ownedState.snapshot().entities.some(e=>e.id===entity.id)&&clients[1].ownedState.snapshot().entities.some(e=>e.id===entity.id));
 log('PASS · both live WebRTC sessions received ownership invalidation');log('PASS · complete owned-state views reconciled the transfer');log('PASS · committed transfer remains pending after lost reply');log('Reload this page (optionally restart server), then recover.');
});
$('recover').onclick=()=>run(async()=>{
 const expected=JSON.parse(localStorage.getItem('zone-outbox-test-expected')||'null');if(!expected)throw Error('Run lost-reply test first');
 await connect();const box=new DurableOutbox(a);const pending=await box.entries();if(!pending.some(i=>i.command.requestId===expected.requestId&&i.result===null))throw Error('Pending request did not survive reload');
 const outcomes=await box.flush(),outcome=outcomes.find(i=>i.command.requestId===expected.requestId);if(outcome.result.status!=='committed'||outcome.result.revision!==expected.revision)throw Error('Original outcome not recovered');
 const entities=(await listEntities(b)).entities.filter(e=>e.id===expected.entityId);if(entities.length!==1||entities[0].revision!==expected.revision)throw Error('Duplicate effect or wrong ownership');
 await box.acknowledge(expected.requestId);if((await box.entries()).length)throw Error('Acknowledged command remained');
 log('PASS · pending command survived page reload');log('PASS · original committed outcome recovered without a second transfer');log('PASS · reconnect invalidation and explicit consumer acknowledgement');
});
