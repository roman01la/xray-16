import {BrowserEngineBridge,EngineBridgeEndpoint} from './engine-bridge.mjs';
import {Reconciler,createWasmMotor} from './prediction.mjs';
import {createContentVerifier,levelForWorld} from './content.mjs';
import {createEnginePoll} from './engine-abi.mjs';
import {createAppearancePoll} from './appearance-abi.mjs';
import {createInventoryPoll} from './inventory-abi.mjs';
import {createCorpseSearchPoll} from './corpse-search-abi.mjs';
import {createWorldItemsPoll} from './world-items-abi.mjs';
import {MAX_DETONATIONS,MAX_GRENADES,MAX_GUNSHOTS} from './control.mjs';
import {ENVIRONMENT_OPCODE,LOOP_SOUND_OPCODE} from './protocol.mjs';
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
export function installDormantEngineBridge(scope,port,{epoch,contract,content=null,nativeMovement=false,getHeap}) {
  if(scope.zoneEnginePoll)throw new Error('Engine worker bridge already installed');
  let endpoint=null,poll=null,appearancePoll=null,inventoryPoll=null,worldItemsPoll=null,corpseSearchPoll=null,misfireLife=null;
  let detector=null,detectorLife=null,detectorUntil=0,detectorPending=false,detectorSelection=null,localClimbing=false;
  const onWorkerError=event=>endpoint?.send({type:'engine-error',message:String(event.error?.stack||event.message||'Engine worker failed').slice(0,4096)});
  scope.addEventListener?.('error',onWorkerError);
  let predictor=null,predictionFailed=false,lastSnapshot=null,lastHistory=[];
  let nativeMedia=null;
  const assets={};
  const level=levelForWorld(contract.world);
  const verifier=createContentVerifier(content,getHeap,error=>{console.error(error.message);endpoint?.close(error.message);},(key,bytes)=>{
    if(nativeMovement)return;
    assets[key]=bytes;
    if(assets.geometry&&assets.materials)void createWasmMotor(level,content,assets).then(motor=>{
      predictor=new Reconciler(motor,undefined,contract.tickHz);
      predictor.update(lastSnapshot,lastHistory,endpoint?.vitals);
      console.log('Zone prediction: shared Rust motor ready');
    }).catch(error=>{predictionFailed=true;console.error(error);}).finally(()=>{delete assets.geometry;delete assets.materials;});
  });
  scope.zoneNativeInputSequence=()=>lastHistory.at(-1)?.sequence ?? lastSnapshot?.ack ?? 0;
  scope.zoneNativeMotionFlags=()=>endpoint?.vitals?.[6] ?? 3;
  scope.zoneNativeMotionScale=()=> (endpoint?.vitals?.[10] ?? 1000)/1000;
  scope.zoneEnginePrediction=pointer=>{
    if(!predictor||predictionFailed||endpoint?.closed)return 0;
    const p=predictor.renderPosition();if(!p)return 0;
    const heap=getHeap(),at=Number(pointer);new Float32Array(heap.buffer,heap.byteOffset+at,4).set([p.x,p.y,p.z,p.yaw]);return 1;
  };
  scope.zoneEngineWorldSpace=()=>level!==null;
  scope.zoneEngineVerifyAsset=(kind,pointer,size)=>{void verifier.verify(kind,pointer,size);};
  scope.zoneEngineContentStatus=()=>verifier.status();
  scope.zoneEnginePoll=(pointer,capacity)=>{
    if(!endpoint){endpoint=new EngineBridgeEndpoint(port,{epoch,contract});poll=createEnginePoll(endpoint,getHeap);appearancePoll=createAppearancePoll(endpoint,getHeap);inventoryPoll=createInventoryPoll(endpoint,getHeap);worldItemsPoll=createWorldItemsPoll(endpoint,getHeap);corpseSearchPoll=createCorpseSearchPoll(endpoint,getHeap);}
    try {
      const hasSnapshot=!!endpoint.snapshot;
      if(hasSnapshot){
        lastSnapshot=endpoint.snapshot.snapshot;
        if(endpoint.snapshot.nativeMedia)nativeMedia=endpoint.snapshot.nativeMedia;
        localClimbing=!!(lastSnapshot.entities.find(entity=>entity.id===lastSnapshot.playerId)?.flags&16);
      }
      const history=endpoint.consumePredictionInputs();if(history)lastHistory=history;
      if(!predictionFailed&&(hasSnapshot||history))
        predictor?.update(hasSnapshot?lastSnapshot:null,history,endpoint.vitals);
    }catch(error){predictionFailed=true;console.error('Prediction disabled:',error.message);}
    return poll(pointer,capacity);
  };
  scope.zoneEngineInput=input=>endpoint?.setInput(input);
  // Inventory cannot claim a dormant worker. The snapshot frame hook owns that.
  scope.zoneEngineWorldItemsPoll=(pointer,capacity)=>{
    const view=endpoint?.worldItems?.view,size=worldItemsPoll?worldItemsPoll(pointer,capacity):0;
    if(size>0){
      detector=view.detector??null;detectorLife=view.life;detectorUntil=performance.now()+3000;
      if(detectorSelection?.life===view.life&&detectorSelection.active===!!detector)detectorSelection=null;
    }
    return size;
  };
  scope.zoneEngineToggleDetector=async life=>{
    if(detectorPending||!endpoint||endpoint.closed)return;
    detectorPending=true;
    try{
      const previous=detectorSelection?.life===life?detectorSelection.active:detectorLife===life&&!!detector;
      const result=await endpoint.selectDetector(life,!previous);
      if(result?.status==='selected')detectorSelection={life,active:!previous};
      else detectorSelection=null;
    }catch(error){console.error('Detector selection:',error.message);}
    finally{detectorPending=false;}
  };
  scope.zoneEngineAimAllowed=life=>!!endpoint&&!endpoint.closed&&!localClimbing&&endpoint.reloadingLife!==life;
  scope.zoneEngineDetectorHint=(life,pointer,aiming=false)=>{
    if(!detector||life!==detectorLife||endpoint.closed||
      detectorSelection?.life===life&&detectorSelection.active===false)return false;
    const heap=getHeap(),at=Number(pointer),floats=6+32*3,labelStride=65;
    if(!Number.isSafeInteger(at)||at<0||at%4!==0||at+floats*4+32*labelStride>heap.byteLength)return false;
    const out=new Float32Array(heap.buffer,heap.byteOffset+at,floats);
    const working=detector.working&&!aiming&&scope.zoneEngineAimAllowed(life)&&performance.now()<=detectorUntil;
    const points=working?(detector.points??[]):[];
    out.set([detector.tier,Number(working),working?(detector.period??0):0,working?(detector.pitch??0):0,
      working?(detector.bearing??0):0,points.length]);
    for(const [i,point] of points.entries())out.set(point,6+i*3);
    const labels=working?(detector.labels??[]):[];
    for(const [i,label] of labels.entries()){
      const start=at+out.byteLength+i*labelStride;
      for(let j=0;j<label.length;j++)heap[start+j]=label.charCodeAt(j);
      heap[start+label.length]=0;
    }
    return true;
  };
  scope.zoneEngineNpcMediaPoll=(pointer,capacity)=>{
    const media=nativeMedia;
    nativeMedia=null;
    if(!media)return 0;
    const heap=getHeap(),start=Number(pointer);
    const environment=media.environment?[media.environment]:[];
    const loops=media.loops??[];
    const size=media.poses.concat(media.sounds,environment,loops).reduce((sum,packet)=>sum+8+packet.length,0);
    if(!Number.isSafeInteger(start)||start<0||size>capacity||start+size>heap.byteLength)return 0;
    const view=new DataView(heap.buffer,heap.byteOffset+start,size);
    let offset=0;
    for(const [type,packets] of [[ENVIRONMENT_OPCODE,environment],[33,media.poses],[34,media.sounds],[LOOP_SOUND_OPCODE,loops]]){
      for(const packet of packets){
        view.setUint32(offset,type,true);
        view.setUint32(offset+4,packet.length,true);
        heap.set(packet,start+offset+8);
        offset+=8+packet.length;
      }
    }
    return size;
  };
  scope.zoneEngineAppearancePoll=(pointer,capacity)=>appearancePoll?appearancePoll(pointer,capacity):0;
  scope.zoneEngineDetonations=(pointer,capacity)=>{
    if(!endpoint||endpoint.closed||capacity!==MAX_DETONATIONS)return 0;
    // C++ record: 3 float32 coordinates, up to 128 ASCII bytes and a NUL.
    const stride=144,at=Number(pointer),heap=getHeap();
    if(!Number.isSafeInteger(at)||at<0||at+capacity*stride>heap.byteLength)return 0;
    const effects=endpoint.consumeDetonations();
    if(!effects)return 0;
    const out=new DataView(heap.buffer,heap.byteOffset+at,effects.length*stride);
    for(const [index,[section,x,y,z]] of effects.entries()){
      const base=index*stride;
      out.setFloat32(base,x,true);out.setFloat32(base+4,y,true);out.setFloat32(base+8,z,true);
      for(let i=0;i<section.length;i++)out.setUint8(base+12+i,section.charCodeAt(i));
      out.setUint8(base+12+section.length,0);
    }
    return effects.length;
  };
  scope.zoneEngineGunshots=(pointer,capacity)=>{
    if(!endpoint||endpoint.closed||capacity!==MAX_GUNSHOTS)return 0;
    // C++ record: 3 float32 coordinates, uint32 sound mode and shooter ID, then the section.
    const stride=152,at=Number(pointer),heap=getHeap();
    if(!Number.isSafeInteger(at)||at<0||at+capacity*stride>heap.byteLength)return 0;
    const effects=endpoint.consumeGunshots();
    if(!effects)return 0;
    const out=new DataView(heap.buffer,heap.byteOffset+at,effects.length*stride);
    for(const [index,[shooter,section,sound,x,y,z]] of effects.entries()){
      const base=index*stride;
      out.setFloat32(base,x,true);out.setFloat32(base+4,y,true);out.setFloat32(base+8,z,true);
      out.setUint32(base+12,sound,true);
      out.setUint32(base+16,shooter,true);
      for(let i=0;i<section.length;i++)out.setUint8(base+20+i,section.charCodeAt(i));
      out.setUint8(base+20+section.length,0);
    }
    return effects.length;
  };
  let grenadeTick=null;
  scope.zoneEngineGrenadesPoll=(pointer,capacity)=>{
    const frame=endpoint?.grenades;
    if(endpoint?.closed||!frame||!Number.isFinite(frame.receivedAt)||Date.now()-frame.receivedAt>400){
      if(grenadeTick===null)return -1;
      grenadeTick=null;return 0;
    }
    if(frame.tick===grenadeTick)return -1;
    const stride=52,at=Number(pointer),heap=getHeap();
    if(capacity!==MAX_GRENADES||!Number.isSafeInteger(at)||at<0||at+capacity*stride>heap.byteLength)return -1;
    const out=new DataView(heap.buffer,heap.byteOffset+at,frame.entries.length*stride);
    for(const [i,[id,section,x,y,z]] of frame.entries.entries()){
      const p=i*stride;
      out.setUint32(p,id,true);out.setFloat32(p+4,x,true);out.setFloat32(p+8,y,true);out.setFloat32(p+12,z,true);
      for(let j=0;j<section.length;j++)out.setUint8(p+16+j,section.charCodeAt(j));
      out.setUint8(p+16+section.length,0);
    }
    grenadeTick=frame.tick;return frame.entries.length;
  };
  scope.zoneEngineCorpseSearchPoll=(pointer,capacity)=>corpseSearchPoll?corpseSearchPoll(pointer,capacity):0;
  scope.zoneEngineCorpseIntent=intent=>endpoint?endpoint.corpseIntent(intent):Promise.reject(Error('Engine bridge unavailable'));
  scope.zoneEngineInventoryPoll=(pointer,capacity)=>inventoryPoll?inventoryPoll(pointer,capacity):0;
  scope.zoneEngineVitals=(life,pointer)=>{
    const state=endpoint?.vitals;
    if(!state||endpoint.closed||state[0]!==life)return false;
    const heap=getHeap(),out=new Float32Array(heap.buffer,heap.byteOffset+Number(pointer),8);
    for(let i=0;i<5;i++)out[i]=state[i+1]/1000;
    for(let i=5;i<out.length;i++)out[i]=state[i+2]/1000;
    new Uint32Array(heap.buffer,out.byteOffset+out.byteLength,1)[0]=state[13];
    return true;
  };
  scope.zoneEngineInventoryMove=intent=>endpoint?endpoint.moveInventory(intent):Promise.reject(Error('Engine bridge unavailable'));
  scope.zoneEngineInventoryBatch=intents=>endpoint?endpoint.moveInventoryBatch(intents):Promise.reject(Error('Engine bridge unavailable'));
  scope.zoneEngineInventoryApplied=view=>endpoint?.send({type:'engine-inventory-applied',view});
  scope.zoneEngineReload=()=>{endpoint?.reload().catch(error=>console.error('Reload:',error.message));};
  scope.zoneEngineUseTravel=()=>{endpoint?.useTravel().catch(error=>console.error('Use travel:',error.message));};
  let weaponSelection=null;
  const confirmedSlot=life=>endpoint?.weaponSlot?.life===life?endpoint.weaponSlot.slot:0;
  const pendingSlot=life=>weaponSelection?.life===life?weaponSelection.slot:-1;
  scope.zoneEnginePendingWeaponSlot=pendingSlot;
  scope.zoneEngineWeaponSlot=life=>pendingSlot(life)<0?confirmedSlot(life):0;
  scope.zoneEngineSelectWeapon=async(life,key)=>{
    if(!endpoint||endpoint.closed)return;
    if(weaponSelection?.life===life){
      weaponSelection.slot=weaponSelection.slot===key?0:key;
      return;
    }
    const selection={life,slot:confirmedSlot(life)===key?0:key};
    weaponSelection=selection;
    try{
      // Keep one reliable request and the latest desired slot during a switch.
      let requested;
      do{
        requested=selection.slot;
        await endpoint.selectWeapon(life,requested);
      }while(weaponSelection===selection&&selection.slot!==requested);
    }catch(error){console.error('Weapon selection:',error.message);}
    finally{if(weaponSelection===selection)weaponSelection=null;}
  };
  scope.zoneEngineRespawn=()=>{endpoint?.respawn().catch(error=>console.error('Respawn:',error.message));};
  scope.zoneEngineFire=(aim,item,held=false)=>{
    const life=endpoint?.vitals?.[0];
    endpoint?.fire(aim,item,held).then(result=>{
      if(life!==undefined&&(result?.reason==='misfire'||result?.reason==='jammed'))misfireLife=life;
    }).catch(error=>console.error('Fire intent:',error.message));
  };
  scope.zoneEngineGrenade=(phase,aim,item)=>endpoint?.grenade(phase,aim,item).catch(error=>console.error('Grenade intent:',error.message));
  scope.zoneEngineKnife=(mode,aim,item)=>endpoint?.knife(mode,aim,item).catch(error=>console.error('Knife intent:',error.message));
  scope.zoneEngineWeaponMisfire=life=>{
    const match=misfireLife===life||endpoint?.misfireLife===life;
    misfireLife=null;if(endpoint)endpoint.misfireLife=null;return match;
  };
  scope.zoneEngineConsumeWeaponFire=()=>endpoint?.consumeWeaponFire()??null;
  scope.zoneEngineConsumeWeaponReload=()=>endpoint?.consumeWeaponReload()??null;
  scope.zoneEngineTriggerStop=()=>endpoint?.stopTrigger();
  scope.zoneEngineView=(firstPerson,crosshair)=>endpoint?.send({type:'view',firstPerson,crosshair});
  scope.zoneEngineApplied=(tick,entities)=>endpoint?.send({type:'engine-applied',tick,entities,...(content&&!nativeMovement?{prediction:{ready:!!predictor&&!predictionFailed,active:!!predictor&&!predictionFailed&&!!predictor.position(),replays:predictor?.replays||0}}:{})});
  return ()=>{
    delete scope.zoneEngineGunshots;delete scope.zoneEngineNpcMediaPoll;
    delete scope.zoneNativeInputSequence;delete scope.zoneNativeMotionFlags;delete scope.zoneNativeMotionScale;
    scope.removeEventListener?.('error',onWorkerError);if(endpoint)endpoint.close();else port.close();delete scope.zoneEnginePoll;delete scope.zoneEngineAppearancePoll;delete scope.zoneEngineApplied;delete scope.zoneEngineInput;delete scope.zoneEngineWorldSpace;delete scope.zoneEngineVerifyAsset;delete scope.zoneEngineContentStatus;delete scope.zoneEnginePrediction;delete scope.zoneEngineFire;delete scope.zoneEngineGrenade;delete scope.zoneEngineKnife;delete scope.zoneEngineGrenadesPoll;delete scope.zoneEngineTriggerStop;delete scope.zoneEngineWeaponMisfire;delete scope.zoneEngineConsumeWeaponFire;delete scope.zoneEngineConsumeWeaponReload;delete scope.zoneEngineView;delete scope.zoneEngineReload;delete scope.zoneEngineUseTravel;delete scope.zoneEngineWeaponSlot;delete scope.zoneEnginePendingWeaponSlot;delete scope.zoneEngineSelectWeapon;delete scope.zoneEngineRespawn;delete scope.zoneEngineCorpseSearchPoll;delete scope.zoneEngineCorpseIntent;delete scope.zoneEngineInventoryPoll;delete scope.zoneEngineWorldItemsPoll;delete scope.zoneEngineInventoryMove;delete scope.zoneEngineVitals;delete scope.zoneEngineInventoryBatch;delete scope.zoneEngineInventoryApplied;delete scope.zoneEngineDetonations;delete scope.zoneEngineToggleDetector;delete scope.zoneEngineDetectorHint;delete scope.zoneEngineAimAllowed;
  };
}
