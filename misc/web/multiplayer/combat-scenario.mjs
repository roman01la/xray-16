// Shared by the transport harness and the real engine's explicit test control.
const self=c=>c.snapshot?.entities.find(e=>e.id===c.playerId);
const aimAt=(a,b)=>{const p=self(a),q=self(b),dx=q.x-p.x,dz=q.z-p.z;return {tick:a.snapshot.tick,yaw:Math.atan2(dx,dz),pitch:Math.atan2(q.y+.9-p.y-1.55,Math.hypot(dx,dz))};};
export async function runCombatScenario(a,b,{until,log,phase=()=>{}}){
 const expect=(value,condition,label)=>{log(label+': '+JSON.stringify(value));if(!condition(value))throw Error(label);};
 await until(()=>self(a)&&self(b)&&a.weapon&&b.weapon);
 if(!(self(a).flags&1)||!(self(b).flags&1))throw Error('Both test players must start in the spawn safe zone');
 phase('Safe-zone checks');
 expect(await a.fire({tick:a.snapshot.tick,yaw:0,pitch:0}),r=>r.reason==='safe_zone','Safe-zone shooter rejected');
 expect(await a.attack(b.playerId),r=>r==='unsupported_action','Legacy target-only damage disabled on map');
 const startX=self(a).x;a.setInput({x:1,sprint:true});b.setInput({x:1,sprint:true});
 phase('Moving both players outside the safe zone');
 await until(()=>self(a).x>startX+14);a.setInput({});
 await until(()=>self(b).x>startX+19);b.setInput({});
 await until(()=>Math.abs(self(a).vx)<.01&&Math.abs(self(b).vx)<.01);
 log('Positions: '+JSON.stringify({a:self(a),b:self(b)}));
 let tick=a.snapshot.tick;
 for(const health of [65,30,0]){
  if(health!==65)await until(()=>((a.snapshot.tick-tick)>>>0)>=8);
  expect(await a.fire(aimAt(a,b)),r=>r.status==='hit'&&r.target===b.playerId&&r.health===health,'Authoritative hit');
  tick=a.snapshot.tick;await until(()=>self(b).health===health);
  if(health===65){
   expect(await a.fire(aimAt(a,b)),r=>r.reason==='cooldown','Duplicate rapid shot rejected');
   phase('Server-timed reload');expect(await a.reload(),r=>r.status==='started','Reload started');
   expect(await a.reload(),r=>r.reason==='reloading','Reload cannot restart its timer');
   expect(await a.fire(aimAt(a,b)),r=>r.reason==='reloading','Fire during reload rejected');
   await until(()=>a.weapon.ammo===30&&a.weapon.reserve===89&&a.weapon.reloadReadyTick===null);
   log('PASS · reload transferred one round after the server timer');
  }
 }
 phase('Victim dead · respawn delay');
 expect(await b.fire(aimAt(b,a)),r=>r.reason==='dead','Dead shooter rejected');
 expect(await b.respawn(),r=>r.reason==='respawn_delay','Early respawn rejected');
 expect(await a.fire({...aimAt(a,b),tick:(a.snapshot.tick+100)>>>0}),r=>r.reason==='invalid_tick','Future rewind rejected');
 const before={...self(b)},deathTick=b.snapshot.tick;b.setInput({x:1,sprint:true});
 await until(()=>((b.snapshot.tick-deathTick)>>>0)>=12);
 if(Math.hypot(self(b).x-before.x,self(b).z-before.z)>.001)throw Error('Dead player moved');b.setInput({});log('PASS · dead player input cannot move the body');
 await until(()=>((b.snapshot.tick-deathTick)>>>0)>=94);
 const result=await b.respawn();expect(result,r=>r.status==='respawned','Server-selected respawn');
 await until(()=>self(b).health===100&&(self(b).flags&1)&&a.snapshot.entities.some(e=>e.id===result.corpse&&e.health===0));
 expect(await b.respawn(),r=>r.reason==='alive','Living player cannot duplicate a corpse');
 const protectedAim=aimAt(b,a),sentAt=performance.now();
 log('Post-respawn aim timing: '+JSON.stringify({tick:protectedAim.tick,snapshotAgeMs:sentAt-b.snapshot.receivedAt}));
 const protectedResult=await b.fire(protectedAim);
 log('Post-respawn reply timing: '+JSON.stringify({elapsedMs:performance.now()-sentAt,currentSnapshot:b.snapshot.tick}));
 expect(protectedResult,r=>r.reason==='safe_zone','Respawned player is protected');
 phase('Respawn complete · dead body retained until server expiry');
 log('PASS · corpse has its own ID and player returned to validated safe spawn');
 await until(()=>!a.snapshot.entities.some(e=>e.id===result.corpse),45000);
 log('PASS · server expired corpse');
 if(a.impairment)log('Application delivery impairment: '+JSON.stringify({settings:a.impairment,clients:[a,b].map(c=>({up:c.upQueue.stats,down:c.downQueue.stats,resyncs:c.stats.resyncs}))}));
 b.close();await until(()=>!a.snapshot.entities.some(e=>e.id===b.playerId));log('PASS · disconnected player removed');
 phase('PASS · weapon, reload, death, corpse and respawn cycle');
}
