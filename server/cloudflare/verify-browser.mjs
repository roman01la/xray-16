// Background Chrome transport check; never opens the user's browser/profile.
import {spawn} from 'node:child_process';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {setTimeout as sleep} from 'node:timers/promises';
const base=process.argv[2]?.replace(/\/$/,'');
if(!base || !(base.startsWith('https://') || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(base)))
 throw Error('Supply a deployed HTTPS origin or a loopback preview origin');
const profile=await mkdtemp(join(tmpdir(),'stalker-cf-check-'));let chrome,ws;
try{
 chrome=spawn(process.env.CHROME_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 let port;for(let i=0;i<100&&!port;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await sleep(100);}}
 if(!port)throw Error('Chrome did not start');
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');let sequence=0;const pending=new Map();
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 // Check navigation and transport without installing the entire campaign.
 await send('Network.enable');
 await send('Network.setBlockedURLs',{urls:['*/game-ui.mjs']});
 await send('Page.enable');await send('Page.navigate',{url:base});await sleep(1500);
 const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const frame=document.querySelector('iframe');
 const buttons=[...document.querySelectorAll('button[data-game][data-entry]')];
 const entries=buttons.length?buttons.map(button=>[button.dataset.game,button.dataset.entry]):[['cop',frame.getAttribute('src')]];
 if(location.pathname!=='/' || (buttons.length && (frame.hasAttribute('src') || !([2,3].includes(buttons.length)))))
   throw Error('Game picker did not open at the site root');
 const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
 const titles=[];
 for(const [game,entry] of entries){
   const entryURL=new URL(entry,location.origin);
   const prefix=new URL('./',entryURL);
   const engine=await(await fetch(new URL('engine_data.json',prefix))).json();
   if((engine.gameId??'cop')!==game)throw Error('Wrong engine mode for '+game);
   const index=await(await fetch(new URL('release-files.json',prefix))).json();
   const wasm=await(await fetch(new URL('xr_3da.wasm',prefix))).arrayBuffer();
   if(await sha(wasm)!==index['xr_3da.wasm'].sha256)throw Error('Wasm hash mismatch for '+game);
   await WebAssembly.compile(wasm);
   const packURL=new URL(entryURL.searchParams.get('stream'),location.origin);
   const pack=await(await fetch(packURL)).json();
   const archive=pack.files.find(file=>file.size>=pack.chunkBytes)??pack.files[0];
   const archiveURL=new URL(archive.path,packURL);
   const descriptor=await(await fetch(archiveURL.href+'.json')).json();
   const hash=descriptor.chunks[0];
   const chunk=await fetch(new URL('../chunks/'+hash+'.bin',archiveURL));
   if(!chunk.ok)throw Error('Chunk HTTP '+chunk.status+' for '+game);
   const bytes=await chunk.arrayBuffer();
   if(await sha(bytes)!==hash)throw Error('Decoded chunk hash mismatch for '+game);
   titles.push({game,wasmBytes:wasm.byteLength,wasmCompiled:true,chunkBytes:bytes.byteLength,chunkURL:chunk.url,encoding:chunk.headers.get('content-encoding')});
 }
 const thread=await new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob(['postMessage({isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer!=="undefined"})'],{type:'text/javascript'}));const worker=new Worker(url);worker.onmessage=e=>{worker.terminate();URL.revokeObjectURL(url);resolve(e.data);};worker.onerror=reject;});
 if(!crossOriginIsolated||!thread.isolated||!thread.shared)throw Error('Thread isolation unavailable');
 return {origin:location.origin,isolated:crossOriginIsolated,thread,titles};
})()`});
 if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
 const verified=result.result.value;
 // Exercise the actual startup bundle, with the compatibility gate stopping
 // the multi-gigabyte installation. This catches top-level bootstrap errors.
 await send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'gpu',{value:undefined});"});
 await send('Network.setBlockedURLs',{urls:['*/analytics/event','*/crash-report']});
 verified.startup=[];
 if(verified.titles.length>1){
  for(const {game} of verified.titles){
   await send('Page.navigate',{url:base});
   const clicked=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
    if(document.readyState!=='complete')await new Promise(resolve=>addEventListener('load',resolve,{once:true}));
    const frame=document.querySelector('iframe');
    const loaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
    document.querySelector('button[data-game="${game}"]').click();
    await loaded;
    if(location.pathname!=='/' || frame.hidden || frame.contentDocument.documentElement.dataset.game!=='${game}')return false;
    for(let attempt=0;attempt<100;attempt++){
     const page=frame.contentDocument;
     if(page.querySelector('#boot-status').textContent.includes('This browser cannot run the game.'))
      return !page.querySelector('#choose-game').hidden && page.querySelector('#start-game').disabled;
     await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Startup did not reach the compatibility gate for ${game}');
   })()`});
   if(clicked.exceptionDetails || !clicked.result.value)throw Error('Picker did not open '+game);
   verified.startup.push({game,bootstrapExecuted:true,compatibilityGate:true});
  }
 }
 console.log(JSON.stringify(verified,null,2));
}finally{ws?.close();if(chrome){chrome.kill('SIGTERM');await once(chrome,'exit').catch(()=>{});}await rm(profile,{recursive:true,force:true});}
