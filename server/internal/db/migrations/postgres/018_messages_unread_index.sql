-- Unread counts are recomputed on every WebSocket connect and every read
-- receipt, filtering on read_at IS NULL. A partial index keeps that a lookup
-- of just the unread rows instead of a scan of everything the user received.
CREATE INDEX IF NOT EXISTS idx_messages_unread_recipient
  ON messages(recipient_id) WHERE read_at IS NULL;
