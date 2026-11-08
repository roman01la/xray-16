import {validateCorpseView} from './corpse-search.mjs';
import {writeInventory,MAX_INVENTORY_BYTES} from './inventory-abi.mjs';
export const MAX_CORPSE_SEARCH_BYTES=24+MAX_INVENTORY_BYTES;
export function writeCorpseSearch(message,heap,pointer,capacity){
 const {view,sequence}=message;validateCorpseView(view);
 if(!Number.isSafeInteger(sequence)||sequence<1||!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(capacity)||capacity<24||pointer+24>heap.byteLength)throw Error('Invalid corpse search buffer');
 // Inventory writer validates the complete payload before touching the heap.
 const payload=view?writeInventory({...view,alive:true,corpse:view.source},heap,pointer+24,capacity-24):0;
 const header=new DataView(heap.buffer,heap.byteOffset+pointer,24);
 header.setUint32(0,0x5052435a,true);header.setUint32(4,1,true);
 header.setBigUint64(8,BigInt(sequence),true);header.setUint32(16,Number(view!==null),true);header.setUint32(20,payload,true);
 return 24+payload;
}
export function createCorpseSearchPoll(endpoint,getHeap){
 return (pointer,capacity)=>{
  if(endpoint.closed)return -1;if(!endpoint.session||!endpoint.corpseSearch)return 0;
  try{const size=writeCorpseSearch(endpoint.corpseSearch,getHeap(),Number(pointer),Number(capacity));endpoint.consumeCorpseSearch();return size;}
  catch(error){endpoint.close(error.message);return -1;}
 };
}
