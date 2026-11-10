// Isolated Chrome/OPFS integration check; never uses a user's profile or saves.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const repo=resolve(import.meta.dirname,'../../..');
const output=process.argv[2]?resolve(process.argv[2]):await mkdtemp(join(tmpdir(),'xray-save-import-'));
await mkdir(output,{recursive:true});const profile=join(output,'chrome');await mkdir(profile,{recursive:true});
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
 '--headless=new','--remote-debugging-port=0','--disable-background-networking','--no-first-run',
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
 await send('Page.navigate',{url:origin+'/index.html?saves=import&stream=/pack.json'});
 await poll(()=>evaluate(`document.querySelector('#boot-import')?.textContent==='Choose Backup'`));
 assert.equal(await evaluate(`document.querySelector('#start-game').hidden`),true);
 const bytes=Buffer.alloc(48,19);bytes.writeUInt32LE(0xffffffff,0);bytes.writeUInt32LE(7,4);bytes.writeUInt32LE(4096,8);
 const backup={format:'openxray-saves-v1',files:[{name:'existing.scop',data:bytes.toString('base64')},{name:'new.scop',data:bytes.toString('base64')}]};
 const valid=join(output,'valid.json'),invalid=join(output,'invalid.json');
 await writeFile(valid,JSON.stringify(backup));await writeFile(invalid,JSON.stringify({...backup,files:[...backup.files,{name:'../escape.scop',data:'AAAA'}]}));
 await evaluate(`(async()=>{const {openSaveDirectory}=await import('/save-format.js');const dir=await openSaveDirectory('stream-cop',true);const h=await dir.getFileHandle('existing.scop',{create:true});const w=await h.createWritable();await w.write(new Uint8Array([7,8,9]));await w.close();})()`);
 const upload=async path=>{const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'#boot-import-file'});
  await send('DOM.setFileInputFiles',{nodeId,files:[path]});
  await poll(()=>evaluate(`document.querySelector('#backup-status').textContent.startsWith('Import failed:')||document.querySelector('#backup-status').textContent.startsWith('Imported ')`));
  return evaluate(`document.querySelector('#backup-status').textContent`);};
 assert.match(await upload(invalid),/Invalid or duplicate/);
 assert.deepEqual(await evaluate(`(async()=>{const d=await(await import('/save-format.js')).openSaveDirectory('stream-cop');return Array.fromAsync(d.keys());})()`),['existing.scop']);
 await evaluate(`(async()=>{window.releaseSaveTest=await(await import('/save-format.js')).acquireSaveSession('stream-cop');})()`);
 assert.match(await upload(valid),/Close other game tabs/);
 await evaluate(`window.releaseSaveTest();`);await delay(50);
 assert.match(await upload(valid),/Imported saves: 1. Existing saves kept: 1/);
 const result=await evaluate(`(async()=>{const m=await import('/save-format.js'),d=await m.openSaveDirectory('stream-cop');return {names:(await Array.fromAsync(d.keys())).sort(),existing:Array.from(new Uint8Array(await(await(await d.getFileHandle('existing.scop')).getFile()).arrayBuffer())),backup:JSON.parse(await(await m.prepareSaveBackup(d)).blob.text())};})()`);
 assert.deepEqual(result.names,['existing.scop','new.scop']);assert.deepEqual(result.existing,[7,8,9]);
 assert.equal(result.backup.files.find(f=>f.name==='new.scop').data,bytes.toString('base64'));
 assert(!requests.some(p=>p.includes('xr_3da')||p==='/main.js'||p==='/pack.json'));
 const capture=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'overlay.png'),Buffer.from(capture.data,'base64'));
 await writeFile(join(output,'result.json'),JSON.stringify({passed:true,requests,checks:['invalid archive no writes','active game lock rejection','OPFS conflict preservation','OPFS import/export bytes','engine unloaded'],names:result.names},null,2));
 console.log(JSON.stringify({passed:true,output}));
}finally{socket?.close();chrome.kill('SIGTERM');server.close();}
