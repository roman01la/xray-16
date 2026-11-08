// Application-pthread -> native inventory ABI. This is not the WebRTC protocol.
// A whole coherent view replaces the previous view only at an engine frame boundary.
export const MAX_INVENTORY_BYTES=16*1024*1024,MAX_INVENTORY_ITEMS=100000;
const id=s=>typeof s==='string'&&/^[0-9a-f]{32}$/.test(s);
const uint=n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
const section=s=>typeof s==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(s);
const stringList=v=>Array.isArray(v)&&v.length<=1024&&v.every(section);
export function validateInventoryView(view){
 if(!view||!uint(view.life)||typeof view.alive!=='boolean'||!Number.isSafeInteger(view.generation)||view.generation<0||!(view.corpse===null||id(view.corpse))||!Array.isArray(view.items)||view.items.length>MAX_INVENTORY_ITEMS)throw Error('Invalid engine inventory');
 const ids=new Set(),places=new Set();
 for(const item of view.items){
  const s=item?.state,p=s?.payload;
  if(!id(item?.id)||ids.has(item.id)||!uint(item.revision)||!section(item.section)||!s||!Number.isFinite(s.condition)||s.condition<0||s.condition>1||!stringList(s.upgrades)||!p)throw Error('Invalid engine inventory item');
  ids.add(item.id);
  if(item.place!=='rucksack'){
   if(!/^(slot:([1-9]|1[0-3])|belt:[0-4])$/.test(item.place)||places.has(item.place))throw Error('Invalid engine inventory placement');
   places.add(item.place);
  }
  if(p.kind==='weapon'){
   if(!stringList(p.cartridges)||!stringList(p.launcher_cartridges)||!stringList(p.attachments)||!section(p.selected_ammunition)||!uint(p.fire_mode)||p.fire_mode>255||typeof p.launcher_mode!=='boolean'||(p.jammed!==undefined&&typeof p.jammed!=='boolean'))throw Error('Invalid engine weapon state');
  }else if(p.kind==='ammunition'||p.kind==='consumable'){
   const n=p.kind==='ammunition'?p.rounds:p.uses;if(!uint(n)||!n)throw Error('Invalid engine item quantity');
  }else if(p.kind!=='equipment')throw Error('Invalid engine item kind');
 }
 if(!view.alive&&view.items.length)throw Error('Dead inventory contains carried items');
 return view;
}
export function writeInventory(view,heap,pointer,capacity){
 validateInventoryView(view);
 // Compute the exact size before touching WASM memory. Strings are ASCII sections.
 const stringSize=s=>2+s.length,listSize=v=>2+v.reduce((n,s)=>n+stringSize(s),0);
 let size=48;
 for(const i of view.items){
  const p=i.state.payload;size+=28+stringSize(i.section)+listSize(i.state.upgrades);
  if(p.kind==='weapon')size+=2+stringSize(p.selected_ammunition)+listSize(p.attachments)+listSize(p.cartridges)+listSize(p.launcher_cartridges);
  else if(p.kind!=='equipment')size+=4;
 }
 if(size>MAX_INVENTORY_BYTES||!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(capacity)||capacity<size||pointer+size>heap.byteLength)throw Error('Engine inventory buffer too small');
 const bytes=heap.subarray(pointer,pointer+size),v=new DataView(bytes.buffer,bytes.byteOffset,size);let at=0;
 const u8=n=>v.setUint8(at++,n),u16=n=>{v.setUint16(at,n,true);at+=2;},u32=n=>{v.setUint32(at,n,true);at+=4;};
 const identifier=s=>{for(let n=0;n<16;n++)u8(s?parseInt(s.slice(n*2,n*2+2),16):0);};
 const str=s=>{u16(s.length);for(let n=0;n<s.length;n++)u8(s.charCodeAt(n));};
 const list=values=>{u16(values.length);for(const s of values)str(s);};
 u32(0x564e495a);u32(1);v.setBigUint64(at,BigInt(view.generation),true);at+=8;
 u32(view.life);u32(Number(view.alive));u32(view.items.length);u32(0);identifier(view.corpse);
 for(const i of view.items){
  const p=i.state.payload,[place,index]=i.place.split(':');identifier(i.id);u32(i.revision);
  u8(place==='rucksack'?0:place==='slot'?1:2);u8(index===undefined?0:Number(index));
  u8({equipment:0,ammunition:1,consumable:2,weapon:3}[p.kind]);u8(0);
  v.setFloat32(at,i.state.condition,true);at+=4;str(i.section);list(i.state.upgrades);
  if(p.kind==='weapon'){u8(p.fire_mode);u8(Number(p.launcher_mode)|(p.jammed?2:0));str(p.selected_ammunition);list(p.attachments);list(p.cartridges);list(p.launcher_cartridges);}
  else if(p.kind!=='equipment')u32(p.kind==='ammunition'?p.rounds:p.uses);
 }
 return size;
}
export function createInventoryPoll(endpoint,getHeap){
 return (pointer,capacity)=>{
  if(endpoint.closed)return -1;if(!endpoint.session||!endpoint.inventory)return 0;
  try{const size=writeInventory(endpoint.inventory.view,getHeap(),Number(pointer),Number(capacity));endpoint.consumeInventory();return size;}
  catch(error){endpoint.close(error.message);return -1;}
 };
}
