// Real-browser OPFS/version-update probe; no game assets required.
// node misc/web/streaming/build-update-probe.mjs /tmp/xray-update-probe
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const output=process.argv[2];if(!output)throw Error('Output directory required');
const root=resolve(output),chunkBytes=16*1024*1024;
const shared=Buffer.alloc(chunkBytes,7),old=Buffer.from([1,2,3,4,5]),changed=Buffer.from([1,2,9,4,5]);
const hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir(root,{recursive:true});await copyFile(join(import.meta.dirname,'chunk-reader.mjs'),join(root,'chunk-reader.mjs'));
await copyFile(resolve(import.meta.dirname,'../../../server/web/opfs-store.mjs'),join(root,'opfs-store.mjs'));
for(const [version,tail] of [['v1',old],['v2',changed]]){
 const base=join(root,version);await mkdir(join(base,'chunks'),{recursive:true});await mkdir(join(base,'resources'),{recursive:true});
 for(const bytes of [shared,tail])await writeFile(join(base,'chunks',hash(bytes)+'.bin'),bytes);
 await writeFile(join(base,'resources/archive.db.json'),JSON.stringify({format:'xray-archive-v1',size:chunkBytes+5,chunkBytes,chunks:[hash(shared),hash(tail)]}));
}
await writeFile(join(root,'index.html'),`<!doctype html><meta charset="utf-8"><title>Incremental game update probe</title><h1>Incremental game update probe</h1><pre id="result">Running…</pre><script type="module" src="./probe.mjs"></script>`);
await writeFile(join(root,'probe.mjs'),`import {ChunkReader,CHUNK_BYTES} from './chunk-reader.mjs';
import {openInstallStore} from './opfs-store.mjs';
const name='xray-update-probe-'+crypto.randomUUID(),results=[];
try {
 for(const version of ['v1','v2','v1']){
  const reader=new ChunkReader({openStore:store=>openInstallStore(store,navigator.storage,name),budget:0}),out=new Uint8Array(6);
  await reader.read(new URL('./'+version+'/resources/archive.db',location.href).href,CHUNK_BYTES-1,6,(bytes,at)=>out.set(bytes,at));
  const expected=version==='v2'?'7,1,2,9,4,5':'7,1,2,3,4,5';if(String(out)!==expected)throw Error('Incorrect version bytes');
  results.push({version,bytes:[...out],...reader.stats});
 }
 if(results[0].downloadedBytes!==CHUNK_BYTES+5||results[1].downloadedBytes!==5||results[2].downloadedBytes!==0)throw Error('Incremental reuse failed');
 document.getElementById('result').textContent='PASS · unchanged chunks reused across deployment URLs; changed chunk only; rollback reuses cache\\n'+JSON.stringify(results,null,2);
}catch(error){document.getElementById('result').textContent='FAIL · '+error.stack;}finally{await (await navigator.storage.getDirectory()).removeEntry(name,{recursive:true});}
`);
console.log('Created browser update probe:',root);
