// Isolated real WebGPU probe. Never attaches to an existing browser/profile.
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
const root=fileURLToPath(new URL('../',import.meta.url)),profile=await mkdtemp(join(tmpdir(),'xray-tess-gpu-'));
const chromePath=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Tessellation GPU validation</title>');return;}
 if(path.startsWith('/stock/')&&process.env.TESS_STOCK_DIR){const name=path.slice(7);if(!/^[\w-]+\.json$/.test(name))throw Error('invalid fixture');res.setHeader('Content-Type','application/json');res.end(await readFile(join(process.env.TESS_STOCK_DIR,name)));return;}
 const file=resolve(root,'.'+path);if(!file.startsWith(root)||!['.js','.mjs'].includes(extname(file)))throw Error('invalid file');res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
let chrome,ws;const deadline=setTimeout(()=>{console.error('GPU test timeout');chrome?.kill('SIGKILL');server.close();process.exitCode=1;},60000);
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
 chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--enable-unsafe-webgpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--user-data-dir='+profile,url],{stdio:'ignore'});
 let port;for(let i=0;i<100&&!port;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{}if(!port)await sleep(100);}
 if(!port)throw Error('Headless Chrome did not start');
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');let id=0;const pending=new Map();
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 await send('Page.enable');await send('Page.navigate',{url});
 for(let i=0;i<100;i++){const state=await send('Runtime.evaluate',{expression:'location.href=== '+JSON.stringify(url)+' && document.readyState==="complete"',returnByValue:true});if(state.result.value)break;await sleep(100);}
 const reply=await send('Runtime.evaluate',{expression:`(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)throw Error('No GPU adapter');const d=await a.requestDevice({requiredFeatures:a.features.has('timestamp-query')?['timestamp-query']:[]});try{const m=await import('/tessellation-gpu.mjs');return {...await m.validateTessellation(d),source:await m.validateTessellationSource(d),frontend:await m.validateTessellationFrontend(d),stock:${process.env.TESS_STOCK_DIR?'await m.validateTessellationStock(d)':'null'},adapter:{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device}};}finally{d.destroy();}})()`,awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);console.log(JSON.stringify(reply.result.value,null,2));
}finally{clearTimeout(deadline);ws?.close();if(chrome&&chrome.exitCode===null){chrome.kill();await Promise.race([once(chrome,'exit'),sleep(3000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL');}server.close();await rm(profile,{recursive:true,force:true});}
