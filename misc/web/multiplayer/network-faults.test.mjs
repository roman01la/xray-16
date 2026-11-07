import test from 'node:test';import assert from 'node:assert/strict';import {DeliveryQueue,faultOptions} from './network-faults.mjs';
function clock(){let now=0,id=0;const tasks=new Map();return {now:()=>now,schedule:(fn,ms)=>{tasks.set(++id,{fn,at:now+ms});return id;},cancel:id=>tasks.delete(id),advance:ms=>{const end=now+ms;for(;;){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;tasks.delete(next[0]);now=next[1].at;next[1].fn();}now=end;},tasks};}
test('fault mode is opt-in and bounded',()=>{assert.equal(faultOptions('?map=zaton'),null);assert.deepEqual(faultOptions('?delay=50&loss=.1'),{delayMs:50,jitterMs:10,loss:.1});assert.throws(()=>faultOptions('?delay=Infinity'));assert.throws(()=>faultOptions('?loss=1'));});
test('state may reorder but reliable messages preserve order without loss',()=>{
 const c=clock(),values=[.9,1,.9,0],out=[],q=new DeliveryQueue({...c,delayMs:20,jitterMs:10,random:()=>values.shift()});
 q.push('first',v=>out.push(v));q.push('second',v=>out.push(v));c.advance(40);assert.deepEqual(out,['second','first']);
 const d=clock(),r=[1,0],ordered=[],p=new DeliveryQueue({...d,delayMs:20,jitterMs:10,loss:.5,random:()=>r.shift()});
 p.push('first',v=>ordered.push(v),true);p.push('second',v=>ordered.push(v),true);d.advance(40);assert.deepEqual(ordered,['first','second']);
});
test('loss, queue pressure and close cannot leak an unbounded delayed backlog',()=>{
 const c=clock(),q=new DeliveryQueue({...c,delayMs:20,loss:.5,random:()=>0,maxPending:2,maxBytes:4});
 assert.equal(q.push(new ArrayBuffer(1),()=>assert.fail()),false);assert.equal(q.stats.dropped,1);
 q.push('aa',()=>assert.fail(),true);q.push('bb',()=>assert.fail(),true);assert.throws(()=>q.push('c',()=>{},true),/overflow/);
 assert.equal(q.stats.maxQueuedBytes,4);q.close();c.advance(100);assert.equal(q.bytes,0);assert.equal(c.tasks.size,0);
});

test('default timers invoke host functions without a queue receiver',async()=>{
 const schedule=globalThis.setTimeout,cancel=globalThis.clearTimeout;
 globalThis.setTimeout=function(...args){assert.equal(this,undefined);return schedule(...args);};
 globalThis.clearTimeout=function(...args){assert.equal(this,undefined);return cancel(...args);};
 try{await new Promise(resolve=>{const q=new DeliveryQueue({delayMs:1});q.push('ok',()=>{q.close();resolve();},true);});}
 finally{globalThis.setTimeout=schedule;globalThis.clearTimeout=cancel;}
});
