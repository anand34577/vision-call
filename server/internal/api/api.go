package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"visioncall/internal/auth"
	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/oidc"
	"visioncall/internal/settings"
)

// PresenceProvider is what the API needs from the signaling hub.
type PresenceProvider interface {
	GetPresence() map[int64]string
	OnlineCount() int
	ActiveCalls() int
	KickUser(userID int64, reason string)
	KickSession(userID int64, sessionID, reason string)
	KickOtherSessions(userID int64, keepSessionID, reason string)
	SendToUser(userID int64, typ string, data any) bool
	DirectoryChanged()
	AccountUpdated(userID int64)
	EvictFromGroupRoom(groupID, targetID int64) bool
}

type API struct {
	cfg       *config.Config
	db        *db.DB
	hub       PresenceProvider
	limiter   *auth.LoginLimiter // per-username(+IP): stops guessing one account
	ipLimiter *auth.LoginLimiter // per-source-IP: stops a spray across many accounts
	oidc      *oidc.Manager      // nil when SSO isn't configured
	settings  *settings.Store
	adminMu   sync.Mutex
	startedAt time.Time
	log       *slog.Logger
	restart   func() // set by main; nil when the server can't restart itself
}

func New(cfg *config.Config, dbh *db.DB, hub PresenceProvider, oidcMgr *oidc.Manager, settingsStore *settings.Store, log *slog.Logger) *API {
	return &API{
		cfg:       cfg,
		db:        dbh,
		hub:       hub,
		limiter:   auth.NewLoginLimiter(),
		ipLimiter: auth.NewIPLoginLimiter(),
		oidc:      oidcMgr,
		settings:  settingsStore,
		startedAt: time.Now(),
		log:       log,
	}
}

// Limiter exposes the login rate limiters so main can call Stop() on shutdown.
func (a *API) Limiter() *auth.LoginLimiter   { return a.limiter }
func (a *API) IPLimiter() *auth.LoginLimiter { return a.ipLimiter }

// ---- request ID middleware ----

type ctxKeyReqID struct{}

var reqCounter atomic.Uint64

func nextReqID() string {
	return fmt.Sprintf("%06x", reqCounter.Add(1))
}

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := nextReqID()
		w.Header().Set("X-Request-ID", id)
		ctx := context.WithValue(r.Context(), ctxKeyReqID{}, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func reqIDFrom(r *http.Request) string {
	if id, ok := r.Context().Value(ctxKeyReqID{}).(string); ok {
		return id
	}
	return "-"
}

// ---- response recorder (captures status code for logging) ----

type responseRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func newResponseRecorder(w http.ResponseWriter) *responseRecorder {
	return &responseRecorder{ResponseWriter: w, status: http.StatusOK}
}

func (r *responseRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(p []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(p)
}

// Unwrap lets http.ResponseController reach the real connection (the file
// handlers extend their deadlines through it).
func (r *responseRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *responseRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ---- request logger middleware ----

func (a *API) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := newResponseRecorder(w)
		next.ServeHTTP(rec, r)
		ms := time.Since(start).Milliseconds()

		lvl := slog.LevelInfo
		if rec.status >= 500 {
			lvl = slog.LevelError
		} else if rec.status >= 400 {
			lvl = slog.LevelWarn
		}
		a.log.Log(r.Context(), lvl, "http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"ms", ms,
			"rid", reqIDFrom(r),
			"ip", RealIP(r, a.settings.Get().TrustProxy),
		)
	})
}

// ---- router ----

func (a *API) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(withRequestID)
	r.Use(a.requestLogger)
	r.Use(middleware.Recoverer)
	r.Use(auth.CheckOrigin)

	r.Post("/login", a.handleLogin)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": config.Version})
	})
	r.Get("/metrics", a.handleMetrics)
	r.Get("/cert", a.handleDownloadCert)
	r.Get("/password-reset/enabled", a.handlePasswordResetEnabled)
	r.Post("/password-reset/request", a.handlePasswordResetRequest)
	r.Post("/password-reset/confirm", a.handlePasswordResetConfirm)

	r.Get("/oidc/config", a.handleOIDCConfig)
	r.Get("/oidc/login", a.handleOIDCLogin)
	r.Get("/oidc/callback", a.handleOIDCCallback)

	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAuth(a.db, a.cfg.JWTSecret, a.isSecureRequest, a.sessionTTL))
		r.Use(auth.RequireCSRF)
		r.Use(requirePasswordChange)

		r.Post("/logout", a.handleLogout)
		r.Get("/users/me/sessions", a.handleListSessions)
		r.Delete("/users/me/sessions/{id}", a.handleRevokeSession)
		r.Post("/users/me/sessions/revoke-others", a.handleRevokeOtherSessions)
		r.Post("/users/me/totp/setup", a.handleTOTPSetup)
		r.Post("/users/me/totp/enable", a.handleTOTPEnable)
		r.Post("/users/me/totp/disable", a.handleTOTPDisable)
		r.Put("/users/me/status-text", a.handleSetStatusText)
		r.Get("/me", a.handleMe)
		r.Patch("/users/me", a.handleUpdateSelf)
		r.Get("/users/me/preferences", a.handleGetPreferences)
		r.Put("/users/me/preferences", a.handleUpdatePreferences)
		r.Get("/oidc/link", a.handleOIDCLinkStart)
		r.Delete("/oidc/link", a.handleOIDCUnlink)
		r.Put("/devices/keys", a.handleRegisterDeviceKey)
		r.Get("/devices/keys", a.handleDeviceKeys)
		r.Get("/users/me/key-backup", a.handleGetKeyBackup)
		r.Put("/users/me/key-backup", a.handleSaveKeyBackup)
		r.Delete("/users/me/key-backup", a.handleDeleteKeyBackup)

		r.Get("/users", a.handleListUsers)
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAdmin)
			r.Post("/users", a.handleCreateUser)
			r.Patch("/users/{id}", a.handleUpdateUser)
			r.Delete("/users/{id}", a.handleDeleteUser)
			r.Post("/users/{id}/sign-out", a.handleSignOutUser)
			r.Get("/admin/stats", a.handleAdminStats)
			r.Get("/admin/groups", a.handleAdminListGroups)
			r.Get("/admin/audit", a.handleListAudit)
			r.Get("/admin/backups", a.handleListBackups)
			r.Post("/admin/backups", a.handleCreateSnapshot)
			r.Get("/admin/backups/{name}", a.handleDownloadSnapshot)
			r.Post("/admin/backups/{name}/restore", a.handleRestoreSnapshot)
			r.Get("/admin/backup", a.handleDownloadFull)
			r.Post("/admin/restore", a.handleRestoreUpload)
			r.Delete("/users/{id}/oidc-link", a.handleAdminOIDCUnlink)
			r.Get("/admin/settings", a.handleListSettings)
			r.Put("/admin/settings/{key}", a.handleUpdateSetting)
			r.Delete("/admin/settings/{key}", a.handleResetSetting)
		})

		r.Get("/messages/{userID}", a.handleDirectHistory)
		r.Get("/conversations/recent", a.handleRecentConversations)
		r.Get("/unread", a.handleUnreadSummary)
		r.Get("/conversations/prefs", a.handleListConvoPrefs)
		r.Put("/conversations/prefs", a.handleSetConvoPref)
		r.Get("/groups/public", a.handleListPublicGroups)
		r.Post("/groups/{id}/join", a.handleJoinGroup)
		r.Get("/threads/{id}", a.handleThread)
		r.Get("/users/me/blocked", a.handleListBlocked)
		r.Post("/users/{id}/block", a.handleBlockUser)
		r.Delete("/users/{id}/block", a.handleUnblockUser)
		r.Get("/groups", a.handleListGroups)
		r.Post("/groups", a.handleCreateGroup)
		r.Patch("/groups/{id}", a.handleRenameGroup)
		r.Delete("/groups/{id}", a.handleDeleteGroup)
		r.Get("/groups/{id}/messages", a.handleGroupHistory)
		r.Post("/groups/{id}/members", a.handleAddGroupMembers)
		r.Delete("/groups/{id}/members/{userID}", a.handleRemoveGroupMember)
		r.Patch("/groups/{id}/members/{userID}", a.handleSetGroupMemberRole)
		r.Get("/groups/{id}/read-state", a.handleGroupReadState)

		r.Get("/pinned", a.handlePinnedMessages)
		r.Get("/search", a.handleSearchMessages)
		r.Get("/export", a.handleExportMessages)
		r.Get("/saved", a.handleListSavedMessages)
		r.Put("/messages/{id}/save", a.handleToggleSaveMessage)
		r.Delete("/messages/{id}/save", a.handleToggleSaveMessage)

		r.Get("/calls", a.handleCallHistory)

		r.Post("/rooms", a.handleCreateRoom)
		r.Get("/rooms", a.handleListMyRooms)
		r.Get("/rooms/{id}", a.handleGetRoom)
		r.Delete("/rooms/{id}", a.handleDeleteRoom)

		r.Post("/files", a.handleUpload)
		r.Get("/files/{id}", a.handleDownload)

		r.Get("/ice", a.handleIce)
	})
	return r
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Response already committed; nothing we can do.
		_ = err
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readJSON decodes a JSON body of at most 1 MiB.
func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

// isSecureRequest reports whether r arrived over an actually-encrypted
// connection: real TLS on this listener, a ProxyTLS static override, or (when
// TrustProxy is set) a proxy-asserted HTTPS front end. Computed per request,
// not from static config, because one process can serve both a TLS listener
// and the plain-HTTP companion port (HTTP_ADDR) at the same time.
func (a *API) isSecureRequest(r *http.Request) bool {
	if r.TLS != nil || a.settings.Get().ProxyTLS {
		return true
	}
	return a.settings.Get().TrustProxy && strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// RealIP extracts the client IP; see auth.RealIP.
func RealIP(r *http.Request, trustProxy bool) string { return auth.RealIP(r, trustProxy) }

// decorateUsers fills runtime presence status into user records.
func (a *API) decorateUsers(users []*db.User) {
	if a.hub == nil {
		return
	}
	presence := a.hub.GetPresence()
	for _, u := range users {
		if s, ok := presence[u.ID]; ok {
			u.Status = s
		} else {
			u.Status = "offline"
		}
	}
}

// sessionTTL is the sliding inactivity timeout for sessions.
func (a *API) sessionTTL() time.Duration {
	return time.Duration(a.settings.Get().SessionTTLHours) * time.Hour
}

// startSession creates a session row and sets the session + CSRF cookies.
func (a *API) startSession(w http.ResponseWriter, r *http.Request, user *db.User) error {
	ttl := a.sessionTTL()
	sessionID, token, err := auth.MintSession(a.cfg.JWTSecret, user.ID, user.Role)
	if err != nil {
		return err
	}
	ua := r.UserAgent()
	if err := a.db.CreateSession(sessionID, user.ID, auth.HashToken(token), time.Now().Add(ttl), ua, RealIP(r, a.settings.Get().TrustProxy)); err != nil {
		return err
	}
	isSecure := a.isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: isSecure, MaxAge: int(auth.TokenLifetime.Seconds()),
	})
	auth.EnsureCSRFCookie(w, r, isSecure)
	return nil
}
