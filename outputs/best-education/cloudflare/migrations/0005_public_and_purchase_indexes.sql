-- Public catalogue reads filter on publish state before joining section paths.
CREATE INDEX IF NOT EXISTS idx_cards_public_listing
  ON cards(is_published, section_id, sort_order, updated_at);

-- File mutation safeguards and purchase recovery should not scan the entire
-- catalogue/orders table as the library grows.
CREATE INDEX IF NOT EXISTS idx_cards_file_key
  ON cards(file_key);

CREATE INDEX IF NOT EXISTS idx_orders_card_status_recovery
  ON orders(card_id, status, recovery_expires_at);

CREATE INDEX IF NOT EXISTS idx_orders_status_recovery
  ON orders(status, recovery_expires_at);
