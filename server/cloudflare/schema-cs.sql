-- Add Clear Sky analytics without modifying the live CoP tables.
CREATE TABLE IF NOT EXISTS analytics_cs_browsers (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS analytics_cs_events (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL REFERENCES analytics_cs_browsers(id),
  event TEXT NOT NULL CHECK (event IN ('visit','install','start_game','new_campaign','load_save')),
  received_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS analytics_cs_first_install
  ON analytics_cs_events(browser_id) WHERE event='install';
CREATE INDEX IF NOT EXISTS analytics_cs_event_counts ON analytics_cs_events(event,browser_id);

CREATE TABLE IF NOT EXISTS analytics_cs_devices (
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(browser_id,session_id)
) STRICT;
CREATE INDEX IF NOT EXISTS analytics_cs_device_time ON analytics_cs_devices(received_at);

CREATE TABLE IF NOT EXISTS analytics_cs_performance (
  id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS analytics_cs_performance_time ON analytics_cs_performance(received_at);

CREATE TABLE IF NOT EXISTS analytics_cs_playtime (
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms > 0),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(browser_id,session_id)
) STRICT;

-- Keep Clear Sky tracks independent of the existing campaign history.
CREATE TABLE IF NOT EXISTS analytics_cs_positions (
  game_id TEXT NOT NULL CHECK(game_id IN ('cs')),
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
CREATE INDEX IF NOT EXISTS analytics_cs_position_time ON analytics_cs_positions(received_at);
