-- Per-user, per-conversation settings (mute / archive).
CREATE TABLE conversation_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, target_id)
);
-- JSON array of mentioned user ids, sent by the client (the server can't read E2E text).
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE private_rooms ADD COLUMN scheduled_at TEXT NOT NULL DEFAULT '';
