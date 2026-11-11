// Session checkpoints are cumulative: retries and out-of-order delivery cannot double-count.
export const playtimeUpsert = `INSERT INTO analytics_playtime VALUES (?,?,?,?)
ON CONFLICT(browser_id,session_id) DO UPDATE SET elapsed_ms=max(elapsed_ms,excluded.elapsed_ms),received_at=max(received_at,excluded.received_at)`;
export const playtimeSummary = `SELECT coalesce(sum(elapsed_ms),0) AS totalMs,count(DISTINCT browser_id) AS players FROM analytics_playtime`;
export const playtimeUsers = `SELECT browser_id,sum(elapsed_ms) AS elapsed_ms,count(*) AS sessions FROM analytics_playtime GROUP BY browser_id ORDER BY elapsed_ms DESC,browser_id LIMIT 200`;
