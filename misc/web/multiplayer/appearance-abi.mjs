import {MAX_LIFECYCLE_ENTITIES,validateAppearance,validNpcModel} from './lifecycle.mjs';
const fields=['outfit','helmet','weapon','visual'];
export function validateAppearanceView(entries){
  if(!Array.isArray(entries)||entries.length>MAX_LIFECYCLE_ENTITIES)throw Error('Invalid appearance view');
  let previous=0;
  for(const entry of entries){
    if(!Array.isArray(entry)||entry.length!==2||!Number.isInteger(entry[0])||entry[0]<=previous||entry[0]>0xffffffff)throw Error('Invalid appearance entry');
    previous=entry[0];
    const look=entry[1];
    if(look?.visual!==undefined){if(Object.keys(look).length!==1||!validNpcModel(look.visual))throw Error('Invalid NPC appearance');}
    else validateAppearance(look);
  }
  return entries;
}
export function writeAppearances(entries,heap,pointer,capacity){
  validateAppearanceView(entries);
  let size=4;
  for(const [,appearance] of entries)size+=9+fields.reduce((n,key)=>n+(appearance[key]?.length??0),0);
  if(!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(capacity)||size>capacity||pointer+size>heap.byteLength)throw Error('Appearance buffer too small');
  const out=new DataView(heap.buffer,heap.byteOffset+pointer,size);
  out.setUint32(0,entries.length,true);let at=4;
  for(const [id,appearance] of entries){
    out.setUint32(at,id,true);at+=4;
    for(const key of fields){
      const value=appearance[key]??'';
      out.setUint8(at++,value.length);
      for(let i=0;i<value.length;i++)out.setUint8(at++,value.charCodeAt(i));
    }
    out.setUint8(at++,appearance.weaponAddons??0);
  }
  return size;
}
export function createAppearancePoll(endpoint,getHeap){
  return (pointer,capacity)=>{
    if(endpoint.closed)return -1;
    if(!endpoint.appearances)return 0;
    try{
      const size=writeAppearances(endpoint.appearances.entries,getHeap(),Number(pointer),Number(capacity));
      endpoint.consumeAppearances();return size;
    }catch(error){endpoint.close(error.message);return -1;}
  };
}
