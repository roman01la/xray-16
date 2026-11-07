// Development-only application delivery impairment. This does not alter ICE,
// SCTP congestion control or actual network RTT; never call it a WAN benchmark.
export function faultOptions(search){
 const p=new URLSearchParams(search);if(!p.has('delay')&&!p.has('loss'))return null;
 const delayMs=Number(p.get('delay')||0),loss=Number(p.get('loss')||0),jitterMs=Math.min(delayMs,10);
 if(!Number.isFinite(delayMs)||delayMs<0||delayMs>250||!Number.isFinite(loss)||loss<0||loss>.5)throw Error('Invalid network test settings');
 return {delayMs,jitterMs,loss};
}
export class DeliveryQueue {
 constructor({delayMs=0,jitterMs=0,loss=0,random=Math.random,now=()=>performance.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),maxPending=128,maxBytes=131072}={}){
  if(![delayMs,jitterMs,loss].every(Number.isFinite)||delayMs<0||delayMs>250||jitterMs<0||jitterMs>delayMs||loss<0||loss>.5)throw Error('Invalid impairment');
  Object.assign(this,{delayMs,jitterMs,loss,random,now,schedule,cancel,maxPending,maxBytes});
  this.pending=[];this.bytes=0;this.serial=0;this.timer=null;this.closed=false;this.lastReliableDue=0;
  this.stats={dropped:0,overflow:0,delivered:0,maxQueuedBytes:0};
 }
 push(payload,deliver,reliable=false){
  if(this.closed)return false;
  if(!reliable&&this.random()<this.loss){this.stats.dropped++;return false;}
  const bytes=typeof payload==='string'?new TextEncoder().encode(payload).length:payload.byteLength;
  if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('Invalid queued payload');
  if(this.pending.length>=this.maxPending||this.bytes+bytes>this.maxBytes){this.stats.overflow++;if(reliable)throw Error('Reliable impairment queue overflow');return false;}
  let due=this.now()+this.delayMs+(this.random()*2-1)*this.jitterMs;
  if(reliable){due=Math.max(due,this.lastReliableDue);this.lastReliableDue=due;}
  this.pending.push({payload,deliver,bytes,due,serial:this.serial++});this.bytes+=bytes;
  this.stats.maxQueuedBytes=Math.max(this.stats.maxQueuedBytes,this.bytes);
  this.pending.sort((a,b)=>a.due-b.due||a.serial-b.serial);this.arm();return true;
 }
 arm(){if(this.timer!==null)this.cancel(this.timer);this.timer=null;if(this.pending.length&&!this.closed)this.timer=this.schedule(()=>this.flush(),Math.max(0,this.pending[0].due-this.now()));}
 flush(){this.timer=null;while(!this.closed&&this.pending.length&&this.pending[0].due<=this.now()){
   const item=this.pending.shift();this.bytes-=item.bytes;this.stats.delivered++;item.deliver(item.payload);
  }this.arm();}
 close(){this.closed=true;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.pending=[];this.bytes=0;}
}
