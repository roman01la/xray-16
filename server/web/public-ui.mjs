import {savedKey,importIdentity} from './identity.mjs';
const status=document.querySelector('#status'),connection=document.querySelector('#connection');
new MutationObserver(()=>{connection.hidden=status.textContent.startsWith('C++ tick');}).observe(status,{childList:true,characterData:true,subtree:true});
if(!navigator.gpu||!crossOriginIsolated||!navigator.storage?.getDirectory){status.textContent='This build needs a desktop browser with WebGPU and local file storage. Please try a current Chrome or Edge browser.';}
else import('./engine-preview.mjs').catch(()=>{connection.hidden=false;status.textContent='Could not start the game. Please reload to retry.';});

const slot=new URLSearchParams(location.search).get('slot')||'public';
const savePanel=document.querySelector('#multiplayer-hud');
const releaseSavePanelPointer=()=>{
 if(savePanel.open&&document.pointerLockElement)document.exitPointerLock();
};
savePanel.addEventListener('toggle',releaseSavePanelPointer);
document.addEventListener('pointerlockchange',releaseSavePanelPointer);
const saveStatus=document.querySelector('#save-key-status'),copy=document.querySelector('#copy-save-key'),restore=document.querySelector('#restore-save');
copy.addEventListener('click',async()=>{
 copy.disabled=true;
 try{
  const key=savedKey(slot);
  try{await navigator.clipboard.writeText(key);saveStatus.textContent='Save key copied. Keep it somewhere private.';}
  catch{const field=document.querySelector('#export-save-key');field.value=key;field.hidden=false;field.focus();field.select();saveStatus.textContent='Copy the selected key and keep it somewhere private.';}
 }catch{saveStatus.textContent='Could not retrieve your save key. Please try again.';}
 finally{copy.disabled=false;}
});
restore.addEventListener('click',async()=>{
 restore.disabled=true;copy.disabled=true;
 try{
  await importIdentity(slot,document.querySelector('#import-save-key').value);
  document.querySelector('#import-save-key').value='';
 document.querySelector('#disconnect').click();
 window.dispatchEvent(new Event('xray-browser-navigation'));
 location.reload();
 }catch(error){saveStatus.textContent=error.message;restore.disabled=false;copy.disabled=false;}
});
