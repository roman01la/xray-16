import test from 'node:test';import assert from 'node:assert/strict';import {LifecycleRegistry} from './lifecycle.mjs';
const batch=(revision,upsert=[],remove=[])=>({type:'lifecycle',tick:revision*2,revision,upsert,remove});
const entry=id=>({id,kind:1,model:'stalker'});
test('reliable lifecycle is atomic, ordered and independent of transform membership',()=>{
 const r=new LifecycleRegistry();r.apply(batch(1,[entry(1),entry(2)]));
 assert.throws(()=>r.apply(batch(3,[],[1])));assert.equal(r.entries.size,2);
 assert.throws(()=>r.apply(batch(2,[{...entry(3),model:'../../asset'}],[1])));assert.equal(r.entries.size,2);assert.equal(r.revision,1);
 r.apply(batch(2,[],[1]));assert.equal(r.entries.has(1),false);r.apply(batch(3,[entry(1)]));assert.equal(r.entries.size,2);
 r.clear();assert.equal(r.entries.size,0);assert.equal(r.revision,0);
});
test('lifecycle bounds churn and wraparound',()=>{
 const r=new LifecycleRegistry();for(let i=0;i<32;i++)r.apply(batch(i+1,Array.from({length:16},(_,j)=>entry(i*16+j+1))));
 assert.throws(()=>r.apply(batch(33,[entry(513)])));assert.equal(r.entries.size,512);
 r.apply(batch(33,[entry(513)],[1]));assert.equal(r.entries.size,512);
 r.revision=0xffffffff;r.apply(batch(0,[],[2]));assert.equal(r.revision,0);
});
test('persistent IDs survive AOI re-entry but cannot alias two live proxies',()=>{
 const r=new LifecycleRegistry(),persistentId='a'.repeat(32);
 r.apply(batch(1,[{...entry(1),persistentId}]));
 assert.equal(r.entries.get(1).persistentId,persistentId);
 assert.throws(()=>r.apply(batch(2,[{...entry(2),persistentId}])));
 assert.equal(r.revision,1);
 r.apply(batch(2,[],[1]));r.apply(batch(3,[{...entry(7),persistentId}]));
 assert.equal(r.entries.size,1);assert.equal(r.entries.get(7).persistentId,persistentId);
 r.clear();assert.equal(r.entries.size,0);
});
