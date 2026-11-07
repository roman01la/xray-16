// Read-only coarse archive chunks. Fetches run on WasmFS's dedicated proxy worker.
// CacheStorage persists verified chunks; the hot RAM cache has a hard byte budget.
export const CHUNK_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
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
  constructor({fetcher=(...args)=>fetch(...args), cacheStorage=globalThis.caches, budget=64*1024*1024, digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')}={}) {
    this.fetcher=fetcher;this.cacheStorage=cacheStorage;this.budget=budget;this.digest=digest;
    this.descriptors=new Map();this.hot=new Map();this.pending=new Map();this.bytes=0;
    this.stats={downloadedBytes:0,networkChunks:0,cachedChunks:0};
  }
  async descriptor(url) {
    if(!this.descriptors.has(url)) this.descriptors.set(url,(async()=>{
      const response=await this.fetcher(url+'.json');
      if(!response.ok)throw Error('Archive metadata unavailable: '+response.status);
      return validateDescriptor(await response.json());
    })().catch(e=>{this.descriptors.delete(url);throw e;}));
    return this.descriptors.get(url);
  }
  async chunk(url,hash,size) {
    // Chunks live next to pack.json, two levels above resources/foo.db.json.
    const key=new URL('../chunks/'+hash+'.bin',url).href;
    if(this.hot.has(key)){const bytes=this.hot.get(key);this.hot.delete(key);this.hot.set(key,bytes);return bytes;}
    if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      let cache;try{cache=await this.cacheStorage?.open('xray-game-chunks-v1');}catch{}
      let bytes, cached;try{cached=await cache?.match(key);}catch{}
      if(cached){bytes=new Uint8Array(await cached.arrayBuffer());if(bytes.length!==size || await this.digest(bytes)!==hash){await cache.delete(key);bytes=null;}else this.stats.cachedChunks++;}
      if(!bytes){
        const response=await this.fetcher(key);
        if(!response.ok)throw Error('Game chunk unavailable: '+response.status);
        // Reject oversized payloads before allocating when the host supplies a length.
        const length=response.headers.get('Content-Length');if(length!==null && Number(length)!==size)throw Error('Game chunk length mismatch');
        bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length!==size || await this.digest(bytes)!==hash)throw Error('Game chunk integrity mismatch');
        this.stats.networkChunks++;this.stats.downloadedBytes+=bytes.length;
        try{await cache?.put(key,new Response(bytes));}catch{} // quota failure must not stop play
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
