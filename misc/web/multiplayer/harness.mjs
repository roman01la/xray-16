import {BrowserEngineBridge} from './engine-bridge.mjs';
import {ZoneClient} from './client.mjs';
const $=s=>document.querySelector(s), status=$('#status'), results=$('#results'), canvas=$('#world'), ctx=canvas.getContext('2d');
let clients=[],running=false;const keys=new Set();
const log=s=>{results.textContent+=s+'\n';};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,ms=8000){const start=performance.now();while(!test()){if(performance.now()-start>ms)throw new Error('Timed out waiting for server state');await delay(50);}}
const self=c=>c.snapshot?.entities.find(e=>e.id===c.playerId);
function disconnect(){clients.forEach(c=>c.close());clients=[];keys.clear();status.textContent='Offline';}
async function ready(){
  disconnect();results.textContent='';status.textContent='Connecting two independent WebRTC peers…';
  try {
    for(let i=0;i<2;i++){const c=new ZoneClient();clients.push(c);await c.connect({token:$('#token').value});}
    await until(()=>clients.every(c=>clients.every(other=>c.snapshot?.entities.some(e=>e.id===other.playerId))));
    status.textContent=`Connected · players ${clients.map(c=>c.playerId).join(' & ')} · Rust authority`;
    log('PASS · two real WebRTC peers connected and see each other');
    log(`State channel: ordered=${clients[0].state.ordered}, maxRetransmits=${clients[0].state.maxRetransmits}`);
  } catch(error){disconnect();throw error;}
}
async function tests(){
  await ready();const [a,b]=clients;
  if(a.state.ordered || a.state.maxRetransmits!==0)throw new Error('Incorrect state channel semantics');
  if(await a.attack(b.playerId)!=='safe_zone')throw new Error('Safe zone allowed damage');
  log('PASS · server rejects PvP inside safe zone');
  a.setInput({x:1,sprint:true});b.setInput({x:1,sprint:true});
  await until(()=>self(a)?.x>13 && self(b)?.x>13);a.setInput({});b.setInput({});await delay(200);
  if(Math.abs(self(a).x-self(b).x)>3)throw new Error('Players too far apart');
  log('PASS · both players moved outside safe zone from input only');
  const hit=await a.attack(b.playerId);if(hit?.applied?.health!==75)throw new Error(`PvP result ${JSON.stringify(hit)}`);
  await until(()=>self(b)?.health===75);log('PASS · authoritative PvP damage replicated (100 → 75)');
  if(await a.attack(b.playerId)!=='cooldown')throw new Error('Attack cooldown bypassed');
  log('PASS · server rejects attack during cooldown');
  const npc=a.snapshot.entities.find(e=>e.kind===2);if(!npc)throw new Error('Missing NPC');
  a.setInput({x:1,sprint:true});await until(()=>self(a)?.x>28);a.setInput({});await delay(200);
  const npcHit=await a.attack(npc.id);if(!npcHit?.applied)throw new Error(`NPC damage ${JSON.stringify(npcHit)}`);
  log('PASS · same damage policy applies to stationary NPC');
  b.close();await until(()=>!a.snapshot.entities.some(e=>e.id===b.playerId));
  log('PASS · disconnected player removed from snapshots');
  status.textContent='All integration tests passed · player A remains connected';
}
async function loadTest(){
  disconnect();results.textContent='';status.textContent='Connecting 200 real WebRTC peers…';
  const token=$('#token').value;
  try {
    for(let start=0;start<200;start+=8){
      const batch=Array.from({length:Math.min(8,200-start)},()=>new ZoneClient());clients.push(...batch);
      await Promise.all(batch.map(c=>c.connect({token})));
      status.textContent=`Connected ${clients.length}/200 peers…`;
    }
    await until(()=>clients.every(c=>c.snapshot?.entities.filter(e=>e.kind===1).length===200),15000);
    log('PASS · 200 real browser WebRTC peers, each receiving all 200 players');
    const read=async()=>{const r=await fetch('/metrics',{headers:token?{Authorization:`Bearer ${token}`}:{}});if(!r.ok)throw new Error('Metrics unavailable');return (await r.json()).metrics;};
    const before=await read(),start=performance.now();await delay(10000);const after=await read(),seconds=(performance.now()-start)/1000;
    const stale=clients.filter(c=>!c.snapshot || performance.now()-c.snapshot.receivedAt>1000).length;
    const summary={seconds:Number(seconds.toFixed(2)),sessions:after.sessions,staleClients:stale,ticksPerSecond:Number(((after.ticks-before.ticks)/seconds).toFixed(2)),sentMiBPerSecond:Number(((after.sent_bytes-before.sent_bytes)/seconds/1048576).toFixed(2)),udpDrops:after.udp_drops-before.udp_drops,skippedSnapshots:after.skipped_snapshots-before.skipped_snapshots,lateTicks:after.late_ticks-before.late_ticks,maxReplicationMs:after.max_replication_us/1000};
    log(JSON.stringify(summary,null,2));
    if(stale || after.sessions!==200)throw new Error('Peers lost connectivity or fresh snapshots under load');
    log('PASS · all 200 peers still receiving fresh complete snapshots after 10 seconds');
    disconnect();status.textContent='200-peer loopback test complete · all test peers disconnected';
  } catch(error){disconnect();throw error;}
}
async function bridgeTest(){
  disconnect();results.textContent='';status.textContent='Testing WebRTC → browser → engine-worker bridge…';
  const client=new ZoneClient();clients.push(client);await client.connect({token:$('#token').value});
  const incompatible=new ZoneClient();
  let rejected=false;
  try {await incompatible.connect({token:$('#token').value,contract:{...client.contract,world:'zaton'}});}
  catch(error){if(!/contract mismatch/.test(error.message))throw error;rejected=true;}
  finally{incompatible.close();}
  if(!rejected)throw new Error('Synthetic server accepted a Zaton client');
  log('PASS · Rust rejects an incompatible Zaton session before joining');
  const worker=new Worker('./bridge-probe-worker.mjs',{type:'module'}),channel=new MessageChannel(),epoch=crypto.randomUUID();
  const bridge=new BrowserEngineBridge(client,channel.port1,{epoch});
  try {
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker probe timed out')),15000);
      worker.onmessage=({data})=>{if(data.type==='result'){clearTimeout(timer);data.ok?resolve(data):reject(new Error(data.error));}};
      worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};
      worker.postMessage({type:'probe',epoch,contract:client.contract,port:channel.port2},[channel.port2]);
    });
    log('PASS · strict world contract accepted by Rust, browser and worker');
    log(`PASS · paused worker skipped stale frames: tick ${result.firstTick} → ${result.latestTick}`);
    log(`PASS · worker input moved server-owned player ${result.movedMetres.toFixed(2)} m`);
    log('PASS · reliable action and rejection result crossed both worker boundaries');
    log('This is a real worker transport test; the X-Ray C++ actor adapter is still pending.');
    status.textContent='Engine-worker bridge tests passed';
  } finally {worker.terminate();bridge.close();clients=[];}
}
async function action(fn){if(running)return;running=true;$('#connect').disabled=$('#test').disabled=$('#load').disabled=$('#bridge').disabled=$('#disconnect').disabled=true;try{await fn();}catch(e){status.textContent='Test failed';log(`FAIL · ${e.message}`);clients.forEach(c=>c.setInput({}));}finally{running=false;$('#connect').disabled=$('#test').disabled=$('#load').disabled=$('#bridge').disabled=$('#disconnect').disabled=false;}}
$('#bridge').onclick=()=>action(bridgeTest);$('#load').onclick=()=>action(loadTest);$('#connect').onclick=()=>action(ready);$('#test').onclick=()=>action(tests);$('#disconnect').onclick=()=>{if(!running)disconnect();};
function updateInput(){if(!running)clients[0]?.setInput({x:Number(keys.has('d'))-Number(keys.has('a')),z:Number(keys.has('s'))-Number(keys.has('w')),sprint:keys.has('shift')});}
window.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement)return;if(['w','a','s','d','shift'].includes(e.key.toLowerCase())){e.preventDefault();keys.add(e.key.toLowerCase());updateInput();}});
window.addEventListener('keyup',e=>{keys.delete(e.key.toLowerCase());updateInput();});window.addEventListener('blur',()=>{keys.clear();updateInput();});window.addEventListener('pagehide',disconnect);
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);const scale=9,ox=270,oz=190;
  ctx.strokeStyle='#24383a';ctx.lineWidth=1;
  for(let x=0;x<1080;x+=45){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,380);ctx.stroke();}for(let z=10;z<380;z+=45){ctx.beginPath();ctx.moveTo(0,z);ctx.lineTo(1080,z);ctx.stroke();}
  ctx.fillStyle='#315c403f';ctx.strokeStyle='#75ad80';ctx.beginPath();ctx.arc(ox,oz,90,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#a3cbae';ctx.font='13px system-ui';ctx.fillText('SAFE ZONE',ox-38,oz-100);
  for(const e of clients[0]?.snapshot?.entities||[]){const x=ox+e.x*scale,z=oz+e.z*scale;ctx.fillStyle=e.kind===2?'#e8b66e':e.id===clients[0].playerId?'#aff5db':'#9ab9ff';if(e.kind===2)ctx.fillRect(x-6,z-6,12,12);else{ctx.beginPath();ctx.arc(x,z,6,0,Math.PI*2);ctx.fill();}ctx.fillText(`${e.kind===2?'NPC':e.id===clients[0].playerId?'A':'B'} · ${e.health} HP`,x-15,e.kind===2 || e.id!==clients[0].playerId ? z+24 : z-14);}
  requestAnimationFrame(draw);
}draw();
setInterval(async()=>{try{const r=await fetch('/metrics',{headers:$('#token').value?{Authorization:`Bearer ${$('#token').value}`}:{}});$('#metrics').textContent=JSON.stringify(await r.json(),null,2);}catch{}},2000);
