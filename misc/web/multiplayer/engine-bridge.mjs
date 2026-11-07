import {assertCompatible,validateContract} from './contract.mjs';
const validAim=a=>a && Number.isInteger(a.tick)&&a.tick>=0&&a.tick<=0xffffffff&&Number.isFinite(a.yaw)&&Number.isFinite(a.pitch)&&Math.abs(a.pitch)<=1.55;
const validEpoch=e=>typeof e==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(e);
const validInput=i=>i && ['x','z','yaw'].every(k=>Number.isFinite(i[k])) && Math.abs(i.x)<=1 && Math.abs(i.z)<=1 && typeof i.sprint==='boolean' && (i.jump===undefined||typeof i.jump==='boolean') && (i.crouch===undefined||typeof i.crouch==='boolean');
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
    this.snapshots=new LatestMailbox((sequence,snapshot)=>this.send({type:'snapshot',sequence,snapshot}));
    this.unbind=bind(port,m=>this.receive(m));
    this.onSnapshot=e=>{if(this.ready)this.snapshots.offer(e.detail);};
    this.onDisconnect=()=>this.close('transport disconnected');
    client.addEventListener('snapshot',this.onSnapshot);client.addEventListener('disconnected',this.onDisconnect);
  }
  send(message){if(!this.closed)this.port.postMessage({...message,epoch:this.epoch});}
  receive(m){
    if(this.closed || !m || m.epoch!==this.epoch)return;
    try {
      if(m.type==='ready'){
        if(this.ready)throw new Error('Duplicate engine ready');assertCompatible(this.contract,m.contract);this.ready=true;
        this.send({type:'session',contract:this.contract,playerId:this.client.playerId});
        if(this.client.snapshot)this.snapshots.offer(this.client.snapshot);return;
      }
      if(!this.ready)throw new Error('Engine sent data before ready');
      if(m.type==='engine-applied'){
        if(!Number.isInteger(m.tick)||m.tick<0||m.tick>0xffffffff||!Number.isInteger(m.entities)||m.entities<1||m.entities>7424)throw new Error('Invalid engine report');
        if(m.prediction && (typeof m.prediction.ready!=='boolean'||(m.prediction.active!==undefined&&typeof m.prediction.active!=='boolean')||!Number.isInteger(m.prediction.replays)||m.prediction.replays<0||m.prediction.replays>8))throw Error('Invalid prediction report');
        this.onApplied({tick:m.tick,entities:m.entities,...(m.prediction?{prediction:m.prediction}:{})});return;
      }
      if(m.type==='prediction-applied'){this.predictionInputs.ack(m.sequence);return;}
      if(m.type==='snapshot-applied'){this.snapshots.ack(m.sequence);return;}
      if(m.type==='input'){
        if(!validInput(m.input) || !Number.isSafeInteger(m.sequence) || m.sequence<1)throw new Error('Invalid engine input');
        this.client.setInput(m.input);this.send({type:'input-accepted',sequence:m.sequence});return;
      }
      if(m.type==='view'){
        if(typeof m.firstPerson!=='boolean')throw Error('Invalid camera mode');
        this.client.emit?.('view',m.firstPerson);return;
      }
      if(m.type==='reload'||m.type==='respawn'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1)throw Error('Invalid or excessive action');
        this.actions++;this.client[m.type]().then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
      }
      if(m.type==='fire'){
        if(this.actions>=16||!Number.isSafeInteger(m.request)||m.request<1||!validAim(m.aim))throw Error('Invalid or excessive fire intent');
        this.actions++;this.client.fire(m.aim).then(result=>this.send({type:'action-result',request:m.request,result}),error=>this.send({type:'action-result',request:m.request,error:error.message})).finally(()=>this.actions--);return;
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
    if(this.closed)return;this.send({type:'closed',reason});this.closed=true;this.snapshots.clear();this.predictionInputs.clear();this.client.removeEventListener('input-sent',this.onInputSent);
    this.client.removeEventListener('snapshot',this.onSnapshot);this.client.removeEventListener('disconnected',this.onDisconnect);
    this.client.setInput({});this.client.close();this.unbind();
  }
}
// Engine-worker endpoint. C++ consumes once at the frame boundary. Rendering
// must additionally wait for level readiness; partial/stale frames never apply.
export class EngineBridgeEndpoint {
  closed=false;session=null;snapshot=null;predictionInputs=null;requests=new Map();request=0;
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
        this.snapshot=m;return;
      }
      if(m.type==='prediction-inputs'){if(!Array.isArray(m.history)||m.history.length>32)throw Error('Invalid prediction inputs');this.predictionInputs=m;return;}
      if(m.type==='input-accepted'){this.inputs.ack(m.sequence);return;}
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
  setInput(input){if(!validInput(input))throw new Error('Invalid input');if(!this.closed && this.session)this.inputs.offer({...input});}
  reload(){return this.simpleAction('reload');}
  respawn(){return this.simpleAction('respawn');}
  simpleAction(type){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type,request});});
  }
  fire(aim){
    if(this.closed||!this.session||this.requests.size>=16)return Promise.reject(Error('Engine bridge unavailable or busy'));
    if(!validAim(aim))return Promise.reject(Error('Invalid aim'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'fire',request,aim:{tick:aim.tick,yaw:aim.yaw,pitch:aim.pitch}});});
  }
  attack(target){
    if(this.closed || !this.session || this.requests.size>=16)return Promise.reject(new Error('Engine bridge unavailable or busy'));
    if(!Number.isInteger(target)||target<1||target>0xffffffff)return Promise.reject(new Error('Invalid target'));
    const request=++this.request;return new Promise((resolve,reject)=>{this.requests.set(request,{resolve,reject});this.send({type:'attack',request,target});});
  }
  close(reason='engine closed'){
    if(this.closed)return;this.send({type:'close'});this.closed=true;this.snapshot=null;this.inputs.clear();
    for(const p of this.requests.values())p.reject(new Error(reason));this.requests.clear();this.unbind();this.onClosed(reason);
  }
}
