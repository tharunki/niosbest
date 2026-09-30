-- The scheduled retention task filters these short-lived rate-limit records by
-- their window start. Keep those deletes indexed as the public site grows.
CREATE INDEX IF NOT EXISTS idx_analytics_attempts_window_started
  ON analytics_attempts(window_started_at);

CREATE INDEX IF NOT EXISTS idx_feedback_attempts_window_started
  ON feedback_attempts(window_started_at);
