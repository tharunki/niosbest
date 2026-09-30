-- Every rate-limit table stores a short-lived keyed technical identifier.
-- Index cleanup so routine retention does not scan the whole table as traffic grows.
CREATE INDEX IF NOT EXISTS idx_login_attempts_window_started
  ON login_attempts(window_started_at);

CREATE INDEX IF NOT EXISTS idx_checkout_attempts_window_started
  ON checkout_attempts(window_started_at);
