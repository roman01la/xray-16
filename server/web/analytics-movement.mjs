export const movementMapId = /^[a-z0-9_]{1,64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function validMovementData(data, now = Date.now()) {
  if (!data || Object.keys(data).sort().join() !== 'points,release,sessionId' ||
      !uuid.test(data.sessionId) || !/^[a-f0-9]{64}$/.test(data.release) ||
      !Array.isArray(data.points) || !data.points.length || data.points.length > 6) return false;
  let previous = 0;
  for (const p of data.points) {
    if (!p || Object.keys(p).sort().join() !== 'map,t,x,y,z' || !movementMapId.test(p.map) ||
        !Number.isSafeInteger(p.t) || p.t <= previous || p.t > now + 300000 ||
        !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 1000000)) return false;
    previous = p.t;
  }
  return true;
}

// Persist before sending. Stable event and sample IDs make retries idempotent.
export function createMovementTracker({gameId, sessionId, release, send, storage, newId = () => crypto.randomUUID()}) {
  const prefix = 'xray-analytics-movement-v1:' + gameId + ':';
  const key = prefix + sessionId;
  let queue = [], sending = false;
  try {
    const saved = JSON.parse(storage.getItem(key) || '[]');
    if (Array.isArray(saved)) queue = saved.filter(b => uuid.test(b.id) && validMovementData(b.data)).slice(-120);
  } catch {}
  const persist = () => { try { storage.setItem(key, JSON.stringify(queue)); } catch {} };
  return {
    add(point) {
      if (!validMovementData({sessionId, release, points:[point]})) return;
      let batch = queue.at(-1);
      if (!batch || batch.sealed || batch.data.sessionId !== sessionId || batch.data.points.length === 6) {
        batch = {id:newId(), data:{sessionId, release, points:[]}};
        queue.push(batch);
        if (queue.length > 120) queue.shift();
      }
      if (point.t <= (batch.data.points.at(-1)?.t ?? 0)) return;
      batch.data.points.push(point);
      persist();
    },
    async flush() {
      if (sending) return;
      sending = true;
      queue.forEach(batch => { batch.sealed = true; });
      persist();
      try {
        for (const batch of [...queue]) {
          if (!await send('movement', batch.id, batch.data)) break;
          queue = queue.filter(entry => entry.id !== batch.id);
          persist();
        }
        // Other tabs own their session keys. Recover completed/offline batches
        // only if the stored snapshot is unchanged after acknowledgment.
        const keys = [];
        for (let i=0;i<storage.length;i++) {
          const other=storage.key(i);
          if (other!==key && other?.startsWith(prefix)) keys.push(other);
        }
        for (const other of keys) {
          const snapshot=storage.getItem(other);
          let batches;
          try { batches=JSON.parse(snapshot); } catch { continue; }
          if (!Array.isArray(batches) || batches.length>120 ||
              !batches.every(b=>uuid.test(b.id)&&validMovementData(b.data))) continue;
          let delivered=true;
          for (const batch of batches) {
            if (!await send('movement',batch.id,batch.data)) { delivered=false; break; }
          }
          if (delivered && storage.getItem(other)===snapshot) storage.removeItem(other);
        }
      } catch {
        // Unavailable storage or a failed request can be retried next minute.
      } finally { sending = false; }
    },
  };
}
