import {loadIdentity} from './identity.mjs';import {ZoneClient} from './client.mjs';
const $=id=>document.getElementById(id);let client,slot,disconnected=false;
addEventListener('pagehide',()=>client?.close());
$('connect').onclick=async()=>{
 $('connect').disabled=true;
 try{
  slot='access-'+Date.now().toString(36);const identity=await loadIdentity(slot);
  const {contract}=await (await fetch('/world.json')).json();client=new ZoneClient();
  await client.connect({contract,identitySecret:identity.secret});
  $('results').textContent='Principal: '+identity.principalId;
  client.addEventListener('disconnected',()=>{disconnected=true;$('status').textContent='Session disconnected';});
  $('status').textContent='Connected · revoke this test principal using admin.py';$('verify').disabled=false;
 }catch(e){$('status').textContent='FAIL · '+e.message;client?.close();}
};
$('verify').onclick=async()=>{
 try{
  if(!disconnected||!client.closed)throw Error('Revoked session has not disconnected');
  let rejected=false;try{await loadIdentity(slot);}catch(error){rejected=error.message==='unauthorized identity';}
  if(!rejected)throw Error('Old credential still accepted');
  $('status').textContent='PASS · revoked live session closed and credential rejected';
 }catch(e){$('status').textContent='FAIL · '+e.message;}
};
