import {validateWorldItems} from './world-items.mjs';
import {writeInventory,MAX_INVENTORY_BYTES} from './inventory-abi.mjs';
export const MAX_WORLD_ITEMS_BYTES=MAX_INVENTORY_BYTES+12+40+8192*28;
export function writeWorldItems(view,heap,pointer,capacity){
 validateWorldItems(view);
 const corpses=view.corpses??[],locations=(view.items.length+corpses.length)*28;
 const storageSize=view.storage?40:0;
 const available=Math.min(capacity,heap.length-pointer)-12-locations-storageSize;
 if(!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(capacity)||available<48)throw Error('World item buffer too small');
 const size=writeInventory({...view,alive:true,corpse:null,items:view.items.map(item=>({...item,place:'rucksack'}))},heap,pointer+12,available);
 const total=12+size+locations+storageSize;
 const bytes=heap.subarray(pointer,pointer+total),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
 v.setUint32(0,0x444c575a,true);v.setUint32(4,size,true);v.setUint32(8,storageSize,true);
 let at=12+size;
 const writeLocation=(id,position)=>{
  for(let i=0;i<16;i++)bytes[at++]=parseInt(id.slice(2*i,2*i+2),16);
  for(const n of position){v.setFloat32(at,n,true);at+=4;}
 };
 if(view.storage){
  writeLocation(view.storage.id,view.storage.position);
  for(const angle of view.storage.rotation){v.setFloat32(at,angle,true);at+=4;}
 }
 for(const item of view.items)writeLocation(item.source,item.position);
 for(const corpse of corpses)writeLocation(corpse.id,corpse.position);
 return total;
}
export function createWorldItemsPoll(endpoint,getHeap){
 return (pointer,capacity)=>{
  if(endpoint.closed)return -1;if(!endpoint.session||!endpoint.worldItems)return 0;
  try{const size=writeWorldItems(endpoint.worldItems.view,getHeap(),Number(pointer),Number(capacity));endpoint.consumeWorldItems();return size;}
  catch(error){endpoint.close(error.message);return -1;}
 };
}
