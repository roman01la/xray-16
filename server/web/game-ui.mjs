const params=new URLSearchParams(location.search),multiplayer=params.get('play')==='multiplayer';
function selectMode(mode){
 const url=new URL(location.href);url.searchParams.delete('save');url.searchParams.delete('autostart');
 if(mode==='multiplayer'){url.searchParams.set('play',mode);url.searchParams.delete('map');url.searchParams.set('slot','public');}
 else {for(const key of ['play','map','slot'])url.searchParams.delete(key);}
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
try {
 if (/^\/releases\/[a-f0-9]{64}\/index\.html$/.test(location.pathname)) {
  const {preparePublishedRelease}=await import('./release-cache.mjs');
  const status=document.querySelector('#boot-status'),meter=document.querySelector('#load-progress');
  status.textContent='Checking game engine files…';
  await preparePublishedRelease((done,total)=>{meter.max=total;meter.value=done;});
  meter.removeAttribute('value');
 }
 await import('./singleplayer-ui.mjs');
} catch(error) {
 document.querySelector('#boot-status').textContent=error.message;
 const retry=document.querySelector('#retry');retry.hidden=false;retry.onclick=()=>location.reload();
}
