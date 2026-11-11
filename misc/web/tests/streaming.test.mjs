import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ChunkReader,CHUNK_BYTES} from '../streaming/chunk-reader.mjs';
import {validatePack,streamingConfig} from '../page/streaming.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const a=new Uint8Array(CHUNK_BYTES).fill(65),b=new Uint8Array(5).fill(66),c=new Uint8Array(CHUNK_BYTES).fill(67);
 const d={format:'xray-archive-v1',size:a.length+b.length,chunkBytes:CHUNK_BYTES,chunks:[hash(a),hash(b)]};
 const cache=memoryStore(),stored=cache.items,requests=[];let fail=false,corrupt=false;
 const reader=new ChunkReader({budget:CHUNK_BYTES,openStore:async()=>cache,digest:async b=>hash(b),fetcher:async url=>{
  requests.push(url);if(url.endsWith('.json'))return Response.json(d);
  if(fail)return new Response('',{status:503});
  return new Response(corrupt?c:url.includes(hash(a))?a:b);
 }});
 return {reader,requests,stored,d,a,b,fail:()=>fail=true,corrupt:()=>corrupt=true};
}
const url='https://test/pack/resources/resources.db';
test('metadata does not fetch game bytes; random read downloads only touched coarse chunk',async()=>{
 const f=fixture();assert.equal((await f.reader.descriptor(url)).size,CHUNK_BYTES+5);assert.equal(f.requests.length,1);
 let output;assert.equal(await f.reader.read(url,CHUNK_BYTES+2,2,b=>output=b.slice()),2);assert.deepEqual([...output],[66,66]);assert.equal(f.reader.stats.downloadedBytes,5);assert.equal(f.requests.length,2);
});
test('reads spanning chunks and EOF are exact; hot memory remains bounded',async()=>{
 const f=fixture(),out=new Uint8Array(4);assert.equal(await f.reader.read(url,CHUNK_BYTES-2,4,(b,at)=>out.set(b,at)),4);assert.deepEqual([...out],[65,65,66,66]);assert.ok(f.reader.bytes<=CHUNK_BYTES);
 assert.equal(await f.reader.read(url,CHUNK_BYTES+5,100,()=>assert.fail()),0);
 await f.reader.read(url,0,1,()=>{});assert.equal(f.reader.stats.cachedChunks,1);assert.equal(f.reader.stats.networkChunks,2);
});
test('missing and corrupt chunks fail closed and can retry',async()=>{
 const missing=fixture();missing.fail();await assert.rejects(missing.reader.read(url,0,1,()=>assert.fail()),/unavailable/);assert.equal(missing.reader.pending.size,0);
 const corrupt=fixture();corrupt.corrupt();await assert.rejects(corrupt.reader.read(url,0,1,()=>assert.fail()),/integrity/);assert.equal(corrupt.reader.hot.size,0);assert.equal(corrupt.stored.size,0);
});
test('persistent cache corruption is discarded and fetched again',async()=>{
 const f=fixture();f.stored.set(hash(f.b),new Blob([new Uint8Array(5)]));
 let output;await f.reader.read(url,CHUNK_BYTES,1,b=>output=b[0]);assert.equal(output,66);assert.equal(f.reader.stats.networkChunks,1);
});
test('concurrent requests share download and quota failure preserves read',async()=>{
 const f=fixture();f.reader.openStore=async()=>{throw Error('quota');};
 await Promise.all([f.reader.read(url,0,1,()=>{}),f.reader.read(url,1,1,()=>{})]);assert.equal(f.reader.stats.networkChunks,1);
});
test('manifest validation rejects writes, traversal, duplicate paths and missing levels',()=>{
 const pack={format:'xray-stream-pack-v1',chunkBytes:CHUNK_BYTES,files:[{path:'resources/configs.db',size:10},{path:'levels/levels.db0',size:20}]};assert.equal(validatePack(pack),pack);
 for(const path of ['_appdata_/user.ltx','levels/../x.db','levels//x.db','https://test/x.db'])assert.throws(()=>validatePack({...pack,files:[...pack.files,{path,size:1}]}));
 assert.throws(()=>validatePack({...pack,files:[...pack.files,pack.files[0]]}));
});
test('streaming config preserves writable save and engine override paths',()=>{
 const source='$app_data_root$ = true| false| $fs_root$| _appdata_\\\n$arch_dir_resources$ = false| false| $fs_root$| resources\\\n$arch_dir_patches$ = false| true| $fs_root$| patches\\\n$game_saves$ = true| false| $app_data_root$| savedgames\\\n';
 const result=streamingConfig(source);assert.match(result,/\$app_data_root\$ = true\| false\| \$fs_root\$\| _appdata_/);assert.match(result,/\/stream\/resources\//);assert.match(result,/\$game_saves\$ = true\| false\| \$app_data_root\$/);
 assert.ok(result.indexOf('$arch_dir_stream_patches$')<result.indexOf('$arch_dir_patches$'));
});
test('compact archive index reads do not download payload chunks',async()=>{
 const index=Uint8Array.from([1,2,3,4,5,6,7,8]),digest=hash(index),requests=[];
 const descriptor={format:'xray-archive-v1',size:CHUNK_BYTES*40,chunkBytes:CHUNK_BYTES,chunks:Array(40).fill('a'.repeat(64)),bootstrap:[{offset:CHUNK_BYTES*39+10,size:8,hash:digest}]};
 const reader=new ChunkReader({openStore:async()=>null,digest:async b=>hash(b),fetcher:async url=>{requests.push(url);if(url.endsWith('.json'))return Response.json(descriptor);assert.ok(url.endsWith(digest+'.bin'));return new Response(index);}});
 const output=[];await reader.read(url,CHUNK_BYTES*39+12,4,b=>output.push(...b));assert.deepEqual(output,[3,4,5,6]);assert.equal(reader.stats.downloadedBytes,8);assert.equal(requests.length,2);
});
test('bad metadata and invalid ranges fail before payload allocation',async()=>{
 const f=fixture();f.d.bootstrap=[{offset:0,size:CHUNK_BYTES*4,hash:'a'.repeat(64)}];await assert.rejects(f.reader.descriptor(url),/index/);
 await assert.rejects(f.reader.read(url,-1,1,()=>{}),/range/);await assert.rejects(f.reader.read(url,0,Infinity,()=>{}),/range/);
});
test('texture metadata sharing one bootstrap blob preserves archive offsets',async()=>{
 const bundle=Uint8Array.from([10,11,12,20,21]),digest=hash(bundle),requests=[];
 const descriptor={format:'xray-archive-v1',size:CHUNK_BYTES*2,chunkBytes:CHUNK_BYTES,chunks:['a'.repeat(64),'b'.repeat(64)],bootstrap:[{offset:100,size:3,hash:digest,chunkOffset:0,chunkSize:5},{offset:CHUNK_BYTES+100,size:2,hash:digest,chunkOffset:3,chunkSize:5}]};
 const reader=new ChunkReader({openStore:async()=>null,digest:async b=>hash(b),fetcher:async url=>{requests.push(url);return url.endsWith('.json')?Response.json(descriptor):new Response(bundle);}});
 const output=[];await reader.read(url,101,2,b=>output.push(...b));await reader.read(url,CHUNK_BYTES+100,2,b=>output.push(...b));assert.deepEqual(output,[11,12,20,21]);assert.equal(reader.stats.downloadedBytes,5);assert.equal(requests.length,2);
});
test('archive metadata parser selects .thm entries and rejects malformed ranges',async()=>{
 const {textureMetadataEntries}=await import('../streaming/archive-index.mjs');
 const entry=(name,offset,size)=>{const b=Buffer.alloc(18+name.length);b.writeUInt16LE(16+name.length);b.writeUInt32LE(size,2);b.writeUInt32LE(size,6);b.write(name,14);b.writeUInt32LE(offset,b.length-4);return b;};
 const table=Buffer.concat([entry('textures\\a.thm',100,20),entry('textures\\a.dds',200,40)]);
 assert.deepEqual(textureMetadataEntries(table,1000),[{offset:100,size:20}]);assert.throws(()=>textureMetadataEntries(table.subarray(0,-1),1000),/table/);assert.throws(()=>textureMetadataEntries(table,110),/range/);
});

function memoryStore(){
 const items=new Map();
 return {items,async get(key){return items.get(key);},async put(key,bytes){items.set(key,new Blob([bytes]));},
  async handle(key){const file=items.get(key);return file?{getFile:async()=>file}:null;}};
}
test('immutable release update downloads only changed chunks and rollback reuses old bytes',async()=>{
 const shared=new Uint8Array(CHUNK_BYTES).fill(7),old=Uint8Array.from([1,2,3,4,5]),updated=Uint8Array.from([1,2,9,4,5]);
 const store=memoryStore(),requests=[],chunks=new Map([shared,old,updated].map(b=>[hash(b),b]));
 const versions={v1:[hash(shared),hash(old)],v2:[hash(shared),hash(updated)]};
 const make=()=>new ChunkReader({openStore:async()=>store,budget:0,digest:async b=>hash(b),fetcher:async url=>{
  requests.push(url);
  if(url.endsWith('.json')){const version=new URL(url).pathname.split('/')[2];return Response.json({format:'xray-archive-v1',size:shared.length+5,chunkBytes:CHUNK_BYTES,chunks:versions[version]});}
  const key=url.split('/').pop().replace('.bin','');assert.ok(chunks.has(key));return new Response(chunks.get(key));
 }});
 const read=async(version)=>{const reader=make(),out=new Uint8Array(6),url=`https://test/packs/${version}/resources/resources.db`;await reader.read(url,CHUNK_BYTES-1,6,(b,at)=>out.set(b,at));return {out,reader};};
 const first=await read('v1');assert.deepEqual([...first.out],[7,1,2,3,4,5]);assert.equal(first.reader.stats.downloadedBytes,CHUNK_BYTES+5);
 const second=await read('v2');assert.deepEqual([...second.out],[7,1,2,9,4,5]);assert.equal(second.reader.stats.downloadedBytes,5);assert.equal(second.reader.stats.networkChunks,1);
 const rollback=await read('v1');assert.deepEqual(rollback.out,first.out);assert.equal(rollback.reader.stats.downloadedBytes,0);
 assert.equal(requests.filter(s=>s.endsWith('.bin')).length,3);
 assert.equal(requests.filter(s=>s.endsWith('.json')).length,3); // release descriptors stay pinned, never cache-swapped
});
test('corrupt shared update cache is repaired only for the requested chunk',async()=>{
 const bytes=Uint8Array.from([4,5,6]),digest=hash(bytes),store=memoryStore();let requests=0;
 const key=digest;await store.put(key,Uint8Array.from([4,0,6]));
 const reader=new ChunkReader({openStore:async()=>store,digest:async b=>hash(b),fetcher:async url=>{requests++;assert.match(url,/packs\/v2\/chunks/);return new Response(bytes);}});
 assert.deepEqual(await reader.chunk('https://test/packs/v2/resources/configs.db',digest,3),bytes);assert.equal(requests,1);
 assert.deepEqual(new Uint8Array(await store.items.get(key).arrayBuffer()),bytes);
 await assert.rejects(reader.chunk('https://test/packs/v3/resources/configs.db',digest,2),/size conflict/);
});

test('download progress reports streamed bytes, completion and failures without changing data',async()=>{
 const bytes=new Uint8Array([1,2,3,4]),events=[];
 const reader=new ChunkReader({openStore:async()=>null,onProgress:p=>events.push(p),digest:async b=>hash(b),fetcher:async()=>new Response(new ReadableStream({async start(controller){
  controller.enqueue(bytes.slice(0,2));await new Promise(resolve=>setTimeout(resolve,170));controller.enqueue(bytes.slice(2));controller.close();
 }}))});
 assert.deepEqual(await reader.chunk(url,hash(bytes),4),bytes);
 assert.ok(events.some(p=>p.active===1&&p.received===4&&p.total===4));
 assert.equal(events.at(-1).active,0);assert.equal(events.at(-1).downloadedBytes,4);
 const broken=[];
 const bad=new ChunkReader({openStore:async()=>null,onProgress:p=>broken.push(p),fetcher:async()=>new Response(new Uint8Array(5))});
 await assert.rejects(bad.chunk(url,hash(bytes),4),/length mismatch/);
 assert.ok(broken.some(p=>p.error));assert.equal(broken.at(-1).active,0);assert.equal(broken.at(-1).downloadedBytes,0);
});

function packStores() {
  const stores=new Map();
  return {stores,async openStore(name){
    if(!stores.has(name))stores.set(name,memoryStore());
    return stores.get(name);
  }};
}

test('complete startup installation shares payloads across modes, pins metadata and stays offline during play',async()=>{
  const shared=Uint8Array.of(1,2),old=Uint8Array.of(3,4),updated=Uint8Array.of(5,6),bootstrap=Uint8Array.of(1);
  const chunks=new Map([shared,old,updated,bootstrap].map(bytes=>[hash(bytes),bytes]));
  const {openStore,stores}=packStores(),requests=[],events=[];
  const files=['resources/configs.db','levels/levels.db0','patches/game.db'];
  const archives=version=>files.map(path=>({url:`https://test/packs/${version}/${path}`,size:2}));
  const options={openStore,digest:async bytes=>hash(bytes),budget:0,fetcher:async url=>{
    requests.push(url);
    const path=new URL(url).pathname;
    if(path.endsWith('.json')){
      const level=path.includes('/levels/');
      return Response.json({format:'xray-archive-v1',size:2,chunkBytes:CHUNK_BYTES,
        chunks:[hash(level?(path.includes('/v2/')?updated:old):shared)],
        ...(path.includes('/resources/')?{bootstrap:[{offset:0,size:1,hash:hash(bootstrap)}]}:{})});
    }
    return new Response(chunks.get(path.split('/').pop().slice(0,-4)));
  }};
  const install=async version=>{
    const reader=new ChunkReader({...options,mode:'install',onProgress:event=>events.push(event)});
    await reader.install(archives(version));
    return reader;
  };
  const runtime=()=>new ChunkReader({...options,mode:'installed',
    fetcher:()=>assert.fail('gameplay tried to fetch'),digest:()=>assert.fail('gameplay tried to rehash a chunk')});
  const first=await install('v1');
  assert.equal(first.stats.networkChunks,3);
  assert.equal(first.stats.downloadedBytes,5);
  assert.equal(first.hot.size,0);
  assert.deepEqual([events.at(-1).checkedBytes,events.at(-1).packBytes],[5,5]);
  const read=async (reader,url,length)=>{
    const out=[];assert.equal(await reader.read(url,0,length,bytes=>out.push(...bytes)),length);return out;
  };
  const singleplayer=runtime(),multiplayer=runtime();
  assert.deepEqual(await read(singleplayer,archives('v1')[0].url,1),[1]);
  assert.deepEqual(await read(multiplayer,archives('v1')[1].url,2),[3,4]);
  const second=await install('v2');
  assert.equal(second.stats.networkChunks,1);
  assert.equal(second.stats.downloadedBytes,2);
  assert.deepEqual(await read(runtime(),archives('v2')[1].url,2),[5,6]);
  assert.deepEqual(await read(singleplayer,archives('v1')[1].url,2),[3,4]);
  assert.equal((await install('v1')).stats.downloadedBytes,0);
  assert.equal(requests.filter(url=>url.endsWith('.bin')).length,4);
  stores.get('game-chunks').items.delete(hash(old));
  await assert.rejects(read(runtime(),archives('v1')[1].url,2),/Reload to repair/);
  await assert.rejects(read(runtime(),archives('unknown')[0].url,1),/metadata is missing/);
});

test('installed reads use exact OPFS ranges across chunks and bootstrap bundles',async()=>{
  const a='a'.repeat(64),b='b'.repeat(64),bundle='c'.repeat(64),reads=[],matches=[];
  const d={format:'xray-archive-v1',size:CHUNK_BYTES+8,chunkBytes:CHUNK_BYTES,chunks:[a,b],
    bootstrap:[{offset:100,size:5,hash:bundle,chunkOffset:8,chunkSize:20}]};
  const sizes=new Map([[a,CHUNK_BYTES],[b,8],[bundle,20]]);
  const makeReader=()=>new ChunkReader({mode:'installed',fetcher:()=>assert.fail('gameplay fetch'),
    digest:()=>assert.fail('gameplay digest'),openStore:async name=>{
      if(name==='game-archives')return {get:async()=>new Blob([JSON.stringify(d)])};
      return {handle:async id=>{
        matches.push(id);
        return {async createSyncAccessHandle({mode}){
          assert.equal(mode,'read-only');
          return {getSize:()=>sizes.get(id),close(){},read(bytes,{at}){
            reads.push([id,at,at+bytes.length]);
            if(id===bundle)bytes.set(Uint8Array.from({length:bytes.length},(_,i)=>at+i));
            else bytes.fill(id.charCodeAt(0));
            return bytes.length;
          }};
        }};
      }};
    }});
  const reader=makeReader(),out=new Uint8Array(5);
  assert.equal(await reader.read(url,CHUNK_BYTES-3,5,(bytes,at)=>out.set(bytes,at)),5);
  assert.deepEqual([...out],[97,97,97,98,98]);
  assert.equal(await reader.read(url,101,2,bytes=>assert.deepEqual([...bytes],[9,10])),2);
  assert.equal(await reader.read(url,102,1,bytes=>assert.deepEqual([...bytes],[10])),1);
  assert.equal(await reader.read(url,CHUNK_BYTES+6,5,bytes=>assert.deepEqual([...bytes],[98,98])),2);
  assert.deepEqual(reads,[[a,CHUNK_BYTES-3,CHUNK_BYTES],[b,0,2],[bundle,0,20],[b,6,8]]);
  assert.deepEqual(matches,[a,b,bundle]);
  assert.equal(reader.hot.size,0);
  sizes.set(b,7);
  await assert.rejects(makeReader().read(url,CHUNK_BYTES,1,()=>assert.fail('used wrong size')),/Reload to repair/);
});

test('a failed startup does not publish archive metadata and resumes verified chunks on retry',async()=>{
  const good=Uint8Array.of(7),bad=Uint8Array.of(8),{openStore,stores}=packStores();
  const files=[{url:'https://test/pack/resources/configs.db',size:1},{url:'https://test/pack/levels/levels.db0',size:1}];
  let fail=true;
  const options={openStore,budget:0,mode:'install',digest:async bytes=>hash(bytes),fetcher:async url=>{
    if(url.endsWith('.json'))return Response.json({format:'xray-archive-v1',size:1,chunkBytes:CHUNK_BYTES,chunks:[hash(url.includes('/resources/')?good:bad)]});
    if(url.includes(hash(good)))return new Response(good);
    return fail?new Response('',{status:503}):new Response(bad);
  }};
  await assert.rejects(new ChunkReader(options).install(files),/HTTP 503/);
  assert.equal(stores.get('game-archives').items.size,0);
  assert.equal(stores.get('game-chunks').items.size,1);
  fail=false;
  const retry=new ChunkReader(options);
  await retry.install(files);
  assert.equal(retry.stats.networkChunks,1);
  assert.equal(retry.stats.cachedChunks,1);
  assert.equal(stores.get('game-archives').items.size,2);
  const quota=packStores(),open=quota.openStore;
  quota.openStore=async name=>{
    const cache=await open(name);
    if(name==='game-chunks')cache.put=()=>{throw new DOMException('full','QuotaExceededError');};
    return cache;
  };
  await assert.rejects(new ChunkReader({...options,openStore:quota.openStore}).install(files),/not enough browser storage/);
  assert.equal(quota.stores.get('game-archives').items.size,0);
});

test('HTTP gzip chunks decode, verify and reuse the same persistent cache',async()=>{
 const {createServer}=await import('node:http');
 const {gzipSync}=await import('node:zlib');
 const original=Buffer.from('compressed game archive data '.repeat(4096));
 const digest=hash(original),compressed=gzipSync(original),store=memoryStore();
 let requests=0;
 const server=createServer((req,res)=>{
  requests++;res.writeHead(200,{'Content-Encoding':'gzip','Content-Length':compressed.length});res.end(compressed);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const archive=`http://127.0.0.1:${server.address().port}/pack/resources/test.db`;
 try{
  const reader=new ChunkReader({openStore:async()=>store,digest:async bytes=>hash(bytes)});
  assert.deepEqual(Buffer.from(await reader.chunk(archive,digest,original.length)),original);
  assert.equal(requests,1);assert.equal(reader.stats.downloadedBytes,original.length);
  const cached=new ChunkReader({openStore:async()=>store,digest:async bytes=>hash(bytes),fetcher:()=>assert.fail('Cached bytes must not be downloaded again')});
  assert.deepEqual(Buffer.from(await cached.chunk(archive,digest,original.length)),original);
  assert.equal(cached.stats.cachedChunks,1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('decoded size and hash are enforced even when compression headers are hidden by CORS',async()=>{
 const original=Buffer.from('game data'),digest=hash(original);
 for(const payload of [Buffer.from('bad data!'),original.subarray(1),Buffer.concat([original,Buffer.from('x')])]){
  const store=memoryStore();
  const reader=new ChunkReader({openStore:async()=>store,digest:async bytes=>hash(bytes),fetcher:async()=>new Response(payload,{headers:{'Content-Length':'3'}})});
  await assert.rejects(reader.chunk(url,digest,original.length),/integrity|length/);
  assert.equal(store.items.size,0);
 }
 const reader=new ChunkReader({openStore:async()=>null,digest:async bytes=>hash(bytes),fetcher:async()=>new Response(original,{headers:{'Content-Length':'3'}})});
 assert.deepEqual(Buffer.from(await reader.chunk(url,digest,original.length)),original);
});
