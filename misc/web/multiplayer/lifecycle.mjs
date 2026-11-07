// Reliable metadata is a separate cache. It never creates/removes actors by
// itself: only complete transform membership can do that across channel skew.
export class LifecycleRegistry {
  revision=0; entries=new Map();
  apply(message){
    const uint=n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
    if(message?.type!=='lifecycle'||!uint(message.revision)||message.revision!==((this.revision+1)>>>0)||!uint(message.tick)||!Array.isArray(message.upsert)||!Array.isArray(message.remove)||message.upsert.length+message.remove.length>16)throw Error('Invalid lifecycle batch');
    const next=new Map(this.entries),seen=new Set();
    for(const id of message.remove){if(!uint(id)||!id||seen.has(id)||!next.delete(id))throw Error('Invalid lifecycle removal');seen.add(id);}
    for(const e of message.upsert){if(!uint(e?.id)||!e.id||seen.has(e.id)||![1,2].includes(e.kind)||e.model!=='stalker'||(e.persistentId!==undefined&&!/^[a-f0-9]{32}$/.test(e.persistentId)))throw Error('Invalid lifecycle descriptor');seen.add(e.id);next.set(e.id,Object.freeze({id:e.id,kind:e.kind,model:e.model,...(e.persistentId?{persistentId:e.persistentId}:{})}));}
    const persistent=new Set();for(const e of next.values()){if(e.persistentId){if(persistent.has(e.persistentId))throw Error('Duplicate persistent mapping');persistent.add(e.persistentId);}}
    if(next.size>512)throw Error('Lifecycle capacity exceeded');
    this.entries=next;this.revision=message.revision;
  }
  clear(){this.entries.clear();this.revision=0;}
}
