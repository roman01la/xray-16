import {writeRecord,transferEntity} from './identity.mjs';
const MAX_ITEMS=32,MAX_BYTES=192*1024;
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function validate(kind,command){
 if(!['record','transfer'].includes(kind)||!command||typeof command!=='object')throw Error('Invalid durable command');
 const keys=kind==='record'?['expectedRevision','requestId','value']:['entityId','expectedRevision','recipient','requestId'];
 if(Object.keys(command).sort().join()!==keys.sort().join()||!Number.isInteger(command.expectedRevision)||command.expectedRevision<0||command.expectedRevision>0xffffffff||!/^[a-zA-Z0-9_-]{1,64}$/.test(command.requestId))throw Error('Invalid durable command');
 if(kind==='transfer'&&(!/^[a-f0-9]{32}$/.test(command.entityId)||!/^[a-f0-9]{32}$/.test(command.recipient)))throw Error('Invalid transfer IDs');
 if(kind==='record'&&new TextEncoder().encode(JSON.stringify(command.value)).length>4096)throw Error('Record too large');
}
export class DurableOutbox {
 constructor(identity,{storage=localStorage,locks=globalThis.navigator?.locks,send=null,token=''}={}){
  if(!/^[a-f0-9]{32}$/.test(identity.principalId))throw Error('Invalid outbox principal');
  this.principalId=identity.principalId;this.storage=storage;this.locks=locks;
  this.key='zone-multiplayer-outbox-v1:'+identity.principalId;
  this.send=send||((kind,command)=>(kind==='record'?writeRecord:transferEntity)(identity,command,{token}));
 }
 async lock(fn){
  if(!this.locks)throw Error('Durable outbox requires Web Locks');
  return this.locks.request(this.key,{mode:'exclusive',signal:AbortSignal.timeout(15000)},fn);
 }
 read(){
  const text=this.storage.getItem(this.key);if(!text)return [];
  if(new TextEncoder().encode(text).length>MAX_BYTES)throw Error('Oversized saved outbox');
  const data=JSON.parse(text);
  if(data.version!==1||data.principalId!==this.principalId||!Array.isArray(data.items)||data.items.length>MAX_ITEMS)throw Error('Invalid saved outbox');
  const ids=new Set();for(const item of data.items){validate(item.kind,item.command);if(ids.has(item.command.requestId))throw Error('Duplicate saved command');ids.add(item.command.requestId);if(item.result!==null&&!['committed','conflict','rejected'].includes(item.result?.status))throw Error('Invalid saved outcome');}
  return data.items;
 }
 save(items){
  const text=JSON.stringify({version:1,principalId:this.principalId,items});
  if(items.length>MAX_ITEMS||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('Durable outbox full');
  // A storage failure must stop before transmitting, or leave the previous
  // pending command intact after an uncertain response. Never silently evict.
  this.storage.setItem(this.key,text);
 }
 async enqueue(kind,payload){
  const command=JSON.parse(JSON.stringify({...payload,requestId:payload.requestId??crypto.randomUUID()}));validate(kind,command);
  return this.lock(()=>{const items=this.read(),existing=items.find(i=>i.command.requestId===command.requestId);
   if(existing){if(existing.kind!==kind||canonical(existing.command)!==canonical(command))throw Error('Request ID already used');return structuredClone(existing);}
   const item={kind,command,result:null};items.push(item);this.save(items);return structuredClone(item);
  });
 }
 async entries(){return this.lock(()=>structuredClone(this.read()));}
 async flush(){
  // Acquire per command, allowing other tabs to enqueue/inspect between sends.
  // Concurrent flushers see the saved result and cannot send completed work twice.
  for(let attempt=0;attempt<MAX_ITEMS;attempt++){
   const sent=await this.lock(async()=>{
    const items=this.read(),item=items.find(i=>i.result===null);if(!item)return false;
    const result=await this.send(item.kind,structuredClone(item.command));
    if(!result||!['committed','conflict','rejected'].includes(result.status))throw Error('Unknown durable outcome');
    item.result=result;this.save(items);return true;
   });
   if(!sent)break;
  }
  return this.entries();
 }
 async acknowledge(requestId){return this.lock(()=>{
  const items=this.read(),item=items.find(i=>i.command.requestId===requestId);
  if(item?.result===null)throw Error('Cannot forget an unresolved command');
  this.save(items.filter(i=>i.command.requestId!==requestId));
 });}
}
