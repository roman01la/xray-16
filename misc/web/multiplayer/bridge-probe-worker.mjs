import {EngineBridgeEndpoint} from './engine-bridge.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const start=performance.now();while(!fn()){if(performance.now()-start>6000)throw new Error('Worker bridge timed out');await delay(15);}}
self.onmessage=async({data})=>{
  if(data.type!=='probe')return;
  const endpoint=new EngineBridgeEndpoint(data.port,{epoch:data.epoch,contract:data.contract});let timer;
  try {
    await until(()=>endpoint.session && endpoint.snapshot);
    const firstTick=endpoint.snapshot.snapshot.tick;
    await delay(1000); // Simulate an engine paused during loading.
    const first=endpoint.consumeSnapshot();
    if(first.tick!==firstTick)throw new Error('In-flight frame was overwritten');
    await until(()=>endpoint.snapshot);
    const latest=endpoint.consumeSnapshot();
    if(((latest.tick-firstTick)|0)<15)throw new Error('Bridge replayed stale frames instead of the latest');
    let current=latest;
    timer=setInterval(()=>{current=endpoint.consumeSnapshot() || current;},1000/30);
    const initial=current.entities.find(e=>e.id===current.playerId).x;
    endpoint.setInput({x:1,z:0,yaw:0,sprint:true});
    await until(()=>current.entities.find(e=>e.id===current.playerId).x>initial+.5);
    endpoint.setInput({x:0,z:0,yaw:0,sprint:false});
    const result=await endpoint.attack(endpoint.session.playerId);
    if(result!=='invalid_target')throw new Error('Action response did not cross worker bridge');
    self.postMessage({type:'result',ok:true,firstTick,latestTick:latest.tick,movedMetres:current.entities.find(e=>e.id===current.playerId).x-initial});
  }catch(error){self.postMessage({type:'result',ok:false,error:error.message});}
  finally{clearInterval(timer);endpoint.close();}
};
