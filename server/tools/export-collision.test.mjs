import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const exporter=new URL('./export-collision.mjs',import.meta.url).pathname;
function archive(payload,compressed=false){
 const name=Buffer.from('levels\\zaton\\level.cform'),entry=Buffer.alloc(18+name.length);
 entry.writeUInt16LE(16+name.length);entry.writeUInt32LE(payload.length+(compressed?1:0),2);entry.writeUInt32LE(payload.length,6);name.copy(entry,14);entry.writeUInt32LE(8,entry.length-4);
 const h=Buffer.alloc(8);h.writeUInt32LE(payload.length,4);const table=Buffer.alloc(8);table.writeUInt32LE(1);table.writeUInt32LE(entry.length,4);
 return Buffer.concat([h,payload,table,entry]);
}
test('extracts exact geometry, honors patch override, rejects compressed/truncated records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zone-export-'));
 try{
  const game=join(root,'game'),out=join(root,'out');await mkdir(join(game,'levels'),{recursive:true});await mkdir(join(game,'patches'));
  const data=Buffer.alloc(64);data.writeUInt32LE(4);data.writeUInt32LE(1,4);data.writeUInt32LE(1,8);
  await writeFile(join(game,'levels','base.db'),archive(data));const patch=Buffer.from(data);patch.writeFloatLE(7,12);
  await writeFile(join(game,'patches','patch.db'),archive(patch));
  execFileSync(process.execPath,[exporter,game,out],{stdio:'pipe'});
  const m=JSON.parse(await readFile(join(out,'zaton.json'),'utf8'));
  assert.equal(m.sha256,createHash('sha256').update(patch).digest('hex'));assert.equal(m.source.archive,'patches/patch.db');
  assert.deepEqual(await readFile(join(out,m.sha256+'.cform')),patch);
  await writeFile(join(game,'patches','patch.db'),archive(patch,true));
  assert.throws(()=>execFileSync(process.execPath,[exporter,game,out],{stdio:'pipe'}),/Compressed CFORM/);
  await writeFile(join(game,'patches','patch.db'),archive(patch).subarray(0,20));
  assert.throws(()=>execFileSync(process.execPath,[exporter,game,out],{stdio:'pipe'}),/Invalid archive chunk/);
 }finally{await rm(root,{recursive:true,force:true});}
});
