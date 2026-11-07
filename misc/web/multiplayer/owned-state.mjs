import {listEntities} from './identity.mjs';
const idPattern=/^[a-f0-9]{32}$/;
class Changed extends Error {}
// Publishes only complete, same-generation views. Notifications are invalidation
// hints; they never add/remove entities themselves or authorize gameplay actions.
export class OwnedState extends EventTarget {
 #entities=[];
 constructor(readPage,{schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),maxEntities=4096,maxBytes=16*1024*1024,auditMs=30000,onError=()=>{}}={}){
  super();Object.assign(this,{readPage,schedule,cancel,maxEntities,maxBytes,auditMs,onError});
  this.generation=null;this.ready=false;this.stale=true;this.closed=false;this.serial=0;this.running=null;this.timer=null;this.retryMs=1000;
 }
 snapshot(){return {generation:this.generation,entities:structuredClone(this.#entities),ready:this.ready,stale:this.stale};}
 refresh(){
  if(this.closed)return Promise.reject(Error('Owned state closed'));
  this.serial++;this.stale=true;this.dispatchEvent(new Event('stale'));
  if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
  if(this.running)return this.running;
  this.running=this.run().catch(error=>{this.onError(error);throw error;}).finally(()=>{
   this.running=null;
   if(!this.closed){const delay=this.stale?this.retryMs:this.auditMs;if(delay>0)this.timer=this.schedule(()=>{this.timer=null;this.refresh().catch(()=>{});},delay);if(this.stale)this.retryMs=Math.min(this.retryMs*2,10000);}
  });return this.running;
 }
 async run(){
  for(let attempt=0;attempt<3;attempt++){
   const serial=this.serial;this.controller=new AbortController();
   const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(10000)]);
   let after='',generation=null,bytes=0;const entities=[];
   try{
    for(let pageNumber=0;pageNumber<Math.ceil(this.maxEntities/100)+1;pageNumber++){
     const page=await this.readPage(after,generation,signal);
     if(this.closed)throw Error('Owned state closed');
     if(serial!==this.serial||page?.status==='conflict')throw new Changed();
     if(!page||!Number.isSafeInteger(page.generation)||page.generation<0||!Array.isArray(page.entities)||page.entities.length>100||(page.nextCursor!==null&&!idPattern.test(page.nextCursor)))throw Error('Invalid owned-state page');
     if(generation!==null&&generation!==page.generation)throw new Changed();generation=page.generation;
     for(const entity of page.entities){
      if(!entity||!idPattern.test(entity.id)||entity.id<=after||!Number.isInteger(entity.revision)||entity.revision<0||entity.revision>0xffffffff||!Object.hasOwn(entity,'value'))throw Error('Invalid owned entity ordering or data');
      bytes+=new TextEncoder().encode(JSON.stringify(entity)).length;
      if(entities.length>=this.maxEntities||bytes>this.maxBytes)throw Error('Owned-state view exceeds capacity');
      entities.push(entity);after=entity.id;
     }
     if(page.nextCursor!==null){if(page.entities.length===0||page.nextCursor!==after)throw Error('Invalid owned-state cursor');continue;}
     if(serial!==this.serial)throw new Changed();
     this.#entities=structuredClone(entities);this.generation=generation;this.ready=true;this.stale=false;this.retryMs=1000;
     this.dispatchEvent(new CustomEvent('snapshot',{detail:this.snapshot()}));return this.snapshot();
    }
    throw Error('Owned-state page limit');
   }catch(error){if(error instanceof Changed)continue;throw error;}
  }
  throw Error('Ownership kept changing; refresh deferred');
 }
 close(){if(this.closed)return;this.closed=true;this.serial++;this.controller?.abort();if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.#entities=[];this.generation=null;this.ready=false;this.stale=true;this.dispatchEvent(new Event('cleared'));}
}
export function bindOwnedState(client,identity,options={}){
 const view=new OwnedState((after,generation,signal)=>listEntities(identity,after,{generation,signal}),options);
 const changed=()=>{view.refresh().catch(()=>{});};
 const disconnected=()=>{client.removeEventListener('ownership-invalidated',changed);client.removeEventListener('disconnected',disconnected);view.close();};
 client.addEventListener('ownership-invalidated',changed);client.addEventListener('disconnected',disconnected);
 if(client.closed)disconnected();else changed();return view;
}
