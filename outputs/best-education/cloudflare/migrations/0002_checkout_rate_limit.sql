CREATE TABLE IF NOT EXISTS checkout_attempts (
  client_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
