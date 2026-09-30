package api

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
)

func currentSessionID(a *API, r *http.Request) string {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		if claims, err := auth.ParseToken(a.cfg.JWTSecret, c.Value); err == nil {
			return claims.SessionID
		}
	}
	return ""
}

// handleListSessions lists the caller's signed-in devices.
func (a *API) handleListSessions(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	list, err := a.db.ListSessions(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list sessions")
		return
	}
	cur := currentSessionID(a, r)
	for i := range list {
		list[i].Current = list[i].ID == cur
	}
	writeJSON(w, http.StatusOK, list)
}

// handleRevokeSession signs one of the caller's devices out. Revoking the
// current session is a normal logout; other devices see a 401 on next use
// and their realtime socket is dropped right away.
func (a *API) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id := chi.URLParam(r, "id")
	ok, err := a.db.DeleteSessionOf(me.ID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke session")
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	a.hub.KickSession(me.ID, id, "signed_out_remotely")
	a.audit(r, "session_revoke", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleRevokeOtherSessions signs the caller out everywhere but here.
func (a *API) handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	cur := currentSessionID(a, r)
	if err := a.db.DeleteOtherSessions(me.ID, cur); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke sessions")
		return
	}
	a.hub.KickOtherSessions(me.ID, cur, "signed_out_remotely")
	a.audit(r, "session_revoke_others", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleTOTPSetup returns a fresh authenticator secret. Nothing is stored
// until handleTOTPEnable proves the user's app produces valid codes.
func (a *API) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	secret, err := auth.NewTOTPSecret()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not generate secret")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": secret, "uri": auth.TOTPURI(secret, me.Username)})
}

func (a *API) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req struct {
		Secret string `json:"secret"`
		Code   string `json:"code"`
	}
	if err := readJSON(r, &req); err != nil || !auth.VerifyTOTP(req.Secret, req.Code, time.Now()) {
		writeErr(w, http.StatusBadRequest, "that code is not valid — check your authenticator app and try again")
		return
	}
	if err := a.db.SetTOTPSecret(me.ID, req.Secret); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not enable two-factor")
		return
	}
	a.audit(r, "totp_enable", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleTOTPDisable requires the account password so a stolen session alone
// can't strip the second factor.
func (a *API) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if ok, err := auth.VerifyPassword(me.PasswordHash, req.Password); err != nil || !ok {
		writeErr(w, http.StatusBadRequest, "password is incorrect")
		return
	}
	if err := a.db.SetTOTPSecret(me.ID, ""); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not disable two-factor")
		return
	}
	a.audit(r, "totp_disable", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleSetStatusText sets the caller's short status line (max 140 chars).
func (a *API) handleSetStatusText(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req struct {
		Text string `json:"text"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	text := strings.TrimSpace(req.Text)
	if utf8.RuneCountInString(text) > 140 {
		writeErr(w, http.StatusBadRequest, "status must be 140 characters or fewer")
		return
	}
	if err := a.db.SetStatusText(me.ID, text); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save status")
		return
	}
	a.hub.DirectoryChanged()
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

// requirePasswordChange blocks everything except reading the profile, logging
// out and changing the password while a forced change is pending.
func requirePasswordChange(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := auth.CurrentUser(r); u != nil && u.MustChangePassword {
			p := r.URL.Path
			if !strings.HasSuffix(p, "/me") && !strings.HasSuffix(p, "/logout") {
				writeErr(w, http.StatusForbidden, "password change required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
