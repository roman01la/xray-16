import {faultOptions} from './network-faults.mjs';
import {ZoneClient} from './client.mjs';import {validateWorld} from './content.mjs';import {runCombatScenario} from './combat-scenario.mjs';
const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
let clients=[],cancelled=false,running=false;
const log=s=>{$('results').textContent+=s+'\n';};
function stop(){cancelled=true;clients.forEach(c=>c.close());clients=[];}
$('stop').onclick=stop;addEventListener('pagehide',stop);
async function until(check,timeout=10000){const start=performance.now();while(!check()){if(cancelled||performance.now()-start>timeout)throw Error('Timed out or cancelled');await sleep(25);}}
$('start').onclick=async()=>{
 if(running)return;running=true;cancelled=false;$('start').disabled=true;$('results').textContent='';
 try{
  const state=await (await fetch('/metrics')).json();if(state.metrics.players)throw Error('Close other multiplayer clients first');
  const {contract}=await validateWorld(await (await fetch('/world.json')).json());if(contract.world!=='zaton-static-v1')throw Error('This route requires Zaton');
  for(let i=0;i<2;i++){const c=new ZoneClient();clients.push(c);c.addEventListener('error',e=>log('Client error: '+e.detail));await c.connect({contract,impairment:faultOptions(location.search)});}
  await runCombatScenario(...clients,{until,log,phase:s=>{$('status').textContent=s;}});
 }catch(e){$('status').textContent='FAIL · '+e.message;log(e.stack||e.message);}finally{stop();running=false;$('start').disabled=false;}
};
