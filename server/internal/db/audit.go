package db

import (
	"database/sql"
	"unicode/utf8"
)

// AuditEntry is one row of the audit trail: who did what to what, and from
// where. ActorName/TargetType/Detail are free-form but kept short and
// grep-able rather than structured — this is a log, not a query API.
type AuditEntry struct {
	ID         int64  `json:"id"`
	ActorID    *int64 `json:"actor_id"`
	ActorName  string `json:"actor_name"`
	Action     string `json:"action"`
	TargetType string `json:"target_type"`
	TargetID   *int64 `json:"target_id"`
	Detail     string `json:"detail"`
	IP         string `json:"ip"`
	CreatedAt  string `json:"created_at"`
}

// WriteAudit appends one audit row. actorID is nil for unauthenticated
// actions (e.g. a failed login attempt).
func (d *DB) WriteAudit(actorID *int64, actorName, action, targetType string, targetID *int64, detail, ip string) error {
	actorName, detail, ip = clip(actorName, 64), clip(detail, 500), clip(ip, 64)
	_, err := d.Exec(`INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, detail, ip, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		recID(actorID), actorName, action, targetType, recID(targetID), detail, ip, now())
	return err
}

// AuditFilter narrows ListAudit. Zero values mean "no filter" on that field.
type AuditFilter struct {
	Action   string
	ActorID  int64
	BeforeID int64 // pagination cursor: rows with id < BeforeID
	Limit    int
}

// ListAudit returns audit rows newest-first, optionally filtered.
func (d *DB) ListAudit(f AuditFilter) ([]*AuditEntry, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	where := "1=1"
	var args []any
	if f.Action != "" {
		where += " AND action = ?"
		args = append(args, f.Action)
	}
	if f.ActorID != 0 {
		where += " AND actor_id = ?"
		args = append(args, f.ActorID)
	}
	if f.BeforeID > 0 {
		where += " AND id < ?"
		args = append(args, f.BeforeID)
	}
	args = append(args, limit)
	rows, err := d.Query(`SELECT id, actor_id, actor_name, action, target_type, target_id, detail, ip, created_at
		FROM audit_log WHERE `+where+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*AuditEntry, 0, limit)
	for rows.Next() {
		e := &AuditEntry{}
		var actorID, targetID sql.NullInt64
		if err := rows.Scan(&e.ID, &actorID, &e.ActorName, &e.Action, &e.TargetType, &targetID, &e.Detail, &e.IP, &e.CreatedAt); err != nil {
			return nil, err
		}
		if actorID.Valid {
			v := actorID.Int64
			e.ActorID = &v
		}
		if targetID.Valid {
			v := targetID.Int64
			e.TargetID = &v
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// clip shortens attacker-influenced strings (login names, details) so the
// audit table can't be used as a storage amplifier; it never splits a rune.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// PruneAudit deletes audit rows older than cutoff (RFC3339).
func (d *DB) PruneAudit(cutoff string) error {
	_, err := d.Exec(`DELETE FROM audit_log WHERE created_at < ?`, cutoff)
	return err
}
