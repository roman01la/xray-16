import {LifecycleRegistry} from './lifecycle.mjs';
import {loadContract, assertCompatible} from './contract.mjs';
import {encodeInput, SnapshotAssembler, newer, encodeSnapshotFeedback} from './protocol.mjs';
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
  weapon=null; ownershipVersion=0;
  stats={receivedBytes:0,receivedPackets:0,snapshots:0,resyncs:0};
  input={}; inputActive=true; sequence=0; actionSequence=0; pending=new Map(); snapshot=null; playerId=null;
  emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  async connect({url='/offer',token='',iceServers=[],contract=null,impairment=null,identitySecret=null}={}) {
    if(this.connecting)throw new Error('Connection already started');
    this.connecting=true;
    this.contract=contract || await loadContract();
    if(this.pc) throw new Error('Already connected; create a new client to reconnect');
    this.impairment=impairment;if(impairment){const {DeliveryQueue}=await import('./network-faults.mjs');this.upQueue=new DeliveryQueue(impairment);this.downQueue=new DeliveryQueue(impairment);}
    const pc=this.pc=new RTCPeerConnection({iceServers});
    this.assembler=new SnapshotAssembler(); this.closed=false;
    this.state=pc.createDataChannel('state-v2',{negotiated:true,id:0,ordered:false,maxRetransmits:0,protocol:'zone-v2'});
    this.control=pc.createDataChannel('control-v2',{negotiated:true,id:2,ordered:true,protocol:'zone-v2'});
    this.state.binaryType='arraybuffer';
    const receiveState=data=>{const snapshot=this.assembler.push(data);
      if(this.state.readyState==='open'&&this.state.bufferedAmount<4096){
        if(snapshot)this.sendState(encodeSnapshotFeedback(snapshot.tick));
        else if(this.assembler.needsResync && (!this.lastResync || performance.now()-this.lastResync>1000)){this.lastResync=performance.now();this.assembler.needsResync=false;this.stats.resyncs++;this.sendState(encodeSnapshotFeedback(0,true));}
      }
      if(snapshot){this.stats.snapshots++;this.snapshot=snapshot;this.inputHistory=this.inputHistory.filter(i=>newer(i.sequence,snapshot.ack));this.emit('snapshot',snapshot);}};
    this.state.onmessage=({data})=>{this.stats.receivedPackets++;this.stats.receivedBytes+=data.byteLength||0;this.deliverIncoming(data,receiveState,false);};
    const receiveControl=data=>{
      try {
        const m=JSON.parse(data);
        if(m.type==='welcome' && m.version===2){assertCompatible(this.contract,m.contract);if(identitySecret&&!/^[a-f0-9]{32}$/.test(m.principalId))throw Error('Missing persistent principal');this.playerId=m.playerId;this.principalId=m.principalId??null;this.emit('welcome',m);}
        if(m.type==='ownership_dirty'){this.ownershipVersion++;this.emit('ownership-invalidated',{version:this.ownershipVersion});}
        if(m.type==='weapon'){
          const s=m.state;if(!s||!Number.isInteger(s.ammo)||s.ammo<0||s.ammo>30||!Number.isInteger(s.reserve)||s.reserve<0||s.reserve>90||(s.reloadReadyTick!==null&&(!Number.isInteger(s.reloadReadyTick)||s.reloadReadyTick<0||s.reloadReadyTick>0xffffffff)))throw Error('Invalid weapon state');
          this.weapon={...s};this.emit('weapon',this.weapon);
        }
        if(m.type==='lifecycle'){this.lifecycle.apply(m);this.emit('lifecycle',m);}
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
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({version:2,contract:this.contract,offer:pc.localDescription,...(identitySecret?{identity_secret:identitySecret}:{})}),signal:AbortSignal.timeout(10000)});
      const body=await response.json();
      if(!response.ok || body.version!==2) throw new Error(body.error || 'Signaling version mismatch');
      assertCompatible(this.contract,body.contract);
      await pc.setRemoteDescription(body.answer);
      await Promise.all([waitFor(this.state,'open',()=>this.state.readyState==='open'),waitFor(this.control,'open',()=>this.control.readyState==='open'),waitFor(this,'welcome',()=>this.playerId!==null)]);
      if(this.closed) throw new Error('Connection closed');
      this.connectedAt=performance.now();
      this.timer=setInterval(()=>{if(this.checkLiveness())this.sendInput();},1000/this.contract.tickHz); this.sendInput();
      return this;
    } catch(error){this.close();throw error;}
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
  setInput(input){this.input={...input};}
  sendInput(){
    if(this.state?.readyState==='open' && this.state.bufferedAmount<4096) {
      const packet=encodeInput(this.sequence=(this.sequence+1)>>>0,this.inputActive?this.input:{}),v=new DataView(packet);
      this.sendState(packet);
      // Replay the quantized values that the server actually receives.
      this.inputHistory.push({sequence:this.sequence,x:v.getInt16(8,true)/32767,z:v.getInt16(10,true)/32767,yaw:v.getFloat32(12,true),sprint:!!(v.getUint16(16,true)&1),jump:!!(v.getUint16(16,true)&2),crouch:!!(v.getUint16(16,true)&4)});
      this.inputHistory=this.inputHistory.slice(-32);this.emit('input-sent',this.inputHistory);
    }
  }
  reload(){return this.action({type:'reload'});}
  respawn(){return this.action({type:'respawn'});}
  attack(target){return this.action({type:'attack',target});}
  fire(aim){
    if(!Number.isInteger(aim?.tick)||aim.tick<0||aim.tick>0xffffffff||![aim.yaw,aim.pitch].every(Number.isFinite))return Promise.reject(Error('Invalid aim'));
    return this.action({type:'fire',aim:{tick:aim.tick,yaw:aim.yaw,pitch:aim.pitch}});
  }
  action(command){
    if(this.control?.readyState!=='open' || this.control.bufferedAmount>16384 || this.pending.size>=16) return Promise.reject(new Error('Control channel unavailable or busy'));
    const sequence=this.actionSequence=(this.actionSequence+1)>>>0;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(sequence);reject(new Error('Action result timed out; outcome unknown'));},5000);
      this.pending.set(sequence,{resolve,reject,timer});
      try{this.sendControl(JSON.stringify({...command,sequence}));}
      catch(error){clearTimeout(timer);this.pending.delete(sequence);reject(error);}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;clearInterval(this.timer);this.upQueue?.close();this.downQueue?.close();
    if(this.control?.readyState==='open') {try{this.control.send(JSON.stringify({type:'leave',sequence:(++this.actionSequence)>>>0}));}catch{}}
    this.pc?.close();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected; action outcome unknown'));}
    this.pending.clear();this.lifecycle.clear();this.weapon=null;this.snapshot=null;this.assembler?.pending.clear();this.assembler?.frames.clear();this.inputHistory=[];this.emit('disconnected');
  }
}
