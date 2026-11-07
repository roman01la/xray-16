import {loadIdentity,readRecord,writeRecord} from './identity.mjs';
import {ZoneClient} from './client.mjs';
const $=id=>document.getElementById(id),log=s=>{$('results').textContent+=s+'\n';},pause=ms=>new Promise(r=>setTimeout(r,ms));
let clients=[];const stop=()=>{clients.forEach(c=>c.close());clients=[];};addEventListener('pagehide',stop);
async function connect(identity){const c=new ZoneClient();clients.push(c);await c.connect({identitySecret:identity.secret,contract:(await (await fetch('/world.json')).json()).contract});return c;}
async function run(action){$('run').disabled=$('verify').disabled=true;$('results').textContent='';try{await action();$('status').textContent='PASS';}catch(e){$('status').textContent='FAIL';log(e.message);}finally{stop();$('run').disabled=$('verify').disabled=false;}}
$('run').onclick=()=>run(async()=>{
 const identity=await loadIdentity('foundation-test');log('Stable principal: '+identity.principalId);
 const a=await connect(identity);if(a.principalId!==identity.principalId)throw Error('Welcome identity mismatch');
 const b=new ZoneClient();clients.push(b);let rejected=false;try{await b.connect({identitySecret:identity.secret,contract:a.contract});}catch(e){rejected=e.message==='identity already connected';}if(!rejected)throw Error('Duplicate session was not rejected');log('PASS · duplicate active identity rejected');
 a.close();const start=performance.now();while((await (await fetch('/metrics')).json()).metrics.players){if(performance.now()-start>5000)throw Error('Disconnect did not release session');await pause(50);}
 const c=await connect(identity);if(c.principalId!==identity.principalId||c.playerId===a.playerId)throw Error('Reconnect identity/transport isolation failed');log('PASS · reconnect retained principal with a fresh transport');
 const before=await readRecord(identity),mutation={requestId:crypto.randomUUID(),expectedRevision:before.revision,value:{fixture:'foundation',nonce:crypto.randomUUID()}};
 const committed=await writeRecord(identity,mutation);if(committed.status!=='committed')throw Error('Mutation failed');
 const replay=await writeRecord(identity,mutation);if(JSON.stringify(committed)!==JSON.stringify(replay))throw Error('Replay result changed');
 const conflict=await writeRecord(identity,{...mutation,requestId:crypto.randomUUID()});if(conflict.status!=='conflict')throw Error('Stale revision accepted');
 const record=await readRecord(identity);if(record.revision!==before.revision+1||JSON.stringify(record.value)!==JSON.stringify(mutation.value))throw Error('Record mismatch');
 localStorage.setItem('zone-foundation-test-expected',JSON.stringify({principalId:identity.principalId,...record,mutation,committed}));
 log('PASS · durable commit, exact replay and stale-revision conflict');log('Saved expected revision '+record.revision+' for restart verification');
});
$('verify').onclick=()=>run(async()=>{
 const expected=JSON.parse(localStorage.getItem('zone-foundation-test-expected')||'null');if(!expected)throw Error('Run the identity test first');
 const identity=await loadIdentity('foundation-test'),record=await readRecord(identity);if(identity.principalId!==expected.principalId||record.revision!==expected.revision||JSON.stringify(record.value)!==JSON.stringify(expected.value))throw Error('Restart state mismatch');
 const replay=await writeRecord(identity,expected.mutation);if(JSON.stringify(replay)!==JSON.stringify(expected.committed))throw Error('Restart replay mismatch');
 const c=await connect(identity);if(c.principalId!==expected.principalId)throw Error('Restart welcome mismatch');log('PASS · identity, durable record and original replay result survived restart');
});
