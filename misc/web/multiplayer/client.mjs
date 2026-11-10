import {encodeControl,decodeControl,validateVitals,GUNSHOTS_OPCODE} from './control.mjs';
import {LifecycleRegistry} from './lifecycle.mjs';
import {loadContract, assertCompatible} from './contract.mjs';
import {encodeInput, SnapshotAssembler, newer, encodeSnapshotFeedback, NPC_POSE_MAX_BYTES, ENVIRONMENT_OPCODE, ENVIRONMENT_BYTES, LOOP_SOUND_OPCODE} from './protocol.mjs';
const waitFor = (target,event,test,ms=10000) => new Promise((resolve,reject)=>{
  if(test()) return resolve();
  const finish=()=>{clearTimeout(timer);target.removeEventListener(event,check);};
  const check=()=>{if(test()){finish();resolve();}};
  const timer=setTimeout(()=>{finish();reject(new Error(`Timed out: ${event}`));},ms);
  target.addEventListener(event,check);
});
export class ZoneClient extends EventTarget {
  inputHistory=[];
  lifecycle=new LifecycleRegistry();
  weapon=null; vitals=null; ownershipVersion=0;
  grenades=null;
  npcPosePackets=new Map();
  nativeSoundPackets=[];
  travelPoints=[];
  stats={receivedBytes:0,receivedPackets:0,snapshots:0,resyncs:0};
  input={}; inputActive=true; heldFire=null; knifeAim=null; sequence=0; actionSequence=0; pending=new Map(); snapshot=null; playerId=null;
  emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  async connect({url='/offer',token='',iceServers=[],contract=null,impairment=null,identitySecret=null,nativeMovement=false}={}) {
    if(this.connecting)throw new Error('Connection already started');
    this.connecting=true;
    this.contract=contract || await loadContract();
    if(this.pc) throw new Error('Already connected; create a new client to reconnect');
    this.impairment=impairment;if(impairment){const {DeliveryQueue}=await import('./network-faults.mjs');this.upQueue=new DeliveryQueue(impairment);this.downQueue=new DeliveryQueue(impairment);}
    const pc=this.pc=new RTCPeerConnection({iceServers});
    this.assembler=new SnapshotAssembler(); this.closed=false;
    this.state=pc.createDataChannel('state-v3',{negotiated:true,id:0,ordered:false,maxRetransmits:0,protocol:'zone-v3'});
    this.control=pc.createDataChannel('control-v3',{negotiated:true,id:2,ordered:true,protocol:'zone-v3'});
    this.state.binaryType='arraybuffer';this.control.binaryType='arraybuffer';
    const receiveState=data=>{
      const opcode=data instanceof ArrayBuffer&&data.byteLength>=4?new DataView(data).getUint8(3):0;
      if(opcode===33||opcode===34||opcode===ENVIRONMENT_OPCODE||opcode===LOOP_SOUND_OPCODE){
        const view=new DataView(data);
        if(view.byteLength<5||view.getUint16(0,true)!==0x5a58||view.getUint8(2)!==3)return;
        const packet=new Uint8Array(data,4);
        if(opcode===33&&packet.length>=50&&packet.length<=NPC_POSE_MAX_BYTES){
          const id=view.getUint32(4,true),tick=view.getUint32(8,true);
          const previous=this.npcPosePackets.get(id);
          if(!id||previous&&!newer(tick,previous.tick))return;
          if(!previous&&this.npcPosePackets.size>=64)this.npcPosePackets.delete(this.npcPosePackets.keys().next().value);
          this.npcPosePackets.set(id,{tick,packet});
        }
        if(opcode===34&&packet.length>=25&&packet.length<=151){
          if(this.nativeSoundPackets.length>=64)this.nativeSoundPackets.shift();
          this.nativeSoundPackets.push({packet,receivedAt:performance.now()});
        }
        if(opcode===ENVIRONMENT_OPCODE&&packet.length===ENVIRONMENT_BYTES){
          const tick=view.getUint32(4,true);
          if(this.nativeEnvironmentTick===undefined||newer(tick,this.nativeEnvironmentTick)){
            this.nativeEnvironmentTick=tick;
            this.nativeEnvironment=packet;
          }
        }
        if(opcode===LOOP_SOUND_OPCODE&&packet.length>=33&&packet.length<=159){
          this.nativeLoops??=new Map();
          const id=view.getUint32(4,true),tick=view.getUint32(8,true),previous=this.nativeLoops.get(id);
          if(id&&(previous?newer(tick,previous.tick):this.nativeLoops.size<32))
            this.nativeLoops.set(id,{tick,packet});
        }
        return;
      }
      if(opcode===26||opcode===GUNSHOTS_OPCODE){
        try{
          const frame=decodeControl(data);
          if(frame.type==='gunshots')this.emit('gunshots',frame.effects);
          else if(!this.grenades||newer(frame.tick,this.grenades.tick))this.grenades={...frame,receivedAt:Date.now()};
        }catch{}
        return;
      }
      const snapshot=this.assembler.push(data);
      if(this.state.readyState==='open'&&this.state.bufferedAmount<4096){
        if(snapshot)this.sendState(encodeSnapshotFeedback(snapshot.tick));
        else if(this.assembler.needsResync && (!this.lastResync || performance.now()-this.lastResync>1000)){this.lastResync=performance.now();this.assembler.needsResync=false;this.stats.resyncs++;this.sendState(encodeSnapshotFeedback(0,true));}
      }
      if(snapshot){this.stats.snapshots++;this.snapshot=snapshot;this.inputHistory=this.inputHistory.filter(i=>newer(i.sequence,snapshot.ack));this.emit('snapshot',snapshot);}};
    this.state.onmessage=({data})=>{this.stats.receivedPackets++;this.stats.receivedBytes+=data.byteLength||0;this.deliverIncoming(data,receiveState,false);};
    const receiveControl=data=>{
      try {
        const m=decodeControl(data);
        if(m.type==='welcome' && m.version===3){assertCompatible(this.contract,m.contract);if(identitySecret&&!/^[a-f0-9]{32}$/.test(m.principalId))throw Error('Missing persistent principal');this.playerId=m.playerId;this.principalId=m.principalId??null;this.emit('welcome',m);}
        if(m.type==='ownership_dirty'){this.ownershipVersion++;this.emit('ownership-invalidated',{version:this.ownershipVersion});}
        if(m.type==='weapon'){
          const s=m.state;if(!s||!Number.isInteger(s.ammo)||s.ammo<0||s.ammo>30||!Number.isInteger(s.reserve)||s.reserve<0||s.reserve>90||(s.reloadReadyTick!==null&&(!Number.isInteger(s.reloadReadyTick)||s.reloadReadyTick<0||s.reloadReadyTick>0xffffffff)))throw Error('Invalid weapon state');
          this.weapon={...s};this.emit('weapon',this.weapon);
        }
        if(m.type==='lifecycle'){this.lifecycle.apply(m);this.emit('lifecycle',m);}
        if(m.type==='inventory_dirty')this.emit('inventory-dirty');
        if(m.type==='weapon_shot')this.emit('weapon-shot',m);
        if(m.type==='weapon_fired')this.emit('weapon-fired',m);
        if(m.type==='knife_swing')this.emit('knife-swing',m);
        if(m.type==='grenade_hud')this.emit('grenade-hud',m);
        if(m.type==='weapon_reload')this.emit('weapon-reload',m);
        if(m.type==='detonations')this.emit('detonations',m.effects);
        if(m.type==='travel')this.emit('travel',m.world);
        if(m.type==='vitals'){this.vitals=validateVitals(m.state);this.emit('vitals',this.vitals);}
        if(m.type==='action_result') {const p=this.pending.get(m.sequence);if(p){clearTimeout(p.timer);this.pending.delete(m.sequence);if(m.result?.status==='respawned'){this.setInput({});this.inputHistory=[];this.emit('input-sent',[]);}
          p.resolve(m.result);this.emit('action-result',m.result);}}
      } catch(error){this.emit('error',error);this.close();}
    };
    this.control.onmessage=({data})=>this.deliverIncoming(data,receiveControl,true);
    pc.onconnectionstatechange=()=>{this.emit('connection',pc.connectionState);if(['failed','closed'].includes(pc.connectionState))this.close();};
    for(const channel of [this.state,this.control]) channel.onclose=()=>this.close();
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitFor(pc,'icegatheringstatechange',()=>pc.iceGatheringState==='complete');
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({version:3,contract:this.contract,offer:pc.localDescription,...(nativeMovement?{native_movement:true}:{}),...(identitySecret?{identity_secret:identitySecret}:{})}),signal:AbortSignal.timeout(10000)});
      const body=await response.json();
      if(!response.ok || body.version!==3) throw new Error(body.error || 'Signaling version mismatch');
      assertCompatible(this.contract,body.contract);
      await pc.setRemoteDescription(body.answer);
      await Promise.all([waitFor(this.state,'open',()=>this.state.readyState==='open'),waitFor(this.control,'open',()=>this.control.readyState==='open'),waitFor(this,'welcome',()=>this.playerId!==null)]);
      if(this.closed) throw new Error('Connection closed');
      this.connectedAt=performance.now();
      this.timer=setInterval(()=>{if(this.checkLiveness())this.sendInput();},1000/this.contract.tickHz); this.sendInput();
      return this;
    } catch(error){this.close();throw error;}
  }
  takeNativeMedia(){
    const poses=[...this.npcPosePackets.values()].map(({packet})=>packet);
    const now=performance.now();
    const sounds=this.nativeSoundPackets.filter(({receivedAt})=>now-receivedAt<=400).map(({packet})=>packet);
    this.npcPosePackets.clear();
    this.nativeSoundPackets.length=0;
    const environment=this.nativeEnvironment;
    this.nativeEnvironment=undefined;
    const loops=this.nativeLoops?[...this.nativeLoops.values()].map(({packet})=>packet):[];
    this.nativeLoops?.clear();
    return {poses,sounds,environment,loops};
  }
  checkLiveness(now=performance.now()){
    if(this.closed)return false;
    const latest=this.snapshot?.receivedAt??this.connectedAt;
    if(latest!==undefined&&now-latest>5000){this.emit('error',new Error('Authoritative snapshots timed out'));this.close();return false;}
    return true;
  }
  deliverIncoming(data,receive,reliable){
    if(this.closed)return;
    const deliver=value=>{if(this.closed)return;try{receive(value);}catch(error){this.emit('error',error);this.close();}};
    try{if(this.downQueue)this.downQueue.push(data,deliver,reliable);else deliver(data);}catch(error){this.emit('error',error);this.close();}
  }
  sendState(packet){
    const deliver=value=>{if(this.state?.readyState==='open'&&this.state.bufferedAmount<4096)this.state.send(value);};
    if(this.upQueue)this.upQueue.push(packet,deliver);else deliver(packet);
  }
  sendControl(packet){
    const deliver=value=>{if(this.control?.readyState==='open')this.control.send(value);};
    if(this.upQueue)this.upQueue.push(packet,deliver,true);else deliver(packet);
  }
  setInput(input){
    this.input={...input};
    const aim=this.heldFire??this.knifeAim;
    if(aim&&Number.isFinite(input.yaw)&&Number.isFinite(input.pitch)){
      aim.yaw=input.yaw;aim.pitch=input.pitch;
    }
  }
  sendInput(){
    if(this.state?.readyState==='open' && this.state.bufferedAmount<4096) {
      const actor=this.snapshot?.entities?.find(entity=>entity.id===this.playerId);
      // Keep the server's pose until the engine submits its first input.
      if(this.playerId!==null&&!actor)return;
      const input={yaw:actor?.health?actor.yaw:0,crouch:!!(actor?.health&&(actor.flags&4)),...(this.inputActive?this.input:{})};
      const aim=this.heldFire??this.knifeAim;
      const trigger=this.inputActive&&aim&&this.snapshot?{...aim,tick:this.snapshot.tick}:null;
      const packet=encodeInput(this.sequence=(this.sequence+1)>>>0,input,trigger),v=new DataView(packet);
      this.sendState(packet);
      // Replay the quantized values that the server actually receives.
      const flags=v.getUint16(16,true);
      this.inputHistory.push({sequence:this.sequence,sentAt:performance.timeOrigin+performance.now(),x:v.getInt16(8,true)/32767,z:v.getInt16(10,true)/32767,yaw:v.getFloat32(12,true),sprint:!!(flags&1),jump:!!(flags&2),crouch:!!(flags&4),walk:!!(flags&8)});
      this.inputHistory=this.inputHistory.slice(-32);this.emit('input-sent',this.inputHistory);
    }
  }
  reload(){return this.action({type:'reload'});}
  selectWeapon(life,slot){return this.action({type:'select_weapon',life,slot});}
  async selectDetector(life,active){
    this.selectingDetector=true;
    let result;
    try{
      await this.worldItemsView?.pending?.catch(()=>{});
      for(let attempt=0;attempt<3;attempt++){
        result=await this.action({type:'select_detector',life,active});
        if(result.error!=='inventory busy; retry the same request ID')break;
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,50));
      }
    }finally{this.selectingDetector=false;}
    if(result.status==='selected')this.worldItemsView?.refresh().catch(this.worldItemsView.onError);
    return result;
  }
  nearTravel(){
    const self=this.snapshot?.entities.find(e=>e.id===this.playerId&&e.health>0);
    return self?this.travelPoints.find(([,p])=>Math.hypot(self.x-p[0],self.y-p[1],self.z-p[2])<=2.1)?.[0]:null;
  }
  async useTravel(){
    if(!this.nearTravel())return {status:'ignored'};
    const result=await this.action({type:'use_travel'});
    this.emit('travel-use',result);
    return result;
  }
  corpses(after=''){return this.action({type:'corpses',after});}
  corpseItems(source,after='',generation=null){return this.action({type:'corpse_items',source,after,generation});}
  worldItems(after=''){return this.action({type:'world_items',after});}
  inventoryPage(after='',generation=null){return this.action({type:'inventory_list',after,generation});}
  moveInventory(command){return this.action({type:'inventory_move',command});}
  respawn(){return this.inventory?this.inventory.respawn():this.respawnInventory({requestId:crypto.randomUUID().replaceAll('-',''),life:0});}
  respawnInventory(command){return this.action({type:'respawn',request_id:command.requestId,life:command.life});}
  attack(target){return this.action({type:'attack',target});}
  fire(aim,item=null){
    if(!Number.isInteger(aim?.tick)||aim.tick<0||aim.tick>0xffffffff||![aim.yaw,aim.pitch].every(Number.isFinite))return Promise.reject(Error('Invalid aim'));
    return this.action({type:'fire',item,aim:{tick:aim.tick,yaw:aim.yaw,pitch:aim.pitch}});
  }
  grenade(phase,aim,item){return this.action({type:'grenade',phase,aim,item});}
  knife(mode,aim,item){
    if(this.knifeAim)return Promise.resolve({status:'rejected',reason:'inventory_busy'});
    if(!Number.isInteger(aim?.tick)||aim.tick<0||aim.tick>0xffffffff||!Number.isFinite(aim.yaw)||!Number.isFinite(aim.pitch)||Math.abs(aim.pitch)>1.55)return Promise.reject(Error('Invalid aim'));
    const swing={sequence:(this.actionSequence+1)>>>0,yaw:aim.yaw,pitch:aim.pitch};
    this.knifeAim=swing;
    return this.action({type:'knife',mode,aim,item}).finally(()=>{if(this.knifeAim===swing)this.knifeAim=null;});
  }
  startTrigger(aim,item){
    if(this.heldFire)return Promise.resolve({status:'rejected',reason:'trigger_held'});
    if(!Number.isInteger(aim?.tick)||aim.tick<0||aim.tick>0xffffffff||!Number.isFinite(aim.yaw)||!Number.isFinite(aim.pitch)||Math.abs(aim.pitch)>1.55)return Promise.reject(Error('Invalid aim'));
    const held={sequence:(this.actionSequence+1)>>>0,yaw:aim.yaw,pitch:aim.pitch};
    this.heldFire=held;
    const clear=()=>{if(this.heldFire===held)this.heldFire=null;};
    return this.action({type:'trigger_start',item,aim}).then(result=>{
      if(result?.status==='rejected'||result?.error)clear();
      return result;
    },error=>{clear();throw error;});
  }
  stopTrigger(){
    if(!this.heldFire)return Promise.resolve({status:'released'});
    this.heldFire=null;
    return this.action({type:'trigger_stop'});
  }
  action(command){
    if(this.control?.readyState!=='open' || this.control.bufferedAmount>16384 || this.pending.size>=16) return Promise.reject(new Error('Control channel unavailable or busy'));
    const sequence=this.actionSequence=(this.actionSequence+1)>>>0;
    const reload=command.type==='inventory_move'&&['reload','nextAmmo'].includes(command.command?.action?.kind);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(sequence);reject(new Error('Action result timed out; outcome unknown'));},reload?30000:5000);
      this.pending.set(sequence,{resolve,reject,timer});
      try{this.sendControl(encodeControl({...command,sequence}));}
      catch(error){clearTimeout(timer);this.pending.delete(sequence);reject(error);}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;clearInterval(this.timer);this.upQueue?.close();this.downQueue?.close();
    if(this.control?.readyState==='open') {try{this.control.send(encodeControl({type:'leave',sequence:(++this.actionSequence)>>>0}));}catch{}}
    this.pc?.close();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected; action outcome unknown'));}
    this.pending.clear();this.lifecycle.clear();this.grenades=null;this.weapon=null;this.heldFire=null;this.knifeAim=null;this.snapshot=null;this.assembler?.pending.clear();this.assembler?.frames.clear();this.inputHistory=[];this.emit('disconnected');
  }
}
