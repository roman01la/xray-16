import {createServer,request} from 'node:http';
import {request as secureRequest} from 'node:https';
import {backendUrl,localRequestAllowed,backendHeaders,backendPath} from './preview-backend.mjs';
import {stat,readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
// Local development only. Pair with Rust ZONE_ORIGIN=http://localhost:8086.
if(!process.argv[2])throw Error('Usage: serve-preview.mjs STAGED_PARENT');
const previewPort=Number(process.env.ZONE_PREVIEW_PORT||8086),serverPort=Number(process.env.ZONE_SERVER_PORT||8087);
if(![previewPort,serverPort].every(p=>Number.isInteger(p)&&p>0&&p<=65535))throw Error('Invalid preview/server port');
const backend=backendUrl(process.env.ZONE_SERVER_URL||`http://127.0.0.1:${serverPort}`);
const tokenFile=process.env.ZONE_SERVER_TOKEN_FILE;
if(tokenFile&&((await stat(tokenFile)).mode&0o077))throw Error('Preview token file must be private (0600)');
const token=tokenFile?(await readFile(tokenFile,'utf8')).trim():'';
if(token&&(!/^[\x21-\x7e]{1,256}$/.test(token)))throw Error('Invalid preview token');
const root=resolve(process.argv[2]),mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
createServer(async(req,res)=>{
 if(!localRequestAllowed(req.headers,previewPort)){res.writeHead(403).end();return;}
 let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
 if(path.startsWith('/identity/')||path==='/offer'||path==='/metrics'||path==='/world.json'||path==='/health'){
  const proxy=(backend.protocol==='https:'?secureRequest:request)(new URL(backendPath(req.url),backend),{method:req.method,headers:process.env.ZONE_SERVER_URL?backendHeaders(req.headers,backend,token):req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
  proxy.on('error',()=>res.writeHead(502).end());req.pipe(proxy);return;
 }
 let file=resolve(root,'.'+path);if(!file.startsWith(root+'/')||req.method!=='GET'){res.writeHead(403).end();return;}
 try {if((await stat(file)).isDirectory())file=resolve(file,'index.html');const data=await readFile(file);res.writeHead(200,{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store','Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404).end(path);}
}).listen(previewPort,'127.0.0.1',()=>console.log(`http://localhost:${previewPort}/engine-preview/?stream=/pack/pack.json`));
