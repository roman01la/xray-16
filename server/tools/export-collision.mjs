// Extract one owned level's original CFORM without repacking or redistributing it.
import {open,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {archiveIndexDecoder} from '../../misc/web/streaming/archive-index.mjs';
const [sourceArg,outputArg,level='zaton']=process.argv.slice(2);
if(!sourceArg||!outputArg||!/^[a-z0-9_]+$/.test(level))throw Error('Usage: export-collision.mjs OWNED_GAME OUTPUT_DIR [level]');
const source=resolve(sourceArg),output=resolve(outputArg);
if(output===source||output.startsWith(source+'/'))throw Error('Output must be outside the installation');
const decoder=await archiveIndexDecoder();let found,materials;
async function read(file,offset,size){const b=Buffer.alloc(size);let at=0;while(at<size){const n=await file.read(b,at,size-at,offset+at);if(!n.bytesRead)throw Error('Truncated archive');at+=n.bytesRead;}return b;}
try{
 for(const group of ['resources','levels','patches']){
  const names=await readdir(join(source,group)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of names.filter(n=>/\.db\d*$/i.test(n)).sort()){
   const file=await open(join(source,group,name));
   try{
    const size=(await file.stat()).size;
    for(let at=0;at<size;){
     const h=await read(file,at,8),kind=h.readUInt32LE(0),length=h.readUInt32LE(4);
     if(at+8+length>size)throw Error('Invalid archive chunk');
     if((kind&0x7fffffff)===1){
      if(length>32*1024*1024)throw Error('Oversized archive index');
      let table=await read(file,at+8,length);if(kind>>>31)table=decoder.decode(table);
      for(let p=0;p<table.length;){
       if(p+18>table.length)throw Error('Truncated file record');
       const len=table.readUInt16LE(p),end=p+2+len;
       if(len<16||end>table.length)throw Error('Invalid file record');
       const path=table.toString('latin1',p+14,end-4).toLowerCase();
       if(path===`levels\\${level}\\level.cform`||path==='gamemtl.xr'){
        const raw=table.readUInt32LE(p+2),packed=table.readUInt32LE(p+6),offset=table.readUInt32LE(end-4);
        if(raw!==packed)throw Error('Compressed CFORM extraction is not supported; provide an unpacked original CFORM');
        if(raw<36||raw>256*1024*1024||offset+raw>size)throw Error('Invalid collision range');
        const entry={bytes:await read(file,offset,raw),archive:group+'/'+name,path};
        if(path==='gamemtl.xr')materials=entry;else found=entry;
       }
       p=end;
      }
     }
     at+=8+length;
    }
   }finally{await file.close();}
  }
 }
 if(!found)throw Error('Level collision not found');
 const b=found.bytes,version=b.readUInt32LE(0),vertices=b.readUInt32LE(4),triangles=b.readUInt32LE(8);
 if(version!==4||!vertices||!triangles||36+vertices*12+triangles*16>b.length)throw Error('Invalid CFORM v4 geometry');
 const sha256=createHash('sha256').update(b).digest('hex');
 const manifest={format:'xray-collision-v1',level,coordinates:'metres-y-up',sha256,bytes:b.length,vertices,triangles,bounds:{min:[0,1,2].map(i=>b.readFloatLE(12+i*4)),max:[0,1,2].map(i=>b.readFloatLE(24+i*4))},source:{archive:found.archive,path:found.path}};
 await mkdir(output,{recursive:true});
 if(materials){const hash=createHash('sha256').update(materials.bytes).digest('hex');manifest.materials={sha256:hash,bytes:materials.bytes.length};await writeFile(join(output,hash+'.gamemtl'),materials.bytes);}
 // Immutable content filename permits publishing the manifest last.
 await writeFile(join(output,sha256+'.cform'),b);
 await writeFile(join(output,level+'.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify(manifest,null,2));
}finally{await decoder.close();}
