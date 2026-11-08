// Read-only coarse archive chunks. Fetches run on WasmFS's dedicated proxy worker.
// CacheStorage persists verified chunks; the hot RAM cache has a hard byte budget.
export const CHUNK_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export const GAME_CHUNK_CACHE = 'xray-game-chunks-v1';
// Synthetic CacheStorage key only: never requested from the server.
export const chunkCacheKey=(url,hash)=>new URL('/.xray-cache/game-chunks/'+hash+'.bin',url).href;
export function validateDescriptor(d) {
  if (d?.format !== 'xray-archive-v1' || !Number.isSafeInteger(d.size) || d.size < 1 ||
      d.chunkBytes !== CHUNK_BYTES || !Array.isArray(d.chunks) ||
      d.chunks.length !== Math.ceil(d.size / CHUNK_BYTES) || !d.chunks.every(h=>HASH.test(h)))
    throw Error('Invalid archive descriptor');
  if(d.bootstrap!==undefined && (!Array.isArray(d.bootstrap) || d.bootstrap.length>10000 ||
      d.bootstrap.some(s=>!Number.isSafeInteger(s.offset)||s.offset<0||!Number.isSafeInteger(s.size)||s.size<1||s.size>32*1024*1024||s.offset+s.size>d.size||!HASH.test(s.hash)||
        ((s.chunkSize!==undefined || s.chunkOffset!==undefined) && (!Number.isSafeInteger(s.chunkSize)||s.chunkSize<1||s.chunkSize>32*1024*1024||!Number.isSafeInteger(s.chunkOffset)||s.chunkOffset<0||s.chunkOffset+s.size>s.chunkSize)))))throw Error('Invalid archive index');
  return d;
}
export class ChunkReader {
  constructor({onProgress=()=>{},fetcher=(...args)=>fetch(...args), cacheStorage=globalThis.caches, budget=64*1024*1024, digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')}={}) {
    this.fetcher=fetcher;this.cacheStorage=cacheStorage;this.budget=budget;this.digest=digest;
    this.descriptors=new Map();this.hot=new Map();this.pending=new Map();this.bytes=0;
    this.stats={downloadedBytes:0,networkChunks:0,cachedChunks:0,cachedBytes:0};
    this.onProgress=onProgress;this.transfers=new Map();this.lastReport=0;
  }
  report(force=false,error=null) {
    const now=Date.now();if(!force&&now-this.lastReport<150)return;
    this.lastReport=now;
    let received=0,total=0;for(const transfer of this.transfers.values()){received+=transfer.received;total+=transfer.total;}
    try{this.onProgress({...this.stats,active:this.transfers.size,received,total,error});}catch{}
  }
  async descriptor(url) {
    if(!this.descriptors.has(url)) this.descriptors.set(url,(async()=>{
      const response=await this.fetcher(url+'.json');
      if(!response.ok)throw Error('Archive metadata unavailable (HTTP '+response.status+'): '+new URL(url+'.json').pathname);
      return validateDescriptor(await response.json());
    })().catch(e=>{this.descriptors.delete(url);throw e;}));
    return this.descriptors.get(url);
  }
  async chunk(url,hash,size) {
    if(!HASH.test(hash)||!Number.isSafeInteger(size)||size<1||size>32*1024*1024)throw Error('Invalid chunk identity');
    const networkURL=new URL('../chunks/'+hash+'.bin',url).href;
    const key=chunkCacheKey(url,hash);
    if(this.hot.has(key)){
      const bytes=this.hot.get(key);if(bytes.length!==size)throw Error('Game chunk size conflict');
      this.hot.delete(key);this.hot.set(key,bytes);return bytes;
    }
    if(this.pending.has(key)){
      const bytes=await this.pending.get(key);if(bytes.length!==size)throw Error('Game chunk size conflict');return bytes;
    }
    const task=(async()=>{
      let cache;try{cache=await this.cacheStorage?.open(GAME_CHUNK_CACHE);}catch{}
      let bytes;
      if(cache){
        const cached=async candidate=>{
          try {
            const hit=await cache.match(candidate);if(!hit)return null;
            const value=new Uint8Array(await hit.arrayBuffer());
            if(value.length!==size || await this.digest(value)!==hash){await cache.delete(candidate).catch(()=>{});return null;}
            return value;
          }catch{return null;}
        };
        bytes=await cached(key);
        if(!bytes){
          // Index legacy URL keys once, lazily. No game bytes are fetched while
          // building this migration index; each candidate is still verified.
          this.legacyKeys ||= Promise.resolve().then(async()=>{
            const index=new Map();
            for(const r of await cache.keys?.()||[]){
              const candidate=new URL(r.url),match=candidate.pathname.match(/\/chunks\/([a-f0-9]{64})\.bin$/);
              if(match){const id=candidate.origin+'/'+match[1];if(!index.has(id))index.set(id,[]);index.get(id).push(r.url);}
            }
            return index;
          }).catch(()=>new Map());
          const legacy=(await this.legacyKeys).get(new URL(url).origin+'/'+hash)||[];
          for(const candidate of new Set([networkURL,...legacy])){
            bytes=await cached(candidate);if(!bytes)continue;
            await cache.put(key,new Response(bytes)).catch(()=>{});break;
          }
        }
        if(bytes){this.stats.cachedChunks++;this.stats.cachedBytes+=bytes.length;this.report();}
      }
      if(!bytes){
        const transfer={received:0,total:size};this.transfers.set(key,transfer);this.report(true);
        try {
          const response=await this.fetcher(networkURL);
          if(!response.ok)throw Error('Game chunk unavailable (HTTP '+response.status+'): '+new URL(response.url||networkURL).pathname);
          const length=response.headers.get('Content-Length');if(length!==null && Number(length)!==size)throw Error('Game chunk length mismatch');
          if(response.body?.getReader){
            bytes=new Uint8Array(size);const reader=response.body.getReader();
            try{while(true){const {done,value}=await reader.read();if(done)break;
              if(transfer.received+value.length>size)throw Error('Game chunk length mismatch');
              bytes.set(value,transfer.received);transfer.received+=value.length;this.report();
            }}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
          }else{bytes=new Uint8Array(await response.arrayBuffer());transfer.received=bytes.length;}
          if(transfer.received!==size || await this.digest(bytes)!==hash)throw Error('Game chunk integrity mismatch');
          this.stats.networkChunks++;this.stats.downloadedBytes+=bytes.length;
        }catch(error){this.report(true,error.message);throw error;}
        finally{this.transfers.delete(key);this.report(true);}
        try{await cache?.put(key,new Response(bytes));}catch{}
      }
      if(bytes.length<=this.budget){
        while(this.bytes+bytes.length>this.budget){const oldest=this.hot.keys().next().value;this.bytes-=this.hot.get(oldest).length;this.hot.delete(oldest);}
        this.hot.set(key,bytes);this.bytes+=bytes.length;
      }
      return bytes;
    })();
    this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
  }
  async read(url,offset,length,write) {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0)throw Error('Invalid archive range');
    const d=await this.descriptor(url);length=Math.max(0,Math.min(length,d.size-offset));
    const index=(d.bootstrap||[]).find(s=>offset>=s.offset && offset+length<=s.offset+s.size);
    if(length && index){const bytes=await this.chunk(url,index.hash,index.chunkSize??index.size);const start=(index.chunkOffset??0)+offset-index.offset;write(bytes.subarray(start,start+length),0);return length;}
    for(let at=offset;at<offset+length;){
      const index=Math.floor(at/d.chunkBytes),start=index*d.chunkBytes;
      const bytes=await this.chunk(url,d.chunks[index],Math.min(d.chunkBytes,d.size-start));
      const count=Math.min(bytes.length-(at-start),offset+length-at);
      write(bytes.subarray(at-start,at-start+count),at-offset);at+=count;
    }
    return length;
  }
}
