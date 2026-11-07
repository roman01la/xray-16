// Prepare privately hosted archives; does not distribute game content or touch saves.
// Usage: node misc/web/tools/pack-streaming.mjs /owned/cop /private/output/pack
import {open,readdir,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {CHUNK_BYTES} from '../streaming/chunk-reader.mjs';
import {archiveIndexDecoder,textureMetadataEntries} from '../streaming/archive-index.mjs';
const [sourceArg,outputArg]=process.argv.slice(2);
if(!sourceArg||!outputArg)throw Error('Usage: pack-streaming.mjs GAME_FOLDER OUTPUT_FOLDER');
const source=resolve(sourceArg),output=resolve(outputArg);
if(output===source || output.startsWith(source+'/'))throw Error('Output must be outside the game installation');
await mkdir(join(output,'chunks'),{recursive:true});
const files=[];
const decoder=await archiveIndexDecoder();
try {
for(const group of ['resources','levels','localization','patches']){
  const names=await readdir(join(source,group)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of names.sort()){
    if(!/^[a-z0-9_.-]+\.db[0-9]*$/i.test(name))continue;
    const path=group+'/'+name.toLowerCase(),handle=await open(join(source,group,name),'r');
    try{
      const {size}=await handle.stat(),chunks=[];
      for(let at=0;at<size;at+=CHUNK_BYTES){
        const bytes=Buffer.alloc(Math.min(CHUNK_BYTES,size-at));let done=0;
        while(done<bytes.length){const n=await handle.read(bytes,done,bytes.length-done,at+done);if(!n.bytesRead)throw Error('Archive changed during packing');done+=n.bytesRead;}
        const hash=createHash('sha256').update(bytes).digest('hex');chunks.push(hash);
        const destination=join(output,'chunks',hash+'.bin');
        try{await writeFile(destination,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
      }
      // X-Ray starts by walking top-level chunk headers and loading the file
      // table. Package these compact indexes separately so discovering an
      // unused level archive does not pull its first/last 16 MiB payload chunks.
      const bootstrap=[],textures=[];
      for(let at=0;at<size;){
        const header=Buffer.alloc(8);if((await handle.read(header,0,8,at)).bytesRead!==8)throw Error('Truncated archive header');
        const kind=header.readUInt32LE(0)&0x7fffffff,length=header.readUInt32LE(4);
        if(at+8+length>size)throw Error('Invalid archive chunk');
        const wanted=kind===0?8:8+length;if(wanted>32*1024*1024)throw Error('Archive index too large');
        const bytes=Buffer.alloc(wanted);let done=0;
        while(done<wanted){const n=await handle.read(bytes,done,wanted-done,at+done);if(!n.bytesRead)throw Error('Truncated archive index');done+=n.bytesRead;}
        const hash=createHash('sha256').update(bytes).digest('hex');
        try{await writeFile(join(output,'chunks',hash+'.bin'),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
        bootstrap.push({offset:at,size:wanted,hash});
        if(kind===1){
          const table=(header.readUInt32LE(0)&0x80000000)?decoder.decode(bytes.subarray(8)):bytes.subarray(8);
          textures.push(...textureMetadataEntries(table,size));
        }
        at+=8+length;
      }
      if(textures.length){
        const total=textures.reduce((n,e)=>n+e.size,0);if(total>32*1024*1024)throw Error('Texture metadata bundle too large');
        const bundle=Buffer.alloc(total);let at=0;
        for(const entry of textures){let done=0;while(done<entry.size){const n=await handle.read(bundle,at+done,entry.size-done,entry.offset+done);if(!n.bytesRead)throw Error('Truncated texture metadata');done+=n.bytesRead;}entry.chunkOffset=at;at+=entry.size;}
        const hash=createHash('sha256').update(bundle).digest('hex');
        try{await writeFile(join(output,'chunks',hash+'.bin'),bundle,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
        for(const entry of textures)bootstrap.push({...entry,hash,chunkSize:total});
        console.log(path+': '+textures.length+' texture metadata entries in '+total+' bootstrap bytes');
      }
      bootstrap.sort((a,b)=>a.offset-b.offset);
      const descriptor={format:'xray-archive-v1',size,chunkBytes:CHUNK_BYTES,chunks,bootstrap};
      await mkdir(dirname(join(output,path)),{recursive:true});
      await writeFile(join(output,path+'.json'),JSON.stringify(descriptor));
      files.push({path,size,group});
      console.log(path+': '+chunks.length+' chunks, '+size+' bytes');
    }finally{await handle.close();}
  }
}
if(!files.some(f=>f.group==='resources')||!files.some(f=>f.group==='levels'))throw Error('Missing CoP resources or levels archives');
const manifest={format:'xray-stream-pack-v1',chunkBytes:CHUNK_BYTES,files};
await writeFile(join(output,'pack.json.tmp'),JSON.stringify(manifest,null,2)+'\n');
await rename(join(output,'pack.json.tmp'),join(output,'pack.json'));
console.log('Ready: '+files.length+' archives; '+files.reduce((n,f)=>n+f.size,0)+' logical bytes.');

} finally { await decoder.close(); }
