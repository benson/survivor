CREATE TABLE IF NOT EXISTS episode_snapshots (
  episode INTEGER PRIMARY KEY CHECK (episode BETWEEN 1 AND 30),
  payload TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS result_history (
  episode INTEGER NOT NULL,
  id TEXT NOT NULL,
  placement INTEGER,
  bonuses TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (episode, id)
);
INSERT OR IGNORE INTO result_history SELECT episode,id,placement,bonuses,revision,updated_at FROM results;
CREATE TABLE IF NOT EXISTS viewer_preferences (
  user_id TEXT PRIMARY KEY,
  watched_episode INTEGER NOT NULL DEFAULT 0 CHECK (watched_episode BETWEEN 0 AND 30),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  last_checked TEXT,
  last_success TEXT,
  source_revision TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  lease_until TEXT
);
INSERT OR IGNORE INTO sync_state(id) VALUES(1);
