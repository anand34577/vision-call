package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type Message struct {
	ID          int64   `json:"id"`
	SenderID    int64   `json:"sender_id"`
	RecipientID *int64  `json:"recipient_id"`
	GroupID     *int64  `json:"group_id"`
	FileID      *int64  `json:"file_id"`
	Content     string  `json:"content"`
	SentAt      string  `json:"sent_at"`
	DeliveredAt *string `json:"delivered_at"`
	ReadAt      *string `json:"read_at"`
	DeletedAt   *string `json:"deleted_at"`
	EditedAt    *string `json:"edited_at"`
	ReplyToID   *int64  `json:"reply_to_id"`
	PinnedAt    *string `json:"pinned_at"`
	// E2E: when IsEncrypted, Content is ciphertext (base64) and EncKeys is a
	// JSON blob of per-device wrapped keys — see migration 008's comment for
	// the shape. The server never decrypts either.
	IsEncrypted bool    `json:"is_encrypted"`
	EncIV       *string `json:"enc_iv,omitempty"`
	EncKeys     *string `json:"enc_keys,omitempty"`
	// Mentions are the user ids @-mentioned in the message; the sending client
	// supplies them because the server can't read end-to-end encrypted text.
	Mentions []int64 `json:"mentions,omitempty"`
	// ThreadRootID is set on a reply that lives inside another message's thread.
	ThreadRootID *int64 `json:"thread_root_id,omitempty"`
	// Enriched at runtime:
	ThreadCount int   `json:"thread_count,omitempty"`
	Poll        *Poll `json:"poll,omitempty"`

	Sender    *UserBrief        `json:"sender,omitempty"`
	File      *FileBrief        `json:"file,omitempty"`
	ReplyTo   *MessagePreview   `json:"reply_to,omitempty"`
	Reactions []MessageReaction `json:"reactions,omitempty"`
}

// MessagePreview is the trimmed shape of a quoted message shown above a reply.
type MessagePreview struct {
	ID          int64      `json:"id"`
	Content     string     `json:"content"`
	HasFile     bool       `json:"has_file"`
	Deleted     bool       `json:"deleted"`
	IsEncrypted bool       `json:"is_encrypted"`
	Sender      *UserBrief `json:"sender,omitempty"`
}

type MessageReaction struct {
	MessageID int64  `json:"message_id"`
	UserID    int64  `json:"user_id"`
	Emoji     string `json:"emoji"`
}

// GroupMember is a group member's public info plus their role in that group.
type GroupMember struct {
	ID           int64  `json:"id"`
	DisplayName  string `json:"display_name"`
	Username     string `json:"username"`
	AvatarFileID *int64 `json:"avatar_file_id"`
	Role         string `json:"role"` // "owner" | "admin" | "member"
}

type Group struct {
	ID           int64          `json:"id"`
	Name         string         `json:"name"`
	Topic        string         `json:"topic"`
	CreatedBy    int64          `json:"created_by"`
	CreatedAt    string         `json:"created_at"`
	AvatarFileID *int64         `json:"avatar_file_id"`
	Members      []*GroupMember `json:"members"`
	// Public groups are channels anyone can find and join.
	Public      bool `json:"public"`
	MemberCount int  `json:"member_count,omitempty"`
}

const msgCols = `id, sender_id, recipient_id, group_id, file_id, content, sent_at, delivered_at, read_at, deleted_at, edited_at, reply_to_id, pinned_at, is_encrypted, enc_iv, enc_keys, mentions, thread_root_id`

// prefixCols qualifies every column in a comma-separated column list with a
// table alias (e.g. "m.id, m.sender_id, ..."). Used instead of "SELECT tbl.*"
// so a query's column order is always pinned to msgCols explicitly, rather
// than to the physical column order in whichever dialect's migration files
// happen to be running - the two silently drift apart the moment a future
// migration adds a column in a different position across dialects.
func prefixCols(cols, alias string) []string {
	parts := strings.Split(cols, ", ")
	out := make([]string, len(parts))
	for i, c := range parts {
		out[i] = alias + "." + c
	}
	return out
}

func scanMessage(row interface{ Scan(...any) error }) (*Message, error) {
	m := &Message{}
	var rec, grp, fileID, replyTo sql.NullInt64
	var del, read, deleted, edited, pinned, encIV, encKeys sql.NullString
	var mentions string
	var threadRoot sql.NullInt64
	var isEncrypted int
	if err := row.Scan(&m.ID, &m.SenderID, &rec, &grp, &fileID, &m.Content, &m.SentAt, &del, &read, &deleted, &edited, &replyTo, &pinned, &isEncrypted, &encIV, &encKeys, &mentions, &threadRoot); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if mentions != "" {
		_ = json.Unmarshal([]byte(mentions), &m.Mentions)
	}
	if threadRoot.Valid {
		t := threadRoot.Int64
		m.ThreadRootID = &t
	}
	m.IsEncrypted = isEncrypted != 0
	m.EncIV = nullStringPtr(encIV)
	m.EncKeys = nullStringPtr(encKeys)
	if rec.Valid {
		r := rec.Int64
		m.RecipientID = &r
	}
	if grp.Valid {
		g := grp.Int64
		m.GroupID = &g
	}
	if fileID.Valid {
		f := fileID.Int64
		m.FileID = &f
	}
	if replyTo.Valid {
		rt := replyTo.Int64
		m.ReplyToID = &rt
	}
	m.DeliveredAt = nullStringPtr(del)
	m.ReadAt = nullStringPtr(read)
	m.DeletedAt = nullStringPtr(deleted)
	m.EditedAt = nullStringPtr(edited)
	m.PinnedAt = nullStringPtr(pinned)
	return m, nil
}

// PinMessage sets or clears a message's pinned_at. Permission (who may pin)
// is enforced by the caller, not here.
func (d *DB) PinMessage(id int64, pin bool) (*Message, error) {
	var res sql.Result
	var err error
	if pin {
		res, err = d.Exec(`UPDATE messages SET pinned_at = ? WHERE id = ? AND deleted_at IS NULL`, now(), id)
	} else {
		res, err = d.Exec(`UPDATE messages SET pinned_at = NULL WHERE id = ?`, id)
	}
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return nil, err
	} else if n == 0 {
		return nil, ErrNotFound
	}
	return d.GetMessage(id)
}

// PinnedInGroup returns a group's pinned messages, newest first.
func (d *DB) PinnedInGroup(groupID int64) ([]*Message, error) {
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages WHERE group_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

// PinnedInDM returns a DM thread's pinned messages, newest first.
func (d *DB) PinnedInDM(a, b int64) ([]*Message, error) {
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages
		WHERE pinned_at IS NOT NULL AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
		ORDER BY pinned_at DESC`, a, b, b, a)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func scanMessages(rows *sql.Rows) ([]*Message, error) {
	out := make([]*Message, 0, 8)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SearchFilter narrows SearchMessages. Query may be empty (e.g. "just show
// me everything from Bob last week"); zero values on the other fields mean
// "no filter" on that dimension.
type SearchFilter struct {
	Query    string
	SenderID int64
	Since    string // RFC3339; messages at/after this time
	Until    string // RFC3339; messages before this time
	HasFile  bool   // true = only messages with an attachment
	Limit    int
}

// SearchMessages does a simple case-insensitive substring search (plus
// optional structured filters) over messages userID can see.
// Note: LIKE, not full-text search — fine at this app's scale; swap for
// a proper FTS index if conversations get large enough to need it.
func (d *DB) SearchMessages(userID int64, f SearchFilter) ([]*Message, error) {
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	where := `deleted_at IS NULL AND (sender_id = ? OR recipient_id = ? OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`
	args := []any{userID, userID, userID}
	if f.Query != "" {
		// Encrypted content is ciphertext, not text — matching it against a
		// plaintext query is meaningless (and would leak nothing since it
		// just won't match, but excluding it explicitly is the honest
		// behavior: an E2E message is never server-searchable by design).
		where += ` AND is_encrypted = 0 AND LOWER(content) LIKE LOWER(?) ESCAPE '!'`
		esc := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(f.Query)
		args = append(args, "%"+esc+"%")
	}
	if f.SenderID != 0 {
		where += ` AND sender_id = ?`
		args = append(args, f.SenderID)
	}
	if f.Since != "" {
		where += ` AND sent_at >= ?`
		args = append(args, f.Since)
	}
	if f.Until != "" {
		where += ` AND sent_at < ?`
		args = append(args, f.Until)
	}
	if f.HasFile {
		where += ` AND file_id IS NOT NULL`
	}
	args = append(args, limit)
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages WHERE `+where+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func (d *DB) InsertMessage(senderID int64, recipientID, groupID, fileID, replyToID *int64, content string) (*Message, error) {
	res, err := d.Exec(`INSERT INTO messages (sender_id, recipient_id, group_id, file_id, content, sent_at, reply_to_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, senderID, recID(recipientID), recID(groupID), recID(fileID), content, now(), recID(replyToID))
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return d.GetMessage(id)
}

// InsertEncryptedMessage stores a client-encrypted message: ciphertext (as
// content), the AES-GCM IV, and the JSON blob of per-device wrapped content
// keys. The server treats all three as opaque bytes — it has no key to
// decrypt with and never tries.
func (d *DB) InsertEncryptedMessage(senderID int64, recipientID, groupID, fileID, replyToID *int64, ciphertext, iv, encKeys string) (*Message, error) {
	res, err := d.Exec(`INSERT INTO messages (sender_id, recipient_id, group_id, file_id, content, sent_at, reply_to_id, is_encrypted, enc_iv, enc_keys)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, senderID, recID(recipientID), recID(groupID), recID(fileID), ciphertext, now(), recID(replyToID), iv, encKeys)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return d.GetMessage(id)
}

// DeleteMessage soft-deletes a message: content and attachment are cleared
// but the row (and its place in the conversation) stays. Only the sender may
// delete their own message. Returns ErrNotFound if the message doesn't exist,
// belong to requesterID, or is already deleted.
func (d *DB) DeleteMessage(id, requesterID int64) (*Message, error) {
	res, err := d.Exec(`UPDATE messages SET content = '', file_id = NULL, deleted_at = ?
		WHERE id = ? AND sender_id = ? AND deleted_at IS NULL`, now(), id, requesterID)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return nil, err
	} else if n == 0 {
		return nil, ErrNotFound
	}
	return d.GetMessage(id)
}

// EditMessage updates a message's text in place and stamps edited_at. Only
// the sender may edit, and a deleted message can't be un-deleted this way.
func (d *DB) EditMessage(id, requesterID int64, content string) (*Message, error) {
	res, err := d.Exec(`UPDATE messages SET content = ?, edited_at = ?
		WHERE id = ? AND sender_id = ? AND deleted_at IS NULL`, content, now(), id, requesterID)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return nil, err
	} else if n == 0 {
		return nil, ErrNotFound
	}
	return d.GetMessage(id)
}

// ToggleReaction adds or removes one user's emoji reaction on a message.
// Returns whether the reaction is now present (true = added, false = removed).
func (d *DB) ToggleReaction(messageID, userID int64, emoji string) (bool, error) {
	var exists int
	if err := d.QueryRow(`SELECT EXISTS(SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?)`,
		messageID, userID, emoji).Scan(&exists); err != nil {
		return false, err
	}
	if exists != 0 {
		_, err := d.Exec(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`, messageID, userID, emoji)
		return false, err
	}
	_, err := d.Exec(`INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
		messageID, userID, emoji, now())
	return true, err
}

// ReactionsForMessages batches reaction lookup for a set of messages (chat
// history load / enrichment).
func (d *DB) ReactionsForMessages(messageIDs []int64) (map[int64][]MessageReaction, error) {
	out := map[int64][]MessageReaction{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := d.Query(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (`+placeholders(len(messageIDs))+`) ORDER BY created_at`,
		int64Args(messageIDs)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r MessageReaction
		if err := rows.Scan(&r.MessageID, &r.UserID, &r.Emoji); err != nil {
			return nil, err
		}
		out[r.MessageID] = append(out[r.MessageID], r)
	}
	return out, rows.Err()
}

// ReplyPreviews batches "what does the quoted message look like" lookups for
// a set of reply_to_id values, trimmed to what a reply preview needs.
func (d *DB) ReplyPreviews(ids []int64) (map[int64]*MessagePreview, error) {
	out := map[int64]*MessagePreview{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.Query(`SELECT id, sender_id, content, file_id, deleted_at, is_encrypted FROM messages WHERE id IN (`+placeholders(len(ids))+`)`,
		int64Args(ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	senderIDs := map[int64]bool{}
	type raw struct {
		id          int64
		senderID    int64
		content     string
		fileID      sql.NullInt64
		deleted     sql.NullString
		isEncrypted int
	}
	var raws []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.id, &r.senderID, &r.content, &r.fileID, &r.deleted, &r.isEncrypted); err != nil {
			return nil, err
		}
		raws = append(raws, r)
		senderIDs[r.senderID] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	senderList := make([]int64, 0, len(senderIDs))
	for id := range senderIDs {
		senderList = append(senderList, id)
	}
	senders, err := d.UsersBrief(senderList)
	if err != nil {
		return nil, err
	}
	for _, r := range raws {
		out[r.id] = &MessagePreview{
			ID:          r.id,
			Content:     r.content,
			HasFile:     r.fileID.Valid,
			Deleted:     r.deleted.Valid,
			IsEncrypted: r.isEncrypted != 0,
			Sender:      senders[r.senderID],
		}
	}
	return out, nil
}

// CanSeeMessage reports whether userID is a legitimate party to a message's
// conversation (sender, DM recipient, or a member of its group) — the
// REST-layer equivalent of the signaling hub's canSeeMessage.
func (d *DB) CanSeeMessage(messageID, userID int64) (bool, error) {
	m, err := d.GetMessage(messageID)
	if err != nil {
		return false, err
	}
	if m.SenderID == userID {
		return true, nil
	}
	if m.RecipientID != nil {
		return *m.RecipientID == userID, nil
	}
	if m.GroupID != nil {
		return d.IsGroupMember(*m.GroupID, userID)
	}
	return false, nil
}

// ---- saved (starred) messages: a personal bookmark, independent of pin ----

func (d *DB) SaveMessage(userID, messageID int64) error {
	_, err := d.Exec(insertIgnoreSQL(d.dialect, `saved_messages (user_id, message_id, created_at)`, `?, ?, ?`, `user_id, message_id`),
		userID, messageID, now())
	return err
}

func (d *DB) UnsaveMessage(userID, messageID int64) error {
	_, err := d.Exec(`DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?`, userID, messageID)
	return err
}

// ListSavedMessages returns a user's bookmarked messages, most recently
// saved first.
func (d *DB) ListSavedMessages(userID int64, limit int) ([]*Message, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages m JOIN saved_messages s ON s.message_id = m.id
		WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func recID(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func (d *DB) GetMessage(id int64) (*Message, error) {
	return scanMessage(d.QueryRow(`SELECT `+msgCols+` FROM messages WHERE id = ?`, id))
}

func (d *DB) listMessages(where string, args []any, beforeID int64, limit int) ([]*Message, error) {
	// Parenthesized: callers may pass an OR (see ListDirectMessages), and the
	// cursor below must bind to the whole condition, not its last branch.
	q := `SELECT ` + msgCols + ` FROM messages WHERE (` + where + `)`
	if beforeID > 0 {
		q += ` AND id < ?`
		args = append(args, beforeID)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*Message, 0, 64)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// reverse into chronological order
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (d *DB) ListDirectMessages(a, b int64, beforeID int64, limit int) ([]*Message, error) {
	return d.listMessages(`(sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`,
		[]any{a, b, b, a}, beforeID, limit)
}

func (d *DB) ListGroupMessages(groupID int64, beforeID int64, limit int) ([]*Message, error) {
	return d.listMessages(`group_id = ?`, []any{groupID}, beforeID, limit)
}

// UndeliveredDirect returns 1:1 messages addressed to the user that were never
// marked delivered — pushed to them on connect (offline delivery).
func (d *DB) UndeliveredDirect(userID int64, limit int) ([]*Message, error) {
	return d.listMessages(`recipient_id = ? AND delivered_at IS NULL`, []any{userID}, 0, limit)
}

func (d *DB) MarkDelivered(ids []int64, at string) error {
	if len(ids) == 0 {
		return nil
	}
	q := `UPDATE messages SET delivered_at = ? WHERE id IN (`
	args := []any{at}
	for i, id := range ids {
		if i > 0 {
			q += ","
		}
		q += "?"
		args = append(args, id)
	}
	q += `) AND delivered_at IS NULL`
	_, err := d.Exec(q, args...)
	return err
}

// MarkDirectRead sets read_at on all 1:1 messages from fromUser to toUser.
func (d *DB) MarkDirectRead(fromUser, toUser int64, at string) (int64, error) {
	res, err := d.Exec(`UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
		at, fromUser, toUser)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// UnreadCounts returns, per peer user id, the count of unread 1:1 messages for userID.
func (d *DB) UnreadDirectCounts(userID int64) (map[int64]int, error) {
	rows, err := d.Query(`SELECT sender_id, COUNT(*) FROM messages WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var sender int64
		var n int
		if err := rows.Scan(&sender, &n); err != nil {
			return nil, err
		}
		out[sender] = n
	}
	return out, rows.Err()
}

// RecentDirectPeers returns the most recent DM per peer for the sidebar.
// group_id IS NULL keeps the user's own group messages (recipient_id NULL)
// from collapsing into a bogus "peer" bucket.
func (d *DB) RecentDirectPeers(userID int64, limit int) (map[int64]*Message, error) {
	rows, err := d.Query(`
		SELECT `+strings.Join(prefixCols(msgCols, "m"), ", ")+` FROM messages m
		JOIN (SELECT MAX(id) AS id FROM messages
		      WHERE group_id IS NULL AND (recipient_id = ? OR sender_id = ?)
		      GROUP BY CASE WHEN recipient_id = ? THEN sender_id ELSE recipient_id END) last
		ON m.id = last.id
		ORDER BY m.id DESC LIMIT ?`, userID, userID, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		peer := m.SenderID
		if m.SenderID == userID && m.RecipientID != nil {
			peer = *m.RecipientID
		}
		out[peer] = m
	}
	return out, rows.Err()
}

// RecentGroupMessages returns the latest message of every group userID is in.
func (d *DB) RecentGroupMessages(userID int64) ([]*Message, error) {
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages WHERE id IN (
		SELECT MAX(id) FROM messages
		WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
		GROUP BY group_id)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

// ---- groups ----

func (d *DB) CreateGroup(name string, createdBy int64, memberIDs []int64) (*Group, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	res, err := tx.Exec(`INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)`, name, createdBy, now())
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	gid, err := res.LastInsertId()
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	members := append([]int64{createdBy}, memberIDs...)
	seen := map[int64]bool{}
	for _, uid := range members {
		if seen[uid] {
			continue
		}
		seen[uid] = true
		role := "member"
		if uid == createdBy {
			role = "owner"
		}
		if _, err := tx.Exec(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)`, gid, uid, role); err != nil {
			tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return d.GetGroup(gid)
}

func (d *DB) GetGroup(id int64) (*Group, error) {
	g := &Group{}
	var avatar sql.NullInt64
	err := d.QueryRow(`SELECT id, name, topic, created_by, created_at, avatar_file_id FROM groups WHERE id = ?`, id).
		Scan(&g.ID, &g.Name, &g.Topic, &g.CreatedBy, &g.CreatedAt, &avatar)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if avatar.Valid {
		a := avatar.Int64
		g.AvatarFileID = &a
	}
	rows, err := d.Query(`
		SELECT u.id, u.display_name, u.username, u.avatar_file_id, gm.role
		FROM group_members gm JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id = ? ORDER BY LOWER(u.display_name)`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		b := &GroupMember{}
		var memberAvatar sql.NullInt64
		if err := rows.Scan(&b.ID, &b.DisplayName, &b.Username, &memberAvatar, &b.Role); err != nil {
			return nil, err
		}
		if memberAvatar.Valid {
			a := memberAvatar.Int64
			b.AvatarFileID = &a
		}
		g.Members = append(g.Members, b)
	}
	g.Public = d.IsGroupPublic(id)
	return g, rows.Err()
}

// UpdateGroup patches a group's name and/or topic (nil = leave unchanged).
func (d *DB) UpdateGroup(id int64, name, topic *string) error {
	if name == nil && topic == nil {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	if name != nil {
		if _, err := tx.Exec(`UPDATE groups SET name = ? WHERE id = ?`, *name, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	if topic != nil {
		if _, err := tx.Exec(`UPDATE groups SET topic = ? WHERE id = ?`, *topic, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// SetGroupAvatar sets or clears (fileID == nil) a group's icon.
func (d *DB) SetGroupAvatar(id int64, fileID *int64) error {
	if fileID == nil {
		_, err := d.Exec(`UPDATE groups SET avatar_file_id = NULL WHERE id = ?`, id)
		return err
	}
	_, err := d.Exec(`UPDATE groups SET avatar_file_id = ? WHERE id = ?`, *fileID, id)
	return err
}

// GroupMemberRole returns a member's role in the group, or ErrNotFound if
// they aren't a member.
func (d *DB) GroupMemberRole(groupID, userID int64) (string, error) {
	var role string
	err := d.QueryRow(`SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

// SetGroupMemberRole promotes/demotes a member between "admin" and "member".
// The owner's role is fixed and not managed through this path.
func (d *DB) SetGroupMemberRole(groupID, userID int64, role string) error {
	_, err := d.Exec(`UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ? AND role != 'owner'`, role, groupID, userID)
	return err
}

// GroupReadStates returns, per member, the id of the last message they've
// read — the raw data behind a "seen by" indicator.
func (d *DB) GroupReadStates(groupID int64) (map[int64]int64, error) {
	rows, err := d.Query(`SELECT user_id, last_read_message_id FROM group_read_state WHERE group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var uid, lastID int64
		if err := rows.Scan(&uid, &lastID); err != nil {
			return nil, err
		}
		out[uid] = lastID
	}
	return out, rows.Err()
}

// ListGroupsForUser loads every group userID belongs to, with members, in two
// queries total (not two per group).
func (d *DB) ListGroupsForUser(userID int64) ([]*Group, error) {
	rows, err := d.Query(`SELECT g.id, g.name, g.topic, g.created_by, g.created_at, g.avatar_file_id
		FROM groups g JOIN group_members gm ON gm.group_id = g.id
		WHERE gm.user_id = ? ORDER BY g.id`, userID)
	if err != nil {
		return nil, err
	}
	out := []*Group{}
	byID := map[int64]*Group{}
	for rows.Next() {
		g := &Group{}
		var avatar sql.NullInt64
		if err := rows.Scan(&g.ID, &g.Name, &g.Topic, &g.CreatedBy, &g.CreatedAt, &avatar); err != nil {
			rows.Close()
			return nil, err
		}
		if avatar.Valid {
			a := avatar.Int64
			g.AvatarFileID = &a
		}
		out = append(out, g)
		byID[g.ID] = g
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	mrows, err := d.Query(`
		SELECT gm.group_id, u.id, u.display_name, u.username, u.avatar_file_id, gm.role
		FROM group_members gm JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
		ORDER BY LOWER(u.display_name)`, userID)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var gid int64
		b := &GroupMember{}
		var memberAvatar sql.NullInt64
		if err := mrows.Scan(&gid, &b.ID, &b.DisplayName, &b.Username, &memberAvatar, &b.Role); err != nil {
			return nil, err
		}
		if memberAvatar.Valid {
			a := memberAvatar.Int64
			b.AvatarFileID = &a
		}
		if g := byID[gid]; g != nil {
			g.Members = append(g.Members, b)
		}
	}
	d.markPublic(out)
	return out, mrows.Err()
}

// MarkGroupRead records that userID has read up through the group's latest
// message. Used to compute accurate unread counts on the next login instead
// of only what arrived over an active connection.
func (d *DB) MarkGroupRead(groupID, userID int64) error {
	var lastID sql.NullInt64
	if err := d.QueryRow(`SELECT MAX(id) FROM messages WHERE group_id = ?`, groupID).Scan(&lastID); err != nil {
		return err
	}
	if !lastID.Valid {
		return nil
	}
	// sqlite's two-argument MAX is scalar; Postgres only has GREATEST.
	q := `INSERT INTO group_read_state (group_id, user_id, last_read_message_id) VALUES (?, ?, ?)
		ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_message_id = MAX(group_read_state.last_read_message_id, excluded.last_read_message_id)`
	if d.dialect == DialectPostgres {
		q = strings.Replace(q, "MAX(", "GREATEST(", 1)
	}
	if d.dialect == DialectMySQL {
		q = `INSERT INTO group_read_state (group_id, user_id, last_read_message_id) VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id))`
	}
	_, err := d.Exec(q, groupID, userID, lastID.Int64)
	return err
}

// GroupUnreadCounts returns, per group id, how many messages from other
// members are unread by userID.
func (d *DB) GroupUnreadCounts(userID int64) (map[int64]int, error) {
	rows, err := d.Query(`
		SELECT gm.group_id, COUNT(m.id)
		FROM group_members gm
		JOIN messages m ON m.group_id = gm.group_id AND m.sender_id != gm.user_id
			AND m.id > COALESCE((SELECT last_read_message_id FROM group_read_state grs WHERE grs.group_id = gm.group_id AND grs.user_id = gm.user_id), 0)
		WHERE gm.user_id = ?
		GROUP BY gm.group_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var gid int64
		var n int
		if err := rows.Scan(&gid, &n); err != nil {
			return nil, err
		}
		out[gid] = n
	}
	return out, rows.Err()
}

func (d *DB) IsGroupMember(groupID, userID int64) (bool, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, userID).Scan(&n)
	return n > 0, err
}

func (d *DB) GroupMemberIDs(groupID int64) ([]int64, error) {
	rows, err := d.Query(`SELECT user_id FROM group_members WHERE group_id = ?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (d *DB) DeleteGroup(id int64) error {
	_, err := d.Exec(`DELETE FROM groups WHERE id = ?`, id)
	return err
}

func (d *DB) RenameGroup(id int64, name string) error {
	_, err := d.Exec(`UPDATE groups SET name = ? WHERE id = ?`, name, id)
	return err
}

// AddGroupMembers inserts any of userIDs not already in the group as members.
func (d *DB) AddGroupMembers(groupID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	for _, uid := range userIDs {
		if _, err := tx.Exec(insertIgnoreSQL(d.dialect, `group_members (group_id, user_id, role)`, `?, ?, 'member'`, `group_id, user_id`), groupID, uid); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// RemoveGroupMember drops one member from a group (used for both admin
// removal and self-initiated "leave").
func (d *DB) RemoveGroupMember(groupID, userID int64) error {
	_, err := d.Exec(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, userID)
	return err
}

// SetMessageMentions records who a message @-mentions.
func (d *DB) SetMessageMentions(id int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return nil
	}
	b, err := json.Marshal(userIDs)
	if err != nil {
		return err
	}
	_, err = d.Exec(`UPDATE messages SET mentions = ? WHERE id = ?`, string(b), id)
	return err
}

// DeleteMessageAsModerator soft-deletes any message (group owner/admin or
// site admin). Whether the caller may do so is checked by the caller.
func (d *DB) DeleteMessageAsModerator(id int64) (*Message, error) {
	res, err := d.Exec(`UPDATE messages SET content = '', file_id = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, now(), id)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return nil, err
	} else if n == 0 {
		return nil, ErrNotFound
	}
	return d.GetMessage(id)
}

// PurgeMessagesBefore permanently deletes messages older than cutoff
// (RFC3339), keeping pinned ones. Returns how many were removed.
func (d *DB) PurgeMessagesBefore(cutoff string) (int64, error) {
	res, err := d.Exec(`DELETE FROM messages WHERE sent_at < ? AND pinned_at IS NULL`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ConversationPref is a user's mute/archive setting for one conversation.
type ConversationPref struct {
	Kind     string `json:"kind"` // "dm" | "group"
	TargetID int64  `json:"target_id"`
	Muted    bool   `json:"muted"`
	Archived bool   `json:"archived"`
}

func (d *DB) ListConversationPrefs(userID int64) ([]ConversationPref, error) {
	rows, err := d.Query(`SELECT kind, target_id, muted, archived FROM conversation_prefs WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConversationPref{}
	for rows.Next() {
		var p ConversationPref
		var muted, archived int
		if err := rows.Scan(&p.Kind, &p.TargetID, &muted, &archived); err != nil {
			return nil, err
		}
		p.Muted, p.Archived = muted != 0, archived != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetConversationPref stores a mute/archive setting; a row with both flags off is removed.
func (d *DB) SetConversationPref(userID int64, p ConversationPref) error {
	if !p.Muted && !p.Archived {
		_, err := d.Exec(`DELETE FROM conversation_prefs WHERE user_id = ? AND kind = ? AND target_id = ?`, userID, p.Kind, p.TargetID)
		return err
	}
	m, a := 0, 0
	if p.Muted {
		m = 1
	}
	if p.Archived {
		a = 1
	}
	q := `INSERT INTO conversation_prefs (user_id, kind, target_id, muted, archived) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, kind, target_id) DO UPDATE SET muted = excluded.muted, archived = excluded.archived`
	if d.dialect == DialectMySQL {
		q = `INSERT INTO conversation_prefs (user_id, kind, target_id, muted, archived) VALUES (?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE muted = VALUES(muted), archived = VALUES(archived)`
	}
	_, err := d.Exec(q, userID, p.Kind, p.TargetID, m, a)
	return err
}
