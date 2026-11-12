import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSaveBackup, readSaveBackup, restoreSaveBackup, recoverSaveImport, importSaveBackup,
  acquireSaveSession, encodeBytes } from '../page/save-format.js';

function save(seed=17) {
  const bytes=new Uint8Array(48);const view=new DataView(bytes.buffer);
  view.setUint32(0,0xffffffff,true);view.setUint32(4,7,true);view.setUint32(8,4096,true);
  bytes.fill(seed,12);return bytes;
}
function thumbnail() {
  const bytes=new Uint8Array(144);const view=new DataView(bytes.buffer);
  view.setUint32(0,0x20534444,true);view.setUint32(4,124,true);return bytes;
}
function directory(initial={},fail=()=>false) {
  const data=new Map(Object.entries(initial).map(([name,value])=>[name,new Blob([value])]));
  const writes=[];
  const dir={data,writes,
    async *entries(){for(const name of data.keys())yield [name,{kind:'file',getFile:async()=>data.get(name)}];},
    async getFileHandle(name,{create=false}={}){
      if(!data.has(name)){if(!create)throw new DOMException('Missing','NotFoundError');data.set(name,new Blob());}
      return {getFile:async()=>data.get(name),createWritable:async()=>{
        let pending;
        return {async write(value){writes.push(name);if(fail(name))throw Error('disk full');pending=new Blob([value]);},
          async close(){data.set(name,pending);},async abort(){}};
      }};
    },
    async removeEntry(name){if(!data.delete(name))throw new DOMException('Missing','NotFoundError');},
  };
  return dir;
}
const doc=files=>new Blob([JSON.stringify({format:'openxray-saves-v1',files})]);
const entry=(name,bytes=save())=>({name,data:encodeBytes(bytes)});

test('export/import round trip keeps save and thumbnail bytes and preserves conflicting pairs',async()=>{
  const source=directory({'quicksave.scop':save(),'quicksave.dds':thumbnail(),'new.scop':save(23)});
  const exported=await prepareSaveBackup(source);
  const files=await readSaveBackup(exported.blob);
  const damaged=JSON.parse(await exported.blob.text());
  damaged.files[0].data=encodeBytes(save(21));
  await assert.rejects(readSaveBackup(new Blob([JSON.stringify(damaged)])),/checksum failed/);

  const target=directory({'QUICKSAVE.SCOP':save(99),'unrelated.scop':save(35)});
  assert.deepEqual(await restoreSaveBackup(target,files),{imported:1,skipped:1});
  assert.deepEqual(new Uint8Array(await target.data.get('new.scop').arrayBuffer()),save(23));
  assert.deepEqual(new Uint8Array(await target.data.get('QUICKSAVE.SCOP').arrayBuffer()),save(99));
  assert(!target.data.has('quicksave.dds'));assert(target.data.has('unrelated.scop'));
  assert(!target.data.has('.xray-save-import.json'));
  const empty=directory();
  assert.deepEqual(await restoreSaveBackup(empty,files),{imported:2,skipped:0});
  assert.deepEqual(new Uint8Array(await empty.data.get('quicksave.dds').arrayBuffer()),thumbnail());
});

test('invalid entries anywhere in a backup are rejected before OPFS is touched',async()=>{
  const invalids=[null,entry('../escape.scop'),entry('x.txt'),entry('broken.scop',new Uint8Array(16)),
    entry('broken.dds',new Uint8Array(128)),{name:'bad.scop',data:'bad!'},entry('VALID.SCOP')];
  for(const invalid of invalids)await assert.rejects(readSaveBackup(doc([entry('valid.scop'),invalid])));
  await assert.rejects(readSaveBackup({size:128*1024*1024+1,text(){throw Error('must not read');}}),/128 MB/);
  await assert.rejects(readSaveBackup(doc([entry('only.dds',thumbnail())])),/no saved games/);
  const bomb=save();new DataView(bomb.buffer).setUint32(8,0xffffffff,true);
  await assert.rejects(readSaveBackup(doc([entry('bomb.scop',bomb)])),/Invalid saved game/);
});

test('save backups are scoped to the campaign and old backups remain valid for CoP',async()=>{
  for (const gameId of ['soc', 'cs']) {
    const backup=await prepareSaveBackup(directory({'quicksave.scop':save()}),gameId);
    assert.equal((await readSaveBackup(backup.blob,gameId)).length,1);
    await assert.rejects(readSaveBackup(backup.blob),/belongs to another game/);
  }
  const legacy=doc([entry('quicksave.scop')]);
  assert.equal((await readSaveBackup(legacy)).length,1);
  await assert.rejects(readSaveBackup(legacy,'soc'),/belongs to another game/);
});

test('legacy campaign saves retain their extension and thumbnail on backup and restore', async () => {
  const backup = await prepareSaveBackup(directory({'player - quicksave.sav':save(), 'player - quicksave.dds':thumbnail()}), 'cs');
  const files = await readSaveBackup(backup.blob, 'cs');
  const target = directory();
  assert.deepEqual(await restoreSaveBackup(target, files), {imported:1, skipped:0});
  assert.deepEqual(new Uint8Array(await target.data.get('player - quicksave.sav').arrayBuffer()), save());
  assert(target.data.has('player - quicksave.dds'));
  const existing = directory({'player - quicksave.scop':save(18)});
  assert.deepEqual(await restoreSaveBackup(existing, files), {imported:0, skipped:1});
});

test('failed file writes roll back every new file and preserve existing saves',async()=>{
  const target=directory({'existing.scop':save(77)},name=>name==='second.scop');
  const files=await readSaveBackup(doc([entry('first.scop'),entry('second.scop')]));
  await assert.rejects(restoreSaveBackup(target,files),/disk full/);
  assert.deepEqual([...target.data.keys()],['existing.scop']);
  assert.deepEqual(new Uint8Array(await target.data.get('existing.scop').arrayBuffer()),save(77));
  const noJournal=directory({},name=>name==='.xray-save-import.json');
  await assert.rejects(restoreSaveBackup(noJournal,files),/disk full/);
  assert.equal(noJournal.data.size,0);
});

test('interrupted imports recover before launch and do not touch unrelated files',async()=>{
  const target=directory({'existing.scop':save(77),'partial.scop':save(),
    '.xray-save-import.json':JSON.stringify({format:'openxray-save-import-v1',names:['partial.scop','missing.dds']})});
  await recoverSaveImport(target);assert.deepEqual([...target.data.keys()],['existing.scop']);
  await recoverSaveImport(target); // repeated recovery is harmless
  const emptyJournal=directory({".xray-save-import.json":"","existing.scop":save()});
  await recoverSaveImport(emptyJournal);assert.deepEqual([...emptyJournal.data.keys()],["existing.scop"]);
  const malformed=directory({'.xray-save-import.json':JSON.stringify({format:'openxray-save-import-v1',names:['../existing.scop']}),
    'existing.scop':save()});
  await assert.rejects(recoverSaveImport(malformed));assert(malformed.data.has('existing.scop'));
});

test('import and engine session exclude each other and release after unload',async()=>{
  const target=directory();let held=false;
  const root={getDirectoryHandle:async()=>root,...target};
  root.getDirectoryHandle=async()=>root;
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{
    storage:{getDirectory:async()=>root},
    locks:{async request(name,options,callback){
      if(held)return callback(null);held=true;try{return await callback({name});}finally{held=false;}
    }},
  }});
  try{
    const release=await acquireSaveSession('stream-cop');
    await assert.rejects(importSaveBackup('stream-cop',doc([entry('new.scop')])),/Close other game tabs/);
    assert.equal(target.data.size,0);
    release();await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(await importSaveBackup('stream-cop',doc([entry('new.scop')])),{imported:1,skipped:0});
    await assert.rejects(importSaveBackup('../escape',doc([entry('new.scop')])),/Select a game/);
  }finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});
