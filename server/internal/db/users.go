package db

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type User struct {
	ID           int64   `json:"id"`
	Username     string  `json:"username"`
	DisplayName  string  `json:"display_name"`
	PasswordHash string  `json:"-"`
	Role         string  `json:"role"`
	AvatarFileID *int64  `json:"avatar_file_id"`
	Email        *string `json:"email"`
	Disabled     bool    `json:"disabled"`
	// Deleted accounts were removed by an admin but still appear as
	// "Deleted user" in other people's history. They can't be re-enabled.
	Deleted   bool   `json:"deleted"`
	CreatedAt string `json:"created_at"`
	// StatusText is a short free-text "what I'm up to" line.
	StatusText string `json:"status_text"`
	// MustChangePassword forces a new password at next sign-in (set when an
	// admin creates the account or sets its password).
	MustChangePassword bool `json:"must_change_password"`
	// TOTPSecret is the base32 authenticator secret; empty means 2FA is off.
	TOTPSecret  string  `json:"-"`
	OIDCIssuer  *string `json:"-"`
	OIDCSubject *string `json:"-"`
	// Status is filled at runtime from the presence hub, not stored here.
	Status string `json:"status"`
	// Preferences stores UI theme and styling preferences
	Preferences *UserPreferences `json:"preferences,omitempty"`
}

// OIDCLinked reports whether this account has an SSO identity attached.
func (u *User) OIDCLinked() bool { return u.OIDCSubject != nil }

// MarshalJSON adds the computed oidc_linked field without duplicating every
// other field by hand (a type alias sidesteps MarshalJSON recursion).
func (u *User) MarshalJSON() ([]byte, error) {
	type alias User
	return json.Marshal(struct {
		*alias
		OIDCLinked  bool `json:"oidc_linked"`
		TOTPEnabled bool `json:"totp_enabled"`
	}{alias: (*alias)(u), OIDCLinked: u.OIDCLinked(), TOTPEnabled: u.TOTPSecret != ""})
}

// UserBrief is the trimmed user shape embedded in messages and call records.
type UserBrief struct {
	ID           int64  `json:"id"`
	DisplayName  string `json:"display_name"`
	Username     string `json:"username"`
	AvatarFileID *int64 `json:"avatar_file_id"`
}

var ErrNotFound = errors.New("not found")

const userCols = `id, username, display_name, password_hash, role, avatar_file_id, email, disabled, deleted, created_at, oidc_issuer, oidc_subject, status_text, must_change_password, totp_secret`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	var avatar sql.NullInt64
	var email, oidcIssuer, oidcSubject sql.NullString
	var disabled, deleted, mustChange int
	if err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &avatar, &email, &disabled, &deleted, &u.CreatedAt, &oidcIssuer, &oidcSubject, &u.StatusText, &mustChange, &u.TOTPSecret); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if avatar.Valid {
		a := avatar.Int64
		u.AvatarFileID = &a
	}
	u.Email = nullStringPtr(email)
	u.OIDCIssuer = nullStringPtr(oidcIssuer)
	u.OIDCSubject = nullStringPtr(oidcSubject)
	u.Disabled = disabled != 0
	u.Deleted = deleted != 0
	u.MustChangePassword = mustChange != 0
	return u, nil
}

func (d *DB) CountUsers() (int, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CountActiveUsers counts accounts that haven't been deleted.
func (d *DB) CountActiveUsers() (int, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE deleted = 0`).Scan(&n)
	return n, err
}

func (d *DB) CountEnabledAdmins() (int, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND deleted = 0`).Scan(&n)
	return n, err
}

func (d *DB) CreateUser(username, displayName, passwordHash, role string) (*User, error) {
	res, err := d.Exec(`INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`,
		username, displayName, passwordHash, role, now())
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return d.GetUserByID(id)
}

func (d *DB) GetUserByID(id int64) (*User, error) {
	return scanUser(d.QueryRow(`SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	return scanUser(d.QueryRow(`SELECT `+userCols+` FROM users WHERE username = ?`, username))
}

// GetUserByEmail looks up an enabled account by its on-file email, for
// password-reset requests. Returns ErrNotFound for no match or a disabled
// account (disabled accounts can't be reset back into use this way).
func (d *DB) GetUserByEmail(email string) (*User, error) {
	u, err := scanUser(d.QueryRow(`SELECT `+userCols+` FROM users WHERE email = ?`, email))
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, ErrNotFound
	}
	return u, nil
}

// EmailTaken reports whether any account (enabled or not) already has this
// email on file, so a caller can reject a duplicate before creating a row.
func (d *DB) EmailTaken(email string) (bool, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE email = ?`, email).Scan(&n)
	return n > 0, err
}

func (d *DB) SetUserEmail(id int64, email *string) error {
	_, err := d.Exec(`UPDATE users SET email = ? WHERE id = ?`, sqlNullString(email), id)
	return err
}

// ---- OIDC/SSO account linking ----

// ErrOIDCAlreadyLinked means the (issuer, subject) identity is already
// linked to a different local account.
var ErrOIDCAlreadyLinked = errors.New("this SSO identity is already linked to another account")

// LinkOIDC attaches an external identity to a local account. The unique
// index on (oidc_issuer, oidc_subject) is what actually enforces one
// identity per account; this just turns that constraint violation into a
// typed error instead of a raw driver error.
func (d *DB) LinkOIDC(userID int64, issuer, subject string) error {
	_, err := d.Exec(`UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?`, issuer, subject, userID)
	if isUniqueViolation(err) {
		return ErrOIDCAlreadyLinked
	}
	return err
}

func (d *DB) UnlinkOIDC(userID int64) error {
	_, err := d.Exec(`UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE id = ?`, userID)
	return err
}

// GetUserByOIDC looks up the account linked to an external identity.
func (d *DB) GetUserByOIDC(issuer, subject string) (*User, error) {
	return scanUser(d.QueryRow(`SELECT `+userCols+` FROM users WHERE oidc_issuer = ? AND oidc_subject = ?`, issuer, subject))
}

func (d *DB) ListUsers() ([]*User, error) {
	rows, err := d.Query(`SELECT ` + userCols + ` FROM users ORDER BY LOWER(display_name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*User, 0, 16)
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (d *DB) UsersBrief(ids []int64) (map[int64]*UserBrief, error) {
	out := make(map[int64]*UserBrief, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	q := `SELECT id, display_name, username, avatar_file_id FROM users WHERE id IN (`
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			q += ","
		}
		q += "?"
		args[i] = id
	}
	q += `)`
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		b := &UserBrief{}
		var avatar sql.NullInt64
		if err := rows.Scan(&b.ID, &b.DisplayName, &b.Username, &avatar); err != nil {
			return nil, err
		}
		if avatar.Valid {
			a := avatar.Int64
			b.AvatarFileID = &a
		}
		out[b.ID] = b
	}
	return out, rows.Err()
}

func (d *DB) UpdateUser(id int64, displayName *string, role *string, disabled *bool) error {
	return d.updateUser(id, displayName, role, disabled, nil)
}

func (d *DB) UpdateUserWithPassword(id int64, displayName *string, role *string, disabled *bool, passwordHash *string) error {
	return d.updateUser(id, displayName, role, disabled, passwordHash)
}

func (d *DB) updateUser(id int64, displayName *string, role *string, disabled *bool, passwordHash *string) error {
	if displayName == nil && role == nil && disabled == nil && passwordHash == nil {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	if displayName != nil {
		if _, err := tx.Exec(`UPDATE users SET display_name = ? WHERE id = ?`, *displayName, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	if role != nil {
		if _, err := tx.Exec(`UPDATE users SET role = ? WHERE id = ?`, *role, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	if disabled != nil {
		v := 0
		if *disabled {
			v = 1
		}
		if _, err := tx.Exec(`UPDATE users SET disabled = ? WHERE id = ?`, v, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	if passwordHash != nil {
		if _, err := tx.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, *passwordHash, id); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// SetUserPassword stores a password the user chose themselves, which also
// satisfies a pending "must change password" requirement.
func (d *DB) SetUserPassword(id int64, hash string) error {
	_, err := d.Exec(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`, hash, id)
	return err
}

// SetMustChangePassword flags (or clears) the forced password change.
func (d *DB) SetMustChangePassword(id int64, on bool) error {
	v := 0
	if on {
		v = 1
	}
	_, err := d.Exec(`UPDATE users SET must_change_password = ? WHERE id = ?`, v, id)
	return err
}

func (d *DB) SetStatusText(id int64, text string) error {
	_, err := d.Exec(`UPDATE users SET status_text = ? WHERE id = ?`, text, id)
	return err
}

// SetTOTPSecret stores the authenticator secret ("" turns 2FA off).
func (d *DB) SetTOTPSecret(id int64, secret string) error {
	_, err := d.Exec(`UPDATE users SET totp_secret = ? WHERE id = ?`, secret, id)
	return err
}

func (d *DB) SetUserAvatar(id int64, fileID *int64) error {
	if fileID == nil {
		_, err := d.Exec(`UPDATE users SET avatar_file_id = NULL WHERE id = ?`, id)
		return err
	}
	_, err := d.Exec(`UPDATE users SET avatar_file_id = ? WHERE id = ?`, *fileID, id)
	return err
}

// unusablePasswordHash is stored on anonymized accounts. Its format parses
// but its "memory,time,threads" segment does not, so VerifyPassword always
// errors out on it rather than matching any real password.
const unusablePasswordHash = `$argon2id$v=19$m=0,t=0,p=0$-$-`

// AnonymizeUser replaces an account with a disabled, unnamed placeholder
// instead of deleting the row. Deleting the row outright would cascade
// (messages.sender_id, calls.initiator_id, etc. are ON DELETE CASCADE) and
// erase chat/call history for every other party in those conversations, not
// just the removed user's own data. The row survives so that history intact;
// only the identity and login are wiped.
// AnonymizeUser also clears email and OIDC identity (both otherwise kept
// unique by an index, so a deleted account would permanently squat that
// email/SSO identity and block anyone else, including the same person,
// from ever using it again) and invalidates any outstanding password-reset
// token, matching every other password-mutating path in this file.
func (d *DB) AnonymizeUser(id int64) error {
	_, err := d.Exec(`UPDATE users SET username = ?, display_name = 'Deleted user', password_hash = ?, avatar_file_id = NULL, email = NULL, oidc_issuer = NULL, oidc_subject = NULL, role = 'user', disabled = 1, deleted = 1 WHERE id = ?`,
		fmt.Sprintf("deleted-user-%d", id), unusablePasswordHash, id)
	if err != nil {
		return err
	}
	return d.DeletePasswordResetTokensForUser(id)
}

// PurgeUser permanently removes an account and everything tied to it: its
// messages (in both directions), reactions, call records, uploads, devices,
// rooms and sessions all go through ON DELETE CASCADE. Groups the user
// created are handed to another member first (a group admin if there is
// one) so other people's group conversations survive; a group with nobody
// else in it is removed.
func (d *DB) PurgeUser(id int64) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT id FROM groups WHERE created_by = ?`, id)
	if err != nil {
		return err
	}
	var groups []int64
	for rows.Next() {
		var g int64
		if err := rows.Scan(&g); err != nil {
			rows.Close()
			return err
		}
		groups = append(groups, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, g := range groups {
		var heir int64
		err := tx.QueryRow(`SELECT user_id FROM group_members WHERE group_id = ? AND user_id <> ?
			ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, user_id LIMIT 1`, g, id).Scan(&heir)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if _, err := tx.Exec(`DELETE FROM groups WHERE id = ?`, g); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			if _, err := tx.Exec(`UPDATE groups SET created_by = ? WHERE id = ?`, heir, g); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?`, g, heir); err != nil {
				return err
			}
		}
	}

	// user_preferences has no foreign key on MySQL, so clear it explicitly.
	if _, err := tx.Exec(`DELETE FROM user_preferences WHERE user_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM users WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ---- sessions ----

func (d *DB) CreateSession(sessionID string, userID int64, tokenHash string, expires time.Time, userAgent, ip string) error {
	if len(userAgent) > 255 {
		userAgent = userAgent[:255]
	}
	_, err := d.Exec(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, userID, tokenHash, now(), expires.UTC().Format(time.RFC3339), userAgent, ip, now())
	return err
}

// ExtendSession slides a session's expiry forward (sliding inactivity timeout).
func (d *DB) ExtendSession(sessionID string, expires time.Time) error {
	_, err := d.Exec(`UPDATE sessions SET expires_at = ?, last_seen = ? WHERE id = ?`,
		expires.UTC().Format(time.RFC3339), now(), sessionID)
	return err
}

// SessionInfo describes one signed-in device for the "devices" list.
type SessionInfo struct {
	ID        string `json:"id"`
	UserAgent string `json:"user_agent"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
	LastSeen  string `json:"last_seen"`
	Current   bool   `json:"current"`
}

func (d *DB) ListSessions(userID int64) ([]SessionInfo, error) {
	rows, err := d.Query(`SELECT id, user_agent, ip, created_at, last_seen FROM sessions WHERE user_id = ? AND expires_at >= ? ORDER BY created_at DESC`, userID, now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionInfo{}
	for rows.Next() {
		var s SessionInfo
		if err := rows.Scan(&s.ID, &s.UserAgent, &s.IP, &s.CreatedAt, &s.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeleteSessionOf removes one session, but only if it belongs to userID.
func (d *DB) DeleteSessionOf(userID int64, sessionID string) (bool, error) {
	res, err := d.Exec(`DELETE FROM sessions WHERE id = ? AND user_id = ?`, sessionID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DeleteOtherSessions signs a user out everywhere except keepID.
func (d *DB) DeleteOtherSessions(userID int64, keepID string) error {
	_, err := d.Exec(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`, userID, keepID)
	return err
}

// GetSession returns (tokenHash, expiresAt, userID); ErrNotFound when absent.
func (d *DB) GetSession(sessionID string) (string, time.Time, int64, error) {
	var tokenHash, exp string
	var userID int64
	err := d.QueryRow(`SELECT token_hash, expires_at, user_id FROM sessions WHERE id = ?`, sessionID).
		Scan(&tokenHash, &exp, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, 0, ErrNotFound
	}
	if err != nil {
		return "", time.Time{}, 0, err
	}
	t, err := time.Parse(time.RFC3339, exp)
	if err != nil {
		return "", time.Time{}, 0, err
	}
	return tokenHash, t, userID, nil
}

func (d *DB) DeleteSession(sessionID string) error {
	_, err := d.Exec(`DELETE FROM sessions WHERE id = ?`, sessionID)
	return err
}

func (d *DB) DeleteSessionsForUser(userID int64) error {
	_, err := d.Exec(`DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

func (d *DB) ExpireOldSessions() error {
	_, err := d.Exec(`DELETE FROM sessions WHERE expires_at < ?`, now())
	return err
}

// ---- password reset ----

func hashResetToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// CreatePasswordResetToken mints a random token for userID, stores only its
// hash (like sessions.token_hash), and returns the raw token to email out —
// it is never recoverable from the DB alone.
func (d *DB) CreatePasswordResetToken(userID int64, ttl time.Duration) (rawToken string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", err
	}
	rawToken = hex.EncodeToString(buf)
	id := hex.EncodeToString(buf[:8])
	_, err = d.Exec(`INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		id, userID, hashResetToken(rawToken), now(), time.Now().UTC().Add(ttl).Format(time.RFC3339))
	if err != nil {
		return "", err
	}
	return rawToken, nil
}

// ConsumePasswordResetToken validates a raw token (unexpired, unused, and
// matching by constant-time hash comparison) and marks it used in the same
// call, so a token can never be replayed even if the caller doesn't get to
// finish resetting the password. Returns the owning user id.
func (d *DB) ConsumePasswordResetToken(rawToken string) (int64, error) {
	// Restricting to still-unexpired rows keeps this scan bounded by "reset
	// links requested in roughly the last 30 minutes" rather than by every
	// unused token in the table's history — the periodic cleanup loop (see
	// main.go) keeps that set small, but this filter holds even if cleanup
	// ever falls behind.
	rows, err := d.Query(`SELECT id, user_id, token_hash, expires_at FROM password_reset_tokens WHERE used_at IS NULL AND expires_at >= ?`, now())
	if err != nil {
		return 0, err
	}
	type cand struct {
		id, hash, expires string
		userID            int64
	}
	var cands []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.userID, &c.hash, &c.expires); err != nil {
			rows.Close()
			return 0, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	want := hashResetToken(rawToken)
	for _, c := range cands {
		if subtle.ConstantTimeCompare([]byte(c.hash), []byte(want)) != 1 {
			continue
		}
		exp, err := time.Parse(time.RFC3339, c.expires)
		if err != nil || time.Now().After(exp) {
			return 0, ErrNotFound
		}
		// The `AND used_at IS NULL` guard makes this the actual single-use
		// gate: if two requests race past the SELECT above with the same
		// token, only the first UPDATE here affects a row — the loser sees
		// RowsAffected == 0 and is rejected instead of also succeeding.
		res, err := d.Exec(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`, now(), c.id)
		if err != nil {
			return 0, err
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			return 0, ErrNotFound
		}
		return c.userID, nil
	}
	return 0, ErrNotFound
}

// DeletePasswordResetTokensForUser invalidates any outstanding reset tokens,
// e.g. after a successful reset or a normal password change.
func (d *DB) DeletePasswordResetTokensForUser(userID int64) error {
	_, err := d.Exec(`DELETE FROM password_reset_tokens WHERE user_id = ?`, userID)
	return err
}

// ExpireOldPasswordResetTokens purges expired/used rows to cap table growth.
func (d *DB) ExpireOldPasswordResetTokens() error {
	_, err := d.Exec(`DELETE FROM password_reset_tokens WHERE expires_at < ? OR used_at IS NOT NULL`, now())
	return err
}

// UserPreferences stores UI customizations (theme, accent color, density/radius)
// persisted across logins and sessions in the database.
type UserPreferences struct {
	Theme       string `json:"theme"`
	AccentColor string `json:"accent_color"`
	Radius      string `json:"radius"`
}

func DefaultUserPreferences() *UserPreferences {
	return &UserPreferences{
		Theme:       "dark",
		AccentColor: "blue",
		Radius:      "rounded",
	}
}

func (d *DB) GetUserPreferences(userID int64) (*UserPreferences, error) {
	row := d.QueryRow(`SELECT theme, accent_color, radius FROM user_preferences WHERE user_id = ?`, userID)
	p := &UserPreferences{}
	if err := row.Scan(&p.Theme, &p.AccentColor, &p.Radius); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DefaultUserPreferences(), nil
		}
		return nil, err
	}
	if p.Theme == "" {
		p.Theme = "dark"
	}
	if p.AccentColor == "" {
		p.AccentColor = "blue"
	}
	if p.Radius == "" {
		p.Radius = "rounded"
	}
	return p, nil
}

func (d *DB) SetUserPreferences(userID int64, prefs *UserPreferences) error {
	if prefs == nil {
		prefs = DefaultUserPreferences()
	}
	if prefs.Theme == "" {
		prefs.Theme = "dark"
	}
	if prefs.AccentColor == "" {
		prefs.AccentColor = "blue"
	}
	if prefs.Radius == "" {
		prefs.Radius = "rounded"
	}

	q := `INSERT INTO user_preferences (user_id, theme, accent_color, radius, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			theme = excluded.theme,
			accent_color = excluded.accent_color,
			radius = excluded.radius,
			updated_at = excluded.updated_at`
	if d.dialect == DialectMySQL {
		q = `INSERT INTO user_preferences (user_id, theme, accent_color, radius, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				theme = VALUES(theme),
				accent_color = VALUES(accent_color),
				radius = VALUES(radius),
				updated_at = VALUES(updated_at)`
	}
	_, err := d.Exec(q, userID, prefs.Theme, prefs.AccentColor, prefs.Radius, now())
	return err
}
