-- Device info for the "signed-in devices" list. last_seen is refreshed when a
-- session's sliding expiry is extended (see auth.ValidateSession).
ALTER TABLE sessions ADD COLUMN user_agent VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ip VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_seen VARCHAR(32) NOT NULL DEFAULT '';
