// Session checkpoints are cumulative: retries and out-of-order delivery cannot double-count.
export function playtimeQueries(table) {
  return {
    playtimeUpsert: `INSERT INTO ${table} VALUES (?,?,?,?)
ON CONFLICT(browser_id,session_id) DO UPDATE SET elapsed_ms=max(elapsed_ms,excluded.elapsed_ms),received_at=max(received_at,excluded.received_at)`,
    playtimeSummary: `SELECT coalesce(sum(elapsed_ms),0) AS totalMs,count(DISTINCT browser_id) AS players FROM ${table}`,
    playtimeUsers: `SELECT browser_id,sum(elapsed_ms) AS elapsed_ms,count(*) AS sessions FROM ${table} GROUP BY browser_id ORDER BY elapsed_ms DESC,browser_id LIMIT 200`,
  };
}
export const {playtimeUpsert,playtimeSummary,playtimeUsers} = playtimeQueries('analytics_playtime');
