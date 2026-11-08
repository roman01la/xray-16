// Read original CoP configuration archives using the engine's LZHUF index codec
// and LZO1X payload codec. Host-side only; no game data is added to the repository.
import {open,readdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,posix} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {archiveIndexDecoder} from '../../misc/web/streaming/archive-index.mjs';

export function configPath(name){
 const value=name.replaceAll('\\','/').toLowerCase();
 if(value.startsWith('/')||value.includes('\0')||value.split('/').includes('..'))throw Error('Unsafe configuration path: '+name);
 return posix.normalize(value);
}
async function bytes(file,offset,size){
 const out=Buffer.alloc(size);let done=0;
 while(done<size){const n=await file.read(out,done,size-done,offset+done);if(!n.bytesRead)throw Error('Truncated archive');done+=n.bytesRead;}
 return out;
}
async function payloadDecoder(){
 const dir=await mkdtemp(join(tmpdir(),'zone-lzo-')),binary=join(dir,'decode');
 try{
  const flags=execFileSync('pkg-config',['--cflags','--libs','lzo2'],{encoding:'utf8'}).trim().split(/\s+/);
  await writeFile(join(dir,'decode.cpp'),`#include <lzo1x.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
int main(int argc,char**argv){if(argc!=2||lzo_init()!=LZO_E_OK)return 2;unsigned long size=strtoul(argv[1],nullptr,10);if(!size||size>67108864)return 3;std::vector<unsigned char>in;unsigned char b[65536];size_t n;while((n=fread(b,1,sizeof(b),stdin))) {in.insert(in.end(),b,b+n);if(in.size()>67108864)return 4;}std::vector<unsigned char>out(size);lzo_uint actual=size;if(lzo1x_decompress_safe(in.data(),in.size(),out.data(),&actual,nullptr)!=LZO_E_OK||actual!=size)return 5;return fwrite(out.data(),1,size,stdout)==size?0:6;}`);
  execFileSync(process.env.CXX||'c++',['-O2','-std=c++17',join(dir,'decode.cpp'),...flags,'-o',binary]);
 }catch(e){await rm(dir,{recursive:true,force:true});throw e;}
 return {decode:(data,size)=>execFileSync(binary,[String(size)],{input:data,maxBuffer:64*1024*1024,timeout:10000}),close:()=>rm(dir,{recursive:true,force:true})};
}
async function readGameArchiveFiles(source, accepts, put, maxBytes=16*1024*1024){
 const index=await archiveIndexDecoder();
 let payload;
 try{
  // CoP resources first, patches second, loose overrides last. Later registrations
  // replace whole files, matching CLocatorAPI::Register rather than merging LTX.
  for(const group of ['resources','patches']){
   const names=(await readdir(join(source,group))).filter(n=>/\.db\d*$/i.test(n)).sort();
   for(const name of names){
    const file=await open(join(source,group,name));
    try{
     const size=(await file.stat()).size;let table,header;
     for(let at=0;at<size;){
      const h=await bytes(file,at,8),kind=h.readUInt32LE(0),length=h.readUInt32LE(4);
      if(at+8+length>size)throw Error('Invalid archive chunk');
      if((kind&0x7fffffff)!==0){
       if(length>32*1024*1024)throw Error('Archive metadata too large');
       let data=await bytes(file,at+8,length);if(kind>>>31)data=index.decode(data);
       if((kind&0x7fffffff)===1)table=data;
       if((kind&0x7fffffff)===666)header=data.toString('latin1');
      }
      at+=8+length;
     }
     if(!table)continue;
     const entryPoint=/^\s*entry_point\s*=\s*(.*?)\s*$/mi.exec(header||'')?.[1];
     if(!['gamedata','$fs_root$\\gamedata\\'].includes(entryPoint))throw Error('Unsupported archive entry point: '+group+'/'+name);
     for(let at=0;at<table.length;){
      if(at+18>table.length)throw Error('Truncated archive table');
      const length=table.readUInt16LE(at),end=at+2+length;
      if(length<16||end>table.length)throw Error('Invalid archive entry');
      const path=configPath(table.toString('latin1',at+14,end-4));
      if(accepts(path)){
       const raw=table.readUInt32LE(at+2),packed=table.readUInt32LE(at+6),offset=table.readUInt32LE(end-4);
       if(raw>maxBytes||packed>maxBytes||offset+packed>size)throw Error('Invalid archive file payload: '+path);
       let data=await bytes(file,offset,packed);
       if(raw!==packed){payload??=await payloadDecoder();data=payload.decode(data,raw);}
       put(path,data,group+'/'+name);
      }
      at=end;
     }
    }finally{await file.close();}
   }
  }
 }finally{
  await index.close();
  if(payload)await payload.close();
 }
}
export async function readGameFiles(source, paths){
 const wanted=new Set(paths.map(configPath));
 const files=new Map();
 await readGameArchiveFiles(source,path=>wanted.has(path),(path,data,origin)=>{
  files.set(path,{data,origin,sha256:createHash('sha256').update(data).digest('hex')});
 },64*1024*1024);
 for(const path of wanted)if(!files.has(path))throw Error('Missing game file: '+path);
 return files;
}
export async function readGameConfigs(source,overlays=[]){
 const files=new Map();let total=0;
 const put=(path,data,origin)=>{
  const previous=files.get(path);total+=data.length-(previous?.bytes||0);
  if(total>128*1024*1024)throw Error('Configuration set too large');
  files.set(path,{text:new TextDecoder('windows-1251').decode(data),origin,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 };

 await readGameArchiveFiles(source,path=>path.startsWith('configs/')&&path.endsWith('.ltx'),
  (path,data,origin)=>put(path.slice(8),data,origin));
  async function loose(root,dir=''){
   for(const entry of await readdir(join(root,dir),{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())await loose(root,path);
    else if(entry.isFile()&&path.endsWith('.ltx'))put(configPath(path),await readFile(join(root,path)),'loose:'+resolve(root));
   }
  }
  for(const overlay of overlays)await loose(overlay);
  return files;
}

function stripComment(line){
 let quoted=false;
 for(let i=0;i<line.length;i++){
  if(line[i]==='"')quoted=!quoted;
  if(!quoted&&(line[i]===';'||line.slice(i,i+2)==='//'))return line.slice(0,i).trim();
 }
 return line.trim();
}
function compact(value){
 let quoted=false,result='';for(const c of value){if(c==='"')quoted=!quoted;if(quoted||!/[\t\r\n ]/.test(c))result+=c;}
 if(quoted)throw Error('Unsupported unterminated LTX string');return result;
}
export function parseLtx(files,entry='system.ltx'){
 const sections=new Map(),stack=[],loaded=new Set();
 function load(path){
  path=configPath(path);const file=files.get(path);
  if(!file)throw Error('Missing include: '+path);
  if(stack.includes(path))throw Error('Include cycle: '+[...stack,path].join(' -> '));
  stack.push(path);loaded.add(path);let current;
  // Like CInifile::Load, an include gets its own Current section; the parent's
  // pending section is not published until the next header or end of that file.
  function finish(){if(!current)return;if(sections.has(current.name))throw Error('Duplicate section: '+current.name);sections.set(current.name,current);}
  const lines=file.text.replace(/^\uFEFF/,'').split(/\r?\n/);
  for(let n=0;n<lines.length;n++){
   const line=stripComment(lines[n]);if(!line)continue;
   const include=/^#include\s+"([^"]+)"\s*$/.exec(line);
   if(include){
    const target=configPath(posix.join(posix.dirname(path),include[1].replaceAll('\\','/')));
    if(target.includes('*')){
     if(!target.endsWith('*.ltx')||target.slice(0,-5).includes('*'))throw Error('Unsupported include glob: '+target);
     const prefix=target.slice(0,-5);for(const name of [...files.keys()].sort())if(name.startsWith(prefix)&&name.endsWith('.ltx')&&!name.slice(prefix.length).includes('/'))load(name);
    }else load(target);
    continue;
   }
   if(line.startsWith('[')){
    finish();const match=/^\[([^\]]+)\](?::(.*))?/.exec(line);if(!match)throw Error('Invalid section in '+path+':'+(n+1));
    current={name:match[1].toLowerCase(),values:Object.create(null),source:path,line:n+1};
    for(const base of (match[2]||'').split(',').map(v=>v.trim()).filter(Boolean)){
     const parent=sections.get(base);if(!parent)throw Error('Missing or forward base '+base+' in '+current.name);
     Object.assign(current.values,parent.values);
    }
   }else if(current){
    const equal=line.indexOf('='),key=(equal<0?line:line.slice(0,equal)).trim();
    let value=equal<0?'':line.slice(equal+1);
    while((value.match(/"/g)||[]).length%2){if(++n>=lines.length)throw Error('Unterminated string in '+path);value+='\r\n'+lines[n];}
    if(key)current.values[key]=compact(value);
   }else if(line.startsWith('#'))throw Error('Unsupported LTX directive: '+line);
  }
  finish();stack.pop();
 }
 load(entry);return {sections,loaded:[...loaded].sort()};
}
