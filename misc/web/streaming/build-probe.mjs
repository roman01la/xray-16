// Usage: EMXX=/path/to/em++ EM_CACHE=/path/to/cache node build-probe.mjs /tmp/preview
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const source=import.meta.dirname,output=resolve(process.argv[2]||'/tmp/xray-stream-probe');
await mkdir(join(output,'pack/resources'),{recursive:true});await mkdir(join(output,'pack/chunks'),{recursive:true});
const chunks=[];
for(const bytes of [Buffer.alloc(16*1024*1024,65),Buffer.alloc(16*1024*1024,66),Buffer.alloc(5,67)]){
 const hash=createHash('sha256').update(bytes).digest('hex');chunks.push(hash);await writeFile(join(output,'pack/chunks',hash+'.bin'),bytes);
}
await writeFile(join(output,'pack/resources/test.db.json'),JSON.stringify({format:'xray-archive-v1',size:32*1024*1024+5,chunkBytes:16*1024*1024,chunks}));
await copyFile(join(source,'chunk-reader.mjs'),join(output,'chunk-reader.mjs'));
execFileSync(process.env.EMXX||'em++',[join(source,'probe.cpp'),'-m64','-pthread','-sWASMFS','-sPROXY_TO_PTHREAD','-sPTHREAD_POOL_SIZE=3','-sEXIT_RUNTIME','-sMODULARIZE','-sEXPORT_ES6','-sENVIRONMENT=web,worker','-O2','--js-library',join(source,'library.js'),'-o',join(output,'probe.mjs')],{stdio:'inherit'});
await writeFile(join(output,'index.html'),`<!doctype html><title>Streaming filesystem probe</title><h1>Wasm64 archive streaming</h1><pre id="log">Booting filesystem probe…\n</pre><script type="module">import create from './probe.mjs';const print=(...s)=>document.querySelector('#log').textContent+=s.join(' ')+'\\n';create({print,printErr:print}).catch(e=>print(e.stack));</script>`);
console.log('Serve '+output+' with COOP/COEP; expected pread ABB; third payload chunk must remain unread: '+chunks[2]);
