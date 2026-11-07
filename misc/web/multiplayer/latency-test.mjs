import {ZoneClient} from './client.mjs';
import {loadIdentity} from './identity.mjs';
import {validateWorld} from './content.mjs';
const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let client,stopped=false,running=false;
const stop=()=>{stopped=true;client?.close();};
$('stop').onclick=stop;addEventListener('pagehide',stop);
const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b),percentile=p=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]??null;return {count:sorted.length,minMs:sorted[0]??null,medianMs:percentile(.5),p95Ms:percentile(.95),maxMs:sorted.at(-1)??null};};
$('start').onclick=async()=>{
 if(running)return;running=true;stopped=false;$('start').disabled=true;$('status').textContent='Connecting…';$('results').textContent='';
 const samples=[],paths=[],seen=new Map();let hiddenSamples=0;
 try{
  const response=await fetch('/world.json');if(!response.ok)throw Error('World unavailable');
  const data=await response.json(),{contract}=await validateWorld(data),identity=data.persistence?await loadIdentity('latency-probe'):null;
  client=new ZoneClient();await client.connect({contract,identitySecret:identity?.secret});
  const began=performance.now();
  while(performance.now()-began<90000){
   if(stopped||client.closed)throw Error('Measurement interrupted');
   const stats=await client.pc.getStats();let pair;
   for(const entry of stats.values())if(entry.type==='transport'&&entry.selectedCandidatePairId)pair=stats.get(entry.selectedCandidatePairId);
   if(!pair)throw Error('No selected candidate pair');
   const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);
   if(!paths.some(p=>p.id===pair.id))paths.push({id:pair.id,protocol:local?.protocol,localType:local?.candidateType,remoteType:remote?.candidateType,remoteAddress:remote?.address,remotePort:remote?.port});
   if(document.hidden)hiddenSamples++;
   if(Number.isFinite(pair.currentRoundTripTime)&&pair.responsesReceived>(seen.get(pair.id)??0)){
    seen.set(pair.id,pair.responsesReceived);samples.push({elapsedMs:performance.now()-began,rttMs:pair.currentRoundTripTime*1000,responses:pair.responsesReceived,path:pair.id});
   }
   $('status').textContent=`Measuring · ${Math.floor((performance.now()-began)/1000)}/90 seconds · ${samples.length} fresh RTT readings`;
   $('results').textContent=JSON.stringify(summarize(samples.map(s=>s.rttMs)),null,2);
   await sleep(1000);
  }
  if(samples.length<5)throw Error('Insufficient fresh RTT readings');
  const differences=samples.slice(1).flatMap((s,i)=>s.path===samples[i].path?[Math.abs(s.rttMs-samples[i].rttMs)]:[]);
  $('results').textContent=JSON.stringify({measuredAt:new Date().toISOString(),world:contract.world,durationSeconds:(performance.now()-began)/1000,scope:'One browser on this laptop to Fly Frankfurt; selected WebRTC ICE UDP path; no artificial impairment; gameplay snapshots active; no rendered engine or load peers',rtt:summarize(samples.map(s=>s.rttMs)),successiveRttVariation:summarize(differences),hiddenSamples,paths,samples},null,2);
  $('status').textContent='PASS · network RTT measured; peer disconnected';
 }catch(error){$('status').textContent='FAIL · '+error.message;}
 finally{client?.close();running=false;$('start').disabled=false;}
};
