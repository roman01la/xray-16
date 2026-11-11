import {analyticsDashboard,validateAnalyticsEvent} from '../web/analytics-http.mjs';
import {record,summary,prune} from './analytics-d1.mjs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'};
const response=(status,text='',extra={})=>new Response(text,{status,headers:{...headers,...extra}});
async function equalSecret(a,b){
  const encode=new TextEncoder();
  const [x,y]=await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',encode.encode(s))));
  let delta=0;const left=new Uint8Array(x),right=new Uint8Array(y);
  for(let i=0;i<left.length;i++)delta|=left[i]^right[i];
  return delta===0;
}
async function limited(binding,key){return binding&&!(await binding.limit({key})).success;}
async function readBody(request,max){
  const reader=request.body?.getReader();if(!reader)return '';
  const parts=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Object.assign(Error('Body too large'),{status:413});}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return new TextDecoder().decode(bytes);
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    try{
      if(path==='/health')return response(200,JSON.stringify({status:'ok',mode:'singleplayer',hosting:'cloudflare'}),{'Content-Type':'application/json'});
      if(['/world.json','/offer','/metrics'].includes(path)||path.startsWith('/identity/'))return response(503,'Multiplayer is not released');
      if(path!=='/analytics'&&path!=='/analytics/'&&path!=='/analytics/event')return response(404,'Not found');
      const ip=request.headers.get('CF-Connecting-IP')||'unknown';
      if(path==='/analytics/event'){
        if(request.method!=='POST')return response(405);
        if(request.headers.get('Origin')!==env.ORIGIN||request.headers.get('Sec-Fetch-Site')==='cross-site')return response(403);
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))return response(415);
        if(await limited(env.EVENT_LIMIT,ip)||await limited(env.EVENT_GLOBAL,'events'))return response(429);
        const raw=await readBody(request,8192);let value;try{value=JSON.parse(raw);}catch{return response(400);}
        if(!['device','performance'].includes(value?.event)&&new TextEncoder().encode(raw).length>1024)return response(413);
        const event=validateAnalyticsEvent(value);if(!event)return response(400);
        await record(env.DB,event);return response(204,null);
      }
      if(!['GET','HEAD'].includes(request.method))return response(405);
      if(request.headers.get('Sec-Fetch-Site')==='cross-site')return response(403);
      const auth=request.headers.get('Authorization')||'';
      if(auth&&(await limited(env.AUTH_LIMIT,ip)||await limited(env.AUTH_GLOBAL,'auth')))return response(429,'Too many requests',{'Retry-After':'60'});
      let credentials='';try{if(/^Basic /i.test(auth))credentials=atob(auth.slice(6));}catch{}
      if(!env.ANALYTICS_PASSWORD||!await equalSecret(credentials,'analytics:'+env.ANALYTICS_PASSWORD))return response(401,'Authentication required',{'WWW-Authenticate':'Basic realm="S.T.A.L.K.E.R. Analytics", charset="UTF-8"'});
      if(request.method==='HEAD')return response(200,null,{'Content-Type':'text/html; charset=utf-8'});
      const nonce = crypto.randomUUID();
      return response(200,analyticsDashboard(await summary(env.DB), nonce),{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'`});
    }catch(error){console.error('Request failed',error.status||500);return response(error.status||503,'Request failed');}
  },
  async scheduled(event,env,ctx){ctx.waitUntil(prune(env.DB));},
};
