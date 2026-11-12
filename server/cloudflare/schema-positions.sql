CREATE TABLE IF NOT EXISTS analytics_positions (
  game_id TEXT NOT NULL CHECK(game_id IN ('cop','soc')),
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  map TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(game_id,browser_id,session_id,sampled_at)
) STRICT;
CREATE INDEX IF NOT EXISTS analytics_position_time ON analytics_positions(received_at);
