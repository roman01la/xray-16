const params=new URLSearchParams(location.search),multiplayer=params.get('play')==='multiplayer';
function selectMode(mode){
 const url=new URL(location.href);url.searchParams.delete('save');url.searchParams.delete('autostart');
 if(mode==='multiplayer'){url.searchParams.set('play',mode);url.searchParams.set('map','zaton');url.searchParams.set('slot','public');}
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
await import('./singleplayer-ui.mjs');
