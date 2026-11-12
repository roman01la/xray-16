// Read-only coarse archive chunks shared by the startup installer and WasmFS.
// Verified chunks live in OPFS. Installed reads use synchronous byte ranges in the WasmFS worker.
export const CHUNK_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CHUNK_STORE = 'game-chunks';
const DESCRIPTOR_STORE = 'game-archives';
const INSTALLED_HANDLE_LIMIT = 64;
const openOPFS = (name, gameId) => import('./opfs-store.mjs').then(
  ({openInstallStore, gameInstallDirectory}) => openInstallStore(name, navigator.storage, gameInstallDirectory(gameId)),
);
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const BOOTSTRAP_MEMORY_LIMIT = 256 * 1024;
export function gameStorageError(error) {
  return new Error(error?.name === 'QuotaExceededError'
    ? 'There is not enough browser storage for the complete game. Free disk space or clear data from other sites, then retry.'
    : 'Local game storage is unavailable. Check your browser storage settings and retry.', {cause:error});
}
const descriptorKey = url => sha256(new TextEncoder().encode(url));
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
  constructor({onProgress=()=>{},fetcher=(...args)=>fetch(...args), gameId='cop', openStore=name=>openOPFS(name,gameId), budget=64*1024*1024, mode='stream', digest=sha256}={}) {
    this.fetcher=fetcher;this.openStore=openStore;this.budget=budget;this.digest=digest;this.mode=mode;
    this.descriptors=new Map();this.hot=new Map();this.pending=new Map();this.bytes=0;
    this.stores=new Map();this.installedChunks=new Map();
    this.stats={downloadedBytes:0,networkChunks:0,cachedChunks:0,cachedBytes:0};
    this.onProgress=onProgress;this.transfers=new Map();this.lastReport=0;
  }
  report(force=false,error=null) {
    const now=Date.now();if(!force&&now-this.lastReport<150)return;
    this.lastReport=now;
    let received=0,total=0;for(const transfer of this.transfers.values()){received+=transfer.received;total+=transfer.total;}
    try{this.onProgress({...this.stats,active:this.transfers.size,received,total,error,...this.installProgress});}catch{}
  }
  storage(name) {
    if(!this.stores.has(name)) this.stores.set(name,Promise.resolve().then(()=>this.openStore(name)).catch(error=>{
      this.stores.delete(name);
      if(this.mode!=='stream')throw gameStorageError(error);
      return null;
    }));
    return this.stores.get(name);
  }
  async persist(store,key,bytes) {
    try{await store?.put(key,bytes);}
    catch(error){if(this.mode==='install')throw gameStorageError(error);}
  }
  async descriptor(url) {
    if(!this.descriptors.has(url)) this.descriptors.set(url,(async()=>{
      const metadata=url+'.json';
      if(this.mode==='installed') {
        const store=await this.storage(DESCRIPTOR_STORE), response=await store.get(await descriptorKey(metadata));
        if(!response)throw Error('Installed archive metadata is missing. Reload to repair game data.');
        return validateDescriptor(JSON.parse(await response.text()));
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
    const metadata=await this.storage(DESCRIPTOR_STORE);
    await this.storage(CHUNK_STORE);
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
    for(const {url,d} of descriptors)await this.persist(metadata,await descriptorKey(url+'.json'),JSON.stringify(d));
    this.report(true);
  }
  async openInstalledChunk(hash) {
    const handle=await (await this.storage(CHUNK_STORE)).handle(hash);
    if(!handle)throw Error('Missing chunk '+hash);
    if(handle.createSyncAccessHandle){
      try{
        const file=await handle.createSyncAccessHandle({mode:'read-only'});
        return {size:file.getSize(),close:()=>file.close(),read(offset,length){
          const bytes=new Uint8Array(length);
          if(file.read(bytes,{at:offset})!==length)throw Error('Short archive read');
          return bytes;
        }};
      }catch(error){
        if(!['TypeError','NotSupportedError','NoModificationAllowedError','InvalidStateError'].includes(error.name))throw error;
      }
    }
    // Some browsers expose OPFS files but lack shared synchronous handles.
    const file=await handle.getFile();
    return {size:file.size,close(){},async read(offset,length){
      const bytes=new Uint8Array(await file.slice(offset,offset+length).arrayBuffer());
      if(bytes.byteLength!==length)throw Error('Short archive read');
      return bytes;
    }};
  }
  retireChunk(entry) {
    entry.retired=true;
    if(!entry.users)entry.file.then(file=>file.close()).catch(()=>{});
  }
  async readChunkRange(url,hash,size,offset,length,bootstrap=false) {
    if(this.mode!=='installed'){
      const bytes=await this.chunk(url,hash,size);
      return bytes.subarray(offset,offset+length);
    }
    let entry=this.installedChunks.get(hash);
    if(!entry)entry={file:this.openInstalledChunk(hash),users:0};
    this.installedChunks.delete(hash);
    this.installedChunks.set(hash,entry);
    if(this.installedChunks.size>INSTALLED_HANDLE_LIMIT){
      const oldest=this.installedChunks.keys().next().value;
      this.retireChunk(this.installedChunks.get(oldest));
      this.installedChunks.delete(oldest);
    }
    entry.users++;
    try {
      const file=await entry.file;
      if(file.size!==size)throw Error('Archive size mismatch');
      // Thousands of tiny texture metadata reads share compact bundles.
      if(bootstrap && size<=BOOTSTRAP_MEMORY_LIMIT){
        entry.bootstrap ??= file.read(0,size);
        return (await entry.bootstrap).subarray(offset,offset+length);
      }
      return await file.read(offset,length);
    } catch(error) {
      if(this.installedChunks.get(hash)===entry){
        this.installedChunks.delete(hash);
        this.retireChunk(entry);
      }
      throw Error('Installed game data is missing or damaged. Reload to repair it.',{cause:error});
    } finally {
      if(--entry.users===0&&entry.retired)entry.file.then(file=>file.close()).catch(()=>{});
    }
  }
  async chunk(url,hash,size) {
    if(!HASH.test(hash)||!Number.isSafeInteger(size)||size<1||size>32*1024*1024)throw Error('Invalid chunk identity');
    if(this.mode==='installed')return this.readChunkRange(url,hash,size,0,size);
    const networkURL=new URL('../chunks/'+hash+'.bin',url).href;
    const key=hash;
    if(this.hot.has(key)){
      const bytes=this.hot.get(key);if(bytes.length!==size)throw Error('Game chunk size conflict');
      this.hot.delete(key);this.hot.set(key,bytes);return bytes;
    }
    if(this.pending.has(key)){
      const bytes=await this.pending.get(key);if(bytes.length!==size)throw Error('Game chunk size conflict');return bytes;
    }
    const task=(async()=>{
      const store=await this.storage(CHUNK_STORE);
      let bytes;
      try {
        const file=await store?.get(key);
        if(file?.size===size){
          const value=new Uint8Array(await file.arrayBuffer());
          if(await this.digest(value)===hash){
            bytes=value;
            this.stats.cachedChunks++;
            this.stats.cachedBytes+=bytes.length;
            this.report();
          }
        }
      } catch(error) {
        if(this.mode!=='stream' && error.name!=='NotReadableError')throw gameStorageError(error);
      }
      if(!bytes){
        const transfer={received:0,total:size};this.transfers.set(key,transfer);this.report(true);
        try {
          const response=await this.fetcher(networkURL);
          if(!response.ok)throw Error('Game chunk unavailable (HTTP '+response.status+'): '+new URL(response.url||networkURL).pathname);
          // Fetch decodes HTTP compression; Content-Length describes wire bytes and
          // Content-Encoding may be hidden by CDN CORS. Verify decoded bytes below.
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
        await this.persist(store,key,bytes);
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
