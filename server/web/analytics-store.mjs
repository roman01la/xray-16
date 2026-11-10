import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isMainThread,parentPort,Worker,workerData} from 'node:worker_threads';

export const analyticsEvents = new Set(['visit','install','start_game','new_campaign','load_save']);
const visitGap = 30 * 60 * 1000;

export function openAnalytics(database) {
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS analytics_browsers (
      id TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      browser_id TEXT NOT NULL REFERENCES analytics_browsers(id),
      event TEXT NOT NULL CHECK (event IN ('visit','install','start_game','new_campaign','load_save')),
      received_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS analytics_first_install
      ON analytics_events(browser_id) WHERE event='install';
    CREATE INDEX IF NOT EXISTS analytics_event_counts ON analytics_events(event,browser_id);
  `);
  const findBrowser = db.prepare('SELECT last_seen FROM analytics_browsers WHERE id=?');
  const addBrowser = db.prepare('INSERT INTO analytics_browsers VALUES (?,?,?)');
  const touchBrowser = db.prepare('UPDATE analytics_browsers SET last_seen=max(last_seen,?) WHERE id=?');
  const findEvent = db.prepare('SELECT 1 FROM analytics_events WHERE id=?');
  const addEvent = db.prepare('INSERT OR IGNORE INTO analytics_events VALUES (?,?,?,?)');
  const browserCount = db.prepare('SELECT count(*) AS total FROM analytics_browsers');
  const eventCounts = db.prepare(`
    SELECT event, count(*) AS total, count(DISTINCT browser_id) AS browsers
    FROM analytics_events GROUP BY event
  `);
  return {
    record({browserId,eventId,event}, now = Date.now()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!findEvent.get(eventId)) {
          const browser = findBrowser.get(browserId);
          if (!browser) {
            addBrowser.run(browserId,now,now);
            // Parallel requests can deliver a milestone before its visit.
            if (event !== 'visit') addEvent.run(randomUUID(),browserId,'visit',now);
          } else touchBrowser.run(now,browserId);
          if (event !== 'visit' || !browser || now - browser.last_seen >= visitGap)
            addEvent.run(eventId,browserId,event,now);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    summary() {
      return {browsers:browserCount.get().total,events:eventCounts.all()};
    },
    close() {db.close();},
  };
}

export function startAnalytics(database) {
  // SQLite's synchronous API runs off the gateway's HTTP event loop.
  const worker = new Worker(new URL(import.meta.url), {workerData:{analyticsDatabase:database},env:{}});
  const pending = new Map();
  let sequence = 0, stopped = false;
  const unavailable = () => Object.assign(Error('Analytics storage unavailable'), {status:503});
  const stop = () => {
    stopped = true;
    for (const {reject} of pending.values()) reject(unavailable());
    pending.clear();
  };
  worker.on('message',({id,result,error}) => {
    const reply = pending.get(id);
    if (!reply) return;
    pending.delete(id);
    if (error) reply.reject(unavailable());
    else reply.resolve(result);
  });
  worker.on('error',() => {console.error('Analytics storage unavailable');stop();});
  worker.on('exit',stop);
  function request(operation,event) {
    if (stopped || pending.size >= 128) return Promise.reject(unavailable());
    return new Promise((resolve,reject) => {
      const id = ++sequence;
      pending.set(id,{resolve,reject});
      worker.postMessage({id,operation,event});
    });
  }
  return {request,close() {stop();return worker.terminate();}};
}

if (!isMainThread && typeof workerData?.analyticsDatabase === 'string') {
  const store = openAnalytics(workerData.analyticsDatabase);
  parentPort.on('message',({id,operation,event}) => {
    try {
      const result = operation === 'record' ? store.record(event) : store.summary();
      parentPort.postMessage({id,result});
    } catch {
      parentPort.postMessage({id,error:true});
    }
  });
}
