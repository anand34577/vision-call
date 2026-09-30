// Package settings is the admin "Settings" screen's backend: a catalog of
// every configuration key the app has, each resolved through one priority
// chain — a real environment variable (including Docker's `environment:`,
// which is already merged into the process environment by the time this
// runs) beats a .env-file value (also already merged, at lower priority, by
// main.go's godotenv.Load call) beats a value saved from the Settings
// screen (stored in the app_settings table) beats the hardcoded default.
//
// Only "dynamic" fields are DB-editable at all — things like the listen
// address, TLS material, the database connection, and the JWT signing key
// are fixed at process start (some for chicken-and-egg reasons: you can't
// store the database connection string in the database), so they're
// cataloged as read-only/"static" purely so the Settings screen can show
// every setting the app has, per the brief.
package settings

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync/atomic"

	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/logger"
)

type Kind string

const (
	KindString Kind = "string"
	KindInt    Kind = "int"
	KindBool   Kind = "bool"
	KindSecret Kind = "secret" // masked in the UI; write-only from the admin's perspective
)

// Field describes one setting for the catalog. Dynamic fields are resolved
// through env/.env/DB/default and editable via Set/Reset; static fields are
// informational only — their Default here is just what to show when no env
// var is set, not a value this package ever writes anywhere.
type Field struct {
	Key         string
	Label       string
	Description string
	Kind        Kind
	Default     string
	Group       string
	Dynamic     bool
}

// Group names double as the Settings screen's section order (Catalog order
// is display order) - each is a self-contained feature area so "which
// settings belong together" and "which feature this toggle controls" read
// the same way in the UI as they do here.
const (
	GroupCalling  = "Calling & Media"
	GroupFiles    = "Files & Storage"
	GroupEmail    = "Email & Password Reset"
	GroupSSO      = "Single Sign-On (SSO)"
	GroupSecurity = "Security & Sessions"
	GroupNetwork  = "Network & TLS"
	GroupServer   = "Server & Logging"
)

var Catalog = []Field{
	// ---- Calling & Media: dynamic, but the SFU only re-reads these at boot ----
	{Key: "EXTERNAL_IP", Label: "External IP", Description: "Optional. The IP group-call media is sent to. Leave empty to use whatever address each browser connected to, which works for most setups. Changing this needs a restart to take effect.", Kind: KindString, Group: GroupCalling, Dynamic: true},
	{Key: "TURN_HOST", Label: "TURN host", Description: "host:port of your coturn server, advertised to clients. Takes effect immediately.", Kind: KindString, Group: GroupCalling, Dynamic: true},
	{Key: "TURN_SECRET", Label: "TURN secret", Description: "Shared coturn static-auth-secret. Takes effect immediately.", Kind: KindSecret, Group: GroupCalling, Dynamic: true},
	{Key: "MAX_CALL_PARTICIPANTS", Label: "Max call participants", Description: "Conference soft cap. Changing this needs a restart to take effect.", Kind: KindInt, Default: "8", Group: GroupCalling, Dynamic: true},

	// ---- Files & Storage: dynamic (upload limits), or static (where the data itself lives) ----
	{Key: "MAX_FILE_MB", Label: "Max upload size (MB)", Description: "Per-file upload limit. Takes effect immediately.", Kind: KindInt, Default: "50", Group: GroupFiles, Dynamic: true},
	{Key: "MAX_USER_STORAGE_MB", Label: "Max storage per user (MB)", Description: "Total upload storage allowed per user; 0 = unlimited. Takes effect immediately.", Kind: KindInt, Default: "2048", Group: GroupFiles, Dynamic: true},
	{Key: "BLOCKED_FILE_EXTENSIONS", Label: "Blocked file extensions", Description: `Comma-separated, e.g. ".exe,.bat". "none" allows every file type. Takes effect immediately.`, Kind: KindString, Group: GroupFiles, Dynamic: true},
	{Key: "DATA_DIR", Label: "Data directory", Description: "Where the database and uploaded files live. Fixed at boot - the app must know this before it can open its database.", Kind: KindString, Default: "./data", Group: GroupFiles, Dynamic: false},
	{Key: "DATABASE_URL", Label: "Database URL", Description: "Empty = built-in sqlite. Fixed at boot for the same reason as Data Directory.", Kind: KindSecret, Group: GroupFiles, Dynamic: false},

	// ---- Email & Password Reset: fully dynamic and live ----
	{Key: "PASSWORD_RESET_ENABLED", Label: "Enable password reset emails", Description: "Master switch for self-service \"forgot password\" - off disables the feature even if SMTP is fully configured below, without discarding that configuration. Takes effect immediately.", Kind: KindBool, Default: "true", Group: GroupEmail, Dynamic: true},
	{Key: "SMTP_HOST", Label: "SMTP host", Description: "Required (along with the switch above) to enable self-service password reset. Takes effect immediately.", Kind: KindString, Group: GroupEmail, Dynamic: true},
	{Key: "SMTP_PORT", Label: "SMTP port", Kind: KindInt, Default: "587", Group: GroupEmail, Dynamic: true},
	{Key: "SMTP_USER", Label: "SMTP username", Kind: KindString, Group: GroupEmail, Dynamic: true},
	{Key: "SMTP_PASS", Label: "SMTP password", Kind: KindSecret, Group: GroupEmail, Dynamic: true},
	{Key: "SMTP_FROM", Label: "SMTP From address", Description: "Defaults to the SMTP username if unset.", Kind: KindString, Group: GroupEmail, Dynamic: true},
	{Key: "PUBLIC_BASE_URL", Label: "Public base URL", Description: "e.g. https://call.example.com — used to build password-reset links and the OIDC callback URL. Takes effect immediately.", Kind: KindString, Group: GroupEmail, Dynamic: true},

	// ---- Single Sign-On (SSO): the enable switch, auto-create, and button
	// label are fully live; the identity-provider fields themselves are only
	// read once when the OIDC manager is built at boot, so those four still
	// need a restart even though they're editable here without one.
	{Key: "OIDC_ENABLED", Label: "Enable SSO login", Description: "Master switch for SSO - off disables the \"Sign in with SSO\" button and its endpoints even if fully configured below, without discarding that configuration. Takes effect immediately.", Kind: KindBool, Default: "true", Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_ISSUER_URL", Label: "OIDC issuer URL", Description: "Needs a restart to take effect.", Kind: KindString, Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_CLIENT_ID", Label: "OIDC client ID", Description: "Needs a restart to take effect.", Kind: KindString, Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_CLIENT_SECRET", Label: "OIDC client secret", Description: "Needs a restart to take effect.", Kind: KindSecret, Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_REDIRECT_URL", Label: "OIDC redirect URL", Description: "Needs a restart to take effect.", Kind: KindString, Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_AUTO_CREATE_USERS", Label: "OIDC auto-create users", Description: "Takes effect immediately.", Kind: KindBool, Default: "false", Group: GroupSSO, Dynamic: true},
	{Key: "OIDC_BUTTON_LABEL", Label: "OIDC button label", Description: "Takes effect immediately.", Kind: KindString, Default: "Sign in with SSO", Group: GroupSSO, Dynamic: true},

	// ---- Security & Sessions ----
	{Key: "JWT_SECRET", Label: "JWT signing secret", Description: "Fixed at boot - it must be stable before any session can be validated, including the one that would let you change it here.", Kind: KindSecret, Group: GroupSecurity, Dynamic: false},
	{Key: "SESSION_TTL_HOURS", Label: "Session lifetime (hours)", Description: "How long a device stays signed in without being used. The timer restarts each time the app is used, so people who use it regularly stay signed in. Takes effect immediately.", Kind: KindInt, Default: "720", Group: GroupSecurity, Dynamic: true},
	{Key: "MESSAGE_RETENTION_DAYS", Label: "Message retention (days)", Description: "Permanently delete chat messages older than this many days (pinned messages are kept). 0 keeps everything. Runs once a day.", Kind: KindInt, Default: "0", Group: GroupSecurity, Dynamic: true},
	{Key: "METRICS_TOKEN", Label: "Metrics access token", Description: "If set, /metrics requires 'Authorization: Bearer <token>'. If empty, /metrics is only reachable from the server itself and private networks.", Kind: KindSecret, Group: GroupSecurity, Dynamic: true},

	// ---- Network & TLS: the first six bind a socket / load a certificate
	// file once at boot, before this Settings store's own database is even
	// open - there's no live value to swap them for, so they stay read-only
	// here regardless of whether an env var is set; change them via
	// environment/.env and restart. Trust reverse proxy and Proxy terminates
	// TLS are different: they only affect how each *request* is handled
	// (which header to trust for the caller's IP, whether to mark cookies
	// Secure), so those two are DB-editable like everything else - a restart
	// is only needed for the narrower case of switching whether this process
	// binds its own TLS listener at all.
	{Key: "LISTEN_ADDR", Label: "Listen address", Description: "The port this process binds. Decided once at boot before any config storage exists to read an override from - change via environment/.env, then restart.", Kind: KindString, Group: GroupNetwork, Dynamic: false},
	{Key: "HTTP_ADDR", Label: "HTTP companion address", Description: "Same as Listen Address - fixed at boot.", Kind: KindString, Default: ":8080", Group: GroupNetwork, Dynamic: false},
	{Key: "HTTPS_REDIRECT", Label: "HTTP redirects to HTTPS", Description: "Decided once at boot alongside which ports get bound - change via environment/.env, then restart.", Kind: KindBool, Default: "false", Group: GroupNetwork, Dynamic: false},
	{Key: "DISABLE_TLS", Label: "TLS disabled", Description: "Decided once at boot - determines whether a TLS listener is opened at all. Change via environment/.env, then restart.", Kind: KindBool, Default: "false", Group: GroupNetwork, Dynamic: false},
	{Key: "TLS_CERT", Label: "TLS certificate path", Description: "Loaded from disk once at boot - change via environment/.env, then restart.", Kind: KindString, Group: GroupNetwork, Dynamic: false},
	{Key: "TLS_KEY", Label: "TLS key path", Description: "Loaded from disk once at boot - change via environment/.env, then restart.", Kind: KindString, Group: GroupNetwork, Dynamic: false},
	{Key: "TRUST_PROXY", Label: "Trust reverse proxy", Description: "Whether to trust X-Forwarded-For/X-Real-IP and X-Forwarded-Proto from a proxy in front of this app. Takes effect immediately for request handling; a restart is only needed if this also changes whether the app binds its own TLS listener.", Kind: KindBool, Default: "false", Group: GroupNetwork, Dynamic: true},
	{Key: "PROXY_TLS", Label: "Proxy terminates TLS", Description: "Marks the session cookie Secure when a trusted proxy (not this process) terminates TLS. Takes effect immediately.", Kind: KindBool, Default: "false", Group: GroupNetwork, Dynamic: true},

	// ---- Server & Logging ----
	{Key: "LOG_LEVEL", Label: "Log level", Description: `"debug", "info", "warn", or "error". Takes effect immediately.`, Kind: KindString, Default: "info", Group: GroupServer, Dynamic: true},
	{Key: "BOOTSTRAP_ADMIN_USER", Label: "Bootstrap admin username", Description: "Only used to name the very first account, created when the database is empty; has no effect afterward.", Kind: KindString, Default: "admin", Group: GroupServer, Dynamic: false},
}

func fieldByKey(key string) *Field {
	for i := range Catalog {
		if Catalog[i].Key == key {
			return &Catalog[i]
		}
	}
	return nil
}

// Values is the resolved snapshot of every dynamic field, swapped in
// atomically on load and on every change — readers always see a consistent
// whole snapshot, never a half-updated one.
type Values struct {
	ExternalIP            string
	TurnHost              string
	TurnSecret            string
	MaxCallParticipants   int
	MaxFileBytes          int64
	MaxUserStorageBytes   int64
	BlockedFileExtensions map[string]bool
	PasswordResetEnabled  bool
	SMTPHost              string
	SMTPPort              int
	SMTPUser              string
	SMTPPass              string
	SMTPFrom              string
	PublicBaseURL         string
	OIDCEnabled           bool
	OIDCIssuerURL         string // read once at boot (see main.go)
	OIDCClientID          string
	OIDCClientSecret      string
	OIDCRedirectURL       string
	OIDCAutoCreateUsers   bool
	OIDCButtonLabel       string
	SessionTTLHours       int
	MessageRetentionDays  int
	MetricsToken          string
	LogLevel              string
	TrustProxy            bool
	ProxyTLS              bool
}

type Store struct {
	dbh      *db.DB
	defaults *config.Config
	envSet   map[string]string // dynamic keys that are pinned by env/.env
	cur      atomic.Pointer[Values]
	logLevel *slog.LevelVar // kept in sync with LOG_LEVEL on every Reload, if set
}

// New builds the store from cfg (the env/.env-resolved config computed at
// startup — its dynamic-field values become each field's fallback default)
// and loads the current DB overrides. logLevel is optional: when provided
// (see main.go), LOG_LEVEL changes take effect immediately instead of
// needing a restart; pass nil to skip that wiring.
func New(dbh *db.DB, cfg *config.Config, logLevel *slog.LevelVar) *Store {
	s := &Store{dbh: dbh, defaults: cfg, envSet: map[string]string{}, logLevel: logLevel}
	for _, f := range Catalog {
		if !f.Dynamic {
			continue
		}
		if v, ok := os.LookupEnv(f.Key); ok {
			s.envSet[f.Key] = v
		}
	}
	s.Reload()
	return s
}

// Reload re-resolves every dynamic field from env/DB/default and publishes
// a fresh snapshot. Called at startup and after every admin edit; cheap
// enough (a handful of indexed lookups) not to need finer-grained updates.
func (s *Store) Reload() {
	extDefault := make([]string, 0, len(s.defaults.BlockedFileExtensions))
	for ext := range s.defaults.BlockedFileExtensions {
		extDefault = append(extDefault, ext)
	}
	logLevel := s.resolveString("LOG_LEVEL", s.defaults.LogLevel)
	v := &Values{
		ExternalIP:            s.resolveString("EXTERNAL_IP", s.defaults.ExternalIP),
		TurnHost:              s.resolveString("TURN_HOST", s.defaults.TurnHost),
		TurnSecret:            s.resolveString("TURN_SECRET", s.defaults.TurnSecret),
		MaxCallParticipants:   s.resolveInt("MAX_CALL_PARTICIPANTS", s.defaults.MaxCallParticipants),
		MaxFileBytes:          int64(s.resolveInt("MAX_FILE_MB", int(s.defaults.MaxFileBytes/(1<<20)))) * 1024 * 1024,
		MaxUserStorageBytes:   int64(s.resolveInt("MAX_USER_STORAGE_MB", int(s.defaults.MaxUserStorageBytes/(1<<20)))) * 1024 * 1024,
		BlockedFileExtensions: config.ParseExtList(s.resolveString("BLOCKED_FILE_EXTENSIONS", strings.Join(extDefault, ","))),
		PasswordResetEnabled:  s.resolveBool("PASSWORD_RESET_ENABLED", true),
		SMTPHost:              s.resolveString("SMTP_HOST", s.defaults.SMTPHost),
		SMTPPort:              s.resolveInt("SMTP_PORT", s.defaults.SMTPPort),
		SMTPUser:              s.resolveString("SMTP_USER", s.defaults.SMTPUser),
		SMTPPass:              s.resolveString("SMTP_PASS", s.defaults.SMTPPass),
		SMTPFrom:              s.resolveString("SMTP_FROM", s.defaults.SMTPFrom),
		PublicBaseURL:         s.resolveString("PUBLIC_BASE_URL", s.defaults.PublicBaseURL),
		OIDCEnabled:           s.resolveBool("OIDC_ENABLED", true),
		OIDCIssuerURL:         s.resolveString("OIDC_ISSUER_URL", s.defaults.OIDCIssuerURL),
		OIDCClientID:          s.resolveString("OIDC_CLIENT_ID", s.defaults.OIDCClientID),
		OIDCClientSecret:      s.resolveString("OIDC_CLIENT_SECRET", s.defaults.OIDCClientSecret),
		OIDCRedirectURL:       s.resolveString("OIDC_REDIRECT_URL", s.defaults.OIDCRedirectURL),
		OIDCAutoCreateUsers:   s.resolveBool("OIDC_AUTO_CREATE_USERS", s.defaults.OIDCAutoCreateUsers),
		OIDCButtonLabel:       s.resolveString("OIDC_BUTTON_LABEL", s.defaults.OIDCButtonLabel),
		SessionTTLHours:       s.resolveInt("SESSION_TTL_HOURS", s.defaults.SessionTTLHours),
		MessageRetentionDays:  s.resolveInt("MESSAGE_RETENTION_DAYS", s.defaults.MessageRetentionDays),
		MetricsToken:          s.resolveString("METRICS_TOKEN", s.defaults.MetricsToken),
		LogLevel:              logLevel,
		TrustProxy:            s.resolveBool("TRUST_PROXY", s.defaults.TrustProxy),
		ProxyTLS:              s.resolveBool("PROXY_TLS", s.defaults.ProxyTLS),
	}
	s.cur.Store(v)
	if s.logLevel != nil {
		s.logLevel.Set(logger.ParseLevel(logLevel))
	}
}

// Get returns the current resolved snapshot. Safe to call from any goroutine.
func (s *Store) Get() *Values { return s.cur.Load() }

func (s *Store) resolveRaw(key string) (string, bool) {
	if v, ok := s.envSet[key]; ok {
		return v, true
	}
	if v, err := s.dbh.GetAppSetting(key); err == nil {
		return v, true
	}
	return "", false
}

func (s *Store) resolveString(key, def string) string {
	if v, ok := s.resolveRaw(key); ok {
		return v
	}
	return def
}

func (s *Store) resolveInt(key string, def int) int {
	v, ok := s.resolveRaw(key)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	// A value saved before range validation existed (or set via env) must
	// not be able to lock the app up: fall back to the default instead.
	if r, ok := intRanges[key]; ok && (n < r[0] || n > r[1]) {
		return def
	}
	return n
}

func (s *Store) resolveBool(key string, def bool) bool {
	v, ok := s.resolveRaw(key)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// sourceOfDynamic reports where a dynamic field's current value came from.
func (s *Store) sourceOfDynamic(key string) string {
	if _, ok := s.envSet[key]; ok {
		return "env"
	}
	if _, err := s.dbh.GetAppSetting(key); err == nil {
		return "db"
	}
	return "default"
}

// intRanges bounds the int settings whose out-of-range values break the app
// (SESSION_TTL_HOURS=0 expires every session at login, a negative
// MAX_FILE_MB rejects every upload, ...). Mirrors config.Validate's clamps.
var intRanges = map[string][2]int{
	"SESSION_TTL_HOURS":      {1, 24 * 365},
	"MESSAGE_RETENTION_DAYS": {0, 36500},
	"MAX_CALL_PARTICIPANTS":  {2, 100},
	"MAX_FILE_MB":            {1, 10240},
	"MAX_USER_STORAGE_MB":    {0, 1 << 30},
	"SMTP_PORT":              {1, 65535},
}

func validateKind(key string, k Kind, value string) error {
	switch k {
	case KindInt:
		n, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("must be a whole number")
		}
		if r, ok := intRanges[key]; ok && (n < r[0] || n > r[1]) {
			return fmt.Errorf("must be between %d and %d", r[0], r[1])
		}
	case KindBool:
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf(`must be "true" or "false"`)
		}
	}
	return nil
}

// Set updates a dynamic setting's DB-stored value. Rejects unknown/static
// keys and keys currently pinned by an environment variable — env always
// wins, so writing here would silently do nothing, which is worse than an
// error explaining why.
func (s *Store) Set(key, value string, updatedBy int64) error {
	f := fieldByKey(key)
	if f == nil || !f.Dynamic {
		return fmt.Errorf("%q is not an editable setting", key)
	}
	if _, ok := s.envSet[key]; ok {
		return fmt.Errorf("%q is set by an environment variable (or .env) and can't be changed here — edit that instead", key)
	}
	if err := validateKind(key, f.Kind, value); err != nil {
		return fmt.Errorf("%s: %w", f.Label, err)
	}
	if err := s.dbh.SetAppSetting(key, value, &updatedBy); err != nil {
		return err
	}
	s.Reload()
	return nil
}

// Reset removes a Settings-screen override, falling back to env/default.
func (s *Store) Reset(key string) error {
	f := fieldByKey(key)
	if f == nil || !f.Dynamic {
		return fmt.Errorf("%q is not an editable setting", key)
	}
	if err := s.dbh.DeleteAppSetting(key); err != nil {
		return err
	}
	s.Reload()
	return nil
}

// View is one row of the Settings screen: everything the UI needs to
// render and (if editable) let an admin change one field.
type View struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Kind        Kind   `json:"kind"`
	Group       string `json:"group"`
	Editable    bool   `json:"editable"`
	Value       string `json:"value"`
	Source      string `json:"source"` // "env" | "db" | "default"
}

// List returns every catalogued setting — dynamic and static alike, per
// the brief that every setting should be visible on the Settings screen,
// even the ones that can only be changed by editing the environment.
func (s *Store) List() []View {
	out := make([]View, 0, len(Catalog))
	for _, f := range Catalog {
		var value, source string
		if f.Dynamic {
			v, ok := s.resolveRaw(f.Key)
			if !ok {
				v = f.Default
			}
			value = v
			source = s.sourceOfDynamic(f.Key)
		} else {
			if v, ok := os.LookupEnv(f.Key); ok {
				value = v
				source = "env"
			} else {
				value = f.Default
				source = "default"
			}
		}
		if f.Kind == KindSecret && value != "" {
			value = "••••••••"
		}
		out = append(out, View{
			Key: f.Key, Label: f.Label, Description: f.Description, Kind: f.Kind, Group: f.Group,
			Editable: f.Dynamic && source != "env", Value: value, Source: source,
		})
	}
	return out
}
