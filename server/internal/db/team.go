package db

import (
	"database/sql"
	"errors"
	"strings"
)

// ---- public channels ------------------------------------------------------

func (d *DB) SetGroupPublic(groupID int64, public bool) error {
	if !public {
		_, err := d.Exec(`DELETE FROM public_groups WHERE group_id = ?`, groupID)
		return err
	}
	q := `INSERT INTO public_groups (group_id) VALUES (?) ON CONFLICT (group_id) DO NOTHING`
	if d.dialect == DialectMySQL {
		q = `INSERT IGNORE INTO public_groups (group_id) VALUES (?)`
	}
	_, err := d.Exec(q, groupID)
	return err
}

func (d *DB) IsGroupPublic(groupID int64) bool {
	var n int
	return d.QueryRow(`SELECT COUNT(*) FROM public_groups WHERE group_id = ?`, groupID).Scan(&n) == nil && n > 0
}

// markPublic sets Group.Public on every group in the list with one query.
func (d *DB) markPublic(groups []*Group) {
	if len(groups) == 0 {
		return
	}
	ids := make([]any, len(groups))
	byID := map[int64]*Group{}
	for i, g := range groups {
		ids[i] = g.ID
		byID[g.ID] = g
	}
	rows, err := d.Query(`SELECT group_id FROM public_groups WHERE group_id IN (`+placeholders(len(ids))+`)`, ids...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			if g := byID[id]; g != nil {
				g.Public = true
			}
		}
	}
}

// ListPublicGroups lists channels userID could join (public, not yet a member).
func (d *DB) ListPublicGroups(userID int64) ([]*Group, error) {
	return d.listGroupsBrief(`SELECT g.id, g.name, g.topic, g.created_by, g.created_at, g.avatar_file_id,
		(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)
		FROM groups g JOIN public_groups p ON p.group_id = g.id
		WHERE g.id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
		ORDER BY LOWER(g.name)`, userID)
}

// ListAllGroups is the admin overview of every group and channel.
func (d *DB) ListAllGroups() ([]*Group, error) {
	return d.listGroupsBrief(`SELECT g.id, g.name, g.topic, g.created_by, g.created_at, g.avatar_file_id,
		(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)
		FROM groups g ORDER BY LOWER(g.name)`)
}

func (d *DB) listGroupsBrief(query string, args ...any) ([]*Group, error) {
	rows, err := d.Query(query, args...)
	if err != nil {
		return nil, err
	}
	out := []*Group{}
	for rows.Next() {
		g := &Group{Members: []*GroupMember{}}
		var avatar sql.NullInt64
		if err := rows.Scan(&g.ID, &g.Name, &g.Topic, &g.CreatedBy, &g.CreatedAt, &avatar, &g.MemberCount); err != nil {
			rows.Close()
			return nil, err
		}
		if avatar.Valid {
			a := avatar.Int64
			g.AvatarFileID = &a
		}
		out = append(out, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	d.markPublic(out)
	return out, nil
}

// ---- blocking -------------------------------------------------------------

func (d *DB) BlockUser(userID, blockedID int64) error {
	q := `INSERT INTO blocked_users (user_id, blocked_id) VALUES (?, ?) ON CONFLICT (user_id, blocked_id) DO NOTHING`
	if d.dialect == DialectMySQL {
		q = `INSERT IGNORE INTO blocked_users (user_id, blocked_id) VALUES (?, ?)`
	}
	_, err := d.Exec(q, userID, blockedID)
	return err
}

func (d *DB) UnblockUser(userID, blockedID int64) error {
	_, err := d.Exec(`DELETE FROM blocked_users WHERE user_id = ? AND blocked_id = ?`, userID, blockedID)
	return err
}

func (d *DB) ListBlocked(userID int64) ([]int64, error) {
	rows, err := d.Query(`SELECT blocked_id FROM blocked_users WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// IsBlockedEitherWay reports whether a blocked b or b blocked a.
func (d *DB) IsBlockedEitherWay(a, b int64) bool {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM blocked_users WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`, a, b, b, a).Scan(&n)
	return err == nil && n > 0
}

// ---- threads --------------------------------------------------------------

func (d *DB) SetThreadRoot(messageID, rootID int64) error {
	_, err := d.Exec(`UPDATE messages SET thread_root_id = ? WHERE id = ?`, rootID, messageID)
	return err
}

// ThreadCounts returns how many replies each of the given messages has.
func (d *DB) ThreadCounts(ids []int64) (map[int64]int, error) {
	out := map[int64]int{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := d.Query(`SELECT thread_root_id, COUNT(*) FROM messages WHERE deleted_at IS NULL AND thread_root_id IN (`+placeholders(len(ids))+`) GROUP BY thread_root_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// ThreadReplies lists a thread's replies oldest first.
func (d *DB) ThreadReplies(rootID int64, limit int) ([]*Message, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := d.Query(`SELECT `+msgCols+` FROM messages WHERE thread_root_id = ? ORDER BY id ASC LIMIT ?`, rootID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- polls ----------------------------------------------------------------

type PollOption struct {
	ID    int64   `json:"id"`
	Text  string  `json:"text"`
	Votes []int64 `json:"votes"` // ids of the people who voted for it
}

type Poll struct {
	ID       int64        `json:"id"`
	Question string       `json:"question"`
	Multi    bool         `json:"multi"`
	Closed   bool         `json:"closed"`
	Options  []PollOption `json:"options"`
}

var ErrPollClosed = errors.New("poll is closed")

// CreatePoll attaches a poll to an existing message.
func (d *DB) CreatePoll(messageID int64, question string, options []string, multi bool) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	m := 0
	if multi {
		m = 1
	}
	res, err := tx.Exec(`INSERT INTO polls (message_id, question, multi, closed) VALUES (?, ?, ?, 0)`, messageID, question, m)
	if err != nil {
		return err
	}
	pid, err := res.LastInsertId()
	if err != nil {
		return err
	}
	for i, text := range options {
		if _, err := tx.Exec(`INSERT INTO poll_options (poll_id, text, pos) VALUES (?, ?, ?)`, pid, text, i); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PollsForMessages loads the poll (with votes) attached to each message, if any.
func (d *DB) PollsForMessages(messageIDs []int64) (map[int64]*Poll, error) {
	out := map[int64]*Poll{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}
	rows, err := d.Query(`SELECT id, message_id, question, multi, closed FROM polls WHERE message_id IN (`+placeholders(len(args))+`)`, args...)
	if err != nil {
		return nil, err
	}
	byPoll := map[int64]*Poll{}
	pollIDs := []any{}
	for rows.Next() {
		p := &Poll{Options: []PollOption{}}
		var mid int64
		var multi, closed int
		if err := rows.Scan(&p.ID, &mid, &p.Question, &multi, &closed); err != nil {
			rows.Close()
			return nil, err
		}
		p.Multi, p.Closed = multi != 0, closed != 0
		out[mid] = p
		byPoll[p.ID] = p
		pollIDs = append(pollIDs, p.ID)
	}
	rows.Close()
	if len(pollIDs) == 0 {
		return out, nil
	}
	orows, err := d.Query(`SELECT id, poll_id, text FROM poll_options WHERE poll_id IN (`+placeholders(len(pollIDs))+`) ORDER BY pos`, pollIDs...)
	if err != nil {
		return nil, err
	}
	optByID := map[int64]*PollOption{}
	type ref struct {
		poll *Poll
		idx  int
	}
	refs := map[int64]ref{}
	for orows.Next() {
		var o PollOption
		var pid int64
		if err := orows.Scan(&o.ID, &pid, &o.Text); err != nil {
			orows.Close()
			return nil, err
		}
		o.Votes = []int64{}
		p := byPoll[pid]
		p.Options = append(p.Options, o)
		refs[o.ID] = ref{p, len(p.Options) - 1}
	}
	orows.Close()
	_ = optByID
	vrows, err := d.Query(`SELECT option_id, user_id FROM poll_votes WHERE poll_id IN (`+placeholders(len(pollIDs))+`)`, pollIDs...)
	if err != nil {
		return nil, err
	}
	defer vrows.Close()
	for vrows.Next() {
		var oid, uid int64
		if err := vrows.Scan(&oid, &uid); err != nil {
			return nil, err
		}
		if r, ok := refs[oid]; ok {
			r.poll.Options[r.idx].Votes = append(r.poll.Options[r.idx].Votes, uid)
		}
	}
	return out, vrows.Err()
}

// PollMessageID resolves a poll to its message (for permission checks).
func (d *DB) PollMessageID(pollID int64) (int64, error) {
	var mid int64
	err := d.QueryRow(`SELECT message_id FROM polls WHERE id = ?`, pollID).Scan(&mid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return mid, err
}

// VotePoll toggles userID's vote for an option. On a single-choice poll, any
// other vote by that user is replaced.
func (d *DB) VotePoll(pollID, optionID, userID int64) error {
	var multi, closed int
	if err := d.QueryRow(`SELECT multi, closed FROM polls WHERE id = ?`, pollID).Scan(&multi, &closed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if closed != 0 {
		return ErrPollClosed
	}
	var ok int
	if err := d.QueryRow(`SELECT COUNT(*) FROM poll_options WHERE id = ? AND poll_id = ?`, optionID, pollID).Scan(&ok); err != nil || ok == 0 {
		return ErrNotFound
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`DELETE FROM poll_votes WHERE option_id = ? AND user_id = ?`, optionID, userID)
	if err != nil {
		return err
	}
	removed, _ := res.RowsAffected()
	if removed == 0 {
		if multi == 0 {
			if _, err := tx.Exec(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`, pollID, userID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`INSERT INTO poll_votes (option_id, poll_id, user_id) VALUES (?, ?, ?)`, optionID, pollID, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) ClosePoll(pollID int64) error {
	_, err := d.Exec(`UPDATE polls SET closed = 1 WHERE id = ?`, pollID)
	return err
}

// trimOptions cleans up poll option text; used by the realtime handler.
func CleanPollOptions(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
