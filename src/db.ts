import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'peer' CHECK (role IN ('supervisor', 'worker', 'peer')),
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'blocked')),
  metadata TEXT,
  last_heartbeat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  purpose TEXT,
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  from_agent TEXT REFERENCES agents(id) ON DELETE SET NULL,
  to_agent TEXT REFERENCES agents(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('dm', 'channel', 'broadcast')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, seq);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent, seq);

CREATE TABLE IF NOT EXISTS read_cursors (
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, source)
);
`;

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
