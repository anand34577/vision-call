package db

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
)

type FileBrief struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

type File struct {
	FileBrief
	UploaderID int64  `json:"uploader_id"`
	Path       string `json:"-"`
	CreatedAt  string `json:"created_at"`
}

// CanAccessFile applies the same ownership rules used by chat attachments:
// the uploader, a user whose avatar uses the file, a group whose avatar uses
// the file (accessible to any member of that group), a direct-message party,
// or a member of the group containing the attachment may download it.
func (d *DB) CanAccessFile(fileID, userID int64) (bool, error) {
	var allowed int
	err := d.QueryRow(`
		SELECT EXISTS(
			SELECT 1 FROM files f
			WHERE f.id = ? AND (
				f.uploader_id = ?
				OR EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
				OR EXISTS (
					SELECT 1 FROM groups g
					JOIN group_members gm ON gm.group_id = g.id
					WHERE g.avatar_file_id = f.id AND gm.user_id = ?
				)
				OR EXISTS (
					SELECT 1 FROM messages m
					WHERE m.file_id = f.id
					  AND (
						m.sender_id = ?
						OR m.recipient_id = ?
						OR EXISTS (
							SELECT 1 FROM group_members gm
							WHERE gm.group_id = m.group_id AND gm.user_id = ?
						)
					  )
				)
			)
		)`, fileID, userID, userID, userID, userID, userID).Scan(&allowed)
	return allowed != 0, err
}

// FilePathsForUploader returns on-disk paths safe to remove when a user's
// account is closed: their own uploads that are not attached to any message,
// not anyone's avatar, and not any group's avatar. Files still referenced by
// a chat message or group are kept so preserved conversation history and
// groups don't end up with broken attachments/avatars.
func (d *DB) FilePathsForUploader(userID int64) ([]string, error) {
	rows, err := d.Query(`
		SELECT path FROM files f
		WHERE f.uploader_id = ?
		  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.avatar_file_id = f.id)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

// DeleteOrphanFiles removes file rows created before cutoff (RFC3339) that
// nothing references any more — uploads that were never sent, attachments of
// deleted messages — and returns their on-disk paths for the caller to
// remove. The age cutoff protects an upload whose message is still being
// composed.
func (d *DB) DeleteOrphanFiles(cutoff string) ([]string, error) {
	rows, err := d.Query(`
		SELECT id, path FROM files f
		WHERE f.created_at < ?
		  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.avatar_file_id = f.id)`, cutoff)
	if err != nil {
		return nil, err
	}
	var ids []int64
	var paths []string
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		paths = append(paths, path)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return nil, err
	}
	if _, err := d.Exec(`DELETE FROM files WHERE id IN (`+placeholders(len(ids))+`)`, int64Args(ids)...); err != nil {
		return nil, err
	}
	return paths, nil
}

// SumFileBytesForUploader totals the size of everything a user has uploaded,
// for enforcing a per-user storage quota.
func (d *DB) SumFileBytesForUploader(userID int64) (int64, error) {
	var total sql.NullInt64
	err := d.QueryRow(`SELECT SUM(size) FROM files WHERE uploader_id = ?`, userID).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total.Int64, nil
}

func (d *DB) InsertFile(uploaderID int64, name, mime string, size int64, path string) (*File, error) {
	res, err := d.Exec(`INSERT INTO files (uploader_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		uploaderID, name, mime, size, path, now())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return d.GetFile(id)
}

func (d *DB) GetFile(id int64) (*File, error) {
	f := &File{}
	err := d.QueryRow(`SELECT id, uploader_id, name, mime, size, path, created_at FROM files WHERE id = ?`, id).
		Scan(&f.ID, &f.UploaderID, &f.Name, &f.Mime, &f.Size, &f.Path, &f.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// FilesBrief batches file lookups for chat enrichment and message export.
func (d *DB) FilesBrief(ids []int64) (map[int64]*FileBrief, error) {
	out := map[int64]*FileBrief{}
	if len(ids) == 0 {
		return out, nil
	}
	unique := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}

	const chunkSize = 500
	for i := 0; i < len(unique); i += chunkSize {
		end := i + chunkSize
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[i:end]
		rows, err := d.Query(`SELECT id, name, mime, size FROM files WHERE id IN (`+placeholders(len(chunk))+`)`,
			int64Args(chunk)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var f FileBrief
			if err := rows.Scan(&f.ID, &f.Name, &f.Mime, &f.Size); err != nil {
				rows.Close()
				return nil, err
			}
			out[f.ID] = &f
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

// ---- calls ----

type CallParticipant struct {
	UserID   int64      `json:"user_id"`
	JoinedAt *string    `json:"joined_at"`
	LeftAt   *string    `json:"left_at"`
	Missed   bool       `json:"missed"`
	User     *UserBrief `json:"user"`
}

type Call struct {
	ID           int64   `json:"id"`
	RoomID       string  `json:"room_id"`
	InitiatorID  int64   `json:"initiator_id"`
	IsConference bool    `json:"is_conference"`
	StartedAt    string  `json:"started_at"`
	EndedAt      *string `json:"ended_at"`
	// Enriched:
	Initiator    *UserBrief         `json:"initiator,omitempty"`
	Participants []*CallParticipant `json:"participants,omitempty"`
}

func (d *DB) CreateCall(roomID string, initiatorID int64, isConference bool) (*Call, error) {
	res, err := d.Exec(`INSERT INTO calls (room_id, initiator_id, is_conference, started_at) VALUES (?, ?, ?, ?)`,
		roomID, initiatorID, boolInt(isConference), now())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return d.GetCall(id)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (d *DB) GetCall(id int64) (*Call, error) {
	c := &Call{}
	var ended sql.NullString
	err := d.QueryRow(`SELECT id, room_id, initiator_id, is_conference, started_at, ended_at FROM calls WHERE id = ?`, id).
		Scan(&c.ID, &c.RoomID, &c.InitiatorID, &c.IsConference, &c.StartedAt, &ended)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.EndedAt = nullStringPtr(ended)
	return c, nil
}

func (d *DB) EndCall(id int64) error {
	_, err := d.Exec(`UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, now(), id)
	return err
}

// FinalizeOpenCalls closes any call rows left open by a restart (ended_at NULL).
func (d *DB) FinalizeOpenCalls() error {
	_, err := d.Exec(`UPDATE calls SET ended_at = ? WHERE ended_at IS NULL`, now())
	return err
}

// AddCallParticipant inserts a participant row; missed defaults true for invitees
// until they join (AddCallParticipant with joined=true flips it).
func (d *DB) AddCallParticipant(callID, userID int64, joined bool) error {
	var joinedAt any
	if joined {
		joinedAt = now()
	}
	q := `INSERT INTO call_participants (call_id, user_id, joined_at, missed) VALUES (?, ?, ?, ?)
		ON CONFLICT (call_id, user_id) DO UPDATE SET
			joined_at = CASE WHEN excluded.joined_at IS NOT NULL THEN excluded.joined_at ELSE call_participants.joined_at END,
			left_at = CASE WHEN excluded.joined_at IS NOT NULL THEN NULL ELSE call_participants.left_at END,
			missed = CASE WHEN excluded.joined_at IS NOT NULL THEN 0 ELSE call_participants.missed END`
	if d.dialect == DialectMySQL {
		q = `INSERT INTO call_participants (call_id, user_id, joined_at, missed) VALUES (?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				joined_at = CASE WHEN VALUES(joined_at) IS NOT NULL THEN VALUES(joined_at) ELSE joined_at END,
				left_at = CASE WHEN VALUES(joined_at) IS NOT NULL THEN NULL ELSE left_at END,
				missed = CASE WHEN VALUES(joined_at) IS NOT NULL THEN 0 ELSE missed END`
	}
	_, err := d.Exec(q, callID, userID, joinedAt, boolInt(!joined))
	return err
}

func (d *DB) CallParticipantLeft(callID, userID int64) error {
	_, err := d.Exec(`UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND left_at IS NULL`,
		now(), callID, userID)
	return err
}

// MarkParticipantMissed records that the invitee never picked up.
func (d *DB) MarkParticipantMissed(callID, userID int64) error {
	_, err := d.Exec(`UPDATE call_participants SET missed = 1 WHERE call_id = ? AND user_id = ? AND joined_at IS NULL`,
		callID, userID)
	return err
}

// ListCallsForUser returns recent calls involving userID, newest first, with
// participant and initiator info attached.
func (d *DB) ListCallsForUser(userID int64, limit int) ([]*Call, error) {
	rows, err := d.Query(`
		SELECT c.id FROM calls c
		LEFT JOIN call_participants cp ON cp.call_id = c.id
		WHERE cp.user_id = ? OR c.initiator_id = ?
		GROUP BY c.id ORDER BY c.id DESC LIMIT ?`, userID, userID, limit)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]*Call, 0, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	// gather participants + users for all calls in one pass
	parts := map[int64][]*CallParticipant{}
	prows, err := d.Query(`
		SELECT cp.call_id, cp.user_id, cp.joined_at, cp.left_at, cp.missed,
		       u.id, u.display_name, u.username, u.avatar_file_id
		FROM call_participants cp JOIN users u ON u.id = cp.user_id
		WHERE cp.call_id IN (SELECT DISTINCT call_id FROM call_participants WHERE call_id IN (`+placeholders(len(ids))+`))`, int64Args(ids)...)
	if err != nil {
		return nil, err
	}
	for prows.Next() {
		var callID int64
		cp := &CallParticipant{User: &UserBrief{}}
		var joined, left sql.NullString
		var missed int
		var avatar sql.NullInt64
		if err := prows.Scan(&callID, &cp.UserID, &joined, &left, &missed, &cp.User.ID, &cp.User.DisplayName, &cp.User.Username, &avatar); err != nil {
			prows.Close()
			return nil, err
		}
		cp.JoinedAt = nullStringPtr(joined)
		cp.LeftAt = nullStringPtr(left)
		cp.Missed = missed != 0 && cp.JoinedAt == nil
		if avatar.Valid {
			a := avatar.Int64
			cp.User.AvatarFileID = &a
		}
		parts[callID] = append(parts[callID], cp)
	}
	prows.Close()
	if err := prows.Err(); err != nil {
		return nil, err
	}

	// Batch the call rows and their initiators in two queries total, instead
	// of one GetCall + one UsersBrief per call — this used to be up to
	// 2*len(ids) round trips for what participants above already does in one.
	calls := map[int64]*Call{}
	crows, err := d.Query(`SELECT id, room_id, initiator_id, is_conference, started_at, ended_at FROM calls WHERE id IN (`+placeholders(len(ids))+`)`, int64Args(ids)...)
	if err != nil {
		return nil, err
	}
	initiatorIDs := make([]int64, 0, len(ids))
	for crows.Next() {
		c := &Call{}
		var ended sql.NullString
		if err := crows.Scan(&c.ID, &c.RoomID, &c.InitiatorID, &c.IsConference, &c.StartedAt, &ended); err != nil {
			crows.Close()
			return nil, err
		}
		c.EndedAt = nullStringPtr(ended)
		calls[c.ID] = c
		initiatorIDs = append(initiatorIDs, c.InitiatorID)
	}
	crows.Close()
	if err := crows.Err(); err != nil {
		return nil, err
	}

	initiators, err := d.UsersBrief(initiatorIDs)
	if err != nil {
		return nil, err
	}

	for _, id := range ids {
		c, ok := calls[id]
		if !ok {
			continue
		}
		c.Participants = parts[id]
		c.Initiator = initiators[c.InitiatorID]
		out = append(out, c)
	}
	return out, nil
}

func placeholders(n int) string {
	s := ""
	for i := 0; i < n; i++ {
		if i > 0 {
			s += ","
		}
		s += "?"
	}
	return s
}

func int64Args(ids []int64) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

// AllFilePathsForUploader returns the on-disk path of every file a user
// uploaded. Permanently deleting a user removes all those rows (ON DELETE
// CASCADE), so the files themselves have to go too.
func (d *DB) AllFilePathsForUploader(userID int64) ([]string, error) {
	rows, err := d.Query(`SELECT path FROM files WHERE uploader_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

// RebaseFilePaths points every stored upload path at filesDir, keeping each
// file's own name. A restored backup may come from a server whose data
// folder was somewhere else (for example /data in Docker).
func (d *DB) RebaseFilePaths(filesDir string) error {
	rows, err := d.Query(`SELECT id, path FROM files`)
	if err != nil {
		return err
	}
	type row struct {
		id   int64
		path string
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.path); err != nil {
			rows.Close()
			return err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range all {
		want := filepath.Join(filesDir, filepath.Base(filepath.FromSlash(strings.ReplaceAll(r.path, "\\", "/"))))
		if want == r.path {
			continue
		}
		if _, err := d.Exec(`UPDATE files SET path = ? WHERE id = ?`, want, r.id); err != nil {
			return err
		}
	}
	return nil
}
