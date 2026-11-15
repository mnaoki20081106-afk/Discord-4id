-- 見つけたユーザー名のリスト（一度でも「空き」と判定されたもの）
-- status: 'available' = 使える / 'taken' = 使えない（取られた）
CREATE TABLE IF NOT EXISTS found (
  name       TEXT PRIMARY KEY,
  len        INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'available',
  found_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_found_status ON found (status, checked_at);
CREATE INDEX IF NOT EXISTS idx_found_len ON found (len, status);

-- スキャンの進捗などの状態
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
