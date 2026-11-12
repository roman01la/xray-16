import {playtimeQueries} from '../web/analytics-playtime.mjs';
import {analyticsGames} from '../web/analytics-events.mjs';

// Keep the existing CoP tables compatible with the live Worker during rollout.
const tablePrefix = gameId => {
  if (!analyticsGames.has(gameId ?? 'cop')) throw Error('Unknown analytics game');
  return !gameId || gameId === 'cop' ? 'analytics' : 'analytics_' + gameId;
};
const positionTable = gameId => gameId === 'cs' ? 'analytics_cs_positions' : 'analytics_positions';
const performanceQuery = prefix => `SELECT coalesce(json_extract(d.data,'$.os'),'Unknown') AS os,coalesce(json_extract(d.data,'$.browser'),'Unknown') AS browser,
        coalesce(nullif(json_extract(d.data,'$.gpuDescription'),''),nullif(json_extract(d.data,'$.gpuDevice'),''),nullif(json_extract(d.data,'$.gpuVendor'),''),'Unknown') AS gpu,
        json_extract(d.data,'$.cores') AS cores,json_extract(p.data,'$.vsync') AS vsync,json_extract(p.data,'$.fpsCap') AS cap,
        json_extract(p.data,'$.width') AS width,json_extract(p.data,'$.height') AS height,
        count(DISTINCT p.browser_id) AS users,count(*) AS samples,
        sum(json_extract(p.data,'$.frames'))*1000.0/sum(json_extract(p.data,'$.elapsedMs')) AS fps,
        sum(json_extract(p.data,'$.elapsedMs'))/60000.0 AS minutes,
        avg(json_extract(p.data,'$.p95Ms')) AS p95, max(json_extract(p.data,'$.maxMs')) AS worst,
        sum(json_extract(p.data,'$.stalls100')) AS stalls
        FROM ${prefix}_performance p LEFT JOIN ${prefix}_devices d ON d.browser_id=p.browser_id AND d.session_id=p.session_id
        WHERE p.received_at >= ? GROUP BY os,browser,gpu,cores,vsync,cap,width,height ORDER BY minutes DESC LIMIT 200`;
export async function record(db,{browserId,eventId,event,data,gameId},now=Date.now()) {
  const prefix=tablePrefix(gameId);
  const events=`${prefix}_events`, browsers=`${prefix}_browsers`;
  const q=(sql,...values)=>db.prepare(sql).bind(...values);
  if(event==='movement') return db.batch(data.points.map(p => q(
    `INSERT OR IGNORE INTO ${positionTable(gameId)} VALUES (?,?,?,?,?,?,?,?,?)`,
    gameId ?? 'cop',browserId,data.sessionId,p.t,p.map,p.x,p.y,p.z,now)));
  if(event==='playtime')return q(playtimeQueries(`${prefix}_playtime`).playtimeUpsert,browserId,data.sessionId,data.elapsedMs,now).run();
  if(event==='device')return q(`INSERT INTO ${prefix}_devices VALUES (?,?,?,?) ON CONFLICT(browser_id,session_id) DO UPDATE SET received_at=excluded.received_at,data=excluded.data`,browserId,data.sessionId,now,JSON.stringify(data)).run();
  if(event==='performance')return q(`INSERT OR IGNORE INTO ${prefix}_performance VALUES (?,?,?,?,?)`,eventId,browserId,data.sessionId,now,JSON.stringify(data)).run();
  const statements=[q(`INSERT OR IGNORE INTO ${browsers} VALUES (?,?,?)`,browserId,now,now)];
  // D1 batches execute atomically; predicates run against preceding statements.
  if(event!=='visit')statements.push(q(`INSERT OR IGNORE INTO ${events} SELECT ?,?,'visit',? WHERE NOT EXISTS (SELECT 1 FROM ${events} WHERE browser_id=?)`,crypto.randomUUID(),browserId,now,browserId));
  if(event==='visit')statements.push(q(`INSERT OR IGNORE INTO ${events} SELECT ?,?,'visit',? WHERE NOT EXISTS (SELECT 1 FROM ${events} WHERE browser_id=?) OR (SELECT last_seen FROM ${browsers} WHERE id=?)<=?`,eventId,browserId,now,browserId,browserId,now-30*60000));
  else statements.push(q(`INSERT OR IGNORE INTO ${events} VALUES (?,?,?,?)`,eventId,browserId,event,now));
  statements.push(q(`UPDATE ${browsers} SET last_seen=max(last_seen,?) WHERE id=? AND (NOT EXISTS (SELECT 1 FROM ${events} WHERE id=?) OR EXISTS (SELECT 1 FROM ${events} WHERE id=? AND received_at=?))`,now,browserId,eventId,eventId,now));
  return db.batch(statements);
}
export async function summary(db,now=Date.now(),gameId='cop') {
  const prefix=tablePrefix(gameId);
  const {playtimeSummary,playtimeUsers}=playtimeQueries(`${prefix}_playtime`);
  const rows=await db.batch([
    db.prepare(`SELECT count(*) AS total FROM ${prefix}_browsers`),
    db.prepare(`SELECT event,count(*) AS total,count(DISTINCT browser_id) AS browsers FROM ${prefix}_events GROUP BY event`),
    db.prepare(`SELECT data,received_at FROM ${prefix}_devices ORDER BY received_at DESC LIMIT 200`),
    db.prepare(performanceQuery(prefix)).bind(now-30*86400000),
    db.prepare(playtimeSummary),db.prepare(playtimeUsers),
  ]);
  return {browsers:rows[0].results[0].total,events:rows[1].results,devices:rows[2].results,performance:rows[3].results,playtime:rows[4].results[0],playtimeUsers:rows[5].results};
}
export async function prune(db,now=Date.now()) {
  // Hourly batches avoid scanning/deleting old samples on every event request.
  return db.batch([...[...analyticsGames.keys()].flatMap(gameId => ['performance','devices'].map(table =>
    db.prepare(`DELETE FROM ${tablePrefix(gameId)}_${table} WHERE received_at<?`).bind(now-30*86400000),
  )), ...['analytics_positions','analytics_cs_positions'].map(table=>db.prepare(`DELETE FROM ${table} WHERE received_at<?`).bind(now-30*86400000))]);
}

export async function tracks(db, gameId, {browserId,sessionId,after=0} = {}) {
  if (!browserId) {
    const result = await db.prepare(`SELECT browser_id,count(*) AS samples,max(sampled_at) AS last_seen
      FROM ${positionTable(gameId)} WHERE game_id=? GROUP BY browser_id ORDER BY last_seen DESC LIMIT 200`).bind(gameId).all();
    return {users:result.results};
  }
  if (!sessionId) {
    const result = await db.prepare(`SELECT session_id,min(sampled_at) AS first_seen,max(sampled_at) AS last_seen,count(*) AS samples
      FROM ${positionTable(gameId)} WHERE game_id=? AND browser_id=? GROUP BY session_id ORDER BY last_seen DESC LIMIT 200`).bind(gameId,browserId).all();
    return {sessions:result.results};
  }
  const result = await db.prepare(`SELECT sampled_at AS t,map,x,y,z FROM ${positionTable(gameId)}
    WHERE game_id=? AND browser_id=? AND session_id=? AND sampled_at>?
    ORDER BY sampled_at LIMIT 1001`).bind(gameId,browserId,sessionId,after).all();
  const points = result.results.slice(0,1000);
  return {points,next:result.results.length>1000 ? points.at(-1).t : null};
}
