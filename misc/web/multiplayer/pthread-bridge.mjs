import {BrowserEngineBridge,EngineBridgeEndpoint} from './engine-bridge.mjs';
import {Reconciler,createWasmMotor} from './prediction.mjs';
import {createContentVerifier} from './content.mjs';
import {createEnginePoll} from './engine-abi.mjs';
// Emscripten prewarms many pthreads. Ports remain dormant until the C++ frame
// hook executes in the application pthread; pool workers cannot consume frames.
export function createPthreadBridge(client,{epoch,contract=client.contract,onError=()=>{},onApplied=()=>{}}) {
  const pending=new Map();let active=null,closed=false;
  function detach(port,listener){port.removeEventListener('message',listener);pending.delete(port);}
  function reject(port,listener,reason){detach(port,listener);port.postMessage({type:'closed',epoch,reason});port.close();}
  function close(reason='engine stopped'){
    if(closed)return;closed=true;
    for(const [port,listener] of pending)reject(port,listener,reason);
    if(active)active.close(reason);else client.close();
    client.removeEventListener('disconnected',onDisconnect);
  }
  const onDisconnect=()=>close('transport disconnected');
  client.addEventListener('disconnected',onDisconnect);
  return {
    createPort(){
      if(closed)throw new Error('Engine session closed');
      if(pending.size>=128)throw new Error('Too many dormant engine workers');
      const {port1,port2}=new MessageChannel();
      const listener=({data})=>{
        if(data?.epoch!==epoch)return;
        if(data.type!=='ready'){reject(port1,listener,'Expected engine ready');return;}
        if(active){reject(port1,listener,'Application pthread already attached');return;}
        detach(port1,listener);
        active=new BrowserEngineBridge(client,port1,{epoch,contract,onError,onApplied});active.receive(data);
      };
      pending.set(port1,listener);port1.addEventListener('message',listener);port1.start();
      return port2;
    },close,
  };
}
export function installDormantEngineBridge(scope,port,{epoch,contract,content=null,getHeap}) {
  if(scope.zoneEnginePoll)throw new Error('Engine worker bridge already installed');
  let endpoint=null,poll=null;
  let predictor=null,predictionFailed=false,lastSnapshot=null,lastHistory=[];
  const assets={};
  const verifier=createContentVerifier(content,getHeap,error=>{console.error(error.message);endpoint?.close(error.message);},(key,bytes)=>{
    assets[key]=bytes;
    if(assets.geometry&&assets.materials)void createWasmMotor(content,assets).then(motor=>{
      predictor=new Reconciler(motor);if(lastSnapshot)predictor.snapshotReceived(lastSnapshot);predictor.inputsReceived(lastHistory);
      console.log('Zone prediction: shared Rust motor ready');
    }).catch(error=>{predictionFailed=true;console.error(error);}).finally(()=>{delete assets.geometry;delete assets.materials;});
  });
  scope.zoneEnginePrediction=pointer=>{
    if(!predictor||predictionFailed||endpoint?.closed)return 0;
    const p=predictor.position();if(!p)return 0;
    const heap=getHeap(),at=Number(pointer);new Float32Array(heap.buffer,heap.byteOffset+at,4).set([p.x,p.y,p.z,p.yaw]);return 1;
  };
  scope.zoneEngineWorldSpace=()=>contract.world==='zaton-static-v1';
  scope.zoneEngineVerifyAsset=(kind,pointer,size)=>{void verifier.verify(kind,pointer,size);};
  scope.zoneEngineContentStatus=()=>verifier.status();
  scope.zoneEnginePoll=(pointer,capacity)=>{
    if(!endpoint){endpoint=new EngineBridgeEndpoint(port,{epoch,contract});poll=createEnginePoll(endpoint,getHeap);}
    try {
      if(endpoint.snapshot){lastSnapshot=endpoint.snapshot.snapshot;if(!predictionFailed)predictor?.snapshotReceived(lastSnapshot);}
      const history=endpoint.consumePredictionInputs();if(history){lastHistory=history;if(!predictionFailed)predictor?.inputsReceived(history);}
    }catch(error){predictionFailed=true;console.error('Prediction disabled:',error.message);}
    return poll(pointer,capacity);
  };
  scope.zoneEngineInput=input=>endpoint?.setInput(input);
  scope.zoneEngineReload=()=>{endpoint?.reload().catch(error=>console.error('Reload:',error.message));};
  scope.zoneEngineRespawn=()=>{endpoint?.respawn().catch(error=>console.error('Respawn:',error.message));};
  scope.zoneEngineFire=aim=>{endpoint?.fire(aim).catch(error=>console.error('Fire intent:',error.message));};
  scope.zoneEngineView=firstPerson=>endpoint?.send({type:'view',firstPerson});
  scope.zoneEngineApplied=(tick,entities)=>endpoint?.send({type:'engine-applied',tick,entities,...(content?{prediction:{ready:!!predictor&&!predictionFailed,active:!!predictor&&!predictionFailed&&!!predictor.position(),replays:predictor?.replays||0}}:{})});
  return ()=>{if(endpoint)endpoint.close();else port.close();delete scope.zoneEnginePoll;delete scope.zoneEngineApplied;delete scope.zoneEngineInput;delete scope.zoneEngineWorldSpace;delete scope.zoneEngineVerifyAsset;delete scope.zoneEngineContentStatus;delete scope.zoneEnginePrediction;delete scope.zoneEngineFire;delete scope.zoneEngineView;delete scope.zoneEngineReload;delete scope.zoneEngineRespawn;};
}
