CREATE TABLE IF NOT EXISTS league (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open INTEGER NOT NULL DEFAULT 1,
  deadline TEXT,
  invite_hash TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  last_episode INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO league (id) VALUES (1);
CREATE TABLE IF NOT EXISTS members (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_commissioner ON members(role) WHERE role = 'admin';
CREATE TABLE IF NOT EXISTS teams (
  user_id TEXT PRIMARY KEY REFERENCES members(user_id),
  draft TEXT NOT NULL,
  submitted TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  submitted_at TEXT
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  placement INTEGER,
  bonuses TEXT NOT NULL,
  episode INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_placement ON results(placement) WHERE placement IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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
