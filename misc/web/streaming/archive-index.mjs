// Build a small host helper from the engine's own decoder; no alternate archive
// codec or npm dependency. Used by the packer, never shipped to the browser.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
export async function archiveIndexDecoder(){
 const dir=await mkdtemp(join(tmpdir(),'xray-index-')),binary=join(dir,'decode');
 const source=await readFile(resolve(import.meta.dirname,'../../../src/xrCore/LzHuf.cpp'),'utf8');
 const prefix=`#include <cstdint>\n#include <cstdlib>\n#include <cstdio>\n#include <cstring>\n#include <unistd.h>\n#include <vector>\nusing u8=uint8_t;using u32=uint32_t;\n#define IC inline\n#define xr_malloc malloc\n#define xr_realloc realloc\n#define xr_free free\n#define _write write\n#define _read read\n`;
 const main=`\nint main(){std::vector<u8> in;u8 buf[65536];size_t n;while((n=fread(buf,1,sizeof(buf),stdin)))in.insert(in.end(),buf,buf+n);if(in.size()<4||in.size()>32*1024*1024)return 2;u32 size;memcpy(&size,in.data(),4);if(size==0||size>32*1024*1024)return 3;u8* out=nullptr;size_t count=0;if(!_decompressLZ(&out,&count,in.data(),in.size(),32*1024*1024))return 4;if(count!=size)return 5;return fwrite(out,1,count,stdout)==count?0:6;}\n`;
 try{await writeFile(join(dir,'decode.cpp'),prefix+source.replace('#include "stdafx.h"','')+main);execFileSync(process.env.CXX||'c++',['-O2','-std=c++17',join(dir,'decode.cpp'),'-o',binary],{stdio:'pipe'});}catch(error){await rm(dir,{recursive:true,force:true});throw error;}
 return {decode:bytes=>execFileSync(binary,[],{input:bytes,maxBuffer:32*1024*1024,timeout:30000}),close:()=>rm(dir,{recursive:true,force:true})};
}
export function textureMetadataEntries(table,archiveSize){
 const entries=[];
 for(let at=0;at<table.length;){
  if(at+18>table.length)throw Error('Truncated archive table');
  const size=table.readUInt16LE(at),length=size-16,end=at+2+size;
  if(length<0||end>table.length)throw Error('Invalid archive table entry');
  const name=table.toString('latin1',at+14,at+14+length),bytes=table.readUInt32LE(at+6),offset=table.readUInt32LE(end-4);
  if(/\.thm$/i.test(name)){
   if(bytes<1||offset+bytes>archiveSize)throw Error('Invalid texture metadata range');
   entries.push({offset,size:bytes});
  }
  at=end;
 }
 return entries;
}
