// Isolated Chrome/OPFS integration check; never uses a user's profile or saves.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const repo=resolve(import.meta.dirname,'../../..');
const output=process.argv[2]?resolve(process.argv[2]):await mkdtemp(join(tmpdir(),'xray-compatibility-'));
await mkdir(output,{recursive:true});const profile=join(output,'chrome');await mkdir(profile,{recursive:true});await rm(join(profile,'DevToolsActivePort'),{force:true});
const files={ '/compatibility.mjs':'server/web/compatibility.mjs', '/index.html':'server/web/game.html','/game-ui.mjs':'server/web/game-ui.mjs',
 '/analytics-client.mjs':'server/web/analytics-client.mjs','/opfs-store.mjs':'server/web/opfs-store.mjs',
 '/save-format.js':'misc/web/page/save-format.js','/startup-wallpaper.webp':'server/web/startup-wallpaper.webp',
 '/favicon.ico':'src/xr_3da/stalker_cop.ico'};
const requests=[];
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;requests.push(path);
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 const file=files[path];if(!file){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',path.endsWith('.html')?'text/html':/\.m?js$/.test(path)?'text/javascript':'application/octet-stream');
 res.end(await readFile(join(repo,file)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const chrome=spawn(process.env.XRAY_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 '--headless=new','--enable-unsafe-webgpu','--remote-debugging-port=0','--disable-background-networking','--no-first-run',
 '--no-default-browser-check','--window-size=1100,850',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(check){for(let i=0;i<100;i++){const value=await check();if(value)return value;await delay(100);}throw Error('Timed out');}
let socket;
try{
 const port=await poll(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}});
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
 let serial=0;const pending=new Map();
 socket.addEventListener('message',({data})=>{const message=JSON.parse(data),request=pending.get(message.id);if(!request)return;
  pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},15000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 await send('Page.enable');
 await send('Page.navigate',{url:origin+'/index.html?saves=import&stream=/pack.json'});
 await poll(()=>evaluate(`!!document.querySelector('#boot-status')`));
 const actual=await evaluate(`import('/compatibility.mjs').then(m=>m.checkGameCompatibility())`);
 assert.deepEqual(actual,[], 'Real Chrome must pass preflight');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`WebAssembly.validate=()=>false;`});
 requests.length=0;
 await send('Page.navigate',{url:origin+'/index.html?stream=/pack.json'});
 await poll(()=>evaluate(`document.querySelector('#boot-status')?.textContent.includes('Memory64')`));
 const result=await evaluate(`({status:document.querySelector('#boot-status').textContent,detail:document.querySelector('#load-detail').textContent,startDisabled:document.querySelector('#start-game').disabled,progressHidden:document.querySelector('#load-progress').hidden})`);
 assert.equal(result.startDisabled,true);assert.equal(result.progressHidden,true);
 assert(!requests.some(p=>/xr_3da|main.js|pack.json|singleplayer-ui|release-cache|engine_data/.test(p)));
 await writeFile(join(output,'result.json'),JSON.stringify({passed:true,actualChrome:actual,result,requests},null,2));
 console.log(JSON.stringify({passed:true,output,result,requests}));
}finally{socket?.close();chrome.kill('SIGTERM');server.close();}
