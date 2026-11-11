const performanceQuery = `SELECT coalesce(json_extract(d.data,'$.os'),'Unknown') AS os,coalesce(json_extract(d.data,'$.browser'),'Unknown') AS browser,
        coalesce(nullif(json_extract(d.data,'$.gpuDescription'),''),nullif(json_extract(d.data,'$.gpuDevice'),''),nullif(json_extract(d.data,'$.gpuVendor'),''),'Unknown') AS gpu,
        json_extract(d.data,'$.cores') AS cores,json_extract(p.data,'$.vsync') AS vsync,json_extract(p.data,'$.fpsCap') AS cap,
        json_extract(p.data,'$.width') AS width,json_extract(p.data,'$.height') AS height,
        count(DISTINCT p.browser_id) AS users,count(*) AS samples,
        sum(json_extract(p.data,'$.frames'))*1000.0/sum(json_extract(p.data,'$.elapsedMs')) AS fps,
        sum(json_extract(p.data,'$.elapsedMs'))/60000.0 AS minutes,
        avg(json_extract(p.data,'$.p95Ms')) AS p95, max(json_extract(p.data,'$.maxMs')) AS worst,
        sum(json_extract(p.data,'$.stalls100')) AS stalls
        FROM analytics_performance p LEFT JOIN analytics_devices d ON d.browser_id=p.browser_id AND d.session_id=p.session_id
        WHERE p.received_at >= ? GROUP BY os,browser,gpu,cores,vsync,cap,width,height ORDER BY minutes DESC LIMIT 200`;
export async function record(db,{browserId,eventId,event,data},now=Date.now()) {
  const q=(sql,...values)=>db.prepare(sql).bind(...values);
  if(event==='device')return q('INSERT INTO analytics_devices VALUES (?,?,?,?) ON CONFLICT(browser_id,session_id) DO UPDATE SET received_at=excluded.received_at,data=excluded.data',browserId,data.sessionId,now,JSON.stringify(data)).run();
  if(event==='performance')return q('INSERT OR IGNORE INTO analytics_performance VALUES (?,?,?,?,?)',eventId,browserId,data.sessionId,now,JSON.stringify(data)).run();
  const statements=[q('INSERT OR IGNORE INTO analytics_browsers VALUES (?,?,?)',browserId,now,now)];
  // D1 batches execute atomically; predicates run against preceding statements.
  if(event!=='visit')statements.push(q(`INSERT OR IGNORE INTO analytics_events SELECT ?,?,'visit',? WHERE NOT EXISTS (SELECT 1 FROM analytics_events WHERE browser_id=?)`,crypto.randomUUID(),browserId,now,browserId));
  if(event==='visit')statements.push(q(`INSERT OR IGNORE INTO analytics_events SELECT ?,?,'visit',? WHERE NOT EXISTS (SELECT 1 FROM analytics_events WHERE browser_id=?) OR (SELECT last_seen FROM analytics_browsers WHERE id=?)<=?`,eventId,browserId,now,browserId,browserId,now-30*60000));
  else statements.push(q('INSERT OR IGNORE INTO analytics_events VALUES (?,?,?,?)',eventId,browserId,event,now));
  statements.push(q(`UPDATE analytics_browsers SET last_seen=max(last_seen,?) WHERE id=? AND (NOT EXISTS (SELECT 1 FROM analytics_events WHERE id=?) OR EXISTS (SELECT 1 FROM analytics_events WHERE id=? AND received_at=?))`,now,browserId,eventId,eventId,now));
  return db.batch(statements);
}
export async function summary(db,now=Date.now()) {
  const rows=await db.batch([
    db.prepare('SELECT count(*) AS total FROM analytics_browsers'),
    db.prepare('SELECT event,count(*) AS total,count(DISTINCT browser_id) AS browsers FROM analytics_events GROUP BY event'),
    db.prepare('SELECT data,received_at FROM analytics_devices ORDER BY received_at DESC LIMIT 200'),
    db.prepare(performanceQuery).bind(now-30*86400000),
  ]);
  return {browsers:rows[0].results[0].total,events:rows[1].results,devices:rows[2].results,performance:rows[3].results};
}
export async function prune(db,now=Date.now()) {
  // Hourly batches avoid scanning/deleting old samples on every event request.
  return db.batch(['analytics_performance','analytics_devices'].map(table=>db.prepare(`DELETE FROM ${table} WHERE received_at<?`).bind(now-30*86400000)));
}
