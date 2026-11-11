import {createServer, request} from 'node:http';
import {createReadStream, createWriteStream} from 'node:fs';
import {access,mkdir,readFile,writeFile,stat,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {createGunzip} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {startAnalytics} from './analytics-store.mjs';
import {analyticsDashboard,validateAnalyticsEvent} from './analytics-http.mjs';
const HASH=/^[a-f0-9]{64}$/,PATH=/^\/(releases|packs)\/[a-f0-9]{64}\/[a-zA-Z0-9_./#@+ -]+$/;
const mime=p=>({html:'text/html; charset=utf-8',js:'text/javascript',mjs:'text/javascript',json:'application/json',wasm:'application/wasm',css:'text/css',ico:'image/x-icon',webp:'image/webp'})[p.split('.').at(-1)]||'application/octet-stream';
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
function safePath(p){return PATH.test(p)&&!p.slice(1).split('/').some(x=>x==='..'||x==='.'||!x);}
async function body(req,max){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>max)throw Object.assign(Error('Request too large'),{status:413});parts.push(part);}return Buffer.concat(parts);}
export async function createGateway({root,token,origin,backendPort=8082,assetOrigin=process.env.ZONE_ASSET_ORIGIN,cdnRefreshMs=5000,analyticsPassword=process.env.ZONE_ANALYTICS_PASSWORD}){
 if(!token||new URL(origin).origin!==origin)throw Error('Gateway requires token and canonical origin');
 if(assetOrigin&&(new URL(assetOrigin).protocol!=='https:'||new URL(assetOrigin).origin!==assetOrigin))throw Error('CDN origin must be HTTPS');
 await mkdir(root+'/blobs',{recursive:true});await mkdir(root+'/manifests',{recursive:true});
 const analytics=analyticsPassword?startAnalytics(join(root,'analytics.sqlite')):null;
 let active=null;try{active=JSON.parse(await readFile(root+'/active.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let cdnHashes=new Set(),nextCdnRead=0;
 async function cdnReady(hash){
  if(Date.now()>=nextCdnRead){nextCdnRead=Date.now()+cdnRefreshMs;try{const hashes=JSON.parse(await readFile(root+'/cdn-ready.json','utf8'));if(Array.isArray(hashes)&&hashes.length<=10000&&hashes.every(h=>HASH.test(h)))cdnHashes=new Set(hashes);}catch{}}
  return cdnHashes.has(hash);
 }
 async function storedSize(hash){
  try{return (await stat(root+'/blobs/'+hash)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(assetOrigin&&await cdnReady(hash)){
   const item=Object.entries(active?.files||{}).find(([p,v])=>p.startsWith('/packs/')&&p.includes('/chunks/')&&v.sha256===hash);
   if(item)return item[1].size;
  }
  throw Error('Missing blob');
 }
 const limits=new Map();let uploads=0;
 function limited(ip,kind,max,window){const key=ip+':'+kind,now=Date.now();let item=limits.get(key);if(!item||now-item.start>=window){if(limits.size>=10000){for(const [k,v] of limits)if(now-v.start>3600000)limits.delete(k);if(limits.size>=10000)return true;}item={start:now,count:0};limits.set(key,item);}return ++item.count>max;}
 const server=createServer(async(req,res)=>{
  const headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store'};
  const reply=(status,data='')=>{if(!res.headersSent)res.writeHead(status,headers);res.end(data);};
  try{
   const url=new URL(req.url,'http://local'),path=url.pathname,admin=equal(req.headers.authorization,'Bearer '+token);
   if(path==='/analytics'||path==='/analytics/'||path==='/analytics/event'){
    if(!analytics)return reply(404);
    const ip=String(req.headers['fly-client-ip']||req.socket.remoteAddress);
    if(path==='/analytics/event'){
     if(req.method!=='POST')return reply(405);
     if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return reply(403);
     if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reply(415);
     if(limited(ip,'analytics-event',600,60000)||limited('*','analytics-event',1800,60000))return reply(429);
     const raw=await body(req,8192);
     const parsed=JSON.parse(raw);
     if(!['device','performance'].includes(parsed?.event)&&raw.length>1024)return reply(413);
     const event=validateAnalyticsEvent(parsed);
     if(!event)return reply(400);
     await analytics.request('record',event);
     return reply(204);
    }
    if(!['GET','HEAD'].includes(req.method))return reply(405);
    if(req.headers['sec-fetch-site']==='cross-site')return reply(403);
    headers['Referrer-Policy']='no-referrer';
    headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
    const credentials=/^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization||'');
    // Limit both individual and distributed guessing before comparing passwords.
    if(credentials&&(limited(ip,'analytics-auth',8,900000)||limited('*','analytics-auth',60,900000))){
     headers['Retry-After']='900';
     return reply(429,'Too many analytics requests');
    }
    if(!credentials||!equal(Buffer.from(credentials[1],'base64').toString('utf8'),'analytics:'+analyticsPassword)){
     headers['WWW-Authenticate']='Basic realm="S.T.A.L.K.E.R. Analytics", charset="UTF-8"';
     return reply(401,'Authentication required');
    }
    const page=analyticsDashboard(await analytics.request('summary'));
    headers['Content-Type']='text/html; charset=utf-8';
    headers['Content-Length']=Buffer.byteLength(page);
    return reply(200,req.method==='HEAD'?undefined:page);
   }
   if(path.startsWith('/_deploy/')){
    if(!admin)return reply(403);
    const hash=path.slice('/_deploy/blobs/'.length);
    if(path.startsWith('/_deploy/blobs/')&&HASH.test(hash)){
     const file=root+'/blobs/'+hash;
     if(req.method==='HEAD'){try{const size=await storedSize(hash);res.writeHead(200,{...headers,'Content-Length':size});res.end();}catch{reply(404);}return;}
     if(req.method!=='PUT')return reply(405);
     if(uploads>=8)return reply(429);uploads++;const tmp=file+'.'+randomUUID()+'.tmp';
     try{
      const digest=createHash('sha256');let bytes=0;
      const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>64*1024*1024)return done(Object.assign(Error('Blob too large'),{status:413}));digest.update(chunk);done(null,chunk);}});
      if(req.headers['content-encoding']&&!['gzip','identity'].includes(req.headers['content-encoding']))throw Object.assign(Error('Unsupported encoding'),{status:415});
      let incoming=0;const bound=new Transform({transform(chunk,encoding,done){incoming+=chunk.length;done(incoming>64*1024*1024?Object.assign(Error('Upload too large'),{status:413}):null,chunk);}});
      await pipeline(req,bound,...(req.headers['content-encoding']==='gzip'?[createGunzip()]:[]),meter,createWriteStream(tmp,{flags:'wx',mode:0o600}));
      if(digest.digest('hex')!==hash)throw Object.assign(Error('Hash mismatch'),{status:400});
      await rename(tmp,file);reply(201);
     }finally{uploads--;await rm(tmp,{force:true});}return;
    }
    if(path==='/_deploy/publish'&&req.method==='POST'){
     const raw=await body(req,2*1024*1024),manifest=JSON.parse(raw);
     if(manifest.format!==1||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||Object.keys(manifest.files).length>10000)throw Error('Invalid manifest');
     const mode=manifest.mode||'multiplayer';if(!['singleplayer','multiplayer'].includes(mode))throw Error('Invalid mode');
     const entry=new URL(manifest.entry,'http://local');
     if(entry.origin!=='http://local'||!safePath(entry.pathname)||!manifest.files[entry.pathname])throw Error('Invalid entry');
     for(const [name,value] of Object.entries(manifest.files)){
      if(!safePath(name)||!HASH.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<0)throw Error('Invalid file');
      if((await storedSize(value.sha256))!==value.size)throw Error('Missing blob');
      if(!name.startsWith('/packs/')||!name.includes('/chunks/'))await stat(root+'/blobs/'+value.sha256);
      if(active?.files[name]&&active.files[name].sha256!==value.sha256)throw Error('Immutable URL changed');
     }
     // Publish each game mode independently; root remains the multiplayer entry.
     manifest.entries={...active?.entries,...(active?.entry&&!active?.entries?.multiplayer?{multiplayer:active.entry}:{}),[mode]:manifest.entry};
     manifest.entry=manifest.entries.multiplayer||manifest.entry;
     // Retain prior release URLs for clients already running and rollback.
     manifest.files={...active?.files,...manifest.files};
     const serialized=JSON.stringify(manifest),id=createHash('sha256').update(serialized).digest('hex');
     await writeFile(root+'/manifests/'+id+'.json',serialized,{mode:0o600});
     const tmp=root+'/active.'+randomUUID()+'.tmp';await writeFile(tmp,serialized,{mode:0o600});await rename(tmp,root+'/active.json');active=manifest;
     headers['Content-Type']='application/json';return reply(200,JSON.stringify({release:id,files:Object.keys(manifest.files).length}));
    }
    return reply(404);
   }
   const publicAPI=new Set(['/health','/world.json','/offer','/identity/register','/identity/resume','/identity/state','/identity/entities','/identity/transfer']);
   if(path==='/metrics'&&!admin)return reply(403);
   if(publicAPI.has(path)||path==='/metrics'){
    if(req.headers.origin&&req.headers.origin!==origin)return reply(403);
    if(req.headers['sec-fetch-site']==='cross-site')return reply(403);
    const write=req.method==='POST';if(!['GET','POST','HEAD'].includes(req.method))return reply(405);
    if(write&&!admin&&req.headers.origin!==origin)return reply(403);
    const ip=String(req.headers['fly-client-ip']||req.socket.remoteAddress);
    if(!admin&&path!=='/health'&&limited(ip,'api',600,60000))return reply(429);
    if(!admin&&path==='/identity/register'&&limited(ip,'register',12,3600000))return reply(429);
    if(!admin&&path==='/offer'&&limited(ip,'offer',30,60000))return reply(429);
    const payload=write?await body(req,32*1024):null;
    const upstream=request({host:'127.0.0.1',port:backendPort,path:url.pathname+url.search,method:req.method,headers:{origin,authorization:'Bearer '+token,...(req.headers['x-zone-identity']?{'x-zone-identity':req.headers['x-zone-identity']}:{}),...(write?{'content-type':'application/json','content-length':payload.length}:{})}},response=>{
     res.writeHead(response.statusCode,{...response.headers,...headers});response.pipe(res);
    });upstream.setTimeout(15000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)reply(502);else res.destroy();});upstream.end(payload);return;
   }
   if(!['GET','HEAD'].includes(req.method))return reply(405);
   if(path==='/'){
    if(!active)return reply(503,'Preparing game deployment');
    // Keep the document URL stable and the game frame inside its release's worker scope.
    const source=active.entry.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
    const icon=new URL('favicon.ico',new URL(active.entry,'http://local')).pathname;
    const iconLink=active.files[icon]?`<link rel="icon" href="${icon}" type="image/x-icon">`:'';
    const html=`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>S.T.A.L.K.E.R. — Call of Pripyat</title>
${iconLink}
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style>
<iframe src="${source}" title="S.T.A.L.K.E.R.: Call of Pripyat" allowfullscreen></iframe>
</html>`;
    headers['Content-Type']='text/html; charset=utf-8';
    headers['Content-Length']=Buffer.byteLength(html);
    return reply(200,req.method==='HEAD'?undefined:html);
   }
   const decoded=decodeURIComponent(path),file=active?.files[decoded];if(!file)return reply(404);
   if(assetOrigin&&/^\/packs\/[a-f0-9]{64}\/chunks\/[a-f0-9]{64}\.bin$/.test(decoded)&&await cdnReady(file.sha256)){res.writeHead(307,{...headers,'Cache-Control':'public, max-age=300',Location:assetOrigin+'/chunks/'+file.sha256+'.bin.gz'});res.end();return;}
   headers['Cache-Control']='public, max-age=31536000, immutable';headers['ETag']='"'+file.sha256+'"';headers['Content-Type']=mime(decoded);
   if(req.headers['if-none-match']===headers.ETag)return reply(304);
   headers['Content-Length']=file.size;res.writeHead(200,headers);
   if(req.method==='HEAD'){res.end();return;}
   createReadStream(root+'/blobs/'+file.sha256).on('error',()=>res.destroy()).pipe(res);
  }catch(error){if(!res.headersSent)reply(error.status||400,'Request failed');else res.destroy();}
 });
 server.requestTimeout=1800000;server.headersTimeout=15000;server.maxRequestsPerSocket=1000;
 if(analytics)server.once('close',()=>{void analytics.close();});
 return server;
}
async function nativeAlifeHosts(root){
 const campaignPath=process.env.ZONE_CAMPAIGN_CONFIG;
 if(!campaignPath){
  const socket=process.env.ZONE_ALIFE_INTEREST_SOCKET;
  if(!socket)throw Error('Native A-Life requires a private socket');
  return [{root,socket}];
 }
 const campaign=JSON.parse(await readFile(campaignPath,'utf8'));
 const hosts=[];
 for(const region of campaign.regions){
  if(!region.alifeSocket)continue;
  const {level}=JSON.parse(await readFile(resolve(dirname(campaignPath),region.collision),'utf8'));
  if(typeof level!=='string'||!/^[a-z0-9_]+$/.test(level)||hosts.some(host=>host.level===level)){
   throw Error('Native A-Life requires a separate game directory for each map');
  }
  hosts.push({root:join(root,level),socket:region.alifeSocket,level,anchor:region.spawn.join(' ')});
 }
 return hosts;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=await createGateway({root:process.env.ZONE_WEB_ROOT||'/data/web',token:process.env.ZONE_DEV_TOKEN,origin:process.env.ZONE_ORIGIN});
 const nativeRoot=process.env.ZONE_NATIVE_ALIFE_ROOT;
 const nativeBin=process.env.ZONE_NATIVE_ALIFE_BIN;
 let nativeHosts=[];
 if(nativeRoot){
  if(!isAbsolute(nativeRoot)||!nativeBin||!isAbsolute(nativeBin))throw Error('Native A-Life requires absolute game and binary paths');
  nativeHosts=await nativeAlifeHosts(nativeRoot);
  await Promise.all(nativeHosts.map(host=>access(join(host.root,'archives-ready'))));
 }
 const children=new Set();
 let exitCode;
 const shutdown=(code=0)=>{
  if(exitCode!==undefined)return;
  exitCode=code;
  server.close();
  for(const child of children)child.kill('SIGTERM');
  if(!children.size)process.exit(exitCode);
  setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(1);},23000).unref();
 };
 function supervise(command,args,options,restart=false){
  const child=spawn(command,args,{...options,stdio:'inherit'});
  children.add(child);
  child.once('close',(code,signal)=>{
   children.delete(child);
   if(exitCode===undefined){
    console.error(`Service ${command} exited (${signal||code})`);
    if(restart){
     setTimeout(()=>{if(exitCode===undefined)supervise(command,args,options,true);},5000).unref();
     return;
    }
    shutdown(1);
   }
   if(!children.size)process.exit(exitCode);
  });
  child.on('error',error=>console.error(error.message));
 }
 const rustEnv={...process.env};
 delete rustEnv.ZONE_ANALYTICS_PASSWORD;
 supervise('/usr/local/bin/zone-server',[],{env:rustEnv});
 for(const host of nativeHosts){
  const env={PATH:process.env.PATH,LD_LIBRARY_PATH:dirname(nativeBin),ZONE_ALIFE_INTEREST_SOCKET:host.socket,
   SDL_VIDEODRIVER:'offscreen',SDL_AUDIODRIVER:'dummy',ALSOFT_DRIVERS:'null',LIBGL_ALWAYS_SOFTWARE:'1',LP_NUM_THREADS:'2'};
  if(host.level){
   env.ZONE_ALIFE_LEVEL=host.level;
   env.ZONE_ALIFE_ANCHOR=host.anchor;
  }
  supervise(nativeBin,['-cop','-r3','-nointro','-nogameintro','-noprefetch','-zone-alife-headless','-silent_error_mode',
   '-start','server(all/single/alife/new)','client(localhost)'],{
   cwd:host.root,env,
  },true);
 }
 process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
 server.listen(8080,'0.0.0.0',()=>console.log('Public game gateway listening on 8080'));
}
