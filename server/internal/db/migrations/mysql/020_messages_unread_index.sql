-- Unread counts are recomputed on every WebSocket connect and every read
-- receipt, filtering on read_at IS NULL. MySQL has no partial indexes, so this
-- is a plain composite index instead: (recipient_id, read_at) lets the
-- recipient_id equality lookup narrow to that user's rows, and read_at is
-- carried in the index so the IS NULL check never touches the table.
CREATE INDEX idx_messages_unread_recipient
  ON messages(recipient_id, read_at);
