package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
)

// CSRFCookieName is a double-submit cookie: readable by JS (not HttpOnly) so
// the frontend can echo it back as a header on state-changing requests.
// SameSite=Lax plus the existing Origin check (CheckOrigin) already block
// most CSRF; this is a second, independent check that doesn't rely on the
// browser sending Origin correctly (some proxies/older clients strip it).
const CSRFCookieName = "vc_csrf"
const csrfHeaderName = "X-CSRF-Token"

func generateCSRFToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// EnsureCSRFCookie sets a fresh CSRF cookie if the request doesn't already
// carry a well-formed one, so a browser is guaranteed to have one by the time
// it needs to make its first mutating request (the app's initial GET /me
// covers this for an existing session that predates this feature).
func EnsureCSRFCookie(w http.ResponseWriter, r *http.Request, secureCookie bool) {
	if cookie, err := r.Cookie(CSRFCookieName); err == nil && isHex64(cookie.Value) {
		return
	}
	token, err := generateCSRFToken()
	if err != nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CSRFCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: false, // must be JS-readable so the frontend can echo it back
		SameSite: http.SameSiteLaxMode,
		Secure:   secureCookie,
	})
}

// RequireCSRF enforces the double-submit pattern on state-changing requests:
// the header must match the cookie. Read-only requests are exempt.
func RequireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(CSRFCookieName)
		header := r.Header.Get(csrfHeaderName)
		if err != nil || header == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header)) != 1 {
			http.Error(w, "missing or invalid CSRF token", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
