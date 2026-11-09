import {assertCompatible,validateContract} from './contract.mjs';
import {encodeControl,validateDetonations,validateGrenades,validateGunshots,validateVitals,validateWeaponFire,validateWeaponReload} from './control.mjs';
import {validateInventoryView} from './inventory-abi.mjs';
import {validateCorpseView,validateCorpseIntent} from './corpse-search.mjs';
import {validateWorldItems} from './world-items.mjs';
import {validateAppearanceView} from './appearance-abi.mjs';
function validateInventoryIntent(intent){
  if(!intent||Object.keys(intent).length!==4||!['life','item','revision','action'].every(k=>Object.hasOwn(intent,k)))throw Error('Invalid inventory intent');
  // Use the same strict command validator as the network codec. Only the main
  // thread journal creates the durable request ID; the engine sends an intent.
  encodeControl({type:'inventory_move',sequence:1,command:{requestId:'0'.repeat(32),...intent}});
  return intent;
}
function validateInventoryBatch(intents){
  if(!Array.isArray(intents)||!intents.length||intents.length>4096)throw Error('Invalid inventory batch');
  const ids=new Set();
  for(const intent of intents){
    validateInventoryIntent(intent);
    if(!['drop','unload','store','detach'].includes(intent.action.kind)||intent.action.kind!==intents[0].action.kind||intent.action.destination!==intents[0].action.destination||intent.action.slot!==intents[0].action.slot||intent.life!==intents[0].life||ids.has(intent.item))throw Error('Invalid inventory batch');
    ids.add(intent.item);
  }
  return intents;
}
const validWeapon=item=>item===null||(typeof item==='string'&&/^[0-9a-f]{32}$/.test(item)&&item!=='0'.repeat(32));
const validAim=a=>a && Number.isInteger(a.tick)&&a.tick>=0&&a.tick<=0xffffffff&&Number.isFinite(a.yaw)&&Number.isFinite(a.pitch)&&Math.abs(a.pitch)<=1.55;
const validEpoch=e=>typeof e==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(e);
const validInput=i=>i && ['x','z','yaw'].every(k=>Number.isFinite(i[k])) && Math.abs(i.x)<=1 && Math.abs(i.z)<=1 && (i.pitch===undefined||Number.isFinite(i.pitch)&&Math.abs(i.pitch)<=1.55) && typeof i.sprint==='boolean' && ['jump','crouch','walk','aiming'].every(k=>i[k]===undefined||typeof i[k]==='boolean');
// One in-flight value plus one replaceable latest value. Credit is returned only
// after the consumer applies/takes it; a paused engine cannot accumulate frames.
class LatestMailbox {
  sequence=0;inflight=null;pending=null;
  constructor(send){this.send=send;}
  offer(value){this.pending=value;this.flush();}
  flush(){if(this.inflight!==null || this.pending===null)return;const value=this.pending;this.pending=null;this.inflight=++this.sequence;this.send(this.inflight,value);}
  ack(sequence){if(sequence!==this.inflight)return;this.inflight=null;this.flush();}
  clear(){this.pending=null;this.inflight=null;}
}
function bind(port,receive){const listener=e=>receive(e.data);port.addEventListener('message',listener);port.start();return ()=>{port.removeEventListener('message',listener);port.close();};}
export class BrowserEngineBridge {
  ready=false;closed=false;actions=0;
  constructor(client,port,{epoch,contract=client.contract,onError=()=>{},onApplied=()=>{}}){
    if(!validEpoch(epoch))throw new Error('Invalid session epoch');
    assertCompatible(client.contract,contract);
    this.client=client;this.port=port;this.epoch=epoch;this.contract=validateContract(contract);this.onError=onError;this.onApplied=onApplied;
    this.predictionInputs=new LatestMailbox((sequence,history)=>this.send({type:'prediction-inputs',sequence,history}));
    this.onInputSent=e=>{if(this.ready)this.predictionInputs.offer(e.detail);};client.addEventListener('input-sent',this.onInputSent);
    this.snapshots=new LatestMailbox((sequence,snapshot)=>this.send({type:'snapshot',sequence,snapshot,
      vitals:this.client.vitals??null,grenades:this.client.grenades??null}));
    this.appearances=new LatestMailbox((sequence,entries)=>this.send({type:'appearances',sequence,entries}));
    this.lastAppearances=[];
    this.onLifecycle=()=>{
      if(!this.ready)return;
      const entries=[];
      for(const e of this.client.lifecycle?.entries.values()??[]){
        if(e.kind===2)entries.push([e.id,{visual:e.model}]);
        else if(e.appearance)entries.push([e.id,e.appearance]);
      }
      entries.sort((a,b)=>a[0]-b[0]);
      if(entries.length===this.lastAppearances.length&&entries.every(([id,look],i)=>{
        const [oldId,old]=this.lastAppearances[i];
        return id===oldId&&look.outfit===old.outfit&&look.helmet===old.helmet&&look.weapon===old.weapon&&look.weaponAddons===old.weaponAddons&&look.visual===old.visual;
      }))return;
      this.lastAppearances=entries;this.appearances.offer(entries);
    };
    client.addEventListener('lifecycle',this.onLifecycle);
    this.inventories=new LatestMailbox((sequence,view)=>this.send({type:'inventory',sequence,view}));
    this.corpseViews=new LatestMailbox((sequence,value)=>this.send({type:'corpse-search',sequence,view:value.view}));
    this.onCorpseSearch=e=>{if(this.ready){try{this.corpseViews.offer({view:validateCorpseView(e.detail)});}catch(error){this.onError(error);this.close(error.message);}}};
    client.addEventListener('corpse-search',this.onCorpseSearch);
    this.worldItems=new LatestMailbox((sequence,view)=>this.send({type:'world-items',sequence,view}));
    this.onWorldItems=e=>{if(this.ready){try{this.worldItems.offer(validateWorldItems(e.detail));}catch(error){this.onError(error);this.close(error.message);}}};
    client.addEventListener('world-items',this.onWorldItems);
    this.onInventory=e=>{if(this.ready){try{this.inventories.offer(validateInventoryView(e.detail));}catch(error){this.onError(error);this.close(error.message);}}};
    client.addEventListener('inventory',this.onInventory);
    this.onWeaponShot=({detail:{result}})=>{
      const life=this.client.vitals?.[0];
      if(this.ready&&life!==undefined&&(result?.reason==='misfire'||result?.reason==='jammed'))this.send({type:'weapon-misfire',life});
    };
    client.addEventListener('weapon-shot',this.onWeaponShot);
    this.weaponFire=new LatestMailbox((sequence,value)=>this.send({type:'weapon-fired',sequence,...value}));
    this.onWeaponFired=e=>{if(this.ready)this.weaponFire.offer({cue:e.detail,receivedAt:Date.now()});};
    client.addEventListener('weapon-fired',this.onWeaponFired);
    client.addEventListener('knife-swing',this.onWeaponFired);
    client.addEventListener('grenade-hud',this.onWeaponFired);
    this.weaponReload=new LatestMailbox((sequence,value)=>this.send({type:'weapon-reload',sequence,...value}));
    this.onWeaponReload=e=>{if(this.ready)this.weaponReload.offer({cue:e.detail,receivedAt:Date.now()});};
    client.addEventListener('weapon-reload',this.onWeaponReload);
    this.detonations=new LatestMailbox((sequence,value)=>this.send({type:'detonations',sequence,...value}));
    this.onDetonations=e=>{if(this.ready)this.detonations.offer({effects:e.detail,receivedAt:Date.now()});};
    client.addEventListener('detonations',this.onDetonations);
    this.gunshots=new LatestMailbox((sequence,value)=>this.send({type:'gunshots',sequence,...value}));
    this.onGunshots=e=>{if(this.ready)this.gunshots.offer({effects:e.detail,receivedAt:Date.now()});};
    client.addEventListener('gunshots',this.onGunshots);
    this.unbind=bind(port,m=>this.receive(m));
    this.onSnapshot=e=>{if(this.ready)this.snapshots.offer(e.detail);};
    this.lastWeaponSlot=null;
    this.onVitals=e=>{if(this.ready)this.publishWeaponSlot(e.detail);};
    client.addEventListener('vitals',this.onVitals);
    this.onDisconnect=()=>this.close('transport disconnected');
    client.addEventListener('snapshot',this.onSnapshot);client.addEventListener('disconnected',this.onDisconnect);
  }
  send(message){if(!this.closed)this.port.postMessage({...message,epoch:this.epoch});}
  publishWeaponSlot(state){
    if(!state)return;
    const life=state[0],slot=state[11];
    if(this.lastWeaponSlot?.life===life&&this.lastWeaponSlot.slot===slot)return;
    this.lastWeaponSlot={life,slot};
    this.send({type:'weapon-slot',life,slot});
  }
  receive(m){
    if(this.closed || !m || m.epoch!==this.epoch)return;
    try {
      if(m.type==='ready'){
        if(this.ready)throw new Error('Duplicate engine ready');assertCompatible(this.contract,m.contract);this.ready=true;
        this.send({type:'session',contract:this.contract,playerId:this.client.playerId});
        this.publishWeaponSlot(this.client.vitals);
        this.onLifecycle();
        if(this.client.snapshot)this.snapshots.offer(this.client.snapshot);
        if(this.client.inventory?.view)this.inventories.offer(validateInventoryView(this.client.inventory.view));
        if(this.client.corpseSearch?.view)this.corpseViews.offer({view:validateCorpseView(this.client.corpseSearch.view)});
        if(this.client.worldItemsView?.view)this.worldItems.offer(validateWorldItems(this.client.worldItemsView.view));return;
      }
      if(!this.ready)throw new Error('Engine sent data before ready');
      if(m.type==='engine-error'){
        if(typeof m.message!=='string'||m.message.length>4096)throw Error('Invalid engine error report');
        throw Error(m.message);
      }
      if(m.type==='engine-applied'){
        if(!Number.isInteger(m.tick)||m.tick<0||m.tick>0xffffffff||!Number.isInteger(m.entities)||m.entities<1||m.entities>7424)throw new Error('Invalid engine report');
        if(m.prediction && (typeof m.prediction.ready!=='boolean'||(m.prediction.active!==undefined&&typeof m.prediction.active!=='boolean')||!Number.isInteger(m.prediction.replays)||m.prediction.replays<0||m.prediction.replays>8))throw Error('Invalid prediction report');
        this.onApplied({tick:m.tick,entities:m.entities,...(m.prediction?{prediction:m.prediction}:{})});return;
      }
      if(m.type==='prediction-applied'){this.predictionInputs.ack(m.sequence);return;}
      if(m.type==='snapshot-applied'){this.snapshots.ack(m.sequence);return;}
      if(m.type==='appearances-applied'){this.appearances.ack(m.sequence);return;}
      if(m.type==='detonations-applied'){this.detonations.ack(m.sequence);return;}
      if(m.type==='gunshots-applied'){this.gunshots.ack(m.sequence);return;}
      if(m.type==='weapon-fired-applied'){this.weaponFire.ack(m.sequence);return;}
      if(m.type==='weapon-reload-applied'){this.weaponReload.ack(m.sequence);return;}
      if(m.type==='corpse-search-applied'){this.corpseViews.ack(m.sequence);return;}
      if(m.type==='corpse-intent'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1)throw Error('Invalid or excessive corpse action');
        const intent=validateCorpseIntent(m.intent);this.actions++;
        Promise.resolve().then(async()=>{
          const search=this.client.corpseSearch,inventory=this.client.inventory;
          if(!search)throw Error('Corpse search unavailable');
          if(!inventory?.view?.alive||inventory.view.life!==intent.life)return {status:'rejected',reason:'stale_or_dead_life'};
          if(intent.kind==='dismiss'){search.dismiss();return {status:'closed'};}
          if(intent.kind==='open'){await search.open(intent.source);return {status:'opened'};}
          if(search.view?.source!==intent.source||search.view?.generation!==intent.generation)return {status:'conflict'};
          return search.take(intent.items);
        }).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='world-items-applied'){this.worldItems.ack(m.sequence);return;}
      if(m.type==='inventory-applied'){this.inventories.ack(m.sequence);return;}
      if(m.type==='engine-inventory-applied'){
        const v=m.view;
        if(!v||!Number.isSafeInteger(v.generation)||v.generation<0||!Number.isInteger(v.life)||v.life<0||v.life>0xffffffff||!Number.isInteger(v.items)||v.items<0||v.items>100000||typeof v.alive!=='boolean')throw Error('Invalid native inventory report');
        this.client.emit?.('engine-inventory',v);return;
      }
      if(m.type==='inventory-move'||m.type==='inventory-batch'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1)throw Error('Invalid or excessive inventory action');
        const batch=m.type==='inventory-batch'?validateInventoryBatch(m.intents):null;
        const intent=batch?batch[0]:validateInventoryIntent(m.intent);this.actions++;
        Promise.resolve().then(()=>{
          const inventory=this.client.inventory;
          if(!inventory)throw Error('Inventory unavailable');
          // Do not reinterpret a delayed click as an action for a later life.
          if(inventory.view?.life!==intent.life||!inventory.view?.alive)return {status:'rejected',reason:'stale_or_dead_life'};
          return batch?inventory.moveBatch(batch.map(i=>({id:i.item,revision:i.revision})),intent.action):inventory.move({id:intent.item,revision:intent.revision},intent.action);
        }).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='input'){
        if(!validInput(m.input) || !Number.isSafeInteger(m.sequence) || m.sequence<1)throw new Error('Invalid engine input');
        this.client.setInput(m.input);this.send({type:'input-accepted',sequence:m.sequence});return;
      }
      if(m.type==='view'){
        if(typeof m.firstPerson!=='boolean'||typeof m.crosshair!=='boolean')throw Error('Invalid camera mode');
        this.client.emit?.('view',m.firstPerson);
        this.client.emit?.('crosshair',m.crosshair);return;
      }
      if(m.type==='reload'||m.type==='respawn'||m.type==='useTravel'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1)throw Error('Invalid or excessive action');
        this.actions++;this.client[m.type]().then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='select-weapon'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1||!Number.isInteger(m.life)||m.life<0||m.life>0xffffffff||![0,1,2,3,4,6].includes(m.slot))throw Error('Invalid weapon selection');
        this.actions++;
        this.client.selectWeapon(m.life,m.slot).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='select-detector'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1||!Number.isInteger(m.life)||m.life<0||m.life>0xffffffff||typeof m.active!=='boolean')throw Error('Invalid detector selection');
        this.actions++;
        this.client.selectDetector(m.life,m.active).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='trigger-stop'){
        this.client.stopTrigger().catch(()=>{});return;
      }
      if(['fire','trigger-start','grenade','knife'].includes(m.type)){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1||!validAim(m.aim)||!validWeapon(m.item)
          ||m.type!=='fire'&&m.item===null||m.type==='grenade'&&!['prime','release','cancel'].includes(m.phase)
          ||m.type==='knife'&&!['slash','stab'].includes(m.mode))throw Error('Invalid or excessive fire intent');
        this.actions++;
        const action=m.type==='grenade'?this.client.grenade(m.phase,m.aim,m.item):
          m.type==='knife'?this.client.knife(m.mode,m.aim,m.item):
          m.type==='fire'?this.client.fire(m.aim,m.item):this.client.startTrigger(m.aim,m.item);
        action.then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='attack'){
        if(this.actions>=16 || !Number.isSafeInteger(m.request) || m.request<1 || !Number.isInteger(m.target) || m.target<1 || m.target>0xffffffff)throw new Error('Invalid or excessive engine action');
        this.actions++;
        this.client.attack(m.target).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='close'){this.close('engine closed');return;}
      throw new Error('Unknown engine message');
    }catch(error){this.onError(error);this.close(error.message);}
  }
  close(reason='bridge closed'){
    if(this.closed)return;this.send({type:'closed',reason});this.closed=true;this.snapshots.clear();this.inventories.clear();this.worldItems.clear();this.corpseViews.clear();this.client.removeEventListener('corpse-search',this.onCorpseSearch);this.predictionInputs.clear();this.client.removeEventListener('input-sent',this.onInputSent);
    this.client.removeEventListener('inventory',this.onInventory);this.client.removeEventListener('world-items',this.onWorldItems);this.client.removeEventListener('weapon-shot',this.onWeaponShot);
    this.appearances.clear();this.lastAppearances=[];this.client.removeEventListener('lifecycle',this.onLifecycle);
    this.detonations.clear();this.client.removeEventListener('detonations',this.onDetonations);
    this.gunshots.clear();this.client.removeEventListener('gunshots',this.onGunshots);
    this.weaponFire.clear();this.client.removeEventListener('weapon-fired',this.onWeaponFired);
    this.client.removeEventListener('knife-swing',this.onWeaponFired);
    this.client.removeEventListener('grenade-hud',this.onWeaponFired);
    this.weaponReload.clear();this.client.removeEventListener('weapon-reload',this.onWeaponReload);
    this.client.removeEventListener('snapshot',this.onSnapshot);this.client.removeEventListener('disconnected',this.onDisconnect);
    this.client.removeEventListener('vitals',this.onVitals);
    this.client.setInput({});this.client.close();this.unbind();
  }
}
// Engine-worker endpoint. C++ consumes once at the frame boundary. Rendering
// must additionally wait for level readiness; partial/stale frames never apply.
export class EngineBridgeEndpoint {
  closed=false;session=null;snapshot=null;inventory=null;worldItems=null;corpseSearch=null;predictionInputs=null;requests=new Map();request=0;
  appearances=null;
  reloadingLife=null;weaponSlot=null;
  constructor(port,{epoch,contract,onClosed=()=>{}}){
    if(!validEpoch(epoch))throw new Error('Invalid session epoch');
    this.port=port;this.epoch=epoch;this.contract=validateContract(contract);this.onClosed=onClosed;
    this.inputs=new LatestMailbox((sequence,input)=>this.send({type:'input',sequence,input}));
    this.unbind=bind(port,m=>this.receive(m));this.send({type:'ready',contract:this.contract});
  }
  send(m){if(!this.closed)this.port.postMessage({...m,epoch:this.epoch});}
  receive(m){
    if(this.closed || !m || m.epoch!==this.epoch)return;
    try {
      if(m.type==='session'){assertCompatible(this.contract,m.contract);if(!Number.isInteger(m.playerId)||m.playerId<1)throw new Error('Invalid local entity');this.session=m;return;}
      if(m.type==='closed'){this.close(m.reason);return;}
      if(!this.session)throw new Error('Snapshot or action arrived before session');
      if(m.type==='snapshot'){
        if(this.snapshot || !Number.isSafeInteger(m.sequence) || m.sequence<1 || !Array.isArray(m.snapshot?.entities) || m.snapshot.entities.length>7424 || m.snapshot.playerId!==this.session.playerId)throw new Error('Invalid engine snapshot');
        this.vitals=m.vitals==null?null:validateVitals(m.vitals);
        this.grenades=m.grenades==null?null:validateGrenades(m.grenades);
        this.snapshot=m;return;
      }
      if(m.type==='weapon-slot'){
        if(!Number.isInteger(m.life)||m.life<0||m.life>0xffffffff||![0,1,2,3,4,6].includes(m.slot))throw Error('Invalid confirmed weapon slot');
        this.weaponSlot={life:m.life,slot:m.slot};return;
      }
      if(m.type==='appearances'){
        if(this.appearances||!Number.isSafeInteger(m.sequence)||m.sequence<1)throw Error('Invalid appearance delivery');
        validateAppearanceView(m.entries);this.appearances=m;return;
      }
      if(m.type==='corpse-search'){
        if(this.corpseSearch||!Number.isSafeInteger(m.sequence)||m.sequence<1)throw Error('Invalid corpse search delivery');
        validateCorpseView(m.view);this.corpseSearch=m;return;
      }
      if(m.type==='world-items'){
        if(this.worldItems||!Number.isSafeInteger(m.sequence)||m.sequence<1)throw Error('Invalid world item delivery');
        validateWorldItems(m.view);this.worldItems=m;return;
      }
      if(m.type==='inventory'){
        if(this.inventory||!Number.isSafeInteger(m.sequence)||m.sequence<1)throw Error('Invalid engine inventory delivery');
        validateInventoryView(m.view);this.inventory=m;return;
      }
      if(m.type==='prediction-inputs'){if(!Array.isArray(m.history)||m.history.length>32)throw Error('Invalid prediction inputs');this.predictionInputs=m;return;}
      if(m.type==='input-accepted'){this.inputs.ack(m.sequence);return;}
      if(m.type==='weapon-misfire'){this.misfireLife=m.life;return;}
      if(m.type==='weapon-fired'){
        if(this.weaponFire||!Number.isSafeInteger(m.sequence)||m.sequence<1||!Number.isFinite(m.receivedAt))throw Error('Invalid weapon fire delivery');
        validateWeaponFire(m.cue);this.weaponFire=m;return;
      }
      if(m.type==='weapon-reload'){
        if(this.weaponReload||!Number.isSafeInteger(m.sequence)||m.sequence<1||!Number.isFinite(m.receivedAt))throw Error('Invalid reload delivery');
        const cue=validateWeaponReload(m.cue);
        this.reloadingLife=cue.milliseconds>0?cue.life:null;
        this.weaponReload=m;return;
      }
      if(m.type==='detonations'){
        if(this.detonations||!Number.isSafeInteger(m.sequence)||m.sequence<1||!Number.isFinite(m.receivedAt))throw Error('Invalid detonation delivery');
        validateDetonations(m.effects);this.detonations=m;return;
      }
      if(m.type==='gunshots'){
        if(this.gunshots||!Number.isSafeInteger(m.sequence)||m.sequence<1||!Number.isFinite(m.receivedAt))throw Error('Invalid gunshot delivery');
        validateGunshots(m.effects);this.gunshots=m;return;
      }
      if(m.type==='action-result'){const p=this.requests.get(m.request);if(p){this.requests.delete(m.request);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}return;}
      throw new Error('Unknown browser message');
    }catch(error){this.close(error.message);}
  }
  consumePredictionInputs(){
    if(!this.predictionInputs)return null;const m=this.predictionInputs;this.predictionInputs=null;
    this.send({type:'prediction-applied',sequence:m.sequence});return m.history;
  }
  consumeSnapshot(){
    if(this.closed || !this.snapshot)return null;
    const {sequence,snapshot}=this.snapshot;this.snapshot=null;
    this.send({type:'snapshot-applied',sequence});return snapshot;
  }
  consumeDetonations(now=Date.now()){
    if(this.closed||!this.detonations)return null;
    const {sequence,effects,receivedAt}=this.detonations;this.detonations=null;
    this.send({type:'detonations-applied',sequence});
    return now-receivedAt<=1000?effects:null;
  }
  consumeGunshots(now=Date.now()){
    if(this.closed||!this.gunshots)return null;
    const {sequence,effects,receivedAt}=this.gunshots;this.gunshots=null;
    this.send({type:'gunshots-applied',sequence});
    return now-receivedAt<=300?effects:null;
  }
  consumeWeaponFire(now=Date.now()){
    if(this.closed||!this.weaponFire)return null;
    const {sequence,cue,receivedAt}=this.weaponFire;this.weaponFire=null;
    this.send({type:'weapon-fired-applied',sequence});
    return now-receivedAt<=300?cue:null;
  }
  consumeWeaponReload(now=Date.now()){
    if(this.closed||!this.weaponReload)return null;
    const {sequence,cue,receivedAt}=this.weaponReload;this.weaponReload=null;
    this.send({type:'weapon-reload-applied',sequence});
    return cue.milliseconds===0||now-receivedAt<Math.min(300,cue.milliseconds)?cue:null;
  }
  consumeAppearances(){
    if(this.closed||!this.appearances)return;
    const {sequence}=this.appearances;this.appearances=null;
    this.send({type:'appearances-applied',sequence});
  }
  consumeCorpseSearch(){
    if(this.closed||!this.corpseSearch)return null;
    const message=this.corpseSearch;this.corpseSearch=null;
    this.send({type:'corpse-search-applied',sequence:message.sequence});return {view:message.view};
  }
  corpseIntent(intent){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    try{validateCorpseIntent(intent);}catch(error){return Promise.reject(error);}
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'corpse-intent',request,intent});});
  }
  consumeWorldItems(){
    if(this.closed||!this.worldItems)return null;
    const {sequence,view}=this.worldItems;this.worldItems=null;
    this.send({type:'world-items-applied',sequence});return view;
  }
  consumeInventory(){
    if(this.closed||!this.inventory)return null;
    const {sequence,view}=this.inventory;this.inventory=null;
    this.send({type:'inventory-applied',sequence});return view;
  }
  moveInventory(intent){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    try{validateInventoryIntent(intent);}catch(error){return Promise.reject(error);}
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'inventory-move',request,intent});});
  }
  moveInventoryBatch(intents){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    try{validateInventoryBatch(intents);}catch(error){return Promise.reject(error);}
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'inventory-batch',request,intents});});
  }
  setInput(input){if(!validInput(input))throw new Error('Invalid input');if(!this.closed && this.session)this.inputs.offer({...input});}
  reload(){return this.simpleAction('reload');}
  useTravel(){return this.simpleAction('useTravel');}
  selectWeapon(life,slot){return this.simpleAction('select-weapon',{life,slot});}
  selectDetector(life,active){return this.simpleAction('select-detector',{life,active});}
  grenade(phase,aim,item){return this.simpleAction('grenade',{phase,aim,item});}
  knife(mode,aim,item){return this.simpleAction('knife',{mode,aim,item});}
  respawn(){return this.simpleAction('respawn');}
  simpleAction(type,fields={}){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type,request,...fields});});
  }
  stopTrigger(){if(this.session)this.send({type:'trigger-stop'});}
  fire(aim,item=null,held=false){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    if(!validAim(aim)||!validWeapon(item))return Promise.reject(Error('Invalid aim or weapon ID'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:held?'trigger-start':'fire',request,item,aim:{tick:aim.tick,yaw:aim.yaw,pitch:aim.pitch}});});
  }
  attack(target){
    if(this.closed || !this.session || this.requests.size>=16)return Promise.reject(new Error('Engine bridge unavailable or busy'));
    if(!Number.isInteger(target)||target<1||target>0xffffffff)return Promise.reject(new Error('Invalid target'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'attack',request,target});});
  }
  close(reason='engine closed'){
    if(this.closed)return;this.send({type:'close'});this.closed=true;this.snapshot=null;this.inventory=null;this.worldItems=null;this.corpseSearch=null;this.detonations=null;this.weaponFire=null;this.weaponReload=null;this.appearances=null;this.predictionInputs=null;this.inputs.clear();
    this.gunshots=null;
    for(const p of this.requests.values())p.reject(new Error(reason));this.requests.clear();this.unbind();this.onClosed(reason);
  }
}
