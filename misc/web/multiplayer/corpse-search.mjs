import {validateInventoryView} from './inventory-abi.mjs';
const id=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
export function validateCorpseView(view){
 if(view===null)return null;
 if(!id(view?.source)||!Array.isArray(view.items)||view.items.length>4096||view.items.some(item=>item.place!=='rucksack'))throw Error('Invalid corpse view');
 validateInventoryView({...view,alive:true,corpse:null});return view;
}
export function validateCorpseIntent(intent){
 if(!intent||!Number.isInteger(intent.life)||intent.life<0||intent.life>0xffffffff||!['open','dismiss','take'].includes(intent.kind))throw Error('Invalid corpse intent');
 const keys=intent.kind==='take'?['kind','life','source','generation','items']:intent.kind==='open'?['kind','life','source']:['kind','life'];
 if(Object.keys(intent).length!==keys.length||keys.some(k=>!Object.hasOwn(intent,k)))throw Error('Invalid corpse intent');
 if(intent.kind!=='dismiss'&&!id(intent.source))throw Error('Invalid corpse source');
 if(intent.kind==='take'&&(!Number.isSafeInteger(intent.generation)||intent.generation<0||!Array.isArray(intent.items)||!intent.items.length||intent.items.length>4096||!intent.items.every(id)||new Set(intent.items).size!==intent.items.length))throw Error('Invalid corpse selection');
 return intent;
}
// Original corpse-search UI consumes complete server views. Never merge pages
// from different generations or apply an optimistic local ownership transfer.
export class CorpseSearchClient {
 constructor(client,{onChange=()=>{},onError=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancel=timer=>clearTimeout(timer)}={}){
  Object.assign(this,{client,onChange,onError,schedule,cancel});
  this.source=null;this.view=null;this.epoch=0;this.timer=null;this.pending=null;this.closed=false;
 }
 dismiss(){
  this.epoch++;this.source=null;this.view=null;
  if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.onChange(null);
 }
 close(){this.dismiss();this.closed=true;}
 open(source){
  if(this.closed)throw Error('Corpse search session closed');
  if(!id(source))throw Error('Invalid corpse identifier');
  this.dismiss();this.source=source;return this.refresh();
 }
 refresh(){
  if(this.closed||!this.source)return Promise.resolve(null);
  const epoch=this.epoch;
  if(this.pending?.epoch===epoch)return this.pending.promise;
  if(this.timer!==null)this.cancel(this.timer);this.timer=null;
  const promise=this.read(epoch).catch(error=>{
   // Lost access or a failed scan must not leave stale loot actionable.
   if(this.epoch===epoch){this.view=null;this.onChange(null);}throw error;
  }).finally(()=>{
   if(this.pending?.epoch===epoch)this.pending=null;
   if(!this.closed&&this.epoch===epoch&&this.source)this.timer=this.schedule(()=>{this.timer=null;void this.refresh().catch(this.onError);},1000);
  });
  this.pending={epoch,promise};return promise;
 }
 async read(epoch){
  const source=this.source,inventory=this.client.inventory,life=inventory?.view?.life;
  const current=()=>!this.closed&&this.epoch===epoch&&inventory?.view?.alive&&inventory.view.life===life;
  if(!current()){this.dismiss();return null;}
  if(inventory.inFlight||inventory.refreshing)return this.view;
  for(let attempt=0;attempt<5;attempt++){
   let after='',generation=null;const items=[];
   for(let pages=0;pages<4096;pages++){
    const page=await this.client.corpseItems(source,after,generation);
    if(!current()){if(this.epoch===epoch)this.dismiss();return null;}
    if(page?.status==='conflict')break;
    if(page?.error)throw Error(page.error);
    if(page?.source!==source||page.life!==life||!Array.isArray(page.items)||page.items.length>32||(generation!==null&&page.generation!==generation))throw Error('Invalid corpse contents page');
    validateInventoryView({life,alive:true,corpse:null,generation:page.generation,items:page.items});
    for(const item of page.items){
     if(item.id<=after||item.place!=='rucksack')throw Error('Invalid corpse item order or placement');
     after=item.id;items.push(item);
    }
    if(items.length>4096)throw Error('Corpse contents limit exceeded');
    generation=page.generation;
    if(page.nextCursor===null){
     if(this.view?.generation===generation)return this.view;
     const view={source,life,generation,items};this.view=view;this.onChange(view);return view;
    }
    if(!page.items.length||page.nextCursor!==after)throw Error('Invalid corpse contents cursor');
   }
  }
  throw Error('Corpse changed during reconciliation');
 }
 async take(ids){
  const view=this.view,inventory=this.client.inventory;
  if(this.closed||!view||!inventory.view?.alive||inventory.view.life!==view.life)throw Error('Corpse search unavailable');
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw Error('Invalid corpse selection');
  const selected=ids.map(id=>{const item=view.items.find(item=>item.id===id);if(!item)throw Error('Unknown corpse item');return item;});
  // Journal the original revisions and source before sending any pickup. Each
  // server transaction independently checks range, visibility and ownership.
  try{return await inventory.moveBatch(selected,{kind:'pickup',source:view.source});}
  finally{
   if(this.pending)await this.pending.promise.catch(this.onError);
   if(!this.closed&&this.source===view.source)await this.refresh().catch(this.onError);
  }
 }
}
