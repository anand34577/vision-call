package db

import (
	"database/sql"
	"errors"
	"time"
)

// PrivateRoom is a standalone call room, independent of any chat group.
// Joined by ID (the shareable room code); PasscodeHash is never exposed to
// clients (see api.roomHandlers, which never serializes it back).
type PrivateRoom struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	OwnerID         int64   `json:"owner_id"`
	PasscodeHash    *string `json:"-"`
	RequireApproval bool    `json:"require_approval"`
	CreatedAt       string  `json:"created_at"`
	// ScheduledAt is when a scheduled meeting starts (RFC3339 UTC); empty for an instant room.
	ScheduledAt string `json:"scheduled_at"`
}

const privateRoomCols = `id, name, owner_id, passcode_hash, require_approval, created_at, scheduled_at`

func scanPrivateRoom(row interface{ Scan(...any) error }) (*PrivateRoom, error) {
	pr := &PrivateRoom{}
	var passcode sql.NullString
	var requireApproval int
	if err := row.Scan(&pr.ID, &pr.Name, &pr.OwnerID, &passcode, &requireApproval, &pr.CreatedAt, &pr.ScheduledAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	pr.PasscodeHash = nullStringPtr(passcode)
	pr.RequireApproval = requireApproval != 0
	return pr, nil
}

// CreatePrivateRoom persists a new room and its (possibly empty) invite
// list in one transaction. id must already be a fresh, collision-checked
// code — see api.generateRoomCode.
func (d *DB) CreatePrivateRoom(id, name string, ownerID int64, passcodeHash *string, requireApproval bool, invitedUserIDs []int64, scheduledAt string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	approval := 0
	if requireApproval {
		approval = 1
	}
	if _, err := tx.Exec(
		`INSERT INTO private_rooms (id, name, owner_id, passcode_hash, require_approval, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, ownerID, passcodeHash, approval, time.Now().UTC().Format(time.RFC3339), scheduledAt,
	); err != nil {
		return err
	}
	for _, uid := range invitedUserIDs {
		if uid == ownerID {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO private_room_invites (room_id, user_id) VALUES (?, ?)`, id, uid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) GetPrivateRoom(id string) (*PrivateRoom, error) {
	row := d.QueryRow(`SELECT `+privateRoomCols+` FROM private_rooms WHERE id = ?`, id)
	return scanPrivateRoom(row)
}

// ListMyPrivateRooms returns rooms the user owns or has been invited to, newest first.
func (d *DB) ListMyPrivateRooms(userID int64) ([]*PrivateRoom, error) {
	rows, err := d.Query(`SELECT `+privateRoomCols+` FROM private_rooms
		WHERE owner_id = ? OR id IN (SELECT room_id FROM private_room_invites WHERE user_id = ?) ORDER BY created_at DESC`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*PrivateRoom{}
	for rows.Next() {
		pr, err := scanPrivateRoom(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pr)
	}
	return out, rows.Err()
}

// DeletePrivateRoom removes a room (and its invites, via ON DELETE CASCADE)
// if ownerID actually owns it. Returns ErrNotFound otherwise, so callers
// can't distinguish "doesn't exist" from "not yours" — same shape as the
// group/message ownership checks elsewhere in this package.
func (d *DB) DeletePrivateRoom(id string, ownerID int64) error {
	res, err := d.Exec(`DELETE FROM private_rooms WHERE id = ? AND owner_id = ?`, id, ownerID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// IsPrivateRoomAllowed reports whether userID may attempt to join room id:
// true when the room has no invite list at all (anyone with the code/link
// may try), or when userID is specifically on that list.
func (d *DB) IsPrivateRoomAllowed(id string, userID int64) (bool, error) {
	var allowed int
	err := d.QueryRow(
		`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM private_room_invites WHERE room_id = ?)
		             OR EXISTS (SELECT 1 FROM private_room_invites WHERE room_id = ? AND user_id = ?)
		        THEN 1 ELSE 0 END`,
		id, id, userID,
	).Scan(&allowed)
	if err != nil {
		return false, err
	}
	return allowed != 0, nil
}

// PrivateRoomInviteeIDs lists the user IDs specifically invited to a room
// (empty when it's link/code-only with no restricted list). Pair with
// UsersBrief to render them.
func (d *DB) PrivateRoomInviteeIDs(id string) ([]int64, error) {
	rows, err := d.Query(`SELECT user_id FROM private_room_invites WHERE room_id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}
