// Local-only gateway to a remote acceptance server. No credentials reach JS assets.
export function backendUrl(value){
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid preview backend URL');
 if(url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Remote preview backend requires HTTPS');
 return url;
}
export function localRequestAllowed(headers,port){
 const hosts=[`localhost:${port}`,`127.0.0.1:${port}`];
 return hosts.includes(headers.host)&&(!headers.origin||hosts.some(host=>headers.origin===`http://${host}`));
}
export function backendHeaders(headers,backend,token){
 return {...headers,host:backend.host,origin:backend.origin,...(token?{authorization:`Bearer ${token}`}:{})};
}
export function backendPath(value){const url=new URL(value,'http://localhost');return url.pathname+url.search;}
