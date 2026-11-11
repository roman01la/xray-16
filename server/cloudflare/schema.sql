CREATE TABLE IF NOT EXISTS analytics_devices (browser_id TEXT NOT NULL, session_id TEXT NOT NULL, received_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(browser_id,session_id)) STRICT;
    CREATE TABLE IF NOT EXISTS analytics_performance (id TEXT PRIMARY KEY, browser_id TEXT NOT NULL, session_id TEXT NOT NULL, received_at INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_device_time ON analytics_devices(received_at);
    CREATE INDEX IF NOT EXISTS analytics_performance_time ON analytics_performance(received_at);
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

CREATE TABLE IF NOT EXISTS analytics_playtime (browser_id TEXT NOT NULL, session_id TEXT NOT NULL, elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms > 0), received_at INTEGER NOT NULL, PRIMARY KEY(browser_id,session_id)) STRICT;
