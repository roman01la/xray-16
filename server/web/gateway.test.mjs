import {gzipSync} from 'node:zlib';import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {createServer} from 'node:http';import {createGateway} from './gateway.mjs';
test('public gateway isolates admin, verifies uploads, atomically publishes and proxies identity safely',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zone-web-')),token='private-test-token',origin='https://game.example';
 const backend=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({url:req.url,identity:req.headers['x-zone-identity'],auth:req.headers.authorization,origin:req.headers.origin}));});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const server=await createGateway({root,token,origin,backendPort:backend.address().port,assetOrigin:'https://cdn.example',cdnRefreshMs:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,admin={Authorization:'Bearer '+token};
 try{
  assert.equal((await fetch(base+'/metrics')).status,403);assert.equal((await fetch(base+'/_deploy/publish',{method:'POST'})).status,403);
  assert.equal((await fetch(base+'/offer',{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
  const bytes=Buffer.from('<h1>Game</h1>'),hash=createHash('sha256').update(bytes).digest('hex'),path='/releases/'+hash+'/index.html';
  assert.equal((await fetch(base+'/_deploy/blobs/'+hash,{method:'PUT',headers:admin,body:'wrong'})).status,400);
  assert.equal((await fetch(base+'/_deploy/blobs/'+hash,{method:'PUT',headers:{...admin,'Content-Encoding':'gzip'},body:gzipSync(bytes)})).status,201);
  assert.equal((await fetch(base+path)).status,404);
  const chunk='/packs/'+hash+'/chunks/'+hash+'.bin';
  const entry=path+'?stream=/packs/'+hash+'/pack.json&slot=public';
  const manifest={format:1,entry,files:{[path]:{sha256:hash,size:bytes.length},[chunk]:{sha256:hash,size:bytes.length}}};
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(manifest)})).status,200);
  const home=await fetch(base+'/',{redirect:'manual'});
  assert.equal(home.status,200);
  assert.equal(home.url,base+'/');
  assert.equal(home.headers.get('cache-control'),'no-store');
  assert.equal(home.headers.get('cross-origin-embedder-policy'),'require-corp');
  assert.ok((await home.text()).includes('src="'+entry.replace('&','&amp;')+'"'));
  const head=await fetch(base+'/',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.headers.get('content-length'),home.headers.get('content-length'));
  assert.equal(await head.text(),'');
  assert.equal((await fetch(base+chunk,{redirect:'manual'})).status,200);
  await writeFile(root+'/cdn-ready.json',JSON.stringify([hash]));
  const redirect=await fetch(base+chunk,{redirect:'manual'});assert.equal(redirect.status,307);assert.equal(redirect.headers.get('location'),'https://cdn.example/chunks/'+hash+'.bin');
  const asset=await fetch(base+path);assert.equal(await asset.text(),bytes.toString());assert.equal(asset.headers.get('cross-origin-embedder-policy'),'require-corp');assert.match(asset.headers.get('cache-control'),/immutable/);
  assert.equal((await fetch(base+path,{headers:{'If-None-Match':'"'+hash+'"'}})).status,304);
  const identity=await (await fetch(base+'/identity/entities?after=abc&generation=2',{headers:{'X-Zone-Identity':'player-secret'}})).json();assert.deepEqual(identity,{url:'/identity/entities?after=abc&generation=2',identity:'player-secret',auth:'Bearer '+token,origin});
  const chunkBytes=Buffer.from('bulk game chunk'),chunkHash=createHash('sha256').update(chunkBytes).digest('hex'),chunkPath='/packs/'+hash+'/chunks/'+chunkHash+'.bin';
  await writeFile(root+'/blobs/'+chunkHash,chunkBytes);
  manifest.files[chunkPath]={sha256:chunkHash,size:chunkBytes.length};
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(manifest)})).status,200);
  await writeFile(root+'/cdn-ready.json',JSON.stringify([hash,chunkHash]));await rm(root+'/blobs/'+chunkHash);
  const offloaded=await fetch(base+'/_deploy/blobs/'+chunkHash,{method:'HEAD',headers:admin});assert.equal(offloaded.status,200);assert.equal(Number(offloaded.headers.get('content-length')),chunkBytes.length);
  assert.equal((await fetch(base+chunkPath,{redirect:'manual'})).status,307);
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(manifest)})).status,200);
  const spPath='/releases/'+hash+'/singleplayer.html',sp={format:1,mode:'singleplayer',entry:spPath,files:{[spPath]:{sha256:hash,size:bytes.length}}};
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(sp)})).status,200);
  assert.equal((await fetch(base+'/singleplayer/',{redirect:'manual'})).status,404);
  assert.ok((await (await fetch(base+'/')).text()).includes('src="'+entry.replace('&','&amp;')+'"'));
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(manifest)})).status,200);
  for(const route of ['/singleplayer','/singleplayer/','/multiplayer','/multiplayer/']){
   for(const method of ['GET','HEAD'])assert.equal((await fetch(base+route,{method,redirect:'manual'})).status,404);
  }
  assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify({...sp,mode:'other'})})).status,400);
  manifest.files[path].size++;assert.equal((await fetch(base+'/_deploy/publish',{method:'POST',headers:admin,body:JSON.stringify(manifest)})).status,400);
  assert.equal((await fetch(base+path)).status,200);assert.equal((await fetch(base+'/server.sqlite')).status,404);
 }finally{server.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>backend.close(r))]);await rm(root,{recursive:true,force:true});}
});
