package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
	"visioncall/internal/db"
	"visioncall/internal/oidc"
)

// handleOIDCConfig is public — the login page needs to know whether to show
// an SSO button, before anyone is authenticated.
func (a *API) handleOIDCConfig(w http.ResponseWriter, r *http.Request) {
	if a.oidc == nil || !a.settings.Get().OIDCEnabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":      true,
		"ready":        a.oidc.Ready(),
		"button_label": a.settings.Get().OIDCButtonLabel,
	})
}

// oidcDisabled reports (and, if so, writes the response for) SSO being
// unavailable — either never configured (a.oidc == nil, fixed at boot) or
// configured but turned off from the Settings screen's live OIDC_ENABLED
// toggle, which an admin can flip without discarding the rest of the OIDC
// configuration or restarting.
func (a *API) oidcDisabled(w http.ResponseWriter) bool {
	if a.oidc == nil {
		writeErr(w, http.StatusNotFound, "SSO is not configured on this server")
		return true
	}
	if !a.settings.Get().OIDCEnabled {
		writeErr(w, http.StatusNotFound, "SSO is currently disabled by an administrator")
		return true
	}
	return false
}

// oidcBindCookie ties an SSO round-trip to the browser that started it; see
// oidc.stateClaims.Bind.
const oidcBindCookie = "vc_oidc_bind"

// setOIDCBinding issues a fresh random binding cookie (SameSite=Lax, so the
// IdP's top-level redirect back to /api/oidc/callback still carries it) and
// returns its value for the state token.
func (a *API) setOIDCBinding(w http.ResponseWriter, r *http.Request) string {
	v, err := randomHex(16)
	if err != nil {
		return ""
	}
	http.SetCookie(w, &http.Cookie{
		Name: oidcBindCookie, Value: v, Path: "/api/oidc", MaxAge: 600,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: a.isSecureRequest(r),
	})
	return v
}

// handleOIDCLogin starts the "log me in" flow: redirects to the provider.
func (a *API) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	if a.oidcDisabled(w) {
		return
	}
	url, err := a.oidc.AuthURL(oidc.FlowLogin, 0, a.setOIDCBinding(w, r))
	if err != nil {
		if !a.oidc.Ready() {
			writeErr(w, http.StatusServiceUnavailable, "SSO identity provider is temporarily unreachable — try regular sign-in, or try SSO again shortly")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not start SSO login")
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// handleOIDCLinkStart starts the "attach SSO to my account" flow — requires
// an existing authenticated session, unlike handleOIDCLogin.
func (a *API) handleOIDCLinkStart(w http.ResponseWriter, r *http.Request) {
	if a.oidcDisabled(w) {
		return
	}
	me := auth.CurrentUser(r)
	url, err := a.oidc.AuthURL(oidc.FlowLink, me.ID, a.setOIDCBinding(w, r))
	if err != nil {
		if !a.oidc.Ready() {
			writeErr(w, http.StatusServiceUnavailable, "SSO identity provider is temporarily unreachable — try again shortly")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not start SSO linking")
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// oidcRedirectResult sends the browser back to the SPA at the given view
// (hash route) with an optional query param the page reads to show a
// success/error toast — the callback itself can't return JSON usefully
// since the browser navigated here directly from the IdP, not via fetch.
func oidcRedirectResult(w http.ResponseWriter, r *http.Request, view, query string) {
	target := "/"
	if query != "" {
		target += "?" + query
	}
	target += "#" + view
	http.Redirect(w, r, target, http.StatusFound)
}

// handleOIDCCallback is where the provider sends the browser back after
// login/consent. It has no RequireAuth/RequireCSRF middleware (the request
// comes from the IdP, not our SPA) — the signed state token is what proves
// this request is legitimate and says which flow it belongs to.
func (a *API) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if a.oidcDisabled(w) {
		return
	}
	q := r.URL.Query()
	if errCode := q.Get("error"); errCode != "" {
		oidcRedirectResult(w, r, "", "sso-error="+errCode)
		return
	}
	binding := ""
	if c, err := r.Cookie(oidcBindCookie); err == nil {
		binding = c.Value
	}
	http.SetCookie(w, &http.Cookie{Name: oidcBindCookie, Path: "/api/oidc", MaxAge: -1, HttpOnly: true})
	result, err := a.oidc.Exchange(r.Context(), q.Get("code"), q.Get("state"), binding)
	if err != nil {
		if a.log != nil {
			a.log.Warn("oidc callback failed", "err", err)
		}
		oidcRedirectResult(w, r, "", "sso-error=exchange_failed")
		return
	}

	switch result.Flow {
	case oidc.FlowLink:
		a.finishOIDCLink(w, r, result)
	default:
		a.finishOIDCLogin(w, r, result)
	}
}

// finishOIDCLink attaches the verified identity to the account that started
// the link flow. Requires that account's session to still be the one making
// this request — a leaked state token alone can't complete a link.
func (a *API) finishOIDCLink(w http.ResponseWriter, r *http.Request, result *oidc.Result) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		oidcRedirectResult(w, r, "settings", "sso-error=session_expired")
		return
	}
	user, err := auth.ValidateSession(a.db, a.cfg.JWTSecret, cookie.Value, a.sessionTTL())
	if err != nil || user.ID != result.LinkUserID {
		oidcRedirectResult(w, r, "settings", "sso-error=session_mismatch")
		return
	}
	if err := a.db.LinkOIDC(user.ID, result.Identity.Issuer, result.Identity.Subject); err != nil {
		msg := "link_failed"
		if err == db.ErrOIDCAlreadyLinked {
			msg = "already_linked"
		}
		oidcRedirectResult(w, r, "settings", "sso-error="+msg)
		return
	}
	if err := a.db.WriteAudit(&user.ID, user.Username, "oidc_link", "user", &user.ID, "issuer="+result.Identity.Issuer, RealIP(r, a.settings.Get().TrustProxy)); err != nil && a.log != nil {
		a.log.Warn("write audit entry", "action", "oidc_link", "err", err)
	}
	oidcRedirectResult(w, r, "settings", "sso=linked")
}

// finishOIDCLogin looks up (or, if enabled, auto-provisions) the local
// account for a verified external identity and mints a normal session for
// it — from here on it's indistinguishable from a password login.
func (a *API) finishOIDCLogin(w http.ResponseWriter, r *http.Request, result *oidc.Result) {
	user, err := a.db.GetUserByOIDC(result.Identity.Issuer, result.Identity.Subject)
	if err == db.ErrNotFound {
		if !a.settings.Get().OIDCAutoCreateUsers {
			oidcRedirectResult(w, r, "", "sso-error=no_linked_account")
			return
		}
		user, err = a.autoProvisionOIDCUser(r, result.Identity)
	}
	if err != nil || user == nil {
		oidcRedirectResult(w, r, "", "sso-error=login_failed")
		return
	}
	if user.Disabled {
		oidcRedirectResult(w, r, "", "sso-error=account_disabled")
		return
	}

	if err := a.startSession(w, r, user); err != nil {
		oidcRedirectResult(w, r, "", "sso-error=session_failed")
		return
	}
	if err := a.db.WriteAudit(&user.ID, user.Username, "login", "user", &user.ID, "via OIDC", RealIP(r, a.settings.Get().TrustProxy)); err != nil && a.log != nil {
		a.log.Warn("write audit entry", "action", "login", "err", err)
	}
	oidcRedirectResult(w, r, "chats", "")
}

// autoProvisionOIDCUser creates a fresh local account for a first-time SSO
// login when OIDC_AUTO_CREATE_USERS is set. The account gets an unusable
// local password (see AnonymizeUser's sibling constant) — it only ever logs
// in via SSO unless an admin sets a password for it.
func (a *API) autoProvisionOIDCUser(r *http.Request, id oidc.Identity) (*db.User, error) {
	username := usernameFromEmail(id.Email)
	if username == "" {
		username = "user"
	}
	base := username
	for n := 2; ; n++ {
		_, err := a.db.GetUserByUsername(username)
		if err == db.ErrNotFound {
			break
		}
		if err != nil {
			return nil, err // a DB error must not spin this loop forever
		}
		username = fmt.Sprintf("%s%d", base, n)
	}
	displayName, ok := cleanDisplayName(id.Name)
	if !ok {
		displayName = username
		if r := []rune(strings.TrimSpace(id.Name)); len(r) > maxDisplayNameRunes {
			displayName = string(r[:maxDisplayNameRunes])
		}
	}
	user, err := a.db.CreateUser(username, displayName, autoProvisionedPasswordHash, "user")
	if err != nil {
		return nil, err
	}
	if id.Email != "" {
		email := strings.ToLower(strings.TrimSpace(id.Email))
		_ = a.db.SetUserEmail(user.ID, &email) // best-effort; a collision just leaves email unset
	}
	if err := a.db.LinkOIDC(user.ID, id.Issuer, id.Subject); err != nil {
		return nil, err
	}
	if err := a.db.WriteAudit(nil, username, "user_create", "user", &user.ID, "via OIDC auto-provision", RealIP(r, a.settings.Get().TrustProxy)); err != nil && a.log != nil {
		a.log.Warn("write audit entry", "action", "user_create", "err", err)
	}
	return a.db.GetUserByID(user.ID)
}

// usernameFromEmail takes the local-part of an email as a starting username
// candidate, trimmed to the same character set the app already requires.
func usernameFromEmail(email string) string {
	local, _, ok := strings.Cut(email, "@")
	if !ok {
		local = email
	}
	local = strings.ToLower(local)
	var b strings.Builder
	for _, r := range local {
		isAllowed := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if isAllowed {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if len(s) < 2 {
		return ""
	}
	if len(s) > 32 {
		s = s[:32]
	}
	return s
}

// autoProvisionedPasswordHash parses but never verifies, like AnonymizeUser's
// unusablePasswordHash — kept as a separate name here since users.go's is
// unexported to that file's package-private context (same package, but this
// documents the two call sites independently).
const autoProvisionedPasswordHash = `$argon2id$v=19$m=0,t=0,p=0$-$-`

func (a *API) handleOIDCUnlink(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	if err := a.db.UnlinkOIDC(me.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not unlink SSO")
		return
	}
	a.audit(r, "oidc_unlink", "user", &me.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleAdminOIDCUnlink(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := a.db.UnlinkOIDC(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not unlink SSO")
		return
	}
	a.audit(r, "oidc_unlink", "user", &id, "by admin")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
