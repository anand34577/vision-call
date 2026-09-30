-- Public channels: a group listed here can be found and joined by anyone.
CREATE TABLE public_groups (
  group_id BIGINT PRIMARY KEY,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- People a user has blocked (they can't send that user direct messages).
CREATE TABLE blocked_users (
  user_id BIGINT NOT NULL,
  blocked_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, blocked_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Threads: a message with thread_root_id is a reply inside that message's thread.
ALTER TABLE messages ADD COLUMN thread_root_id BIGINT;
ALTER TABLE messages ADD CONSTRAINT fk_messages_thread_root FOREIGN KEY (thread_root_id) REFERENCES messages(id) ON DELETE CASCADE;
CREATE INDEX idx_messages_thread ON messages(thread_root_id);

-- Polls: one per message.
CREATE TABLE polls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  message_id BIGINT NOT NULL UNIQUE,
  question VARCHAR(500) NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE poll_options (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  poll_id BIGINT NOT NULL,
  text VARCHAR(200) NOT NULL,
  pos INTEGER NOT NULL,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE poll_votes (
  option_id BIGINT NOT NULL,
  poll_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  PRIMARY KEY (option_id, user_id),
  FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_poll_votes_poll ON poll_votes(poll_id);
