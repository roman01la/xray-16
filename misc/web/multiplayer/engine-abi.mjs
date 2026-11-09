// Complete snapshots cross the WASM boundary in one bounded copy. No C++ heap
// views are retained across frames: memory growth can replace the backing buffer.
export const HEADER_BYTES=24, ENTITY_BYTES=44, MAX_ENTITIES=7424;
export const MAX_SNAPSHOT_BYTES=HEADER_BYTES+ENTITY_BYTES*MAX_ENTITIES;
const u32=n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
export function writeSnapshot(snapshot,heap,pointer,capacity) {
  const {tick,playerId,ack,entities}=snapshot;
  if(!u32(tick)||!u32(playerId)||!playerId||!u32(ack)||!Array.isArray(entities)||entities.length>MAX_ENTITIES)throw new Error('Invalid engine frame');
  const size=HEADER_BYTES+entities.length*ENTITY_BYTES;
  if(!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(capacity)||capacity<size||pointer+size>heap.byteLength)throw new Error('Engine snapshot buffer too small');
  const ids=new Set();let self=false;
  for(const e of entities){
    if(!u32(e.id)||!e.id||ids.has(e.id)||!['x','y','z','vx','vy','vz','yaw'].every(k=>Number.isFinite(e[k])&&Number.isFinite(Math.fround(e[k])))||!Number.isInteger(e.health)||e.health<0||e.health>65535||![1,2].includes(e.kind)||(!Number.isInteger(e.flags)||e.flags<0||e.flags>31))throw new Error('Invalid engine entity');
    if(e.motion!==undefined&&(e.kind!==2||!u32(e.motion?.id)||e.motion.id===0xffffffff||!Number.isInteger(e.motion.timeMs)||e.motion.timeMs<0||e.motion.timeMs>65535))throw Error('Invalid NPC motion');
    ids.add(e.id);if(e.id===playerId){if(e.kind!==1)throw new Error('Local entity is not a player');self=true;}
  }
  if(!self)throw new Error('Missing local player');
  const v=new DataView(heap.buffer,heap.byteOffset+pointer,size);
  [0x474e455a,2,tick,playerId,ack,entities.length].forEach((n,i)=>v.setUint32(i*4,n,true));
  // The shared predictor consumes the climb bit. The native renderer ABI
  // retains its four flags and uses the same authoritative position.
  entities.forEach((e,i)=>{const o=HEADER_BYTES+i*ENTITY_BYTES;v.setUint32(o,e.id,true);['x','y','z','vx','vy','vz','yaw'].forEach((k,j)=>v.setFloat32(o+4+j*4,e[k],true));v.setUint16(o+32,e.health,true);v.setUint8(o+34,e.kind);v.setUint8(o+35,e.flags&15);v.setUint32(o+36,e.motion?.id??0xffffffff,true);v.setUint16(o+40,e.motion?.timeMs??0,true);v.setUint16(o+42,0,true);});
  return size;
}
// Install only in the application pthread. Endpoint ownership remains explicit;
// loader workers must never claim the network session or consume its snapshots.
export function createEnginePoll(endpoint,getHeap) {
  return (pointer,capacity)=>{
    if(endpoint.closed)return -1;
    if(!endpoint.session||!endpoint.snapshot)return 0;
    try {
      // Validate/copy before returning credit to the browser producer.
      const size=writeSnapshot(endpoint.snapshot.snapshot,getHeap(),Number(pointer),Number(capacity));
      endpoint.consumeSnapshot();return size;
    }catch(error){endpoint.close(error.message);return -1;}
  };
}
