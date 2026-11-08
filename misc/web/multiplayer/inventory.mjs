// Presentation adapter for the original engine inventory, not a replacement UI.
// Commands persist before transmission so a lost reply/reload reuses the same ID.
const id=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
export class InventoryClient {
 constructor(client,{principal,storage=globalThis.localStorage,onChange=()=>{},onError=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancel=timer=>clearTimeout(timer)}){
  if(!id(principal))throw Error('Inventory requires a persistent principal');
  this.client=client;this.storage=storage;this.key=`zone.inventory.pending.v1.${principal}`;
  this.onChange=onChange;this.onError=onError;this.view=null;this.closed=false;this.inFlight=false;this.refreshing=null;
  this.schedule=schedule;this.cancel=cancel;this.retryTimer=null;this.retryDelay=1000;
 }
 async refresh(){
  if(this.closed)return null;if(this.inFlight){this.dirty=true;return this.view;}
  if(this.refreshing){this.dirty=true;return this.refreshing;}
  this.refreshing=(async()=>{let view;do{this.dirty=false;view=await this.readCoherent();}while(this.dirty&&!this.closed&&!this.inFlight);return view;})().finally(()=>{this.refreshing=null;});return this.refreshing;
 }
 async readCoherent(){
  for(let attempt=0;attempt<5&&!this.closed;attempt++){
   let after='',generation=null,items=[],metadata=null,restart=false;const seen=new Set();
   for(let pageCount=0;pageCount<1000;pageCount++){
    const page=await this.client.inventoryPage(after,generation);
    if(page?.status==='conflict'||page?.error?.startsWith('inventory busy')){restart=true;break;}
    if(page?.error)throw Error(page.error);
    if(!Array.isArray(page?.items)||page.items.length>100||!Number.isSafeInteger(page.generation)||page.generation<0||!Number.isInteger(page.life)||page.life<0||page.life>0xffffffff||typeof page.alive!=='boolean')throw Error('Invalid inventory page');
    if(generation!==null&&(generation!==page.generation||metadata.life!==page.life||metadata.alive!==page.alive))throw Error('Mixed inventory generations');
    for(const item of page.items){
     if(!id(item.id)||seen.has(item.id)||!Number.isInteger(item.revision)||item.revision<0||item.revision>0xffffffff||typeof item.section!=='string'||typeof item.place!=='string'||!item.state)throw Error('Invalid inventory item');
     seen.add(item.id);items.push(item);
    }
    generation=page.generation;metadata=page;
    if(page.nextCursor===null){
     const view={life:page.life,alive:page.alive,generation,corpse:page.corpse,items};
     if(!this.closed){this.view=view;this.onChange(view);}return view;
    }
    if(!id(page.nextCursor)||page.nextCursor<=after||page.items.at(-1)?.id!==page.nextCursor)throw Error('Invalid inventory cursor');
    after=page.nextCursor;
   }
   if(!restart)throw Error('Inventory page limit exceeded');
   await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
  }
  if(!this.closed)throw Error('Inventory changed during reconciliation');return null;
 }
 async move(item,action){
  if(!this.view)throw Error('Inventory has not loaded');
  if(this.storage.getItem(this.key))throw Error('Recover the pending item action first');
  const command={requestId:crypto.randomUUID().replaceAll('-',''),life:this.view.life,item:item.id,revision:item.revision,action};
  // Failure to persist aborts before send; never mint a fresh request ID on retry.
  this.storage.setItem(this.key,JSON.stringify({kind:'move',command}));return this.recover();
 }
 async moveBatch(items,action){
  if(this.closed)throw Error('Inventory session closed');
  if(!this.view)throw Error('Inventory has not loaded');
  if(this.storage.getItem(this.key))throw Error('Recover the pending item action first');
  if(!Array.isArray(items)||items.length===0||items.length>4096||new Set(items.map(item=>item.id)).size!==items.length)throw Error('Invalid inventory batch');
  const commands=items.map(item=>{
   if(!id(item.id)||!Number.isInteger(item.revision)||item.revision<0||item.revision>0xffffffff)throw Error('Invalid inventory batch item');
   return {requestId:crypto.randomUUID().replaceAll('-',''),life:this.view.life,item:item.id,revision:item.revision,action};
  });
  // Persist every original revision/life and request ID before the first send.
  // A partially completed drop is resumed, never regenerated from the new view.
  this.storage.setItem(this.key,JSON.stringify({kind:'batch',commands,results:[]}));
  return this.recover();
 }
 async respawn(){
  if(!this.view)throw Error('Inventory has not loaded');
  if(this.storage.getItem(this.key))throw Error('Recover the pending item action first');
  const command={requestId:crypto.randomUUID().replaceAll('-',''),life:this.view.life};
  this.storage.setItem(this.key,JSON.stringify({kind:'respawn',command}));return this.recover();
 }
 async recover(){
  if(this.closed)return null;
  if(this.inFlight)throw Error('Inventory action in flight');
  if(this.retryTimer!==null){this.cancel(this.retryTimer);this.retryTimer=null;}
  const raw=this.storage.getItem(this.key);if(!raw)return this.refresh();
  const pending=JSON.parse(raw),{kind,command}=pending;if(!['move','respawn','batch'].includes(kind))throw Error('Invalid pending inventory action');this.inFlight=true;
  try{
   if(kind==='batch'){
    if(!Array.isArray(pending.commands)||!Array.isArray(pending.results)||pending.commands.length+pending.results.length>4096)throw Error('Invalid pending inventory batch');
    while(pending.commands.length){
     if(this.closed)throw Error('Inventory session closed');
     const result=await this.client.moveInventory(pending.commands[0]);
     if(result?.error)throw Error(result.error);
     if(!['committed','rejected','conflict'].includes(result?.status))throw Error('Invalid inventory action result');
     // Persist acknowledgement and remaining commands together. If storage fails,
     // the old head is safely replayed under its unchanged request ID.
     pending.results.push(result);pending.commands.shift();
     this.storage.setItem(this.key,JSON.stringify(pending));
    }
    this.storage.removeItem(this.key);this.retryDelay=1000;
    return {status:'batch_complete',results:pending.results};
   }
   const result=await (kind==='move'?this.client.moveInventory(command):this.client.respawnInventory(command));
   if(result?.error)throw Error(result.error);
   if(!['committed','respawned','rejected','conflict'].includes(result?.status))throw Error('Invalid inventory action result');
   this.storage.removeItem(this.key);this.retryDelay=1000;return result;
  }finally{
   this.inFlight=false;
   // Reconcile current authority rather than applying an old replay response as a
   // new state change (the item may since have been dropped, looted or lost).
   if(this.refreshing)await this.refreshing.catch(this.onError);
   if(!this.closed)await this.refresh().catch(this.onError);
   // A lost reply must not leave the original menu permanently unable to act.
   // Replay the journaled command, including its original life and request ID.
   if(!this.closed&&this.storage.getItem(this.key)&&this.retryTimer===null){
    const delay=this.retryDelay;this.retryDelay=Math.min(30000,delay*2);
    this.retryTimer=this.schedule(()=>{this.retryTimer=null;void this.recover().catch(this.onError);},delay);
   }
  }
 }
 close(){this.closed=true;this.view=null;if(this.retryTimer!==null)this.cancel(this.retryTimer);this.retryTimer=null;}
}
