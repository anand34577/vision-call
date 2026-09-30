package api

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
	"visioncall/internal/db"
)

var usernameRE = regexp.MustCompile(`^[a-zA-Z0-9._-]{2,32}$`)
var emailRE = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// normalizeEmail trims/lowercases an email, validates its shape, and returns
// nil for an empty string (meaning "no email on file"). It does not check
// uniqueness — that's enforced by the DB's partial unique index and surfaced
// as a 409 by the caller.
func normalizeEmail(raw string) (*string, error) {
	e := strings.ToLower(strings.TrimSpace(raw))
	if e == "" {
		return nil, nil
	}
	if len(e) > 254 || !emailRE.MatchString(e) {
		return nil, errors.New("invalid email address")
	}
	return &e, nil
}

// setEmail applies a normalized email to a user, translating the DB's unique
// constraint violation into a friendly 409 instead of a raw SQL error.
func (a *API) setEmail(w http.ResponseWriter, userID int64, raw string) (ok bool) {
	email, err := normalizeEmail(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return false
	}
	if err := a.db.SetUserEmail(userID, email); err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate") {
			writeErr(w, http.StatusConflict, "email already in use")
		} else {
			writeErr(w, http.StatusInternalServerError, "could not update email")
		}
		return false
	}
	return true
}

// maxDisplayNameRunes caps display names so one account can't push
// megabyte-long names into every message, presence and call payload.
const maxDisplayNameRunes = 64

// cleanDisplayName trims a display name and reports whether it's usable.
func cleanDisplayName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	return name, name != "" && utf8.RuneCountInString(name) <= maxDisplayNameRunes
}

func (a *API) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := a.db.ListUsers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list users")
		return
	}
	// The directory is visible to everyone; email addresses are only for
	// admins (who manage them) and the account owner.
	if me := auth.CurrentUser(r); me.Role != "admin" {
		visible := users[:0]
		for _, u := range users {
			if u.Deleted {
				continue
			}
			if u.ID != me.ID {
				u.Email = nil
			}
			visible = append(visible, u)
		}
		users = visible
	}
	a.decorateUsers(users)
	writeJSON(w, http.StatusOK, users)
}

type createUserRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role"`
	Email       string `json:"email"`
}

func (a *API) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.TrimSpace(strings.ToLower(req.Username))
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if utf8.RuneCountInString(req.DisplayName) > maxDisplayNameRunes {
		writeErr(w, http.StatusBadRequest, "display name must be at most 64 characters")
		return
	}
	if !usernameRE.MatchString(req.Username) {
		writeErr(w, http.StatusBadRequest, "username must be 2-32 chars: letters, digits, dot, dash, underscore")
		return
	}
	if req.DisplayName == "" {
		req.DisplayName = req.Username
	}
	if len(req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if req.Role != "admin" && req.Role != "user" {
		req.Role = "user"
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := a.db.GetUserByUsername(req.Username); err == nil {
		writeErr(w, http.StatusConflict, "username already taken")
		return
	}
	if email != nil {
		if taken, err := a.db.EmailTaken(*email); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not verify email")
			return
		} else if taken {
			writeErr(w, http.StatusConflict, "email already in use")
			return
		}
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not hash password")
		return
	}
	user, err := a.db.CreateUser(req.Username, req.DisplayName, hash, req.Role)
	if err == nil {
		// An admin picked this password, so its owner must replace it.
		_ = a.db.SetMustChangePassword(user.ID, true)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create user")
		return
	}
	if req.Email != "" && !a.setEmail(w, user.ID, req.Email) {
		return // setEmail already wrote the error response
	}
	if u, err := a.db.GetUserByID(user.ID); err == nil {
		user = u
	}
	a.audit(r, "user_create", "user", &user.ID, "username="+user.Username+" role="+user.Role)
	a.hub.DirectoryChanged()
	user.PasswordHash = ""
	user.Status = "offline"
	writeJSON(w, http.StatusCreated, user)
}

type updateUserRequest struct {
	DisplayName *string `json:"display_name"`
	Role        *string `json:"role"`
	Disabled    *bool   `json:"disabled"`
	Password    *string `json:"password"`
	Email       *string `json:"email"`
}

func (a *API) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	a.adminMu.Lock()
	defer a.adminMu.Unlock()

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	me := auth.CurrentUser(r)
	target, err := a.db.GetUserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if target.Deleted {
		writeErr(w, http.StatusBadRequest, "this account was deleted and can't be changed")
		return
	}
	var req updateUserRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Role != nil && *req.Role != target.Role {
		if target.ID == me.ID {
			writeErr(w, http.StatusBadRequest, "you cannot change your own role")
			return
		}
		if *req.Role != "admin" && *req.Role != "user" {
			writeErr(w, http.StatusBadRequest, "invalid role")
			return
		}
		// Do not remove the last usable administrator. A disabled admin does
		// not keep the application recoverable.
		if target.Role == "admin" {
			if count, err := a.db.CountEnabledAdmins(); err != nil {
				writeErr(w, http.StatusInternalServerError, "could not verify administrator count")
				return
			} else if (!target.Disabled && count <= 1) || (target.Disabled && count == 0) {
				writeErr(w, http.StatusBadRequest, "cannot demote the last admin")
				return
			}
		}
	}
	if req.Disabled != nil && *req.Disabled && target.Role == "admin" && !target.Disabled {
		if count, err := a.db.CountEnabledAdmins(); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not verify administrator count")
			return
		} else if count <= 1 {
			writeErr(w, http.StatusBadRequest, "cannot suspend the last active admin")
			return
		}
	}
	if req.Disabled != nil && *req.Disabled && target.ID == me.ID {
		writeErr(w, http.StatusBadRequest, "you cannot suspend your own account")
		return
	}
	if req.Password != nil && len(*req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if req.DisplayName != nil {
		name, ok := cleanDisplayName(*req.DisplayName)
		if !ok {
			writeErr(w, http.StatusBadRequest, "display name must be 1-64 characters")
			return
		}
		req.DisplayName = &name
	}

	var passwordHash *string
	if req.Password != nil {
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not hash password")
			return
		}
		passwordHash = &hash
	}
	// Validate/apply the email change first: if it conflicts (already in
	// use), bail before touching password/role/disabled below, so a failed
	// request never leaves a half-applied update (password changed but the
	// session-revoke step never reached).
	if req.Email != nil && !a.setEmail(w, id, *req.Email) {
		return
	}
	if err := a.db.UpdateUserWithPassword(id, req.DisplayName, req.Role, req.Disabled, passwordHash); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update user")
		return
	}

	// Suspending or changing the password takes effect straight away: every
	// session is revoked and a connected app is signed out on the spot.
	suspended := req.Disabled != nil && *req.Disabled
	if suspended || req.Password != nil {
		if err := a.db.DeleteSessionsForUser(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not revoke existing sessions")
			return
		}
		reason := "password_changed"
		if suspended {
			reason = "suspended"
		}
		if req.Password != nil {
			_ = a.db.DeletePasswordResetTokensForUser(id)
			_ = a.db.SetMustChangePassword(id, true)
		}
		a.hub.KickUser(id, reason)
	} else if req.Role != nil || req.DisplayName != nil {
		a.hub.AccountUpdated(id)
	}
	a.hub.DirectoryChanged()

	user, err := a.db.GetUserByID(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not retrieve updated user")
		return
	}
	var changed []string
	if req.DisplayName != nil {
		changed = append(changed, "display_name")
	}
	if req.Role != nil {
		changed = append(changed, "role="+*req.Role)
	}
	if req.Disabled != nil {
		changed = append(changed, fmt.Sprintf("disabled=%v", *req.Disabled))
	}
	if req.Password != nil {
		changed = append(changed, "password")
	}
	if req.Email != nil {
		changed = append(changed, "email")
	}
	a.audit(r, "user_update", "user", &id, strings.Join(changed, ","))
	user.PasswordHash = ""
	user.Status = "offline"
	a.decorateUsers([]*db.User{user})
	writeJSON(w, http.StatusOK, user)
}

// handleSignOutUser ends every session of an account without suspending it,
// for example after a lost phone.
func (a *API) handleSignOutUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := a.db.GetUserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := a.db.DeleteSessionsForUser(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke sessions")
		return
	}
	a.hub.KickUser(id, "signed_out")
	a.audit(r, "user_sign_out", "user", &id, "username="+target.Username)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleDeleteUser removes an account in one of two ways:
//
//   - default: the account is anonymized to "Deleted user". It can never
//     sign in again, but its messages and calls stay in other people's
//     history.
//   - ?permanent=true: the account and everything tied to it (messages in
//     both directions, calls, uploads, rooms) are erased for good.
func (a *API) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	a.adminMu.Lock()
	defer a.adminMu.Unlock()

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	permanent := r.URL.Query().Get("permanent") == "true"
	me := auth.CurrentUser(r)
	if id == me.ID {
		writeErr(w, http.StatusBadRequest, "you cannot delete your own account")
		return
	}
	target, err := a.db.GetUserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if target.Deleted && !permanent {
		writeErr(w, http.StatusBadRequest, "this account is already deleted")
		return
	}
	if target.Role == "admin" && !target.Disabled && !target.Deleted {
		admins, err := a.db.CountEnabledAdmins()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not verify administrator count")
			return
		}
		if admins <= 1 {
			writeErr(w, http.StatusBadRequest, "cannot delete the last active admin")
			return
		}
	}
	if err := a.db.DeleteSessionsForUser(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke existing sessions")
		return
	}
	// Removing keeps files still shown in other people's chats; erasing
	// deletes every upload along with the messages.
	paths, err := a.db.FilePathsForUploader(id)
	if permanent {
		paths, err = a.db.AllFilePathsForUploader(id)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not inspect user files")
		return
	}
	a.hub.KickUser(id, "deleted")
	if permanent {
		if err := a.db.PurgeUser(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not delete user")
			return
		}
		a.audit(r, "user_purge", "user", &id, "username="+target.Username)
	} else {
		if err := a.db.AnonymizeUser(id); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not delete user")
			return
		}
		a.audit(r, "user_delete", "user", &id, "username="+target.Username)
	}
	for _, path := range paths {
		if !withinDirectory(a.cfg.DataDir, path) {
			if a.log != nil {
				a.log.Warn("skip file outside data directory", "user_id", id, "path", path)
			}
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) && a.log != nil {
			a.log.Warn("remove deleted user's file", "user_id", id, "path", path, "err", err)
		}
	}
	a.hub.DirectoryChanged()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func withinDirectory(base, path string) bool {
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return false
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(baseAbs, pathAbs)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

type updateSelfRequest struct {
	DisplayName     *string `json:"display_name"`
	AvatarFileID    *int64  `json:"avatar_file_id"`
	Email           *string `json:"email"`
	CurrentPassword string  `json:"current_password"`
	NewPassword     string  `json:"new_password"`
}

func (a *API) handleUpdateSelf(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req updateSelfRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.NewPassword != "" {
		ok, err := auth.VerifyPassword(me.PasswordHash, req.CurrentPassword)
		if err != nil || !ok {
			writeErr(w, http.StatusBadRequest, "current password is incorrect")
			return
		}
		if len(req.NewPassword) < 8 {
			writeErr(w, http.StatusBadRequest, "new password must be at least 8 characters")
			return
		}
		hash, err := auth.HashPassword(req.NewPassword)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not hash password")
			return
		}
		if err := a.db.SetUserPassword(me.ID, hash); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not update password")
			return
		}
		if err := a.db.DeleteSessionsForUser(me.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not revoke existing sessions")
			return
		}
		_ = a.db.DeletePasswordResetTokensForUser(me.ID)
		a.hub.KickUser(me.ID, "password_changed")
		a.audit(r, "password_change", "user", &me.ID, "self-service")
		writeJSON(w, http.StatusOK, map[string]string{"status": "relogin"})
		return
	}
	if req.DisplayName != nil {
		name, ok := cleanDisplayName(*req.DisplayName)
		if !ok {
			writeErr(w, http.StatusBadRequest, "display name must be 1-64 characters")
			return
		}
		if err := a.db.UpdateUser(me.ID, &name, nil, nil); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not update display name")
			return
		}
	}
	if req.AvatarFileID != nil {
		file, err := a.db.GetFile(*req.AvatarFileID)
		if err != nil || file.UploaderID != me.ID || !strings.HasPrefix(file.Mime, "image/") {
			writeErr(w, http.StatusBadRequest, "avatar must be an image uploaded by you")
			return
		}
		if err := a.db.SetUserAvatar(me.ID, req.AvatarFileID); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not set avatar")
			return
		}
	}
	if req.Email != nil && !a.setEmail(w, me.ID, *req.Email) {
		return
	}
	user, err := a.db.GetUserByID(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not retrieve updated user")
		return
	}
	user.PasswordHash = ""
	user.Status = "online"
	if prefs, err := a.db.GetUserPreferences(user.ID); err == nil {
		user.Preferences = prefs
	}
	writeJSON(w, http.StatusOK, user)
}

var validThemes = map[string]bool{
	"dark": true, "light": true, "midnight": true, "sunset": true, "forest": true, "cyberpunk": true,
}
var validAccents = map[string]bool{
	"blue": true, "purple": true, "emerald": true, "rose": true, "amber": true, "cyan": true,
}
var validRadii = map[string]bool{
	"rounded": true, "compact": true, "pill": true,
}

func (a *API) handleGetPreferences(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	prefs, err := a.db.GetUserPreferences(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

func (a *API) handleUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req db.UserPreferences
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Theme = strings.ToLower(strings.TrimSpace(req.Theme))
	req.AccentColor = strings.ToLower(strings.TrimSpace(req.AccentColor))
	req.Radius = strings.ToLower(strings.TrimSpace(req.Radius))

	if !validThemes[req.Theme] {
		req.Theme = "dark"
	}
	if !validAccents[req.AccentColor] {
		req.AccentColor = "blue"
	}
	if !validRadii[req.Radius] {
		req.Radius = "rounded"
	}

	if err := a.db.SetUserPreferences(me.ID, &req); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save preferences")
		return
	}
	writeJSON(w, http.StatusOK, req)
}
