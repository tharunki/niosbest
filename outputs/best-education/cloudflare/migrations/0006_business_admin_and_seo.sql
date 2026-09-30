-- Editor-controlled SEO and filtering metadata. JSON tag arrays are validated
-- by the Worker and keep the existing cards API backwards-compatible.
ALTER TABLE cards ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN meta_title TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN meta_description TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN seo_keywords TEXT NOT NULL DEFAULT '';

ALTER TABLE catalog_sections ADD COLUMN meta_title TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_sections ADD COLUMN meta_description TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_sections ADD COLUMN seo_keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_sections ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- A lightweight student record is intentionally linked only when a checkout
-- supplies a verified-format email. Student sign-in is a future concern, not
-- something this migration pretends to provide.
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  access_revoked INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  password_reset_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN student_id TEXT;
ALTER TABLE orders ADD COLUMN buyer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN buyer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN access_revoked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN revoked_at TEXT;
ALTER TABLE orders ADD COLUMN revocation_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN refunded_at TEXT;
ALTER TABLE orders ADD COLUMN refund_note TEXT NOT NULL DEFAULT '';

-- Promotions are management records only for now. Checkout deliberately does
-- not read this table, so no unreviewed discount can alter the fixed ₹39/₹399
-- payment calculation.
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'discount',
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value INTEGER NOT NULL DEFAULT 0,
  applies_to TEXT NOT NULL DEFAULT '[]',
  bundle_card_ids TEXT NOT NULL DEFAULT '[]',
  billing_interval TEXT NOT NULL DEFAULT 'none',
  starts_at TEXT,
  ends_at TEXT,
  max_redemptions INTEGER NOT NULL DEFAULT 0,
  redemptions INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  card_id TEXT,
  slug TEXT NOT NULL DEFAULT '',
  resource_title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT NOT NULL DEFAULT '',
  client_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_visitors (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);

CREATE TABLE IF NOT EXISTS analytics_attempts (
  client_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_attempts (
  client_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_published_updated
  ON cards(is_published, updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_student_created
  ON orders(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_revenue_created
  ON orders(status, refunded_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_students_updated
  ON students(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status_created
  ON feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotions_active_updated
  ON promotions(is_active, updated_at DESC);
