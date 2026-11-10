import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openAnalytics} from './analytics-store.mjs';
import {createGateway} from './gateway.mjs';

const event = (kind,browserId) => ({event:kind,browserId,eventId:randomUUID()});

test('visits roll after inactivity, installs are unique and repeated gameplay is counted',() => {
  const db = openAnalytics(':memory:');
  try {
    const a = randomUUID(), b = randomUUID(), minute = 60000;
    const start = event('start_game',a);
    db.record(event('visit',a),0);
    db.record(event('visit',a),minute);
    db.record(start,20*minute);
    db.record(start,21*minute);
    db.record(event('visit',a),40*minute);
    db.record(event('visit',a),70*minute);
    db.record(event('install',a),71*minute);
    db.record(event('install',a),72*minute);
    db.record(event('load_save',a),73*minute);
    db.record(event('load_save',a),74*minute);
    db.record(event('load_save',b),74*minute);
    db.record(event('visit',b),75*minute);
    db.record(event('new_campaign',b),76*minute);
    const {browsers,events} = db.summary();
    assert.equal(browsers,2);
    assert.deepEqual(Object.fromEntries(events.map(row=>[row.event,[row.browsers,row.total]])),{
      visit:[2,3], install:[1,1], start_game:[1,1], new_campaign:[1,1], load_save:[2,3],
    });
  } finally {db.close();}
});

test('gateway protects every dashboard read and persists accepted milestones',async () => {
  const root = await mkdtemp(join(tmpdir(),'zone-analytics-'));
  const origin = 'https://game.example', password = 'isolated-analytics-test';
  const options = {root,origin,token:'isolated-gateway-token'};
  let server;
  async function listen(analyticsPassword) {
    server = await createGateway({...options,analyticsPassword});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return 'http://127.0.0.1:'+server.address().port;
  }
  async function close() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    server = undefined;
  }
  const auth = {Authorization:'Basic '+Buffer.from('analytics:'+password).toString('base64')};
  const wrongAuth = {Authorization:'Basic '+Buffer.from('analytics:wrong').toString('base64')};
  const a = randomUUID();
  try {
    let base = await listen(password);
    const dashboard = () => fetch(base+'/analytics',{headers:auth});
    const send = (body,headers={}) => fetch(base+'/analytics/event',{
      method:'POST', headers:{Origin:origin,'Content-Type':'application/json',...headers},
      body:JSON.stringify(body),
    });
    const guest = await fetch(base+'/analytics');
    assert.equal(guest.status,401);
    assert.match(guest.headers.get('www-authenticate'),/^Basic /);
    assert.doesNotMatch(await guest.text(),/Successful save loads/);
    assert.equal((await fetch(base+'/analytics/',{method:'HEAD'})).status,401);
    assert.equal((await fetch(base+'/analytics',{headers:{Authorization:'Bearer '+options.token}})).status,401);
    assert.equal((await fetch(base+'/analytics/event')).status,405);
    assert.equal((await send(event('visit',a),{Origin:'https://foreign.example'})).status,403);
    assert.equal((await send(event('visit',a),{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await send(event('visit',a),{'Content-Type':'text/plain'})).status,415);
    assert.equal((await send({...event('visit',a),saveName:'personal save'})).status,400);
    assert.equal((await send({...event('visit',a),eventId:'x'.repeat(1200)})).status,413);
    assert.equal((await send(event('unexpected',a))).status,400);
    const accepted = ['visit','visit','install','install','start_game','new_campaign','load_save','load_save'];
    await Promise.all(accepted.map(async kind=>assert.equal((await send(event(kind,a))).status,204)));
    const response = await dashboard();
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    const page = await response.text();
    assert.match(page,/Unique browsers <strong>1<\/strong>/);
    assert.match(page,/First completed game installs<\/th><td>1<\/td><td>1<\/td>/);
    assert.match(page,/Successful save loads<\/th><td>1<\/td><td>2<\/td>/);
    assert.ok(!page.includes(a)&&!page.includes(password));
    assert.equal((await fetch(base+'/analytics.sqlite')).status,404);
    assert.equal((await fetch(base+'/analytics',{method:'HEAD',headers:auth})).status,200);
    const attackingIp = {'Fly-Client-IP':'192.0.2.9'};
    for (let i=0;i<8;i++)
      assert.equal((await fetch(base+'/analytics',{headers:{...wrongAuth,...attackingIp}})).status,401);
    const throttled = await fetch(base+'/analytics',{headers:{...auth,...attackingIp}});
    assert.equal(throttled.status,429);
    assert.ok(throttled.headers.get('retry-after'));
    let distributedStatus;
    for (let i=1;i<=61&&distributedStatus!==429;i++){
      const headers = {...wrongAuth,'Fly-Client-IP':'198.51.100.'+i};
      distributedStatus = (await fetch(base+'/analytics',{headers})).status;
    }
    assert.equal(distributedStatus,429);
    await close();
    base = await listen(password);
    assert.equal(await (await dashboard()).text(),page);
    await close();
    base = await listen('');
    assert.equal((await dashboard()).status,404);
    assert.equal((await send(event('visit',a))).status,404);
  } finally {
    await close();
    await rm(root,{recursive:true,force:true});
  }
});
