import test from 'node:test';import assert from 'node:assert/strict';import {loadIdentity,newCredential,savedKey,writeRecord} from './identity.mjs';
function storage(){const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};}
const ok={ok:true,json:async()=>({principalId:'a'.repeat(32)})};
test('credentials are persisted before enrollment and retries reuse them',async()=>{
 const s=storage(),seen=[];let fail=true;
 const request=async(url,opts)=>{const secret=JSON.parse(opts.body).secret;assert.ok(s.getItem('zone-multiplayer-identity-v1:test'));seen.push([url,secret]);if(fail){fail=false;throw Error('lost reply');}return ok;};
 await assert.rejects(loadIdentity('test',{storage:s,request}),/lost reply/);
 const a=await loadIdentity('test',{storage:s,request}),b=await loadIdentity('test',{storage:s,request});
 assert.deepEqual(a,b);assert.equal(seen[0][1],seen[1][1]);assert.equal(seen[0][0],'/identity/register');assert.equal(seen[1][0],'/identity/register');assert.equal(seen[2][0],'/identity/resume');
 assert.match(newCredential(),/^[a-f0-9]{64}$/);
});
test('copy reads an enrolled key locally and keeps pending enrollments private',async()=>{
 const s=storage();
 assert.throws(()=>savedKey('public',s),/No multiplayer save key/);
 await assert.rejects(loadIdentity('public',{storage:s,request:async()=>{throw Error('offline');}}),/offline/);
 assert.throws(()=>savedKey('public',s),/No multiplayer save key/);
 const enrolled=await loadIdentity('public',{storage:s,request:async()=>ok});
 assert.equal(savedKey('public',s),enrolled.secret);
 s.setItem('zone-multiplayer-identity-v1:public','null');
 assert.throws(()=>savedKey('public',s),/Invalid saved multiplayer identity/);
});
test('missing server identity or changed principal never silently replaces a saved identity',async()=>{
 const s=storage();await loadIdentity('test',{storage:s,request:async()=>ok});
 await assert.rejects(loadIdentity('test',{storage:s,request:async()=>({ok:false,json:async()=>({error:'unauthorized'})})}),/unauthorized/);
 await assert.rejects(loadIdentity('test',{storage:s,request:async()=>({ok:true,json:async()=>({principalId:'b'.repeat(32)})})}),/changed/);
});
test('record conflicts remain explicit and transport errors do not retry with a new request',async()=>{
 let calls=0;const mutation={requestId:'stable',expectedRevision:0,value:{test:true}},identity={secret:'a'.repeat(64)};
 const result=await writeRecord(identity,mutation,{request:async()=>({ok:false,json:async()=>({status:'conflict',revision:1})})});assert.equal(result.status,'conflict');
 await assert.rejects(writeRecord(identity,mutation,{request:async()=>{calls++;throw Error('lost reply');}}),/lost reply/);assert.equal(calls,1);
});

test('concurrent first-use tabs serialize enrollment and share one principal',async()=>{
 const s=storage(),calls=[];let tail=Promise.resolve();
 const locks={request:(_key,_opts,fn)=>{const work=tail.then(fn);tail=work.catch(()=>{});return work;}};
 const request=async(url,opts)=>{calls.push([url,JSON.parse(opts.body).secret]);await Promise.resolve();return ok;};
 const [a,b]=await Promise.all([loadIdentity('shared',{storage:s,request,locks}),loadIdentity('shared',{storage:s,request,locks})]);
 assert.deepEqual(a,b);assert.deepEqual(calls.map(c=>c[0]),['/identity/register','/identity/resume']);assert.equal(calls[0][1],calls[1][1]);
});
test('ownership requests preserve command IDs and explicit rejection outcomes',async()=>{
 const {listEntities,transferEntity}=await import('./identity.mjs');
 const identity={secret:'c'.repeat(64)},command={requestId:'keep-this-id',entityId:'a'.repeat(32),expectedRevision:4,recipient:'b'.repeat(32)};
 let calls=0;
 const result=await transferEntity(identity,command,{request:async(url,opts)=>{calls++;assert.equal(url,'/identity/transfer');assert.equal(opts.headers['X-Zone-Identity'],identity.secret);assert.deepEqual(JSON.parse(opts.body),command);return {ok:true,json:async()=>({status:'rejected',reason:'not_owned'})};}});
 assert.equal(result.reason,'not_owned');assert.equal(calls,1);
 await listEntities(identity,'a'.repeat(32),{generation:7,request:async(url)=>{assert.equal(url,'/identity/entities?after='+'a'.repeat(32)+'&generation=7');return {ok:true,json:async()=>({entities:[],nextCursor:null})};}});
});

test('portable save key resumes the same principal on another browser without enrollment',async()=>{
 const {importIdentity}=await import('./identity.mjs'),first=storage(),second=storage();
 const original=await loadIdentity('public',{storage:first,request:async()=>ok});
 const request=async(url,opts)=>{assert.equal(url,'/identity/resume');assert.equal(JSON.parse(opts.body).secret,original.secret);return ok;};
 const recovered=await importIdentity('public','  '+original.secret.toUpperCase()+'\n',{storage:second,request});
 assert.deepEqual(recovered,original);
 assert.deepEqual(await loadIdentity('public',{storage:second,request}),original);
});
test('invalid, unknown and interrupted save imports preserve the current save',async()=>{
 const {importIdentity}=await import('./identity.mjs'),s=storage();
 await loadIdentity('public',{storage:s,request:async()=>ok});const before=s.getItem('zone-multiplayer-identity-v1:public');
 await assert.rejects(importIdentity('public','typo',{storage:s,request:()=>{throw Error('must not request');}}),/64-character/);
 await assert.rejects(importIdentity('public','b'.repeat(64),{storage:s,request:async()=>({ok:false,json:async()=>({})})}),/not accepted/);
 await assert.rejects(importIdentity('public','b'.repeat(64),{storage:s,request:async()=>{throw Error('offline');}}),/offline/);
 assert.equal(s.getItem('zone-multiplayer-identity-v1:public'),before);
});
test('save import uses the same exclusive slot lock as enrollment',async()=>{
 const {importIdentity}=await import('./identity.mjs'),s=storage();let entered=false;
 const locks={request:async(key,opts,fn)=>{assert.equal(key,'zone-multiplayer-identity-v1:public');assert.equal(opts.mode,'exclusive');entered=true;return fn();}};
 await importIdentity('public','c'.repeat(64),{storage:s,locks,request:async()=>{assert.equal(entered,true);return ok;}});
});
