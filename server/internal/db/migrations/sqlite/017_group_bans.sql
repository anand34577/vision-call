-- Members an admin removed from a public channel; they cannot simply rejoin.
CREATE TABLE group_bans (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
