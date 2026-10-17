package db

import (
	"database/sql"
	"errors"
)

// DeviceKey is one device's registered E2E public key. The server stores
// and serves these verbatim — it has no way to use them (no private key),
// they're only useful to other clients doing the actual encryption.
type DeviceKey struct {
	UserID       int64  `json:"user_id"`
	DeviceID     string `json:"device_id"`
	PublicKeyJWK string `json:"public_key_jwk"`
}

// UpsertDeviceKey registers or replaces a device's public key. Called once
// per device per browser profile (keys are stable once generated; a fresh
// browser profile/cleared storage generates a new one, which naturally
// orphans old messages on that device — there's no way around that with a
// server that never holds private keys).
func (d *DB) UpsertDeviceKey(userID int64, deviceID, publicKeyJWK string) error {
	q := insertIgnoreSQL(d.dialect, `user_devices (user_id, device_id, public_key_jwk, created_at)`, `?, ?, ?, ?`, `user_id, device_id`)
	if _, err := d.Exec(q, userID, deviceID, publicKeyJWK, now()); err != nil {
		return err
	}
	// insertIgnoreSQL is INSERT-if-absent; an existing device re-registering
	// (e.g. after a key rotation) needs an explicit update too.
	_, err := d.Exec(`UPDATE user_devices SET public_key_jwk = ? WHERE user_id = ? AND device_id = ?`, publicKeyJWK, userID, deviceID)
	return err
}

func (d *DB) CountDeviceKeys(userID int64) (int, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM user_devices WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

func (d *DB) HasDeviceKey(userID int64, deviceID string) bool {
	var n int
	return d.QueryRow(`SELECT COUNT(*) FROM user_devices WHERE user_id = ? AND device_id = ?`, userID, deviceID).Scan(&n) == nil && n > 0
}

// DeleteOldestDeviceKey drops the user's oldest regular device (never the
// key-backup pseudo-device).
func (d *DB) DeleteOldestDeviceKey(userID int64) error {
	var dev string
	err := d.QueryRow(`SELECT device_id FROM user_devices WHERE user_id = ? AND device_id <> ? ORDER BY created_at ASC LIMIT 1`, userID, BackupDeviceID).Scan(&dev)
	if err != nil {
		return err
	}
	return d.DeleteDeviceKey(userID, dev)
}

func (d *DB) DeleteDeviceKey(userID int64, deviceID string) error {
	_, err := d.Exec(`DELETE FROM user_devices WHERE user_id = ? AND device_id = ?`, userID, deviceID)
	return err
}

// DeviceKeysForUsers returns every registered device key for the given
// users — the fan-out list a sender encrypts a message's content key to.
func (d *DB) DeviceKeysForUsers(userIDs []int64) ([]DeviceKey, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := d.Query(`SELECT user_id, device_id, public_key_jwk FROM user_devices WHERE user_id IN (`+placeholders(len(userIDs))+`)`, int64Args(userIDs)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceKey
	for rows.Next() {
		var k DeviceKey
		if err := rows.Scan(&k.UserID, &k.DeviceID, &k.PublicKeyJWK); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// BackupDeviceID is the pseudo-device an account's encryption key backup is
// registered under, so senders seal every message for it too.
const BackupDeviceID = "backup"

// KeyBackup returns an account's key backup and when it was saved, or
// ErrNotFound when the account has none.
func (d *DB) KeyBackup(userID int64) (data, updatedAt string, err error) {
	err = d.QueryRow(`SELECT data, updated_at FROM key_backups WHERE user_id = ?`, userID).Scan(&data, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return data, updatedAt, err
}

// SaveKeyBackup stores an account's key backup and registers the backup's
// public key as its "backup" device, in one transaction.
func (d *DB) SaveKeyBackup(userID int64, data, publicKeyJWK string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := now()
	if _, err := tx.Exec(`DELETE FROM key_backups WHERE user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO key_backups (user_id, data, updated_at) VALUES (?, ?, ?)`, userID, data, stamp); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM user_devices WHERE user_id = ? AND device_id = ?`, userID, BackupDeviceID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO user_devices (user_id, device_id, public_key_jwk, created_at) VALUES (?, ?, ?, ?)`, userID, BackupDeviceID, publicKeyJWK, stamp); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteKeyBackup removes an account's key backup and its backup device, so
// new messages are no longer sealed for it.
func (d *DB) DeleteKeyBackup(userID int64) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM key_backups WHERE user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM user_devices WHERE user_id = ? AND device_id = ?`, userID, BackupDeviceID); err != nil {
		return err
	}
	return tx.Commit()
}
