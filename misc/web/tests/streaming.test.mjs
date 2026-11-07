import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ChunkReader,CHUNK_BYTES} from '../streaming/chunk-reader.mjs';
import {validatePack,streamingConfig} from '../page/streaming.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const a=new Uint8Array(CHUNK_BYTES).fill(65),b=new Uint8Array(5).fill(66),c=new Uint8Array(CHUNK_BYTES).fill(67);
 const d={format:'xray-archive-v1',size:a.length+b.length,chunkBytes:CHUNK_BYTES,chunks:[hash(a),hash(b)]};
 const stored=new Map(),requests=[];let fail=false,corrupt=false;
 const cache={match:async k=>stored.get(k)?.clone(),put:async(k,v)=>stored.set(k,v),delete:async k=>stored.delete(k)};
 const reader=new ChunkReader({budget:CHUNK_BYTES,cacheStorage:{open:async()=>cache},digest:async b=>hash(b),fetcher:async url=>{
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
 const f=fixture();f.stored.set('https://test/pack/chunks/'+hash(f.b)+'.bin',new Response(new Uint8Array(5)));
 let output;await f.reader.read(url,CHUNK_BYTES,1,b=>output=b[0]);assert.equal(output,66);assert.equal(f.reader.stats.networkChunks,1);
});
test('concurrent requests share download and quota failure preserves read',async()=>{
 const f=fixture();f.reader.cacheStorage={open:async()=>{throw Error('quota');}};
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
 const reader=new ChunkReader({cacheStorage:null,digest:async b=>hash(b),fetcher:async url=>{requests.push(url);if(url.endsWith('.json'))return Response.json(descriptor);assert.ok(url.endsWith(digest+'.bin'));return new Response(index);}});
 const output=[];await reader.read(url,CHUNK_BYTES*39+12,4,b=>output.push(...b));assert.deepEqual(output,[3,4,5,6]);assert.equal(reader.stats.downloadedBytes,8);assert.equal(requests.length,2);
});
test('bad metadata and invalid ranges fail before payload allocation',async()=>{
 const f=fixture();f.d.bootstrap=[{offset:0,size:CHUNK_BYTES*4,hash:'a'.repeat(64)}];await assert.rejects(f.reader.descriptor(url),/index/);
 await assert.rejects(f.reader.read(url,-1,1,()=>{}),/range/);await assert.rejects(f.reader.read(url,0,Infinity,()=>{}),/range/);
});
test('texture metadata sharing one bootstrap blob preserves archive offsets',async()=>{
 const bundle=Uint8Array.from([10,11,12,20,21]),digest=hash(bundle),requests=[];
 const descriptor={format:'xray-archive-v1',size:CHUNK_BYTES*2,chunkBytes:CHUNK_BYTES,chunks:['a'.repeat(64),'b'.repeat(64)],bootstrap:[{offset:100,size:3,hash:digest,chunkOffset:0,chunkSize:5},{offset:CHUNK_BYTES+100,size:2,hash:digest,chunkOffset:3,chunkSize:5}]};
 const reader=new ChunkReader({cacheStorage:null,digest:async b=>hash(b),fetcher:async url=>{requests.push(url);return url.endsWith('.json')?Response.json(descriptor):new Response(bundle);}});
 const output=[];await reader.read(url,101,2,b=>output.push(...b));await reader.read(url,CHUNK_BYTES+100,2,b=>output.push(...b));assert.deepEqual(output,[11,12,20,21]);assert.equal(reader.stats.downloadedBytes,5);assert.equal(requests.length,2);
});
test('archive metadata parser selects .thm entries and rejects malformed ranges',async()=>{
 const {textureMetadataEntries}=await import('../streaming/archive-index.mjs');
 const entry=(name,offset,size)=>{const b=Buffer.alloc(18+name.length);b.writeUInt16LE(16+name.length);b.writeUInt32LE(size,2);b.writeUInt32LE(size,6);b.write(name,14);b.writeUInt32LE(offset,b.length-4);return b;};
 const table=Buffer.concat([entry('textures\\a.thm',100,20),entry('textures\\a.dds',200,40)]);
 assert.deepEqual(textureMetadataEntries(table,1000),[{offset:100,size:20}]);assert.throws(()=>textureMetadataEntries(table.subarray(0,-1),1000),/table/);assert.throws(()=>textureMetadataEntries(table,110),/range/);
});
