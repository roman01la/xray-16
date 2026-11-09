import {ARCHIVE_CHUNKS, ARCHIVE_DESCRIPTORS, INSTALL_DIRECTORY, LEGACY_CHUNKS, LEGACY_DESCRIPTORS} from './opfs-store.mjs';

// Request fullscreen on an element owned by the top document. Keyboard
// Lock cannot be requested by the release iframe itself.
const frame=window.frameElement;
const fullscreenTarget=frame ?? document.documentElement;
const fullscreenDocument=fullscreenTarget.ownerDocument;
const isFullscreen=()=>fullscreenDocument.fullscreenElement===fullscreenTarget;
if(fullscreenDocument.fullscreenEnabled && fullscreenTarget.requestFullscreen){
 const keyboard=fullscreenDocument.defaultView.navigator.keyboard;
 let locked=false,pending=false,activeDocument=true;
 const syncKeyboard=async()=>{
  if(!activeDocument || !isFullscreen()){
   if(locked){keyboard.unlock();locked=false;}
   return;
  }
  if(locked || pending || !keyboard?.lock)return;
  pending=true;
  try{
   await keyboard.lock(['Escape']);
   if(activeDocument && isFullscreen())locked=true;
   else keyboard.unlock();
  } catch { /* Keep ordinary fullscreen when Keyboard Lock is unavailable. */ }
  finally{pending=false;}
 };
 window.xrayBrowserFullscreen={
  isActive:isFullscreen,
  async set(enabled){
   try{
    if(enabled && !isFullscreen())await fullscreenTarget.requestFullscreen();
    if(!enabled && isFullscreen())await fullscreenDocument.exitFullscreen();
   } catch(error) { console.warn('Could not change the game window mode:',error); }
  },
 };
 fullscreenDocument.addEventListener('fullscreenchange',syncKeyboard);
 window.addEventListener('pagehide',()=>{
  activeDocument=false;
  fullscreenDocument.removeEventListener('fullscreenchange',syncKeyboard);
  syncKeyboard();
 });
 window.addEventListener('pageshow',()=>{
  activeDocument=true;
  fullscreenDocument.addEventListener('fullscreenchange',syncKeyboard);
  syncKeyboard();
 });
 syncKeyboard();
}

// SDL listens for canvas mouse input and document mouse releases. Keep
// unlocked movement and the click that captures the mouse out of the engine.
const canvas=document.querySelector('#canvas');
const capture=document.querySelector('#mouse-capture');
const boot=document.querySelector('#boot');
const hasMouse=()=>document.pointerLockElement===canvas;
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
 capture.hidden=hasMouse();
});
capture.addEventListener('click',async()=>{
 canvas.focus({preventScroll:true});
 try{await canvas.requestPointerLock();}
 catch{capture.firstElementChild.textContent='Click to retry mouse capture';}
});

const params=new URLSearchParams(location.search),multiplayer=params.get('play')==='multiplayer';
const managingStorage=params.get('storage')==='manage';
const returnToMenuKey='xray-return-to-menu';
const storageLock='xray-installed-game-data';
const deleteKey='xray-delete-game-data';
const deleteButton=document.querySelector('#delete-game-data');
const reinstallButton=document.querySelector('#reinstall-game');
const storageStatus=document.querySelector('#storage-status');
const returningToMenu=sessionStorage.getItem(returnToMenuKey)===location.href;
if(returningToMenu)sessionStorage.removeItem(returnToMenuKey);
if(multiplayer||returningToMenu||managingStorage){
 document.querySelector('#start-game').hidden=true;
 document.querySelector('#boot-backup').hidden=true;
}
deleteButton.hidden=multiplayer||returningToMenu||!params.has('stream');
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
     const install=await root.getDirectoryHandle(INSTALL_DIRECTORY);
     await remove(install,ARCHIVE_CHUNKS);
     await remove(install,ARCHIVE_DESCRIPTORS);
    }catch(error){if(error.name!=='NotFoundError')throw error;}
    for await(const [name,profile] of root.entries()){
     if(profile.kind!=='directory'||(name!=='stream-cop'&&!/^zone-engine-preview-[a-z0-9_-]{1,24}$/.test(name)))continue;
     const files=await Array.fromAsync(profile.keys());
     for(const file of files){
      if(file!=='_appdata_'&&file!=='_multiplayer_')await profile.removeEntry(file,{recursive:true});
     }
    }
    await Promise.all([LEGACY_CHUNKS,LEGACY_DESCRIPTORS].map(name=>globalThis.caches?.delete(name)));
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
function selectMode(mode){
 const url=new URL(location.href);url.searchParams.delete('save');url.searchParams.delete('autostart');
 if(mode==='multiplayer'){url.searchParams.set('play',mode);url.searchParams.delete('map');url.searchParams.set('slot','public');}
 else {
  for(const key of ['play','map','slot'])url.searchParams.delete(key);
  sessionStorage.setItem(returnToMenuKey,url.href);
 }
 window.dispatchEvent(new Event('xray-browser-mode-change'));
 location.assign(url.href);
}
let switching=false;
window.addEventListener('xray-engine-log',({detail:line})=>{
 if(switching)return;
 if(line.includes('XRAY_BROWSER_MULTIPLAYER')){switching=true;selectMode('multiplayer');}
 if(line.includes('XRAY_BROWSER_MAIN_MENU')){switching=true;selectMode('singleplayer');}
});
document.querySelector('#multiplayer-hud').hidden=!multiplayer;
document.querySelector('#return-menu').onclick=()=>{document.querySelector('#disconnect').click();selectMode('singleplayer');};
if(managingStorage){
 document.querySelector('#boot-status').textContent='Manage local game data';
 document.querySelector('#load-progress').style.display='none';
 document.querySelector('#load-detail').textContent='Downloaded files can be installed again from this screen.';
 reinstallButton.hidden=false;
 if(sessionStorage.getItem(deleteKey)===location.pathname){
  sessionStorage.removeItem(deleteKey);
  if(!deleteButton.disabled)await clearInstalledGame();
 }
} else try {
 await holdInstalledGame();
 if (/^\/releases\/[a-f0-9]{64}\/index\.html$/.test(location.pathname)) {
  const {preparePublishedRelease}=await import('./release-cache.mjs');
  const status=document.querySelector('#boot-status'),meter=document.querySelector('#load-progress');
  status.textContent='Checking game engine files…';
  globalThis.__xrayRetireLegacyStorage=await preparePublishedRelease((done,total,label)=>{
   status.textContent=label;
   meter.max=total;meter.value=done;
  });
  if(globalThis.__xrayRetireLegacyStorage)window.addEventListener('xray-stream-progress',({detail})=>{
   if(detail.phase==='install'&&detail.ready)globalThis.caches?.delete(LEGACY_DESCRIPTORS).catch(console.warn);
  });
  meter.removeAttribute('value');
 }
 await import('./singleplayer-ui.mjs');
} catch(error) {
 document.querySelector('#boot-status').textContent=error.message;
 const retry=document.querySelector('#retry');retry.hidden=false;retry.onclick=()=>location.reload();
}
