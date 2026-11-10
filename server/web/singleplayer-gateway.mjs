// Single-player hosting: static releases/CDN routing and SQLite analytics only.
// Importing the shared gateway does not start Rust or native A-Life supervisors.
import {createGateway} from './gateway.mjs';
const server=await createGateway({root:process.env.ZONE_WEB_ROOT||'/data/web',token:process.env.ZONE_DEV_TOKEN,origin:process.env.ZONE_ORIGIN});
const handler=server.listeners('request')[0];
server.removeListener('request',handler);
server.on('request',(req,res)=>{
 const path=new URL(req.url,'http://local').pathname;
 if(path==='/health'){
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({status:'ok',mode:'singleplayer'}));return;
 }
 if(['/world.json','/offer','/metrics'].includes(path)||path.startsWith('/identity/')){
  res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({error:'Multiplayer is not released'}));return;
 }
 handler(req,res);
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
 server.close(()=>process.exit(0));
 setTimeout(()=>process.exit(1),20000).unref();
});
server.listen(8080,'0.0.0.0',()=>console.log('Single-player gateway listening on 8080'));
