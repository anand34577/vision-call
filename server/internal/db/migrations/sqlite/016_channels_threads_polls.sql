-- Public channels: a group listed here can be found and joined by anyone.
CREATE TABLE public_groups (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE
);

-- People a user has blocked (they can't send that user direct messages).
CREATE TABLE blocked_users (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, blocked_id)
);

-- Threads: a message with thread_root_id is a reply inside that message's thread.
ALTER TABLE messages ADD COLUMN thread_root_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
CREATE INDEX idx_messages_thread ON messages(thread_root_id);

-- Polls: one per message.
CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  pos INTEGER NOT NULL
);
CREATE TABLE poll_votes (
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX idx_poll_votes_poll ON poll_votes(poll_id);
