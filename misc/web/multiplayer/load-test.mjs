import {ZoneClient} from './client.mjs';
import {loadIdentity,readRecord} from './identity.mjs';
import {DurableOutbox} from './outbox.mjs';
import {bindOwnedState} from './owned-state.mjs';
import {validateWorld} from './content.mjs';
const $=id=>document.getElementById(id),delay=ms=>new Promise(r=>setTimeout(r,ms));
const options=new URLSearchParams(location.search);
const peerCount=Number(options.get('players')||200),existing=Number(options.get('existing')||0);
if(!Number.isInteger(peerCount)||peerCount<1||peerCount>200||!Number.isInteger(existing)||existing<0||existing>1||peerCount+existing>200)throw Error('Invalid test population');
const secondsLimit=Number(options.get('seconds')||60),spread=options.get('layout')==='spread';
if(!Number.isInteger(secondsLimit)||secondsLimit<30||secondsLimit>1800)throw Error('Invalid duration');
const ownership=options.get('ownership')==='1';
const population=peerCount+existing;
$('start').textContent=`Run ${peerCount}-peer moving test`;
$('description').textContent=`${peerCount} WebRTC test clients + ${existing} existing engine client; ${secondsLimit} seconds of ${spread?'spread':'crowded'} movement on the negotiated server world.`;
let clients=[],cancelled=false,running=false;
function stop(){cancelled=true;clients.forEach(c=>c.close());clients=[];}
$('stop').onclick=stop;addEventListener('pagehide',stop);
const metrics=async()=>{const r=await fetch('/metrics');if(!r.ok)throw Error('Metrics unavailable');return r.json();};
$('start').onclick=async()=>{
 if(running)return;running=true;cancelled=false;$('start').disabled=true;$('results').textContent='';
 const diagnostics={longTasks:0,maxLongTaskMs:0,maxTimerGapMs:0,largeGaps:[],heapSamples:[],heapStartMiB:(performance.memory?.usedJSHeapSize||0)/1048576};
 let timerAt=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();diagnostics.maxTimerGapMs=Math.max(diagnostics.maxTimerGapMs,now-timerAt);timerAt=now;},250);
 const observer=PerformanceObserver.supportedEntryTypes.includes('longtask')?new PerformanceObserver(list=>{for(const e of list.getEntries()){diagnostics.longTasks++;diagnostics.maxLongTaskMs=Math.max(diagnostics.maxLongTaskMs,e.duration);}}):null;
 observer?.observe({entryTypes:['longtask']});
 try{
  if((await metrics()).metrics.players!==existing)throw Error('Unexpected existing player count');
  const worldInfo=await (await fetch('/world.json')).json(),{contract}=await validateWorld(worldInfo);
  for(let count=0;count<peerCount;count+=8){
   if(cancelled)throw Error('Cancelled');
   const batch=Array.from({length:Math.min(8,peerCount-count)},()=>new ZoneClient());clients.push(...batch);
   await Promise.all(batch.map(async(c,i)=>{
    if(worldInfo.persistence){
     c.identity=await loadIdentity('load-'+(count+i));c.outbox=new DurableOutbox(c.identity);
     for(const item of await c.outbox.flush())await c.outbox.acknowledge(item.command.requestId);
     c.revision=(await readRecord(c.identity)).revision;c.startRevision=c.revision;c.writes=0;c.transfers=0;
    }
    c.addEventListener('error',event=>{c.failure=event.detail?.message||'client error';});
    await c.connect({contract,...(c.identity?{identitySecret:c.identity.secret}:{})});
    if(c.identity){c.owned=bindOwnedState(c,c.identity);c.owned.addEventListener('snapshot',()=>{c.lastOwnedFresh=performance.now();});await c.owned.refresh();c.lastOwnedFresh=performance.now();}
   }));$('status').textContent=`Connected ${clients.length}/${peerCount}`;
  }
  const waitStart=performance.now();
  while(!clients.every(c=>c.snapshot?.entities.filter(e=>e.kind===1&&e.health>0).length===population)){
   if(cancelled||performance.now()-waitStart>15000)throw Error('Incomplete initial membership');await delay(100);
  }
  const metadataStart=performance.now();while(!clients.every(c=>c.lifecycle.entries.size===c.snapshot.entities.length)){if(cancelled||performance.now()-metadataStart>15000)throw Error('Incomplete reliable metadata');await delay(100);}
  const before=await metrics(),started=performance.now(),samples=[];let iterations=0,lastSample=started;
  const initialResyncs=clients.reduce((n,c)=>n+c.stats.resyncs,0);
  while(performance.now()-started<secondsLimit*1000){
   if(clients.some(c=>c.closed))throw Error('Load peer disconnected');
   if(cancelled)throw Error('Cancelled');
   // Rotate direction every second, keeping all participants in a crowded area.
   const phase=iterations++%4;
   clients.forEach((c,i)=>{const angle=spread?i*Math.PI*2/population:phase*Math.PI/2+(i%8)*Math.PI/4;c.setInput({x:Math.cos(angle),z:Math.sin(angle)});});
   const iterationStarted=performance.now();await delay(1000);const delayEnded=performance.now();
   if(worldInfo.persistence)for(let offset=0;offset<clients.length;offset+=80){
    await Promise.all(clients.slice(offset,offset+80).filter((_,i)=>i%10===iterations%10).map(async c=>{
     await c.outbox.enqueue('record',{expectedRevision:c.revision,value:{fixture:'load',iteration:iterations}});
     for(const item of await c.outbox.flush()){
      if(item.result.status!=='committed')throw Error('Durable load mutation failed');
      c.revision=item.result.revision;c.writes++;await c.outbox.acknowledge(item.command.requestId);
     }
     if(ownership){
      await c.owned.refresh();
      const entity=c.owned.snapshot().entities.find(e=>e.value?.fixture==='load-owned');
      if(!entity)throw Error('Missing trusted load-owned fixture');
      const recipient=clients[(clients.indexOf(c)+1)%clients.length];
      await c.outbox.enqueue('transfer',{entityId:entity.id,expectedRevision:entity.revision,recipient:recipient.identity.principalId});
      for(const item of await c.outbox.flush()){
       if(item.result.status!=='committed')throw Error('Ownership load mutation failed');
       c.transfers++;await c.outbox.acknowledge(item.command.requestId);
      }
      await Promise.all([c.owned.refresh(),recipient.owned.refresh()]);
      if(c.owned.snapshot().entities.some(e=>e.id===entity.id)||!recipient.owned.snapshot().entities.some(e=>e.id===entity.id&&e.revision===entity.revision+1))throw Error('Ownership reconciliation failed');
     }
    }));
   }
   const now=performance.now();
   const stale=clients.filter(c=>!c.snapshot||now-c.snapshot.receivedAt>1000).length;
   const state=await metrics();if(now-lastSample>2000){diagnostics.largeGaps.push({gapMs:now-lastSample,delayMs:delayEnded-iterationStarted,mutationMs:now-delayEnded,stale,heapMiB:(performance.memory?.usedJSHeapSize||0)/1048576});diagnostics.largeGaps=diagnostics.largeGaps.slice(-8);}
   samples.push({stale,ownedRefreshAgeMs:Math.max(...clients.map(c=>c.identity?now-c.lastOwnedFresh:0)),ownedStale:clients.filter(c=>c.owned?.stale).length,gapMs:now-lastSample,hidden:document.hidden,buffered:Math.max(...clients.map(c=>c.state.bufferedAmount)),tickUs:state.metrics.tick_us,replicationUs:state.metrics.replication_us});lastSample=now;
   if(!diagnostics.heapSamples.length||now-started-diagnostics.heapSamples.at(-1).elapsedMs>=30000)diagnostics.heapSamples.push({elapsedMs:now-started,heapMiB:(performance.memory?.usedJSHeapSize||0)/1048576});
   $('status').textContent=`Moving · ${Math.round((now-started)/1000)}/${secondsLimit} seconds · ${stale} stale clients`;
  }
  const after=await metrics(),seconds=(performance.now()-started)/1000;
  const p95=key=>samples.map(s=>s[key]||0).sort((a,b)=>a-b)[Math.floor((samples.length-1)*.95)]/1000;
  const report={maxOwnedRefreshAgeMs:Math.max(...samples.map(s=>s.ownedRefreshAgeMs)),diagnostics:{...diagnostics,heapEndMiB:(performance.memory?.usedJSHeapSize||0)/1048576},committedTransfers:clients.reduce((n,c)=>n+(c.transfers||0),0),committedWrites:clients.reduce((n,c)=>n+(c.writes||0),0),minStartingRevision:worldInfo.persistence?Math.min(...clients.map(c=>c.startRevision)):null,visibleEntityRange:[Math.min(...clients.map(c=>c.snapshot.entities.length)),Math.max(...clients.map(c=>c.snapshot.entities.length))],persistence:worldInfo.persistence,persistenceMetrics:after.persistence,durableOperations:after.persistence?after.persistence.completed-before.persistence.completed:0,maxOwnedStale:Math.max(...samples.map(s=>s.ownedStale)),world:contract.world,wire:contract.wire,testPeers:clients.length,totalPlayers:population,seconds,ticksPerSecond:(after.metrics.ticks-before.metrics.ticks)/seconds,udpMiBPerSecond:(after.metrics.sent_bytes-before.metrics.sent_bytes)/seconds/1048576,statePayloadMiBPerSecond:(after.metrics.state_payload_bytes-before.metrics.state_payload_bytes)/seconds/1048576,stateBudgetSkips:after.metrics.state_budget_skips-before.metrics.state_budget_skips,lifecycleMessages:after.metrics.lifecycle_messages-before.metrics.lifecycle_messages,skippedSnapshots:after.metrics.skipped_snapshots-before.metrics.skipped_snapshots,udpDrops:after.metrics.udp_drops-before.metrics.udp_drops,lateTicks:after.metrics.late_ticks-before.metrics.late_ticks,maxStaleClients:Math.max(...samples.map(s=>s.stale)),maxBrowserSampleGapMs:Math.max(...samples.map(s=>s.gapMs)),hiddenSamples:samples.filter(s=>s.hidden).length,maxClientBufferedBytes:Math.max(...samples.map(s=>s.buffered)),resyncRequests:clients.reduce((n,c)=>n+c.stats.resyncs,0)-initialResyncs,movementErrors:after.movementErrors-before.movementErrors,sampledTickP95Ms:p95('tickUs'),sampledReplicationP95Ms:p95('replicationUs'),scope:`${secondsLimit}-second ${spread?'spread':'crowded'} moving browser WebRTC test; ${existing} separately rendered engine; no injected network impairment; endpoint topology recorded separately`};
  $('results').textContent=JSON.stringify(report,null,2);
  if(report.maxOwnedRefreshAgeMs>45000||report.maxStaleClients||report.movementErrors||report.ticksPerSecond<29||(worldInfo.persistence&&(!report.committedWrites||after.persistence.rejected>before.persistence.rejected)))throw Error('Freshness, movement or tick-rate gate failed');
  $('status').textContent='PASS · moving load completed; peers disconnected';
 }catch(e){$('status').textContent='FAIL · '+e.message;if(!$('results').textContent){try{$('results').textContent=JSON.stringify({failure:e.message,diagnostics,clientErrors:clients.filter(c=>c.failure).map(c=>c.failure),connectedPeers:clients.filter(c=>!c.closed).length,server:await metrics()},null,2);}catch{}}}finally{clearInterval(heartbeat);observer?.disconnect();stop();running=false;$('start').disabled=false;}
};
