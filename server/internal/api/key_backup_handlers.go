package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"visioncall/internal/auth"
	"visioncall/internal/db"
)

// An account's end-to-end encryption key backup. The apps create a "backup"
// key pair, register its public key as a pseudo-device (so every encrypted
// message is also sealed for it), and store the private key here encrypted
// with a password only the user knows. Signing in on a new device and
// entering that password lets it read those messages. The server only ever
// sees the encrypted blob.

const maxKeyBackupBytes = 16 * 1024

type keyBackupRequest struct {
	Data         json.RawMessage `json:"data"`
	PublicKeyJWK string          `json:"public_key_jwk"`
}

func (a *API) handleGetKeyBackup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	data, updated, err := a.db.KeyBackup(me.ID)
	if errors.Is(err, db.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"exists": false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load the key backup")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exists": true, "data": json.RawMessage(data), "updated_at": updated})
}

func (a *API) handleSaveKeyBackup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req keyBackupRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Data) == 0 || len(req.Data) > maxKeyBackupBytes || !json.Valid(req.Data) {
		writeErr(w, http.StatusBadRequest, "invalid backup data")
		return
	}
	var kdf struct {
		Iterations int `json:"iterations"`
	}
	if json.Unmarshal(req.Data, &kdf) != nil || kdf.Iterations < 200_000 || kdf.Iterations > 10_000_000 {
		writeErr(w, http.StatusBadRequest, "invalid backup key-derivation settings")
		return
	}
	if req.PublicKeyJWK == "" || len(req.PublicKeyJWK) > 4096 || !json.Valid([]byte(req.PublicKeyJWK)) {
		writeErr(w, http.StatusBadRequest, "invalid public key")
		return
	}
	if err := a.db.SaveKeyBackup(me.ID, string(req.Data), req.PublicKeyJWK); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the key backup")
		return
	}
	a.audit(r, "key_backup_save", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleDeleteKeyBackup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	if err := a.db.DeleteKeyBackup(me.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not delete the key backup")
		return
	}
	a.audit(r, "key_backup_delete", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
