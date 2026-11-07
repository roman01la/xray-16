import {validateContract} from './contract.mjs';
const hashPattern=/^[a-f0-9]{64}$/;
export async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function validateWorld(value){
 const contract=validateContract(value?.contract),content=value.content;
 if(contract.world==='synthetic-flat-v1'){if(content!==null)throw Error('Unexpected synthetic content');return {contract,content};}
 if(contract.world!=='zaton-static-v1'||!content||Object.keys(content).sort().join(',')!=='geometry,materials,movement'||content.movement!=='capsule-motor-v4'||!hashPattern.test(content.geometry)||!hashPattern.test(content.materials))throw Error('Unsupported world content');
 const revision=await sha256(new TextEncoder().encode(`zaton-static-v1\n${content.geometry}\n${content.materials}\n${content.movement}`));
 if(revision!==contract.contentRevision)throw Error('World content identity mismatch');
 return {contract,content:Object.freeze({...content})};
}
export function createContentVerifier(content,getHeap,onFailure=()=>{},onVerified=()=>{}) {
 const done=new Set(),pending=new Set();let failed=false;
 return {
  status:()=>!content?1:failed?-1:done.size===2?1:0,
  async verify(kind,pointer,size){
   if(!content)return;
   try {
    const key=['geometry','materials'][kind];
    if(!key||pending.has(key)||done.has(key)||failed)throw Error('Duplicate/invalid content verification');
    pending.add(key);const heap=getHeap(),at=Number(pointer);
    if(!Number.isSafeInteger(at)||at<0||!Number.isInteger(size)||size<1||size>256*1024*1024||at+size>heap.byteLength)throw Error('Invalid content byte range');
    // Copy before releasing the C++ reader; WebCrypto cannot consume SAB views.
    const bytes=new Uint8Array(size);bytes.set(heap.subarray(at,at+size));
    if(await sha256(bytes)!==content[key])throw Error(`Engine ${key} differs from server content`);
    done.add(key);onVerified(key,bytes);
   }catch(error){failed=true;onFailure(error);}
  },
 };
}
