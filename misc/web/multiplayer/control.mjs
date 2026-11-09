// WebRTC v3. Commands have fixed layouts; events have positional fields.
import {levelForWorld} from './content.mjs';
const VERSION=3,MAX=16384;
export const GUNSHOTS_OPCODE=31;
const schemas=new Map([[16,['welcome','version','contract','playerId','principalId','tickHz','safeZones']],[17,['ownership_dirty']],[18,['weapon','state']],[19,['lifecycle','revision','tick','upsert','remove']],[20,['action_result','sequence','result']],[21,['inventory_dirty']],[22,['vitals','state']],[23,['weapon_shot','sequence','tick','result']],[24,['detonations','effects']],[25,['travel','world']],[26,['grenades','tick','entries']],[29,['weapon_fired','life','item','ammo','launcher']],[30,['weapon_reload','life','item','alias','milliseconds','sound','cancelled']],[GUNSHOTS_OPCODE,['gunshots','effects']],[32,['knife_swing','life','item','stab']]]);
export const MAX_DETONATIONS=8;
export const MAX_GRENADES=8;
export const MAX_GUNSHOTS=8;
export function validateGunshots(effects){
 if(!Array.isArray(effects)||effects.length<1||effects.length>MAX_GUNSHOTS)throw Error('Invalid gunshot batch');
 for(const entry of effects){
  if(!Array.isArray(entry)||entry.length!==6)throw Error('Invalid gunshot');
  const [shooter,section,sound,x,y,z]=entry;
  if(!Number.isInteger(shooter)||shooter<1||shooter>0xffffffff||typeof section!=='string'
     ||!/^[a-zA-Z0-9_.-]{1,128}$/.test(section)||!(section==='wpn_knife'?[3,4]:[0,1,2]).includes(sound)
     ||![x,y,z].every(n=>Number.isFinite(n)&&Math.abs(n)<=32768))throw Error('Invalid gunshot');
 }
 return effects;
}
export function validateGrenades(frame){
 const ids=new Set();
 if(!Number.isInteger(frame?.tick)||frame.tick<0||frame.tick>0xffffffff||!Array.isArray(frame.entries)||frame.entries.length>MAX_GRENADES)throw Error('Invalid grenade frame');
 for(const entry of frame.entries){
  if(!Array.isArray(entry)||entry.length!==5)throw Error('Invalid grenade entry');
  const [id,section,x,y,z]=entry;
  if(!Number.isInteger(id)||id<1||id>0xffffffff||ids.has(id)||typeof section!=='string'||!(/^[a-zA-Z0-9_.-]{1,32}$/.test(section))
    ||![x,y,z].every(n=>Number.isFinite(n)&&Math.abs(n)<=32768))throw Error('Invalid grenade entry');
  ids.add(id);
 }
 return frame;
}
export function validateDetonations(effects){
 if(!Array.isArray(effects)||effects.length<1||effects.length>MAX_DETONATIONS)throw Error('Invalid detonation batch');
 for(const entry of effects){
  if(!Array.isArray(entry)||entry.length!==4)throw Error('Invalid detonation');
  const [section,x,y,z]=entry;
  if(typeof section!=='string'||section.length<1||section.length>128||/[^a-zA-Z0-9_.-]/.test(section)
     ||![x,y,z].every(n=>Number.isFinite(n)&&Math.abs(n)<=32768))throw Error('Invalid detonation');
 }
 return effects;
}
const uint=n=>{if(!Number.isInteger(n)||n<0||n>0xffffffff)throw Error('Invalid control integer');return n;};
schemas.set(33,['grenade_hud','life','item','phase']);
function validateWeaponCue(cue){
 uint(cue?.life);
 if(typeof cue.item!=='string'||!/^[0-9a-f]{32}$/.test(cue.item)||cue.item==='0'.repeat(32))throw Error('Invalid weapon cue item');
}
export function validateWeaponFire(cue){
 validateWeaponCue(cue);
 if(cue.type==='knife_swing'){
  if(typeof cue.stab!=='boolean')throw Error('Invalid knife swing cue');
  return cue;
 }
 if(cue.type==='grenade_hud'){
  if(!['prime','quick','release','cancel'].includes(cue.phase))throw Error('Invalid grenade HUD cue');
  return cue;
 }
 if(!Number.isInteger(cue.ammo)||cue.ammo<0||cue.ammo>0xffff||typeof cue.launcher!=='boolean')throw Error('Invalid weapon fire cue');
 return cue;
}
export function validateWeaponReload(cue){
 validateWeaponCue(cue);
 if(typeof cue.alias!=='string'||!Number.isInteger(cue.milliseconds)||cue.milliseconds<0||cue.milliseconds>30000||
    typeof cue.cancelled!=='boolean'||!Number.isInteger(cue.sound))throw Error('Invalid weapon reload cue');
 if(cue.milliseconds===0 ? cue.alias!==''||cue.sound!==0 :
    cue.cancelled||cue.sound<1||cue.sound>8||!/^(?:anm|anim)_[a-z0-9_]{1,40}$/.test(cue.alias))throw Error('Invalid weapon reload cue');
 return cue;
}
export function encodeControl(message){
 if(message?.type==='world_items'||message?.type==='corpses'){
  keys(message,['type','sequence','after']);
  if(typeof message.after!=='string'||(message.after!==''&&!/^[0-9a-f]{32}$/.test(message.after)))throw Error('Invalid world item cursor');
  const buffer=new ArrayBuffer(24),v=new DataView(buffer),b=new Uint8Array(buffer);
  v.setUint16(0,0x5a58,true);v.setUint8(2,VERSION);v.setUint8(3,message.type==='world_items'?8:9);v.setUint32(4,uint(message.sequence),true);
  if(message.after!=='')for(let i=0;i<16;i++)b[8+i]=parseInt(message.after.slice(i*2,i*2+2),16);
  return buffer;
 }
 if(message?.type==='corpse_items'){
  keys(message,['type','sequence','source','after','generation']);
  const validId=s=>typeof s==='string'&&/^[0-9a-f]{32}$/.test(s);
  if(!validId(message.source)||(message.after!==''&&!validId(message.after)))throw Error('Invalid corpse identifier');
  const generation=message.generation;
  if(generation!==null&&(!Number.isSafeInteger(generation)||generation<0))throw Error('Invalid corpse generation');
  if(message.after!==''&&generation===null)throw Error('Cursor requires generation');
  const buffer=new ArrayBuffer(48),v=new DataView(buffer),b=new Uint8Array(buffer);
  v.setUint16(0,0x5a58,true);v.setUint8(2,VERSION);v.setUint8(3,10);v.setUint32(4,uint(message.sequence),true);
  for(const [offset,id] of [[8,message.source],[24,message.after]])if(id)for(let i=0;i<16;i++)b[offset+i]=parseInt(id.slice(i*2,i*2+2),16);
  v.setBigUint64(40,generation===null?0xffffffffffffffffn:BigInt(generation),true);return buffer;
 }
 if(message?.type==='inventory_list'||message?.type==='inventory_move')return encodeInventory(message);
 if(message?.type==='select_detector'){
  if(Object.keys(message).length!==4||typeof message.active!=='boolean')throw Error('Invalid detector selection');
  const buffer=new ArrayBuffer(13),v=new DataView(buffer);
  v.setUint16(0,0x5a58,true);v.setUint8(2,VERSION);v.setUint8(3,28);
  v.setUint32(4,uint(message.sequence),true);v.setUint8(8,Number(message.active));v.setUint32(9,uint(message.life),true);
  return buffer;
 }
 const specs={attack:[1,12,['type','sequence','target']],reload:[2,8,['type','sequence']],respawn:[3,28,['type','sequence','request_id','life']],fire:[4,36,['type','sequence','aim','item']],leave:[5,8,['type','sequence']],trigger_start:[11,36,['type','sequence','aim','item']],trigger_stop:[12,8,['type','sequence']],use_travel:[13,8,['type','sequence']],select_weapon:[14,13,['type','sequence','slot','life']],grenade:[15,37,['type','sequence','aim','item','phase']],knife:[27,37,['type','sequence','aim','item','mode']]};
 const spec=specs[message?.type];if(!spec||Object.keys(message).length!==spec[2].length||spec[2].some(k=>!Object.hasOwn(message,k)))throw Error('Invalid control fields');
 const buffer=new ArrayBuffer(spec[1]),v=new DataView(buffer);v.setUint16(0,0x5a58,true);v.setUint8(2,VERSION);v.setUint8(3,spec[0]);v.setUint32(4,uint(message.sequence),true);
 if(message.type==='attack')v.setUint32(8,uint(message.target),true);
 if(message.type==='select_weapon'){
  if(![0,1,2,3,4,6].includes(message.slot))throw Error('Invalid active weapon slot');
  v.setUint8(8,message.slot);v.setUint32(9,uint(message.life),true);
 }
 if(message.type==='respawn'){if(!/^[0-9a-f]{32}$/.test(message.request_id))throw Error('Invalid respawn request ID');const b=new Uint8Array(buffer);for(let i=0;i<16;i++)b[8+i]=parseInt(message.request_id.slice(2*i,2*i+2),16);v.setUint32(24,uint(message.life),true);}
 if(['fire','trigger_start','grenade','knife'].includes(message.type)){
  const aim=message.aim;if(!aim||Object.keys(aim).length!==3||!['tick','yaw','pitch'].every(k=>Object.hasOwn(aim,k))||![aim.yaw,aim.pitch].every(n=>Number.isFinite(n)&&Number.isFinite(Math.fround(n))))throw Error('Invalid aim');
  v.setUint32(8,uint(aim.tick),true);v.setFloat32(12,aim.yaw,true);v.setFloat32(16,aim.pitch,true);
  const item=message.item;
  if(item===null&&message.type!=='fire')throw Error(message.type==='grenade'?'Missing grenade ID':message.type==='knife'?'Missing knife ID':'Missing trigger weapon ID');
  if(item!==null){
   if(typeof item!=='string'||!(/^[0-9a-f]{32}$/).test(item)||item==='0'.repeat(32))throw Error('Invalid weapon ID');
   const bytes=new Uint8Array(buffer);
   for(let i=0;i<16;i++)bytes[20+i]=parseInt(item.slice(i*2,i*2+2),16);
  }
  if(message.type==='grenade'){
    const phase=['prime','release','cancel'].indexOf(message.phase);
    if(phase<0)throw Error('Invalid grenade phase');
    v.setUint8(36,phase);
  }
  if(message.type==='knife'){
    const mode=['slash','stab'].indexOf(message.mode);
    if(mode<0)throw Error('Invalid knife mode');
    v.setUint8(36,mode);
  }
 }return buffer;
}
function keys(value,expected){if(!value||Object.keys(value).length!==expected.length||expected.some(k=>!Object.hasOwn(value,k)))throw Error('Invalid inventory fields');}
function encodeInventory(message){
 const list=message.type==='inventory_list';keys(message,list?['type','sequence','after','generation']:['type','sequence','command']);
 const buffer=new ArrayBuffer(list?32:message.command?.action?.kind==='attach'?70:66),v=new DataView(buffer),bytes=new Uint8Array(buffer);
 v.setUint16(0,0x5a58,true);v.setUint8(2,VERSION);v.setUint8(3,list?6:7);v.setUint32(4,uint(message.sequence),true);
 const id=(offset,value)=>{if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))throw Error('Invalid inventory ID');for(let i=0;i<16;i++)bytes[offset+i]=parseInt(value.slice(i*2,i*2+2),16);};
 if(list){
  if(message.after!=='')id(8,message.after);
  const generation=message.generation;
  if(generation!==null&&(!Number.isSafeInteger(generation)||generation<0))throw Error('Invalid inventory generation');
  if(message.after!==''&&generation===null)throw Error('Cursor requires generation');
  v.setBigUint64(24,generation===null?0xffffffffffffffffn:BigInt(generation),true);
 }else{
  const c=message.command;keys(c,['requestId','life','item','revision','action']);
  id(8,c.requestId);v.setUint32(24,uint(c.life),true);id(28,c.item);v.setUint32(44,uint(c.revision),true);
  const a=c.action;
  if(a?.kind==='pickup'){keys(a,['kind','source']);id(50,a.source);}
  else if(a?.kind==='store'){keys(a,['kind','destination']);bytes[48]=8;id(50,a.destination);}
  else if(['drop','reload','unload','nextAmmo','consume'].includes(a?.kind)){keys(a,['kind']);bytes[48]={drop:1,reload:5,unload:6,nextAmmo:7,consume:9}[a.kind];}
  else if(a?.kind==='fireMode'){keys(a,['kind','next']);if(typeof a.next!=='boolean')throw Error('Invalid fire mode direction');bytes[48]=10;bytes[49]=Number(a.next);}
  else if(a?.kind==='attach'){
   keys(a,['kind','addon','addonRevision']);if(a.addon===c.item)throw Error('Cannot attach an item to itself');
   bytes[48]=11;id(50,a.addon);v.setUint32(66,uint(a.addonRevision),true);
  }
  else if(a?.kind==='detach'){
   keys(a,['kind','slot']);const slot=['scope','silencer','launcher'].indexOf(a.slot);
   if(slot<0)throw Error('Invalid attachment slot');
   bytes[48]=12;bytes[49]=slot;
  }
  else if(a?.kind==='launcherMode'){
   keys(a,['kind','active']);if(typeof a.active!=='boolean')throw Error('Invalid launcher mode');
   bytes[48]=13;bytes[49]=Number(a.active);
  }
  else if(a?.kind==='place'){
   keys(a,['kind','placement']);const p=a.placement;
   if(p?.kind==='rucksack'){keys(p,['kind']);bytes[48]=2;}
   else if(p?.kind==='slot'){keys(p,['kind','slot']);const slot=uint(p.slot);if(slot<1||slot>13)throw Error('Invalid slot');bytes[48]=3;bytes[49]=slot;}
   else if(p?.kind==='belt'){keys(p,['kind','cell']);const cell=uint(p.cell);if(cell>=5)throw Error('Invalid belt cell');bytes[48]=4;bytes[49]=cell;}
   else throw Error('Invalid placement');
  }else throw Error('Invalid inventory action');
 }return buffer;
}
export function decodeControl(buffer){
 if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<4||buffer.byteLength>MAX)throw Error('Invalid control size');
 const v=new DataView(buffer);if(v.getUint16(0,true)!==0x5a58||v.getUint8(2)!==VERSION)throw Error('Invalid control version');
 const schema=schemas.get(v.getUint8(3));if(!schema)throw Error('Invalid event opcode');
 let at=4,nodes=0;const utf8=new TextDecoder('utf-8',{fatal:true});
 const take=n=>{const start=at;at+=n;if(at>buffer.byteLength)throw Error('Truncated control');return start;};
 const u16=()=>v.getUint16(take(2),true);
 const str=()=>{const size=u16();return utf8.decode(new Uint8Array(buffer,take(size),size));};
 function value(depth=0){
  if(depth>8||++nodes>4096)throw Error('Control bounds');
  switch(v.getUint8(take(1))){
   case 0:return null;case 1:return false;case 2:return true;
   case 3:return v.getUint32(take(4),true);
   case 4:{const n=v.getFloat64(take(8),true);if(!Number.isFinite(n))throw Error('Nonfinite control');return n;}
   case 5:return str();
   case 6:{const n=u16();if(n>1024)throw Error('Array bounds');return Array.from({length:n},()=>value(depth+1));}
   case 7:{const n=u16();if(n>1024)throw Error('Map bounds');const out={};for(let i=0;i<n;i++){const k=str();if(['__proto__','constructor','prototype'].includes(k)||Object.hasOwn(out,k))throw Error('Invalid control key');out[k]=value(depth+1);}return out;}
   default:throw Error('Unknown control tag');
  }
 }
 const message={type:schema[0]};for(const field of schema.slice(1))message[field]=value();
 if(at!==buffer.byteLength)throw Error('Trailing control data');
 if(message.type==='detonations')validateDetonations(message.effects);
 if(message.type==='grenades')validateGrenades(message);
 if(message.type==='gunshots')validateGunshots(message.effects);
 if(message.type==='weapon_fired'||message.type==='knife_swing'||message.type==='grenade_hud')validateWeaponFire(message);
 if(message.type==='weapon_reload')validateWeaponReload(message);
 if(message.type==='travel'&&!levelForWorld(message.world))throw Error('Invalid travel world');
 return message;
}


export function validateVitals(state){
 const bounded=(n,max)=>Number.isInteger(n)&&n>=0&&n<=max;
 if(!Array.isArray(state)||state.length!==14||!bounded(state[0],0xffffffff)
    ||!state.slice(1,6).every(n=>bounded(n,1000))||!bounded(state[6],7)
    ||!state.slice(7,10).every(n=>bounded(n,0xffffffff))||state[8]>state[9]
    ||!bounded(state[10],1000)||![0,1,2,3,4,6].includes(state[11])||!bounded(state[12],1000)
    ||!bounded(state[13],0xffff))throw Error('Invalid player vitals');
 const active=state[13]&0xff,expiring=state[13]>>>8;
 if(expiring&~active)throw Error('Invalid expiring booster');
 return state;
}
