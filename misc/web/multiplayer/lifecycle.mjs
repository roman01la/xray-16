// Reliable metadata is a separate cache. It never creates/removes actors by
// itself: only complete transform membership can do that across channel skew.
export const MAX_LIFECYCLE_ENTITIES=512;
export function validNpcModel(path){
  return typeof path==='string'&&path.length<=127&&path.split('\\').every(part=>/^[a-zA-Z0-9_.-]+$/.test(part)&&part!=='.'&&part!=='..');
}
export function validateAppearance(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid equipment appearance');
  const keys=Object.keys(value);
  if(!keys.length||keys.some(key=>key==='weaponAddons'
    ? !Object.hasOwn(value,'weapon')||!Number.isInteger(value[key])||value[key]<1||value[key]>7
    : !['outfit','helmet','weapon'].includes(key)||typeof value[key]!=='string'
      ||!(/^[a-zA-Z0-9_.-]{1,128}$/.test(value[key]))))throw Error('Invalid equipment appearance');
  return value;
}
export class LifecycleRegistry {
  revision=0; entries=new Map();
  apply(message){
    const uint=n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
    if(message?.type!=='lifecycle'||!uint(message.revision)||message.revision!==((this.revision+1)>>>0)||!uint(message.tick)||!Array.isArray(message.upsert)||!Array.isArray(message.remove)||message.upsert.length+message.remove.length>16)throw Error('Invalid lifecycle batch');
    const next=new Map(this.entries),seen=new Set();
    for(const id of message.remove){if(!uint(id)||!id||seen.has(id)||!next.delete(id))throw Error('Invalid lifecycle removal');seen.add(id);}
    for(const e of message.upsert){
      if(!uint(e?.id)||!e.id||seen.has(e.id)||![1,2].includes(e.kind)||(e.kind===1?e.model!=='stalker':!validNpcModel(e.model))||(e.persistentId!==undefined&&!/^[a-f0-9]{32}$/.test(e.persistentId)))throw Error('Invalid lifecycle descriptor');
      const appearance=e.appearance===undefined?undefined:Object.freeze({...validateAppearance(e.appearance)});
      if(appearance&&e.kind!==1)throw Error('Invalid equipment entity');
      seen.add(e.id);next.set(e.id,Object.freeze({id:e.id,kind:e.kind,model:e.model,...(e.persistentId?{persistentId:e.persistentId}:{}),...(appearance?{appearance}:{})}));
    }
    const persistent=new Set();for(const e of next.values()){if(e.persistentId){if(persistent.has(e.persistentId))throw Error('Duplicate persistent mapping');persistent.add(e.persistentId);}}
    if(next.size>MAX_LIFECYCLE_ENTITIES)throw Error('Lifecycle capacity exceeded');
    this.entries=next;this.revision=message.revision;
  }
  clear(){this.entries.clear();this.revision=0;}
}
