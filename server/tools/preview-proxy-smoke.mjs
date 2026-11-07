// Isolated loopback acceptance for the local-to-remote gateway; no real token.
import {createServer,request} from 'node:http';import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'zone-proxy-')),token=join(root,'token');await writeFile(token,'fixture-access',{mode:0o600});
const backend=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url,origin:req.headers.origin,authorization:req.headers.authorization}));});
await new Promise(r=>backend.listen(0,'127.0.0.1',r));const backendPort=backend.address().port;
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const child=spawn(process.execPath,[resolve('misc/web/multiplayer/serve-preview.mjs'),root],{env:{...process.env,ZONE_PREVIEW_PORT:String(port),ZONE_SERVER_URL:`http://127.0.0.1:${backendPort}`,ZONE_SERVER_TOKEN_FILE:token},stdio:['ignore','pipe','pipe']});
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Preview startup timed out')),5000);child.once('exit',()=>{clearTimeout(t);reject(Error('Preview failed'));});child.stdout.once('data',()=>{clearTimeout(t);resolve();});});
 const call=(headers={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/identity/entities?after=abc&generation=17',headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end();});
 const response=await call({Origin:`http://localhost:${port}`});assert.equal(response.status,200);
 assert.deepEqual(JSON.parse(response.text),{path:'/identity/entities?after=abc&generation=17',origin:`http://127.0.0.1:${backendPort}`,authorization:'Bearer fixture-access'});
 assert.equal((await call({Origin:'https://attacker.example'})).status,403);
 assert.equal((await call({Host:'attacker.example'})).status,403);
 console.log('PASS: private token injection, pagination preserved, untrusted Origin/Host rejected');
}finally{child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>backend.close(r));await rm(root,{recursive:true,force:true});}
