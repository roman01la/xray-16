import {validateInventoryView} from './inventory-abi.mjs';
const id=s=>typeof s==='string'&&/^[0-9a-f]{32}$/.test(s);
const position=p=>Array.isArray(p)&&p.length===3&&p.every(n=>Number.isFinite(n)&&Number.isFinite(Math.fround(n)));
function validateCorpses(corpses){
 if(!Array.isArray(corpses)||corpses.length>4096)throw Error('Invalid corpse discovery view');
 let after='';
 for(const corpse of corpses){
  if(!id(corpse?.id)||corpse.id<=after||!position(corpse.position))throw Error('Invalid corpse location or order');
  after=corpse.id;
 }
}

function validateDetector(detector){
 if(detector==null)return;
 const {tier,working,period,pitch,bearing,points,labels}=detector;
 const cue=period!==undefined||pitch!==undefined||bearing!==undefined;
 if(![1,2,3,4].includes(tier)||typeof working!=='boolean'||
    Object.keys(detector).some(key=>!['tier','working','period','pitch','bearing','points','labels'].includes(key))||
    (!working&&(cue||points!==undefined))||
    (cue&&(tier>2||!Number.isFinite(period)||period<=0||period>10||!Number.isFinite(pitch)||pitch<0.89||pitch>1.41||
      (tier===1?bearing!==undefined:!Number.isFinite(bearing)||Math.abs(bearing)>Math.PI)))||
    (working&&tier>=3&&(!Array.isArray(points)||points.length>32||!points.every(position)))||
    (working&&tier===4?(!Array.isArray(labels)||labels.length!==points.length||
      !labels.every(label=>typeof label==='string'&&/^[a-z0-9_-]{1,64}$/.test(label))):labels!==undefined)||
    (tier<3&&points!==undefined))throw Error('Invalid private detector cue');
}

export function validateWorldItems(view){
 if(!view||!Array.isArray(view.items)||view.items.length>4096||!Number.isSafeInteger(view.generation)||view.generation<0)throw Error('Invalid world item view');
 validateInventoryView({life:view.life,alive:true,generation:view.generation,corpse:null,items:view.items.map(item=>({...item,place:'rucksack'}))});
 for(const item of view.items)if(!id(item.source)||!position(item.position))throw Error('Invalid world item location');
 validateCorpses(view.corpses??[]);
 const storage=view.storage;
 if(storage!=null&&(!id(storage.id)||!position(storage.position)||!position(storage.rotation)))throw Error('Invalid private storage location');
 validateDetector(view.detector);
 return view;
}
// Public discovery is a repeated scan, not a durable ownership snapshot. Publish
// only complete traversals; server pickup always checks the current item/range.
export class WorldItemsClient {
 constructor(client,{onChange=()=>{},onError=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancel=timer=>clearTimeout(timer)}={}){
  this.client=client;this.onChange=onChange;this.onError=onError;this.schedule=schedule;this.cancel=cancel;
  this.closed=false;this.timer=null;this.pending=null;this.generation=0;this.view=null;
 }
 start(){if(!this.closed&&this.timer===null&&!this.pending)void this.refresh().catch(this.onError);}
 async refresh(){
  if(this.closed)return null;if(this.pending)return this.pending;
  if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
  this.pending=this.scan().finally(()=>{
   this.pending=null;
   if(!this.closed)this.timer=this.schedule(()=>{this.timer=null;void this.refresh().catch(this.onError);},this.view?.detector?350:2000);
  });return this.pending;
 }
 async scan(){
  const inventory=this.client.inventory;
  if(!inventory?.view?.alive){this.clear();return null;}
  if(inventory.inFlight||inventory.refreshing||this.client.selectingDetector)return this.view;
  const life=inventory.view.life,items=[];let after='',storage=null,detector=null;
  for(let pageCount=0;pageCount<4096;pageCount++){
   if(this.closed)return null;
   if(inventory.view?.life!==life||!inventory.view?.alive){this.clear();return null;}
   // Give durable inventory mutations priority over discovery work.
   if(inventory.inFlight||inventory.refreshing||this.client.selectingDetector)return this.view;
   const page=await this.client.worldItems(after);
   if(this.closed)return null;
   if(inventory.view?.life!==life||!inventory.view?.alive){this.clear();return null;}
   if(page?.error)throw Error(page.error);
   if(page?.life!==life||!Array.isArray(page.items)||page.items.length>32)throw Error('Invalid world item page');
   if(pageCount===0){storage=page.storage??null;detector=page.detector??null;}
   else if(page.storage!=null||page.detector!=null)throw Error('Unexpected private discovery data');
   validateWorldItems({generation:0,life,items:page.items,storage,detector});
   for(const item of page.items){if(item.id<=after)throw Error('Invalid world item order');after=item.id;items.push(item);}
   if(items.length>4096)throw Error('World item scan limit exceeded');
   if(page.nextCursor===null){
    const corpses=this.client.corpses?await this.scanCorpses(life):[];
    if(this.closed)return null;
    if(inventory.view?.life!==life||!inventory.view?.alive){this.clear();return null;}
    if(corpses===null)return this.view;
    const view=validateWorldItems({generation:++this.generation,life,items,corpses,storage,...(detector&&{detector})});
    this.view=view;this.onChange(view);return view;
   }
   if(!page.items.length||!id(page.nextCursor)||page.nextCursor!==after)throw Error('Invalid world item cursor');
  }
  throw Error('World item page limit exceeded');
 }
 async scanCorpses(life){
  const inventory=this.client.inventory,corpses=[];
  let after='';
  for(let count=0;count<128;count++){
   if(this.closed||inventory.view?.life!==life||!inventory.view?.alive||inventory.inFlight||inventory.refreshing||this.client.selectingDetector)return null;
   const page=await this.client.corpses(after);
   if(page?.error)throw Error(page.error);
   if(page?.life!==life||!Array.isArray(page.containers)||page.containers.length>32)throw Error('Invalid corpse discovery page');
   validateCorpses(page.containers);
   for(const corpse of page.containers){
    if(corpse.id<=after)throw Error('Invalid corpse discovery order');
    after=corpse.id;corpses.push(corpse);
   }
   if(page.nextCursor===null)return corpses;
   if(!page.containers.length||page.nextCursor!==after)throw Error('Invalid corpse discovery cursor');
  }
  throw Error('Corpse discovery page limit exceeded');
 }
 clear(){
  if(this.closed)return;
  if(this.view?.items.length||this.view?.corpses?.length||this.view?.storage||this.view?.detector){this.view={generation:++this.generation,life:this.client.inventory?.view?.life??this.view.life,items:[]};this.onChange(this.view);}
 }
 close(){this.closed=true;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.view=null;}
}
