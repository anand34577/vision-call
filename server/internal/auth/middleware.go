package auth

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"visioncall/internal/db"
)

type ctxKey int

const userKey ctxKey = 1

// RequireAuth validates the session cookie and injects the user into the
// request context. isSecure reports, per request, whether the Secure flag
// belongs on the CSRF cookie it opportunistically issues (see
// EnsureCSRFCookie) — a function rather than a fixed bool because a single
// process can serve both a TLS and a plain-HTTP listener at once (the
// HTTP_ADDR companion port), so "is this connection secure" isn't a
// server-wide constant.
func RequireAuth(dbh *db.DB, secret []byte, isSecure func(*http.Request) bool, slide func() time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(CookieName)
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			// ValidateSession already rejects disabled users (see jwt.go) - the
			// user returned here is never disabled, so there is no second
			// check to make here.
			user, err := ValidateSession(dbh, secret, cookie.Value, slide())
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			EnsureCSRFCookie(w, r, isSecure(r))
			ctx := context.WithValue(r.Context(), userKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func CurrentUser(r *http.Request) *db.User {
	user, _ := r.Context().Value(userKey).(*db.User)
	return user
}

func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := CurrentUser(r)
		if user == nil || user.Role != "admin" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// CheckOrigin rejects cross-site mutations: with SameSite=Lax cookies a
// cross-site POST would not carry the cookie anyway, but a mismatched Origin
// header on a state-changing request is always wrong.
func CheckOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			if origin := r.Header.Get("Origin"); origin != "" {
				host := r.Host
				fHost := r.Header.Get("X-Forwarded-Host")
				matchesHost := origin == "http://"+host || origin == "https://"+host
				matchesFHost := fHost != "" && (origin == "http://"+fHost || origin == "https://"+fHost)
				if !matchesHost && !matchesFHost {
					http.Error(w, "cross-origin request rejected", http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// RealIP extracts the client IP. Proxy headers are honored only when
// trustProxy is set, and then only the rightmost X-Forwarded-For hop — the
// one the trusted proxy itself appended. Everything left of it is whatever
// the client sent and can be forged to dodge per-IP rate limits.
func RealIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return strings.Trim(r.RemoteAddr, "[]")
}
