CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  revision INTEGER NOT NULL,
  client_updated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
