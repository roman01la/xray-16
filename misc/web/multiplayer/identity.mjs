// Browser-owned credential, separate from single-player storage. This is a local
// save identity. The secret is also its portable recovery key. Never log it.
export function newCredential(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
export async function loadIdentity(slot,{storage=localStorage,request=fetch,token='',locks=globalThis.navigator?.locks}={}){
 if(!/^[a-z0-9_-]{1,24}$/.test(slot))throw Error('Invalid identity slot');
 const acquire=()=>loadIdentityUnlocked(slot,{storage,request,token});
 // Two first-use tabs must not enroll different principals for the same slot.
 if(locks)return locks.request('zone-multiplayer-identity-v1:'+slot,{mode:'exclusive',signal:AbortSignal.timeout(15000)},acquire);
 if(typeof window!=='undefined')throw Error('Browser identity requires Web Locks');
 return acquire();
}
async function loadIdentityUnlocked(slot,{storage,request,token}){
 if(!/^[a-z0-9_-]{1,24}$/.test(slot))throw Error('Invalid identity slot');
 const key='zone-multiplayer-identity-v1:'+slot;
 let saved=storage.getItem(key),record;
 if(saved){record=JSON.parse(saved);if(!/^[a-f0-9]{64}$/.test(record.secret)||typeof record.registered!=='boolean')throw Error('Invalid saved multiplayer identity');}
 else {record={secret:newCredential(),registered:false};storage.setItem(key,JSON.stringify(record));}
 const response=await request('/identity/'+(record.registered?'resume':'register'),{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({secret:record.secret}),signal:AbortSignal.timeout(10000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Identity unavailable');
 if(!/^[a-f0-9]{32}$/.test(result.principalId))throw Error('Invalid principal identity');
 if(record.principalId&&record.principalId!==result.principalId)throw Error('Persistent identity changed');
 record.registered=true;record.principalId=result.principalId;storage.setItem(key,JSON.stringify(record));return record;
}
// Import only existing saves: a typo must never create a new identity or overwrite
// the current credential. Share the enrollment lock with first-use startup.
export async function importIdentity(slot,key,{storage=localStorage,request=fetch,token='',locks=globalThis.navigator?.locks}={}){
 if(!/^[a-z0-9_-]{1,24}$/.test(slot))throw Error('Invalid identity slot');
 const secret=String(key).trim().toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(secret))throw Error('Enter the complete 64-character save key.');
 const acquire=async()=>{
  const response=await request('/identity/resume',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({secret}),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!response.ok)throw Error('Save key was not accepted. Your current save is unchanged.');
  if(!/^[a-f0-9]{32}$/.test(result.principalId))throw Error('Invalid principal identity');
  const record={secret,registered:true,principalId:result.principalId};
  storage.setItem('zone-multiplayer-identity-v1:'+slot,JSON.stringify(record));return record;
 };
 if(locks)return locks.request('zone-multiplayer-identity-v1:'+slot,{mode:'exclusive',signal:AbortSignal.timeout(15000)},acquire);
 if(typeof window!=='undefined')throw Error('Browser identity requires Web Locks');
 return acquire();
}
export async function readRecord(identity,{request=fetch,token=''}={}){
 const response=await request('/identity/state',{headers:{'X-Zone-Identity':identity.secret,...(token?{Authorization:`Bearer ${token}`}:{})},cache:'no-store',signal:AbortSignal.timeout(10000)});
 const value=await response.json();if(!response.ok)throw Error(value.error||'Record read failed');return value;
}
export async function writeRecord(identity,mutation,{request=fetch,token=''}={}){
 const response=await request('/identity/state',{method:'POST',headers:{'Content-Type':'application/json','X-Zone-Identity':identity.secret,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(mutation),signal:AbortSignal.timeout(10000)});
 const value=await response.json();if(!response.ok&&value.status!=='conflict')throw Error(value.error||'Record write failed; outcome unknown');return value;
}
// Carry the first page generation through every subsequent page; conflicts require restart.
export async function listEntities(identity,after='',{request=fetch,token='',generation=null,signal=AbortSignal.timeout(10000)}={}){
 const query=new URLSearchParams();if(after)query.set('after',after);if(generation!==null)query.set('generation',String(generation));
 const response=await request('/identity/entities'+(query.size?'?'+query:''),{headers:{'X-Zone-Identity':identity.secret,...(token?{Authorization:`Bearer ${token}`}:{})},cache:'no-store',signal});
 const value=await response.json();if(!response.ok&&value.status!=='conflict')throw Error(value.error||'Entity read failed');return value;
}
export async function transferEntity(identity,command,{request=fetch,token=''}={}){
 const response=await request('/identity/transfer',{method:'POST',headers:{'Content-Type':'application/json','X-Zone-Identity':identity.secret,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(command),signal:AbortSignal.timeout(10000)});
 const value=await response.json();if(!response.ok&&value.status!=='conflict')throw Error(value.error||'Transfer failed; outcome unknown');return value;
}
