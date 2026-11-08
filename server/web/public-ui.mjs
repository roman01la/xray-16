import {loadIdentity,importIdentity} from './identity.mjs';
const status=document.querySelector('#status'),connection=document.querySelector('#connection');
new MutationObserver(()=>{connection.hidden=status.textContent.startsWith('C++ tick');}).observe(status,{childList:true,characterData:true,subtree:true});
if(!navigator.gpu||!crossOriginIsolated||!navigator.storage?.getDirectory){status.textContent='This build needs a desktop browser with WebGPU and local file storage. Please try a current Chrome or Edge browser.';}
else import('./engine-preview.mjs').catch(()=>{connection.hidden=false;status.textContent='Could not start the game. Please reload to retry.';});

const slot=new URLSearchParams(location.search).get('slot')||'public';
const saveStatus=document.querySelector('#save-key-status'),copy=document.querySelector('#copy-save-key'),restore=document.querySelector('#restore-save');
copy.addEventListener('click',async()=>{
 copy.disabled=true;
 try{
  const identity=await loadIdentity(slot);
  try{await navigator.clipboard.writeText(identity.secret);saveStatus.textContent='Save key copied. Keep it somewhere private.';}
  catch{const field=document.querySelector('#export-save-key');field.value=identity.secret;field.hidden=false;field.focus();field.select();saveStatus.textContent='Copy the selected key and keep it somewhere private.';}
 }catch{saveStatus.textContent='Could not retrieve your save key. Please try again.';}
 finally{copy.disabled=false;}
});
restore.addEventListener('click',async()=>{
 restore.disabled=true;copy.disabled=true;
 try{
  await importIdentity(slot,document.querySelector('#import-save-key').value);
  document.querySelector('#import-save-key').value='';
  document.querySelector('#disconnect').click();location.reload();
 }catch(error){saveStatus.textContent=error.message;restore.disabled=false;copy.disabled=false;}
});
