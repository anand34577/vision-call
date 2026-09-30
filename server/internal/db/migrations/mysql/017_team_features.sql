-- Per-user, per-conversation settings (mute / archive).
CREATE TABLE conversation_prefs (
  user_id BIGINT NOT NULL,
  kind VARCHAR(8) NOT NULL,
  target_id BIGINT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
-- JSON array of mentioned user ids, sent by the client (the server can't read E2E text).
ALTER TABLE messages ADD COLUMN mentions VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN status_text VARCHAR(140) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE private_rooms ADD COLUMN scheduled_at VARCHAR(32) NOT NULL DEFAULT '';
