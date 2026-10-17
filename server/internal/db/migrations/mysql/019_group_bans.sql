-- Members an admin removed from a public channel; they cannot simply rejoin.
CREATE TABLE group_bans (
  group_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
