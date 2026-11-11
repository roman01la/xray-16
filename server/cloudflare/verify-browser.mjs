// Background Chrome transport check; never opens the user's browser/profile.
import {spawn} from 'node:child_process';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {setTimeout as sleep} from 'node:timers/promises';
const base=process.argv[2];if(!base?.startsWith('https://'))throw Error('Supply deployed HTTPS origin');
const profile=await mkdtemp(join(tmpdir(),'stalker-cf-check-'));let chrome,ws;
try{
 chrome=spawn(process.env.CHROME_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 let port;for(let i=0;i<100&&!port;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await sleep(100);}}
 if(!port)throw Error('Chrome did not start');
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');let sequence=0;const pending=new Map();
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 await send('Page.enable');await send('Page.navigate',{url:base+'/health'});await sleep(1500);
 const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const root=await(await fetch('/')).text();const entry=root.match(/<iframe[^>]*src="([^"]+)"/)[1].replaceAll('&amp;','&');const prefix=entry.split('?')[0].replace(/index.html$/,'');
 const index=await(await fetch(prefix+'release-files.json')).json();const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
 const wasm=await(await fetch(prefix+'xr_3da.wasm')).arrayBuffer();if(await sha(wasm)!==index['xr_3da.wasm'].sha256)throw Error('Wasm hash mismatch');
 await WebAssembly.compile(wasm);
 const packPath=new URL(entry,location.origin).searchParams.get('stream');const pack=await(await fetch(packPath)).json();const archive=pack.files[0];const descriptorURL=new URL(archive.path+'.json',new URL(packPath,location.origin));const descriptor=await(await fetch(descriptorURL)).json();const hash=descriptor.chunks[0];const chunk=await fetch(new URL('../chunks/'+hash+'.bin',new URL(archive.path,new URL(packPath,location.origin))));if(!chunk.ok)throw Error('Chunk HTTP '+chunk.status);const bytes=await chunk.arrayBuffer();if(await sha(bytes)!==hash)throw Error('Decoded chunk hash mismatch');
 const thread=await new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob(['postMessage({isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer!=="undefined"})'],{type:'text/javascript'}));const worker=new Worker(url);worker.onmessage=e=>{worker.terminate();URL.revokeObjectURL(url);resolve(e.data);};worker.onerror=reject;});
 if(!crossOriginIsolated||!thread.isolated||!thread.shared)throw Error('Thread isolation unavailable');
 return {origin:location.origin,isolated:crossOriginIsolated,thread,wasmBytes:wasm.byteLength,wasmCompiled:true,chunkBytes:bytes.byteLength,chunkURL:chunk.url,encoding:chunk.headers.get('content-encoding')};
})()`});
 if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);console.log(JSON.stringify(result.result.value,null,2));
}finally{ws?.close();if(chrome){chrome.kill('SIGTERM');await once(chrome,'exit').catch(()=>{});}await rm(profile,{recursive:true,force:true});}
