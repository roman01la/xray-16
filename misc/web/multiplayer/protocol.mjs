// Protocol v3: little endian; keep in sync with server/src/protocol.rs.
export const newer = (a, b) => ((a - b) | 0) > 0;
export function encodeInput(sequence, {x = 0, z = 0, yaw = 0, pitch = 0, sprint = false, jump = false, crouch = false, walk = false, aiming = false} = {}, trigger = null) {
  const heading=trigger?trigger.yaw:yaw, elevation=trigger?trigger.pitch:pitch;
  if (![x,z,heading,elevation].every(Number.isFinite)) throw new TypeError('Non-finite input');
  if (Math.abs(elevation)>1.55) throw new RangeError('Invalid input pitch');
  const b = new ArrayBuffer(trigger ? 28 : 20), v = new DataView(b);
  v.setUint16(0, 0x5a58, true); v.setUint8(2,3); v.setUint8(3,1);
  v.setUint32(4,sequence,true);
  v.setInt16(8,Math.round(Math.max(-1,Math.min(1,x))*32767),true);
  v.setInt16(10,Math.round(Math.max(-1,Math.min(1,z))*32767),true);
  v.setFloat32(12,heading % (Math.PI*2),true); v.setUint16(16,(sprint?1:0)|(jump?2:0)|(crouch?4:0)|(walk?8:0)|(aiming?16:0),true);
  v.setInt16(18,Math.round(elevation*32767/1.55),true);
  if(trigger){
    if(![trigger.sequence,trigger.tick].every(n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff))throw Error('Invalid held trigger sample');
    v.setUint32(20,trigger.sequence,true);v.setUint32(24,trigger.tick,true);
  }
  return b;
}
export function decodeSnapshot(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > 1100) return null;
  const v = new DataView(buffer);
  if(v.getUint8(3)===3)return decodeDelta(buffer);
  if (v.getUint16(0,true)!==0x5a58 || v.getUint8(2)!==3 || v.getUint8(3)!==2 || v.getUint16(22,true)!==0) return null;
  const tick=v.getUint32(4,true), playerId=v.getUint32(8,true), ack=v.getUint32(12,true);
  const part=v.getUint16(16,true), parts=v.getUint16(18,true), count=v.getUint16(20,true);
  if (!parts || parts>256 || part>=parts || count>29 || buffer.byteLength!==24+count*36) return null;
  const entities=[];
  for(let i=0;i<count;i++) {
    const o=24+i*36, f=Array.from({length:7},(_,j)=>v.getFloat32(o+4+j*4,true));
    if(!f.every(Number.isFinite)) return null;
    entities.push({id:v.getUint32(o,true),x:f[0],y:f[1],z:f[2],vx:f[3],vy:f[4],vz:f[5],yaw:f[6],health:v.getUint16(o+32,true),kind:v.getUint8(o+34),flags:v.getUint8(o+35)});
  }
  return {tick,playerId,ack,part,parts,entities};
}
export function encodeSnapshotFeedback(tick,resync=false){const b=new ArrayBuffer(8),v=new DataView(b);v.setUint16(0,0x5a58,true);v.setUint8(2,3);v.setUint8(3,resync?5:4);v.setUint32(4,resync?0:tick,true);return b;}
function decodeDelta(buffer){
 if(buffer.byteLength<28)return null;const v=new DataView(buffer);
 if(v.getUint16(0,true)!==0x5a58||v.getUint8(2)!==3)return null;
 const tick=v.getUint32(4,true),playerId=v.getUint32(8,true),ack=v.getUint32(12,true),part=v.getUint16(16,true),parts=v.getUint16(18,true),count=v.getUint16(20,true),flags=v.getUint16(22,true),baseline=v.getUint32(24,true);
 if(!parts||parts>256||part>=parts||count>214||flags>1)return null;
 const entities=[];let at=28;
 const signed24=offset=>(v.getUint8(offset)|(v.getUint8(offset+1)<<8)|(v.getUint8(offset+2)<<16))<<8>>8;
 for(let i=0;i<count;i++){
  if(at+5>buffer.byteLength)return null;const type=v.getUint8(at++),id=v.getUint32(at,true);at+=4;if(!id)return null;
  if(type===0){entities.push({id,remove:true});continue;}
  if(type>4)return null;
  const compact=(type&1)!==0, hasMotion=type>2, size=(compact?21:32)+(hasMotion?6:0);
  if(at+size>buffer.byteLength)return null;
  let x,y,z,vx,vy,vz,yaw;
  if(compact){x=signed24(at)/100;y=signed24(at+3)/100;z=signed24(at+6)/100;vx=v.getInt16(at+9,true)/100;vy=v.getInt16(at+11,true)/100;vz=v.getInt16(at+13,true)/100;yaw=v.getInt16(at+15,true)/32767*Math.PI;at+=17;}
  else{x=v.getFloat32(at,true);y=v.getFloat32(at+4,true);z=v.getFloat32(at+8,true);vx=v.getFloat32(at+12,true);vy=v.getFloat32(at+16,true);vz=v.getFloat32(at+20,true);yaw=v.getFloat32(at+24,true);at+=28;
   if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)||!Number.isFinite(vx)||!Number.isFinite(vy)||!Number.isFinite(vz)||!Number.isFinite(yaw))return null;
  }
  const health=v.getUint16(at,true),kind=v.getUint8(at+2),state=v.getUint8(at+3);at+=4;
  if((kind!==1&&kind!==2)||state>31)return null;
  const entity={id,x,y,z,vx,vy,vz,yaw,health,kind,flags:state};
  if(hasMotion){
   const id=v.getUint32(at,true),timeMs=v.getUint16(at+4,true);at+=6;
   if(kind!==2||id===0xffffffff)return null;
   entity.motion={id,timeMs};
  }
  entities.push(entity);
 }
 if(at!==buffer.byteLength)return null;
 return {tick,playerId,ack,part,parts,entities,delta:true,keyframe:!!flags,baseline};
}
// Only complete snapshots replace membership: loss cannot despawn random actors.
// At most four ticks / 256 chunks per tick can be retained, for at most 1 second.
export class SnapshotAssembler {
  pending=new Map(); frames=new Map(); latest=null; needsResync=false;
  push(buffer, now=performance.now()) {
    // Discard superseded datagrams before allocating decoded entity records.
    if(buffer instanceof ArrayBuffer&&buffer.byteLength>=8&&this.latest!==null&&!newer(new DataView(buffer).getUint32(4,true),this.latest))return null;
    const p=decodeSnapshot(buffer);
    if(!p || (this.latest!==null && !newer(p.tick,this.latest))) return null;
    for(const [tick,f] of this.pending) if(now-f.time>1000) this.pending.delete(tick);
    let f=this.pending.get(p.tick);
    if(!f) {
      if(this.pending.size>=4) this.pending.delete(this.pending.keys().next().value);
      f={...p,chunks:new Map(),count:0,time:now}; this.pending.set(p.tick,f);
    }
    if(f.parts!==p.parts || f.playerId!==p.playerId || f.ack!==p.ack || f.delta!==p.delta || f.keyframe!==p.keyframe || f.baseline!==p.baseline) return null;
    const total=f.count-(f.chunks.get(p.part)?.length||0)+p.entities.length;
    if(total>7424){this.pending.delete(p.tick);return null;}
    f.count=total;f.chunks.set(p.part,p.entities);
    if(f.chunks.size!==f.parts) return null;
    let entities=[];
    for(let i=0;i<f.parts;i++) entities.push(...f.chunks.get(i));
    const ids=new Set();for(const e of entities){if(ids.has(e.id)){this.pending.delete(p.tick);return null;}ids.add(e.id);}
    let membership;
    if(f.delta){
      if(!f.keyframe&&!this.frames.has(f.baseline)){this.pending.delete(p.tick);this.needsResync=true;return null;}
      membership=new Map(f.keyframe?[]:this.frames.get(f.baseline));
      for(const e of entities){if(e.remove){if(f.keyframe||!membership.delete(e.id)){this.pending.delete(p.tick);return null;}}else membership.set(e.id,e);}
      entities=[...membership.values()].sort((a,b)=>a.id-b.id);
      if(entities.length>7424||!membership.has(p.playerId)){this.pending.delete(p.tick);return null;}
    }
    if(!membership){membership=new Map();for(const e of entities)membership.set(e.id,e);}
    this.frames.set(p.tick,membership);while(this.frames.size>32)this.frames.delete(this.frames.keys().next().value);
    this.needsResync=false;
    this.latest=p.tick;
    for(const tick of this.pending.keys()) if(!newer(tick,p.tick)) this.pending.delete(tick);
    return {tick:p.tick,playerId:p.playerId,ack:p.ack,entities,receivedAt:now};
  }
}
