import {installBrowserWindowMode} from './browser-window.mjs';
import {requireGameCompatibility, showCompatibilityFailure} from './compatibility.mjs';
import {ARCHIVE_CHUNKS, ARCHIVE_DESCRIPTORS, gameInstallDirectory, LEGACY_CHUNKS, LEGACY_DESCRIPTORS} from './opfs-store.mjs';
import {startCampaignAnalytics} from './analytics-client.mjs';

const selectedGame=document.documentElement.dataset.game;
const gameId=['soc','cs'].includes(selectedGame)?selectedGame:'cop';
const streamRoot=`stream-${gameId}`;
startCampaignAnalytics(gameId);
// Reporting must not prevent startup when a browser blocks or cannot fetch it.
void import('./crash-reporter.mjs').then(({installCrashReporter}) => {
 installCrashReporter(gameId);
}).catch(error => console.warn('Crash reporting unavailable', error));

installBrowserWindowMode();

// SDL listens for canvas mouse input and document mouse releases. Keep
// unlocked movement and the click that captures the mouse out of the engine.
const canvas=document.querySelector('#canvas');
const capture=document.querySelector('#mouse-capture');
const boot=document.querySelector('#boot');
const hasMouse=()=>document.pointerLockElement===canvas;
const syncMouseCapture=()=>{capture.hidden=hasMouse();};
for(const type of ['keydown','keyup','keypress']){
 window.addEventListener(type,event=>{
  if(!boot.hidden)event.stopImmediatePropagation();
 },true);
}
const heldButtons=new Set();
let releasingButtons=false;
for(const type of ['mousemove','pointerrawupdate','mousedown','mouseenter','mouseleave','wheel','click','dblclick']){
 canvas.addEventListener(type,event=>{
  if(!hasMouse())event.stopImmediatePropagation();
  else if(type==='mousedown')heldButtons.add(event.button);
 },true);
}
document.addEventListener('mouseup',event=>{
 if(!hasMouse() && !releasingButtons)event.stopImmediatePropagation();
 else heldButtons.delete(event.button);
});
document.addEventListener('pointerlockchange',()=>{
 if(!boot.hidden && hasMouse())document.exitPointerLock();
 if(!hasMouse() && heldButtons.size){
  // A lock can be lost while a button is held. Release it in SDL so a
  // weapon or menu control cannot stay pressed when the mouse is recaptured.
  releasingButtons=true;
  for(const button of heldButtons)canvas.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button}));
  releasingButtons=false;
 }
 syncMouseCapture();
});
window.addEventListener('blur',()=>{
 if(hasMouse())document.exitPointerLock();
 syncMouseCapture();
});
window.addEventListener('focus',syncMouseCapture);
syncMouseCapture();
capture.addEventListener('click',async()=>{
 canvas.focus({preventScroll:true});
 try{await canvas.requestPointerLock();}
 catch{capture.firstElementChild.textContent='Click to retry mouse capture';}
});

const params=new URLSearchParams(location.search);
document.querySelector('#choose-game').hidden=params.get('picker')!=='1'||!window.frameElement;
const managingStorage=params.get('storage')==='manage';
const importingSaves=params.get('saves')==='import';
const importButton=document.querySelector('#boot-import');
const importFile=document.querySelector('#boot-import-file');
const backupStatus=document.querySelector('#backup-status');
const returnToMenuKey='xray-return-to-menu';
const storageLock='xray-installed-game-data';
const deleteKey='xray-delete-game-data';
const deleteButton=document.querySelector('#delete-game-data');
const reinstallButton=document.querySelector('#reinstall-game');
const storageStatus=document.querySelector('#storage-status');
const returningToMenu=sessionStorage.getItem(returnToMenuKey)===location.href;
if(returningToMenu)sessionStorage.removeItem(returnToMenuKey);
if(returningToMenu||managingStorage||importingSaves){
 document.querySelector('#start-game').hidden=true;
 document.querySelector('#boot-backup').hidden=true;
}
importButton.hidden=returningToMenu||managingStorage;
importButton.disabled=!navigator.locks||!navigator.storage?.getDirectory;
importButton.addEventListener('click',()=>{
 if(importingSaves){importFile.click();return;}
 const root=params.has('stream')?streamRoot:document.querySelector('#game').value;
 if(!root){backupStatus.textContent='Wait for the game files to be selected, then try again.';return;}
 const url=new URL(location.href);url.searchParams.delete('storage');url.searchParams.set('saves','import');
 if(!params.has('stream'))url.searchParams.set('save-root',root);
 // Release engine workers and their OPFS handles before restoring save files.
 window.dispatchEvent(new Event('xray-browser-navigation'));
 location.replace(url.href);
});
deleteButton.hidden=returningToMenu||!params.has('stream');
deleteButton.disabled=!navigator.locks||!navigator.storage?.getDirectory;

async function clearInstalledGame(){
 deleteButton.disabled=true;
 reinstallButton.disabled=true;
 storageStatus.textContent='Deleting downloaded game data…';
 try{
  await navigator.locks.request(storageLock,{ifAvailable:true},async lock=>{
   if(!lock)throw Error('Close other game tabs and try again.');
   await navigator.locks.request('xray-game-pack-install',async()=>{
    const root=await navigator.storage.getDirectory();
    const remove=async(directory,name)=>{
     try{await directory.removeEntry(name,{recursive:true});}
     catch(error){if(error.name!=='NotFoundError')throw error;}
    };
    try{
     const install=await root.getDirectoryHandle(gameInstallDirectory(gameId));
     await remove(install,ARCHIVE_CHUNKS);
     await remove(install,ARCHIVE_DESCRIPTORS);
    }catch(error){if(error.name!=='NotFoundError')throw error;}
    for await(const [name,profile] of root.entries()){
     if(profile.kind!=='directory'||name!==streamRoot)continue;
     const files=await Array.fromAsync(profile.keys());
     for(const file of files){
      if(file!=='_appdata_')await profile.removeEntry(file,{recursive:true});
     }
    }
    if(gameId==='cop')await Promise.all([LEGACY_CHUNKS,LEGACY_DESCRIPTORS].map(name=>globalThis.caches?.delete(name)));
   });
  });
  storageStatus.textContent='Downloaded game data deleted. Your saves and settings are still available.';
 }catch(error){
  storageStatus.textContent='Could not delete all game data. '+error.message;
 }finally{
  deleteButton.disabled=false;
  reinstallButton.disabled=false;
 }
}

deleteButton.addEventListener('click',()=>{
 if(!confirm('Delete the downloaded game files? Saves and settings will be kept. Close any other game tabs before continuing.'))return;
 if(managingStorage){clearInstalledGame();return;}
 sessionStorage.setItem(deleteKey,location.pathname);
 const url=new URL(location.href);
 url.searchParams.set('storage','manage');
 // Unload the engine and its workers before removing files they may have open.
 location.replace(url.href);
});
reinstallButton.addEventListener('click',()=>{
 const url=new URL(location.href);
 url.searchParams.delete('storage');
 location.replace(url.href);
});

async function holdInstalledGame(){
 if(!params.has('stream')||!navigator.locks)return;
 await new Promise((ready,reject)=>{
  navigator.locks.request(storageLock,{mode:'shared'},()=>new Promise(release=>{
   window.addEventListener('pagehide',release,{once:true});
   ready();
  })).catch(reject);
 });
 // A restored page must recheck installation after releasing its storage lock.
 window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
}
if(importingSaves){
 document.querySelector('#boot-status').textContent='Import saved games';
 document.querySelector('#load-progress').style.display='none';
 document.querySelector('#load-detail').textContent='Choose a JSON backup made with Download Saves. Existing saves are kept; matching save names and their thumbnails are skipped.';
 importButton.textContent='Choose Backup';
 deleteButton.hidden=true;
 const back=document.querySelector('#retry');back.hidden=false;back.textContent='Return to Game';
 back.onclick=()=>{
  const url=new URL(location.href);url.searchParams.delete('saves');url.searchParams.delete('save-root');
  location.replace(url.href);
 };
 importFile.addEventListener('change',async()=>{
  const file=importFile.files[0];if(!file)return;
  importButton.disabled=true;back.disabled=true;
  backupStatus.textContent='Checking and importing saves…';
  try{
   const {importSaveBackup}=await import('./save-format.js');
   const root=params.has('stream')?streamRoot:params.get('save-root');
   const result=await importSaveBackup(root,file);
   backupStatus.textContent=`Imported saves: ${result.imported}. Existing saves kept: ${result.skipped}. Select Return to Game, then Load game.`;
  }catch(error){backupStatus.textContent='Import failed: '+error.message;}
  finally{importFile.value='';importButton.disabled=false;back.disabled=false;}
 });
} else if(managingStorage){
 document.querySelector('#boot-status').textContent='Manage local game data';
 document.querySelector('#load-progress').style.display='none';
 document.querySelector('#load-detail').textContent='Downloaded files can be installed again from this screen.';
 reinstallButton.hidden=false;
 if(sessionStorage.getItem(deleteKey)===location.pathname){
  sessionStorage.removeItem(deleteKey);
  if(!deleteButton.disabled)await clearInstalledGame();
 }
} else try {
 document.querySelector('#boot-status').textContent='Checking browser compatibility…';
 await requireGameCompatibility();
 await holdInstalledGame();
 if (/^\/releases\/[a-f0-9]{64}\/index\.html$/.test(location.pathname)) {
  const {preparePublishedRelease}=await import('./release-cache.mjs');
  const status=document.querySelector('#boot-status'),meter=document.querySelector('#load-progress');
  status.textContent='Checking game engine files…';
  globalThis.__xrayRetireLegacyStorage=await preparePublishedRelease((done,total,label)=>{
   status.textContent=label;
   meter.max=total;meter.value=done;
  }, gameId);
  if(globalThis.__xrayRetireLegacyStorage)window.addEventListener('xray-stream-progress',({detail})=>{
   if(detail.phase==='install'&&detail.ready)globalThis.caches?.delete(LEGACY_DESCRIPTORS).catch(console.warn);
  });
  meter.removeAttribute('value');
 }
 await import('./singleplayer-ui.mjs');
} catch(error) {
 if(error.compatibilityFailure)showCompatibilityFailure(error);
 else {
  document.querySelector('#boot-status').textContent=error.message;
  const retry=document.querySelector('#retry');retry.hidden=false;retry.onclick=()=>location.reload();
 }
}
