-- Device info for the "signed-in devices" list. last_seen is refreshed when a
-- session's sliding expiry is extended (see auth.ValidateSession).
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_seen TEXT NOT NULL DEFAULT '';
