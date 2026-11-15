-- 空いている（と判定された）ユーザー名
CREATE TABLE IF NOT EXISTS available (
  name       TEXT PRIMARY KEY,
  len        INTEGER NOT NULL,
  found_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_available_len ON available (len, checked_at);
CREATE INDEX IF NOT EXISTS idx_available_checked ON available (checked_at);

-- スキャンの進捗などの状態
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
