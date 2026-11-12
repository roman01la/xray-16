import {analyticsDashboard,validateAnalyticsEvent} from '../web/analytics-http.mjs';
import {analyticsGames} from '../web/analytics-events.mjs';
import {record,summary,prune,tracks} from './analytics-d1.mjs';
import {crashEnvelope,sentryEndpoint} from './crash-sentry.mjs';
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
    const {pathname:path,searchParams}=new URL(request.url);
    try{
      if(path==='/health')return response(200,JSON.stringify({status:'ok',mode:'singleplayer',hosting:'cloudflare'}),{'Content-Type':'application/json'});
      if(path==='/crash-report'){
        if(request.method!=='POST')return response(405);
        if(request.headers.get('Origin')!==env.ORIGIN||request.headers.get('Sec-Fetch-Site')==='cross-site')return response(403);
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))return response(415);
        const endpoint=sentryEndpoint(env.SENTRY_DSN);
        if(!endpoint)return response(503);
        const ip=request.headers.get('CF-Connecting-IP')||'unknown';
        if(await limited(env.CRASH_LIMIT,ip)||await limited(env.CRASH_GLOBAL,'crashes'))return response(429);
        const raw=await readBody(request,24576);
        let report;try{report=JSON.parse(raw);}catch{return response(400);}
        const body=crashEnvelope(report,env.SENTRY_DSN);if(!body)return response(400);
        const result=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-sentry-envelope'},body});
        if(!result.ok)return response(result.status===429?429:502);
        return response(204,null);
      }
      if(!['/analytics','/analytics/','/analytics/event','/analytics/tracks'].includes(path))return response(404,'Not found');
      const ip=request.headers.get('CF-Connecting-IP')||'unknown';
      if(path==='/analytics/event'){
        if(request.method!=='POST')return response(405);
        if(request.headers.get('Origin')!==env.ORIGIN||request.headers.get('Sec-Fetch-Site')==='cross-site')return response(403);
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))return response(415);
        if(await limited(env.EVENT_LIMIT,ip)||await limited(env.EVENT_GLOBAL,'events'))return response(429);
        const raw=await readBody(request,8192);let value;try{value=JSON.parse(raw);}catch{return response(400);}
        if(!['device','performance','movement'].includes(value?.event)&&new TextEncoder().encode(raw).length>1024)return response(413);
        const event=validateAnalyticsEvent(value);if(!event)return response(400);
        await record(env.DB,event);return response(204,null);
      }
      if(!['GET','HEAD'].includes(request.method))return response(405);
      if(request.headers.get('Sec-Fetch-Site')==='cross-site')return response(403);
      const auth=request.headers.get('Authorization')||'';
      if(auth&&(await limited(env.AUTH_LIMIT,ip)||await limited(env.AUTH_GLOBAL,'auth')))return response(429,'Too many requests',{'Retry-After':'60'});
      let credentials='';try{if(/^Basic /i.test(auth))credentials=atob(auth.slice(6));}catch{}
      if(!env.ANALYTICS_PASSWORD||!await equalSecret(credentials,'analytics:'+env.ANALYTICS_PASSWORD))return response(401,'Authentication required',{'WWW-Authenticate':'Basic realm="S.T.A.L.K.E.R. Analytics", charset="UTF-8"'});
      const gameId=searchParams.get('game')??'cop';
      if(!analyticsGames.has(gameId))return response(400,'Unknown game');
      if(path==='/analytics/tracks') {
        const browserId=searchParams.get('browser'),sessionId=searchParams.get('session');
        const after=Number(searchParams.get('after')??0);
        const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
        if(browserId&&!uuid.test(browserId)||sessionId&&(!browserId||!uuid.test(sessionId))||!Number.isSafeInteger(after)||after<0)return response(400);
        return response(200,JSON.stringify(await tracks(env.DB,gameId,{browserId,sessionId,after})),{'Content-Type':'application/json'});
      }
      if(request.method==='HEAD')return response(200,null,{'Content-Type':'text/html; charset=utf-8'});
      const nonce = crypto.randomUUID();
      return response(200,analyticsDashboard(await summary(env.DB,Date.now(),gameId), nonce, gameId),{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'`});
    }catch(error){console.error('Request failed',error.status||500);return response(error.status||503,'Request failed');}
  },
  async scheduled(event,env,ctx){ctx.waitUntil(prune(env.DB));},
};
