// Local immutable-release server with original, uncompressed pack sources.
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve,join,extname,sep} from 'node:path';
const {values}=parseArgs({options:{assets:{type:'string'},publication:{type:'string',multiple:true,default:[]},port:{type:'string',default:'0'}}});
if(!values.assets)throw Error('Supply --assets DIRECTORY and --publication DIRECTORY for each game pack.');
const root=resolve(values.assets),chunks=new Map();
for(const directory of values.publication){
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const sources=JSON.parse(await readFile(join(directory,'sources.json'),'utf8'));
  for(const [url,item] of Object.entries(manifest.files))chunks.set(url,sources[item.sha256].path);
}
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.webp':'image/webp','.png':'image/png','.ico':'image/x-icon'};
const server=createServer(async(request,response)=>{
  response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  response.setHeader('Cross-Origin-Resource-Policy','same-origin');response.setHeader('Cache-Control','no-store');
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405).end();return;}
  try{
    const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    let file=chunks.get(path);
    if(!file){file=resolve(root,'.'+path);if(file!==root&&!file.startsWith(root+sep)){response.writeHead(403).end();return;}}
    let info=await stat(file);if(info.isDirectory()){file=join(file,'index.html');info=await stat(file);}
    response.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Content-Length':info.size});
    if(request.method==='HEAD')response.end();else createReadStream(file).on('error',()=>response.destroy()).pipe(response);
  }catch{response.writeHead(404).end();}
});
server.listen(Number(values.port),'127.0.0.1',()=>console.log(JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`})));
