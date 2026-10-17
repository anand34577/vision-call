package api

import (
	"net/http"
	"time"

	"visioncall/internal/auth"
	"visioncall/internal/db"
	"visioncall/internal/mail"
	"visioncall/internal/settings"
)

const passwordResetTTL = 30 * time.Minute

// passwordResetActive is true only when SMTP is fully configured, the
// admin's separate "Enable password reset emails" switch is on, and
// PublicBaseURL is set. PublicBaseURL is required rather than falling back
// to the request's Host header: Host is client-supplied and unauthenticated,
// so deriving the reset link from it would let an attacker poison the link
// (send it pointing at their own domain and harvest the token).
func passwordResetActive(sv *settings.Values) bool {
	return sv.SMTPHost != "" && sv.PasswordResetEnabled && sv.PublicBaseURL != ""
}

// handlePasswordResetEnabled tells the login page whether to offer a "forgot
// password" link at all — it only works once an admin has set SMTP
// credentials (SMTP_HOST/SMTP_USER/SMTP_PASS) and left the feature enabled,
// so there's no point showing UI for a feature that would just fail.
func (a *API) handlePasswordResetEnabled(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": passwordResetActive(a.settings.Get())})
}

type passwordResetRequest struct {
	Email string `json:"email"`
}

// handlePasswordResetRequest emails a reset link if, and only if, the email
// matches an enabled account — but always answers with the same generic
// message either way, so the endpoint can't be used to enumerate which
// emails are registered.
func (a *API) handlePasswordResetRequest(w http.ResponseWriter, r *http.Request) {
	const generic = "If that email is on an account, a reset link was sent."
	sv := a.settings.Get()
	if !passwordResetActive(sv) {
		writeErr(w, http.StatusServiceUnavailable, "password reset is not available; contact your administrator")
		return
	}
	var req passwordResetRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email, err := normalizeEmail(req.Email)
	if err != nil || email == nil {
		writeJSON(w, http.StatusOK, map[string]string{"message": generic})
		return
	}
	// Reuses the login limiter's storage under a distinct key namespace so a
	// flood of reset requests for one email/IP can't spam that inbox or hammer
	// the SMTP relay.
	ip := RealIP(r, a.settings.Get().TrustProxy)
	// Three independent caps: per source IP (any email), per target email
	// (any source, so a botnet can't flood one inbox), and per pair.
	if !a.ipLimiter.Reserve("resetip|"+ip) || !a.limiter.Reserve("reset|"+*email) {
		writeJSON(w, http.StatusOK, map[string]string{"message": generic})
		return
	}
	key := "reset|" + *email + "|" + ip
	if !a.limiter.Reserve(key) { // counts toward the same 5-per-15min window as failed logins
		writeJSON(w, http.StatusOK, map[string]string{"message": generic})
		return
	}

	user, err := a.db.GetUserByEmail(*email)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"message": generic})
		return
	}
	// Everything past the lookup runs in the background: the token insert
	// and the SMTP round-trip only happen for real accounts, so doing them
	// inline would let response latency reveal which emails exist (and a
	// slow relay would hang the request).
	smtpCfg := mail.Config{Host: sv.SMTPHost, Port: sv.SMTPPort, User: sv.SMTPUser, Pass: sv.SMTPPass, From: sv.SMTPFrom}
	baseURL := a.publicBaseURL()
	go func(to string, user *db.User) {
		token, err := a.db.CreatePasswordResetToken(user.ID, passwordResetTTL)
		if err != nil {
			a.log.Error("password reset: create token", "user_id", user.ID, "err", err)
			return
		}
		link := baseURL + "/reset-password?token=" + token
		body := "Hi " + user.DisplayName + ",\n\n" +
			"Someone requested a password reset for your account. If this was you, click the link below within 30 minutes:\n\n" +
			link + "\n\n" +
			"If you didn't request this, you can ignore this email.\n"
		if err := mail.Send(smtpCfg, to, "Reset your password", body); err != nil {
			a.log.Error("password reset: send email", "user_id", user.ID, "err", err)
		}
	}(*email, user)
	writeJSON(w, http.StatusOK, map[string]string{"message": generic})
}

type passwordResetConfirmRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (a *API) handlePasswordResetConfirm(w http.ResponseWriter, r *http.Request) {
	if !passwordResetActive(a.settings.Get()) {
		writeErr(w, http.StatusServiceUnavailable, "password reset is not available; contact your administrator")
		return
	}
	var req passwordResetConfirmRequest
	if err := readJSON(r, &req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.NewPassword) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	userID, err := a.db.ConsumePasswordResetToken(req.Token)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "this reset link is invalid or has expired")
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not hash password")
		return
	}
	if err := a.db.SetUserPassword(userID, hash); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update password")
		return
	}
	// The whole point of a password reset is to invalidate any session an
	// attacker might hold, so a failure here is not a "log and move on"
	// situation - surface it as a 500 (the client should retry) rather than
	// silently reporting success while an old session cookie is still valid
	// against the sessions table. hub.KickUser still runs regardless, so any
	// currently-connected socket is dropped immediately either way.
	sessErr := a.db.DeleteSessionsForUser(userID)
	tokenErr := a.db.DeletePasswordResetTokensForUser(userID)
	a.hub.KickUser(userID, "password_changed")
	if sessErr != nil {
		a.log.Error("password reset: revoke sessions failed", "user_id", userID, "err", sessErr)
		writeErr(w, http.StatusInternalServerError, "password was changed, but revoking old sessions failed — please contact your administrator")
		return
	}
	if tokenErr != nil {
		a.log.Error("password reset: clear reset tokens failed", "user_id", userID, "err", tokenErr)
	}
	a.audit(r, "password_change", "user", &userID, "via password-reset email link")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// publicBaseURL is the origin to put in reset links. Only the admin-configured
// PublicBaseURL setting is used — see passwordResetActive for why the
// request's Host header must never be trusted for this.
func (a *API) publicBaseURL() string {
	return a.settings.Get().PublicBaseURL
}
