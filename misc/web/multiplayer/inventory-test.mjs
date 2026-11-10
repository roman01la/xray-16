import {ZoneClient} from './client.mjs';
import {InventoryClient} from './inventory.mjs';
import {loadIdentity} from './identity.mjs';
const $=id=>document.getElementById(id),log=s=>{$('results').textContent+=s+'\n';},pause=ms=>new Promise(r=>setTimeout(r,ms));
const expect=(condition,message)=>{if(!condition)throw Error(message);};
const until=async(fn,ms=15000)=>{const start=performance.now();while(!await fn()){if(performance.now()-start>ms)throw Error('Timed out waiting for scenario state');await pause(60);}};
let clients=[];const stop=()=>{for(const c of clients)c.close();clients=[];};addEventListener('pagehide',stop);
const self=c=>c.snapshot?.entities.find(e=>e.id===c.playerId),owned=(c,id)=>c.inventory.view.items.find(i=>i.id===id);
const starterSections=['ammo_5.45x39_fmj','ammo_9x18_fmj','bandage','bolt','bread','device_pda','device_torch','wpn_ak74','wpn_knife','wpn_pm'];
const hasStarterKit=c=>c.inventory.view.items.map(i=>i.section).sort().join(',')===starterSections.join(',');
async function connect(slot,world){
 const identity=await loadIdentity(slot),client=new ZoneClient();clients.push(client);
 await client.connect({contract:world.contract,identitySecret:identity.secret});
 client.inventory=new InventoryClient(client,{principal:identity.principalId,onError:e=>log('Refresh: '+e.message)});
 await client.inventory.recover();await until(()=>!!self(client));return client;
}
async function run(action){$('run').disabled=$('verify').disabled=true;$('results').textContent='';$('status').textContent='Running';try{await action();$('status').textContent='PASS';}catch(e){$('status').textContent='FAIL';log(e.stack||e.message);}finally{stop();$('run').disabled=$('verify').disabled=false;}}
$('run').onclick=()=>run(async()=>{
 const fixture=await (await fetch('./inventory-fixture.json')).json(),world=await (await fetch('/world.json')).json();
 expect(world.survival,'Survival mode is not enabled');
 const slots=['inv-a-'+fixture.item.slice(0,8),'inv-b-'+fixture.item.slice(0,8)],a=await connect(slots[0],world),b=await connect(slots[1],world);
 expect(hasStarterKit(a)&&hasStarterKit(b),'Starter grants missing');log('PASS · both identities received exactly one starter kit');
 const command={requestId:crypto.randomUUID().replaceAll('-',''),life:0,item:fixture.item,revision:0,action:{kind:'pickup',source:fixture.source}};
 const other={...command,requestId:crypto.randomUUID().replaceAll('-','')};
 const results=await Promise.all([a.moveInventory(command),b.moveInventory(other)]);
 expect(results.filter(r=>r.status==='committed').length===1,'Competing pickup did not have exactly one winner');
 const winner=results[0].status==='committed'?a:b,loser=winner===a?b:a,original=winner===a?command:other;
 await Promise.all([a.inventory.refresh(),b.inventory.refresh()]);expect(!!owned(winner,fixture.item)&&!owned(loser,fixture.item),'Private inventory ownership mismatch');log('PASS · shared pickup had one winner and private contents stayed isolated');
 let result=await winner.inventory.move(owned(winner,fixture.item),{kind:'place',placement:{kind:'slot',slot:3}});expect(result.status==='committed','Equip failed');expect(owned(winner,fixture.item).place==='slot:3','Placement was not reconciled');
 result=await winner.inventory.move(owned(winner,fixture.item),{kind:'drop'});expect(result.status==='committed','Drop failed');
 const dropped={id:fixture.item,revision:result.revision};
 expect((await loser.inventory.move(dropped,{kind:'pickup',source:result.container})).status==='committed','Re-loot failed');
 const replay=await winner.moveInventory(original);expect(JSON.stringify(replay)===JSON.stringify(results[winner===a?0:1]),'Durable replay result changed');await winner.inventory.refresh();expect(!owned(winner,fixture.item),'Replayed pickup duplicated item');log('PASS · equip/drop/re-loot and replay preserved one item');
 a.setInput({x:1,sprint:true});b.setInput({x:1,sprint:true});await until(()=>self(a).x>14&&self(b).x>14);a.setInput({});b.setInput({});await until(()=>Math.abs(self(a).vx)<0.01&&Math.abs(self(b).vx)<0.01);
 const beforeDeath=owned(loser,fixture.item);
 for(let i=0;i<4;i++){const damage=await winner.attack(loser.playerId);expect(damage.applied!==undefined||damage.health!==undefined||typeof damage==='object','Fixture damage failed');await pause(550);}
 await until(async()=>{await loser.inventory.refresh();return !loser.inventory.view.alive;});
 expect(loser.inventory.view.items.length===0,'Death retained carried items');const corpse=loser.inventory.view.corpse;expect(typeof corpse==='string','Missing durable corpse');
 const victimSlot=slots[loser===a?0:1];loser.close();await until(async()=>(await (await fetch('/metrics')).json()).metrics.players===1);
 const recovered=await connect(victimSlot,world);expect(!recovered.inventory.view.alive&&recovered.inventory.view.items.length===0,'Reconnect reversed death');log('PASS · full-loss death and reconnect retain the dead life');
 const early=await recovered.respawn();expect(early.reason==='respawn_delay','Respawn delay was bypassed');
 $('status').textContent='Waiting for configured respawn delay';await pause(10500);
 const respawn=await recovered.respawn();expect(respawn.status==='respawned','Durable respawn failed');expect(recovered.inventory.view.life===1&&hasStarterKit(recovered),'Respawn kit/life mismatch');
 expect((await winner.inventory.move({id:fixture.item,revision:beforeDeath.revision+1},{kind:'pickup',source:corpse})).status==='committed','Corpse re-loot failed');log('PASS · delayed respawn grants a new kit; old equipment stays on the corpse');
 const saved={fixture,slots,views:{[winner===a?slots[0]:slots[1]]:winner.inventory.view,[victimSlot]:recovered.inventory.view}};
 localStorage.setItem('zone-inventory-acceptance',JSON.stringify(saved));log('Saved expected durable inventories for server restart verification');
});
$('verify').onclick=()=>run(async()=>{
 const saved=JSON.parse(localStorage.getItem('zone-inventory-acceptance')||'null');expect(saved,'Run scenario first');const world=await (await fetch('/world.json')).json();
 for(const slot of saved.slots){const c=await connect(slot,world),actual=c.inventory.view,expected=saved.views[slot];expect(actual.life===expected.life&&actual.alive===expected.alive&&JSON.stringify(actual.items)===JSON.stringify(expected.items),'Restart inventory mismatch for '+slot);}
 log('PASS · both identities, life counters, exact item IDs, equipment and item state survived server restart');
});
