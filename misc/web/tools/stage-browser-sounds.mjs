import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {validatePack} from '../page/streaming.js';
import {archiveIndexDecoder} from '../streaming/archive-index.mjs';
import {validateDescriptor} from '../streaming/chunk-reader.mjs';

const outputPath='gamedata/configs/browser_sound_metadata.bin';
const recordBytes=52;
const sha256=data=>createHash('sha256').update(data).digest('hex');

async function verifiedChunk(pack,hash,size) {
  const data=await readFile(join(pack,'chunks',hash+'.bin'));
  if(data.length!==size||sha256(data)!==hash)throw Error('Sound index source chunk failed verification: '+hash);
  return data;
}

function oggEntries(table,archiveSize) {
  const entries=[];
  for(let at=0;at<table.length;){
    if(at+18>table.length)throw Error('Truncated archive table');
    const length=table.readUInt16LE(at),end=at+length+2;
    if(length<16||end>table.length)throw Error('Invalid archive table entry');
    const name=table.toString('latin1',at+14,end-4);
    if(/\.ogg$/i.test(name)){
      const size=table.readUInt32LE(at+2),packed=table.readUInt32LE(at+6),offset=table.readUInt32LE(end-4);
      if(offset+packed>archiveSize)throw Error('Invalid audio archive entry');
      if(size===packed&&size>0&&size<=32*1024*1024)entries.push({crc:table.readUInt32LE(at+10),size,offset});
    }
    at=end;
  }
  return entries.sort((a,b)=>a.offset-b.offset);
}

async function* packedAudio(pack,decoder) {
  const manifest=validatePack(JSON.parse(await readFile(join(pack,'pack.json'),'utf8')));
  for(const file of manifest.files){
    const descriptor=validateDescriptor(JSON.parse(await readFile(join(pack,file.path+'.json'),'utf8')));
    if(descriptor.size!==file.size)throw Error('Sound index source archive size differs from pack: '+file.path);
    let table;
    for(const entry of descriptor.bootstrap||[]){
      if(entry.chunkOffset!==undefined||entry.size<8)continue;
      const bytes=await verifiedChunk(pack,entry.hash,entry.size),kind=bytes.readUInt32LE(0);
      if((kind&0x7fffffff)!==1)continue;
      if(bytes.readUInt32LE(4)!==bytes.length-8)throw Error('Invalid sound index source archive table: '+file.path);
      table=kind>>>31?decoder.decode(bytes.subarray(8)):bytes.subarray(8);
      break;
    }
    if(!table)continue;
    let chunk,chunkIndex=-1;
    for(const entry of oggEntries(table,file.size)){
      const key=Buffer.alloc(12);
      key.writeUInt32LE(entry.crc,0);key.writeUInt32LE(entry.size,4);key.writeUInt32LE(entry.offset,8);
      yield key;
      for(let at=entry.offset,end=at+entry.size;at<end;){
        const index=Math.floor(at/descriptor.chunkBytes),base=index*descriptor.chunkBytes;
        if(index!==chunkIndex){
          chunk=await verifiedChunk(pack,descriptor.chunks[index],Math.min(descriptor.chunkBytes,file.size-base));
          chunkIndex=index;
        }
        const next=Math.min(end,base+chunk.length);
        yield chunk.subarray(at-base,next-base);
        at=next;
      }
    }
  }
}

async function extractMetadata(pack) {
  const work=await mkdtemp(join(tmpdir(),'xray-sound-index-'));
  let decoder;
  try {
    decoder=await archiveIndexDecoder();
    const parser=join(work,'read-ogg-metadata');
    const flags=execFileSync('pkg-config',['--cflags','--libs','vorbisfile'],{encoding:'utf8'}).trim().split(/\s+/);
    execFileSync(process.env.CXX||'c++',['-std=c++17','-O2',join(import.meta.dirname,'../tools/read-ogg-metadata.cpp'),...flags,'-o',parser]);
    const child=spawn(parser,[],{stdio:['pipe','pipe','inherit']});
    const ended=new Promise((ok,fail)=>{
      child.once('error',fail);
      child.once('close',code=>code===0?ok():fail(Error('Sound metadata parser failed: '+code)));
    });
    const read=async()=>{
      const parts=[];
      for await(const bytes of child.stdout)parts.push(bytes);
      return Buffer.concat(parts);
    };
    const [data]=await Promise.all([read(),pipeline(Readable.from(packedAudio(pack,decoder)),child.stdin),ended]);
    if(data.length%recordBytes!==0)throw Error('Malformed sound metadata');
    const unique=new Map();
    for(let at=0;at<data.length;at+=recordBytes){
      const record=data.subarray(at,at+recordBytes),key=record.subarray(0,12).toString('hex');
      const previous=unique.get(key);
      if(previous===undefined)unique.set(key,record);
      else if(previous&&!record.equals(previous))unique.set(key,null);
    }
    const records=[...unique.values()].filter(Boolean).sort((a,b)=>
      a.readUInt32LE(0)-b.readUInt32LE(0)||a.readUInt32LE(4)-b.readUInt32LE(4)||a.readUInt32LE(8)-b.readUInt32LE(8));
    const header=Buffer.alloc(8);
    header.write('XSA1');header.writeUInt32LE(records.length,4);
    console.log('Packaged Ogg metadata for '+records.length+' immutable archive entries');
    return Buffer.concat([header,...records]);
  } finally {
    await decoder?.close();
    await rm(work,{recursive:true,force:true});
  }
}

export async function stageBrowserSounds(frontend,pack) {
  const bytes=await extractMetadata(pack),output=join(frontend,'engine',outputPath);
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,bytes);
  const manifestPath=join(frontend,'engine_data.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.files=manifest.files.filter(({path})=>path!==outputPath);
  manifest.files.push({path:outputPath,size:bytes.length,sha256:sha256(bytes)});
  await writeFile(manifestPath,JSON.stringify(manifest));
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [frontend,pack]=process.argv.slice(2);
  if(!frontend||!pack)throw Error('Usage: stage-browser-sounds.mjs FRONTEND PACK');
  await stageBrowserSounds(frontend,pack);
}
