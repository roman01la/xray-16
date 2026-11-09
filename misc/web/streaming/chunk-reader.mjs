// Read-only coarse archive chunks shared by the startup installer and WasmFS.
// CacheStorage persists verified chunks; installed reads use disk-backed Blob slices.
export const CHUNK_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export const GAME_CHUNK_CACHE = 'xray-game-chunks-v1';
const ARCHIVE_CACHE = 'xray-game-archives-v1';
const INSTALLED_BLOB_LIMIT = 64;
const BOOTSTRAP_MEMORY_LIMIT = 256 * 1024;
export function gameStorageError(error) {
  return new Error(error?.name === 'QuotaExceededError'
    ? 'There is not enough browser storage for the complete game. Free disk space or clear data from other sites, then retry.'
    : 'Local game storage is unavailable. Check your browser storage settings and retry.', {cause:error});
}
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
  constructor({onProgress=()=>{},fetcher=(...args)=>fetch(...args), cacheStorage=globalThis.caches, budget=64*1024*1024, mode='stream', digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')}={}) {
    this.fetcher=fetcher;this.cacheStorage=cacheStorage;this.budget=budget;this.digest=digest;this.mode=mode;
    this.descriptors=new Map();this.hot=new Map();this.pending=new Map();this.bytes=0;
    this.installedBlobs=new Map();
    this.stats={downloadedBytes:0,networkChunks:0,cachedChunks:0,cachedBytes:0};
    this.onProgress=onProgress;this.transfers=new Map();this.lastReport=0;
  }
  report(force=false,error=null) {
    const now=Date.now();if(!force&&now-this.lastReport<150)return;
    this.lastReport=now;
    let received=0,total=0;for(const transfer of this.transfers.values()){received+=transfer.received;total+=transfer.total;}
    try{this.onProgress({...this.stats,active:this.transfers.size,received,total,error,...this.installProgress});}catch{}
  }
  async storage(name) {
    try {
      const cache=await this.cacheStorage?.open(name);
      if(!cache && this.mode!=='stream')throw Error('CacheStorage is unavailable');
      return cache;
    } catch(error) {
      if(this.mode!=='stream')throw gameStorageError(error);
    }
  }
  async persist(cache,key,response) {
    try{await cache?.put(key,response);}
    catch(error){if(this.mode==='install')throw gameStorageError(error);}
  }
  async descriptor(url) {
    if(!this.descriptors.has(url)) this.descriptors.set(url,(async()=>{
      const metadata=url+'.json';
      if(this.mode==='installed') {
        const cache=await this.storage(ARCHIVE_CACHE), response=await cache.match(metadata);
        if(!response)throw Error('Installed archive metadata is missing. Reload to repair game data.');
        return validateDescriptor(await response.json());
      }
      const response=await this.fetcher(metadata);
      if(!response.ok)throw Error('Archive metadata unavailable (HTTP '+response.status+'): '+new URL(metadata).pathname);
      return validateDescriptor(await response.json());
    })().catch(e=>{this.descriptors.delete(url);throw e;}));
    return this.descriptors.get(url);
  }
  async install(archives) {
    if(this.mode!=='install')throw Error('The archive reader is not configured for installation');
    this.installProgress={phase:'install',checkedBytes:0,packBytes:0};
    this.report(true);
    const metadata=await this.storage(ARCHIVE_CACHE);
    await this.storage(GAME_CHUNK_CACHE);
    const descriptors=[],chunks=new Map();
    for(const {url,size} of archives) {
      const d=await this.descriptor(url);
      if(d.size!==size)throw Error('Archive size differs from the game pack manifest: '+new URL(url).pathname);
      descriptors.push({url,d});
      const add=(hash,size)=>{
        const existing=chunks.get(hash);
        if(existing && existing.size!==size)throw Error('Game pack chunk size conflict');
        if(!existing)chunks.set(hash,{url,hash,size});
      };
      d.chunks.forEach((hash,i)=>add(hash,Math.min(d.chunkBytes,d.size-i*d.chunkBytes)));
      for(const entry of d.bootstrap||[])add(entry.hash,entry.chunkSize??entry.size);
    }
    const remaining=chunks.values();
    for(const {size} of chunks.values())this.installProgress.packBytes+=size;
    this.report(true);
    let failure;
    await Promise.all(Array.from({length:4},async()=>{
      while(!failure) {
        const {done,value}=remaining.next();
        if(done)return;
        const {url,hash,size}=value;
        try {
          await this.chunk(url,hash,size);
          this.installProgress.checkedBytes+=size;
          this.report();
        } catch(error) {failure ||= error;}
      }
    }));
    if(failure)throw failure;
    // Publish the pinned metadata only after all its bytes are locally readable.
    for(const {url,d} of descriptors)await this.persist(metadata,url+'.json',Response.json(d));
    this.report(true);
  }
  async readChunkRange(url,hash,size,offset,length,bootstrap=false) {
    if(this.mode!=='installed'){
      const bytes=await this.chunk(url,hash,size);
      return bytes.subarray(offset,offset+length);
    }
    const key=chunkCacheKey(url,hash),missing='Installed game data is missing or damaged. Reload to repair it.';
    let entry=this.installedBlobs.get(key);
    if(!entry){
      this.installedCache ??= this.storage(GAME_CHUNK_CACHE);
      const blob=this.installedCache.then(async cache=>{
        const response=await cache.match(key);
        if(!response)throw Error(missing);
        return response.blob();
      });
      entry={blob};
    }
    this.installedBlobs.delete(key);
    this.installedBlobs.set(key,entry);
    if(this.installedBlobs.size>INSTALLED_BLOB_LIMIT)
      this.installedBlobs.delete(this.installedBlobs.keys().next().value);
    try {
      const file=await entry.blob;
      if(file.size!==size)throw Error(missing);
      // The installer verifies every chunk before publishing the descriptor.
      // Chromium can read this slice directly from the CacheStorage disk entry.
      if(bootstrap && size<=BOOTSTRAP_MEMORY_LIMIT){
        // Texture metadata contains thousands of tiny reads of the same bundle.
        // At most 64 compact bundles (16 MiB) can be retained with their handles.
        entry.bootstrap ??= file.arrayBuffer().then(bytes=>{
          if(bytes.byteLength!==size)throw Error(missing);
          return new Uint8Array(bytes);
        });
        return (await entry.bootstrap).subarray(offset,offset+length);
      }
      const bytes=await file.slice(offset,offset+length).arrayBuffer();
      if(bytes.byteLength!==length)throw Error(missing);
      return new Uint8Array(bytes);
    } catch(error) {
      if(this.installedBlobs.get(key)===entry)this.installedBlobs.delete(key);
      throw Error(missing,{cause:error});
    }
  }
  async chunk(url,hash,size) {
    if(!HASH.test(hash)||!Number.isSafeInteger(size)||size<1||size>32*1024*1024)throw Error('Invalid chunk identity');
    if(this.mode==='installed')return this.readChunkRange(url,hash,size,0,size);
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
      const cache=await this.storage(GAME_CHUNK_CACHE);
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
            await this.persist(cache,key,new Response(bytes));break;
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
        }catch(error){if(this.mode==='stream')this.report(true,error.message);throw error;}
        finally{this.transfers.delete(key);this.report(true);}
        await this.persist(cache,key,new Response(bytes));
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
    if(length && index){
      const start=(index.chunkOffset??0)+offset-index.offset;
      write(await this.readChunkRange(url,index.hash,index.chunkSize??index.size,start,length,true),0);
      return length;
    }
    for(let at=offset;at<offset+length;){
      const index=Math.floor(at/d.chunkBytes),start=index*d.chunkBytes,size=Math.min(d.chunkBytes,d.size-start);
      const count=Math.min(size-(at-start),offset+length-at);
      write(await this.readChunkRange(url,d.chunks[index],size,at-start,count),at-offset);at+=count;
    }
    return length;
  }
}
