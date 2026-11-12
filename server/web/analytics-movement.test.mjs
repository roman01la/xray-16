import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMovementTracker,validMovementData} from './analytics-movement.mjs';
import {validateAnalyticsEvent} from './analytics-http.mjs';

function storage() {
  const data=new Map();
  return {get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
}
const point=(t=10000,map='l01_escape')=>({t,map,x:30,y:2,z:-100});

test('six 10-second samples form a single batch and retry with stable identity',async()=>{
  const local=storage(),sessionId=randomUUID(),sent=[];
  let online=false;
  const track=createMovementTracker({gameId:'soc',sessionId,release:'a'.repeat(64),storage:local,send:async(...args)=>{sent.push(structuredClone(args));return online;}});
  for(let i=1;i<=6;i++)track.add(point(i*10000));
  assert.equal(sent.length,0);
  await track.flush();assert.equal(sent.length,1);assert.equal(sent[0][2].points.length,6);
  track.add(point(70000,'l02_garbage'));
  online=true;await track.flush();
  assert.deepEqual(sent[1],sent[0]);assert.equal(sent[2][2].points[0].map,'l02_garbage');
  assert.equal(JSON.parse(local.getItem(local.key(0))).length,0);
});

test('a new session recovers pending samples without overwriting another tab',async()=>{
  const local=storage(),sent=[];
  const make=(send)=>createMovementTracker({gameId:'soc',sessionId:randomUUID(),release:'a'.repeat(64),storage:local,send});
  const old=make(async()=>false);old.add(point());await old.flush();
  const current=make(async(...args)=>{sent.push(args);return true;});current.add(point(20000));await current.flush();
  assert.equal(sent.length,2);assert.notEqual(sent[0][2].sessionId,sent[1][2].sessionId);
  const cop=createMovementTracker({gameId:'cop',sessionId:randomUUID(),release:'a'.repeat(64),storage:local,send:async()=>assert.fail('other campaign was sent')});
  cop.add(point());
  await current.flush();assert.equal(local.length,2);
});

test('movement ingestion validates timestamps, coordinates, map IDs and batch bounds',()=>{
  const data={sessionId:randomUUID(),release:'a'.repeat(64),points:[point()]};
  const payload={event:'movement',gameId:'soc',browserId:randomUUID(),eventId:randomUUID(),data};
  assert.ok(validateAnalyticsEvent(payload));
  for(const p of [{...point(),x:NaN},{...point(),z:Infinity},{...point(),map:'../unsafe'},{...point(),t:Date.now()+600000}])assert.equal(validMovementData({...data,points:[p]}),false);
  assert.equal(validMovementData({...data,points:[point(),point()]}),false);
  assert.equal(validMovementData({...data,points:Array.from({length:7},(_,i)=>point(i+1))}),false);
  assert.equal(validMovementData({...data,points:[]}),false);
});
