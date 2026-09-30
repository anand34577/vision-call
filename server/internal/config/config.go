package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Version is stamped at build time from the git tag, see scripts/build.sh.
var Version = "dev"

type Config struct {
	// ListenAddr is the app's primary port: HTTPS when TLS is active (a real
	// cert, or the auto-generated self-signed one), or the sole plain-HTTP
	// port when DisableTLS is set. Default depends on DisableTLS (see Load).
	ListenAddr string
	// HTTPAddr is a second, always-plain-HTTP port that runs alongside
	// ListenAddr whenever TLS is active and the app isn't behind a
	// TrustProxy reverse proxy: either a companion "the app also works over
	// plain HTTP" port (HTTPSRedirect=false, the default) or a pure
	// redirect-to-HTTPS port (HTTPSRedirect=true). Unused when DisableTLS.
	HTTPAddr               string
	HTTPSRedirect          bool   // true: HTTPAddr only 301s to HTTPS; false: it also serves the app
	DisableTLS             bool   // force plain HTTP only — no self-signed cert, no HTTPAddr companion port
	TLSCert                string // path to cert file; TLS enabled when both cert+key set
	TLSKey                 string
	DataDir                string // sqlite db + uploaded files live under here
	DatabaseURL            string // postgres://... or mysql://...; empty = sqlite in DataDir (default)
	JWTSecret              []byte
	SessionTTLHours        int
	MessageRetentionDays   int
	MetricsToken           string
	BootstrapAdminUser     string
	BootstrapAdminPassword string // optional; generated + printed when empty and no users exist
	ExternalIP             string // LAN/VPN IP the SFU advertises in ICE candidates
	TurnHost               string // host:port of coturn, e.g. 192.168.1.10:3478
	TurnSecret             string // coturn static-auth-secret; enables TURN credentials
	MaxCallParticipants    int
	WebRTCUDPPort          int // one UDP port for all SFU media; 0 = random ports
	MaxFileBytes           int64
	MaxUserStorageBytes    int64           // total upload storage allowed per user; 0 = unlimited
	BlockedFileExtensions  map[string]bool // lowercase, with leading dot, e.g. ".exe"; rejected on upload
	LogLevel               string          // "debug" | "info" | "warn" | "error"
	TrustProxy             bool            // trust X-Forwarded-* headers for IP
	ProxyTLS               bool            // force Secure cookies behind HTTPS proxy

	// Self-service password reset is only offered when SMTPHost is set; an
	// admin turns it on by providing SMTP credentials, nothing in the app UI
	// enables it.
	SMTPHost      string
	SMTPPort      int
	SMTPUser      string
	SMTPPass      string
	SMTPFrom      string // From: header; defaults to SMTPUser if unset
	PublicBaseURL string // e.g. https://call.example.com; required to enable password-reset emails (see passwordResetActive) since the reset link must never be derived from the client-supplied Host header.

	// SSO via any OpenID Connect provider. Entirely optional: the app has no
	// dependency on it unless OIDCIssuerURL is set. See internal/oidc.
	OIDCIssuerURL       string
	OIDCClientID        string
	OIDCClientSecret    string
	OIDCRedirectURL     string // defaults to PublicBaseURL + /api/oidc/callback
	OIDCAutoCreateUsers bool   // false (default): SSO login requires an admin/self pre-linked account
	OIDCButtonLabel     string // shown on the login button, e.g. "Sign in with Okta"
}

// EffectiveOIDCRedirectURL resolves the callback URL OIDC providers must be
// configured to send users back to. Unlike the session cookie's Secure flag,
// this can't be inferred per-request — the IdP needs one fixed, pre-registered
// URL — so OIDC requires either OIDC_REDIRECT_URL or PUBLIC_BASE_URL set.
func (c *Config) EffectiveOIDCRedirectURL() (string, error) {
	if c.OIDCRedirectURL != "" {
		return c.OIDCRedirectURL, nil
	}
	if c.PublicBaseURL != "" {
		return c.PublicBaseURL + "/api/oidc/callback", nil
	}
	return "", fmt.Errorf("OIDC_ISSUER_URL is set but neither OIDC_REDIRECT_URL nor PUBLIC_BASE_URL is — the identity provider needs one fixed callback URL")
}

// defaultBlockedExtensions covers the common ways to get a teammate to
// double-click their way into running something: Windows/Unix executables,
// installers, and script hosts. Documents, images, archives, etc. are all
// still allowed — this only blocks direct "run me" file types.
const defaultBlockedExtensions = ".exe,.bat,.cmd,.com,.scr,.msi,.msp,.ps1,.psm1,.vbs,.vbe,.js,.jse,.wsf,.wsh,.jar,.app,.dll,.sh,.bin,.cpl,.gadget,.hta,.lnk,.pif,.reg,.vb,.ws,.apk"

// parseExtList turns a comma-separated ".ext,.ext" list into a lookup set.
// The literal value "none" (env vars can't distinguish "unset" from "set to
// empty" through this app's env() helper) disables blocking entirely.
func ParseExtList(csv string) map[string]bool {
	out := map[string]bool{}
	if strings.EqualFold(strings.TrimSpace(csv), "none") {
		return out
	}
	for _, e := range strings.Split(csv, ",") {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		out[e] = true
	}
	return out
}

// DBDriverAndDSN resolves DATABASE_URL into a (driver, dsn) pair for
// db.Open. An empty DATABASE_URL means "use sqlite in DataDir" (the
// default, zero-setup path); sqlitePath is only meaningful in that case.
//
// DATABASE_URL forms:
//
//	postgres://user:pass@host:5432/dbname?sslmode=disable
//	mysql://user:pass@host:3306/dbname
func (c *Config) DBDriverAndDSN(sqlitePath string) (driver, dsn string, err error) {
	if c.DatabaseURL == "" {
		return "sqlite", sqlitePath, nil
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil {
		return "", "", fmt.Errorf("invalid DATABASE_URL: %w", err)
	}
	switch u.Scheme {
	case "postgres", "postgresql":
		return "postgres", c.DatabaseURL, nil
	case "mysql":
		pass, _ := u.User.Password()
		q := u.RawQuery
		if q != "" {
			q = "?" + q
		}
		// go-sql-driver/mysql wants "user:pass@tcp(host:port)/dbname?params",
		// not a URL — translate the one we accept into that.
		dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s%s", u.User.Username(), pass, u.Host, strings.TrimPrefix(u.Path, "/"), q)
		return "mysql", dsn, nil
	default:
		return "", "", fmt.Errorf("DATABASE_URL scheme %q not supported; use postgres:// or mysql://", u.Scheme)
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func Load() *Config {
	disableTLS := envBool("DISABLE_TLS", false)

	listen := os.Getenv("LISTEN_ADDR")
	if listen == "" {
		if p := os.Getenv("PORT"); p != "" {
			if !strings.HasPrefix(p, ":") {
				listen = ":" + p
			} else {
				listen = p
			}
		} else if disableTLS {
			listen = ":8080"
		} else {
			listen = ":8443"
		}
	}

	c := &Config{
		ListenAddr: listen,
		// HTTP_ADDR falls back to the older HTTP_REDIRECT_ADDR name for
		// anyone who set that already; new deployments should use HTTP_ADDR.
		HTTPAddr:              env("HTTP_ADDR", env("HTTP_REDIRECT_ADDR", ":8080")),
		HTTPSRedirect:         envBool("HTTPS_REDIRECT", false),
		DisableTLS:            disableTLS,
		TLSCert:               env("TLS_CERT", ""),
		TLSKey:                env("TLS_KEY", ""),
		DataDir:               env("DATA_DIR", "./data"),
		DatabaseURL:           env("DATABASE_URL", ""),
		SessionTTLHours:       envInt("SESSION_TTL_HOURS", 720),
		MessageRetentionDays:  envInt("MESSAGE_RETENTION_DAYS", 0),
		MetricsToken:          os.Getenv("METRICS_TOKEN"),
		BootstrapAdminUser:    env("BOOTSTRAP_ADMIN_USER", "admin"),
		ExternalIP:            env("EXTERNAL_IP", ""),
		TurnHost:              env("TURN_HOST", ""),
		TurnSecret:            env("TURN_SECRET", ""),
		MaxCallParticipants:   envInt("MAX_CALL_PARTICIPANTS", 8),
		WebRTCUDPPort:         envInt("WEBRTC_UDP_PORT", 7882),
		MaxFileBytes:          int64(envInt("MAX_FILE_MB", 50)) * 1024 * 1024,
		MaxUserStorageBytes:   int64(envInt("MAX_USER_STORAGE_MB", 2048)) * 1024 * 1024,
		BlockedFileExtensions: ParseExtList(env("BLOCKED_FILE_EXTENSIONS", defaultBlockedExtensions)),
		LogLevel:              env("LOG_LEVEL", "info"),
		TrustProxy:            envBool("TRUST_PROXY", false),
		ProxyTLS:              envBool("PROXY_TLS", false),
		SMTPHost:              env("SMTP_HOST", ""),
		SMTPPort:              envInt("SMTP_PORT", 587),
		SMTPUser:              env("SMTP_USER", ""),
		SMTPPass:              env("SMTP_PASS", ""),
		SMTPFrom:              env("SMTP_FROM", ""),
		PublicBaseURL:         strings.TrimSuffix(env("PUBLIC_BASE_URL", ""), "/"),
		OIDCIssuerURL:         env("OIDC_ISSUER_URL", ""),
		OIDCClientID:          env("OIDC_CLIENT_ID", ""),
		OIDCClientSecret:      env("OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURL:       env("OIDC_REDIRECT_URL", ""),
		OIDCAutoCreateUsers:   envBool("OIDC_AUTO_CREATE_USERS", false),
		OIDCButtonLabel:       env("OIDC_BUTTON_LABEL", "Sign in with SSO"),
	}
	c.BootstrapAdminPassword = os.Getenv("BOOTSTRAP_ADMIN_PASSWORD")

	if s := os.Getenv("JWT_SECRET"); s != "" {
		c.JWTSecret = []byte(s)
	} else {
		c.JWTSecret = loadOrCreateSecret(filepath.Join(c.DataDir, "jwt_secret"))
	}
	return c
}

// loadOrCreateSecret keeps a random JWT secret in the data directory, so a
// fresh install needs no JWT_SECRET and logins survive restarts.
func loadOrCreateSecret(path string) []byte {
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("config: generating JWT secret: %v", err)
	}
	secret := []byte(hex.EncodeToString(buf))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
		err = os.WriteFile(path, secret, 0o600)
		if err == nil {
			return secret
		}
	}
	log.Println("config: WARNING: could not save a JWT secret to the data directory; sessions will end on restart. Set JWT_SECRET to avoid this.")
	return secret
}

// Validate logs operational warnings after the structured logger is available.
// It also clamps out-of-range values to safe defaults.
func (c *Config) Validate(log *slog.Logger) {
	if c.DatabaseURL == "" {
		log.Info("DATABASE_URL not set — using embedded sqlite (default)")
	} else if driver, _, err := c.DBDriverAndDSN(""); err != nil {
		log.Error("invalid DATABASE_URL", "err", err)
	} else {
		log.Info("external database configured", "driver", driver)
	}

	if c.ExternalIP == "" {
		log.Info("EXTERNAL_IP not set; group calls will advertise whichever server address each browser connected to")
	} else {
		log.Info("SFU external IP configured", "ip", c.ExternalIP)
	}

	if c.TurnHost == "" {
		log.Info("TURN_HOST not configured — using host ICE candidates only; this is sufficient for LAN/VPN where peers can reach the server directly")
	} else {
		log.Info("TURN relay configured", "host", c.TurnHost)
	}

	switch {
	case c.TrustProxy:
		if c.DisableTLS {
			log.Info("TRUST_PROXY set — DISABLE_TLS is redundant here and ignored; the app always speaks plain HTTP to its proxy")
		} else {
			log.Info("TRUST_PROXY set — trusting the reverse proxy to terminate TLS; the app itself speaks plain HTTP")
		}
		if c.TLSCert != "" {
			log.Warn("TLS_CERT is set but ignored while TRUST_PROXY is true — terminate TLS at the proxy, not here")
		}
	case c.DisableTLS:
		log.Warn("DISABLE_TLS=true — serving plain HTTP only; camera/mic (getUserMedia) will not work in browsers except from localhost. Only use this on a trusted LAN, or put a TLS-terminating proxy in front and set TRUST_PROXY instead")
		if c.TLSCert != "" {
			log.Warn("TLS_CERT is set but ignored while DISABLE_TLS is true")
		}
	case c.TLSCert == "":
		log.Info("TLS_CERT not set — a self-signed certificate will be generated automatically", "https_addr", c.ListenAddr, "http_addr", c.HTTPAddr)
	default:
		log.Info("TLS_CERT configured", "https_addr", c.ListenAddr, "http_addr", c.HTTPAddr)
	}

	if !c.TrustProxy && !c.DisableTLS && c.ListenAddr == c.HTTPAddr {
		log.Error("LISTEN_ADDR and HTTP_ADDR must differ when TLS is active (both would try to bind the same port)", "addr", c.ListenAddr)
		os.Exit(1)
	}
	if c.HTTPSRedirect && (c.DisableTLS || c.TrustProxy) {
		log.Info("HTTPS_REDIRECT has no effect here — TLS isn't terminated by this process in this mode")
	}

	if c.SessionTTLHours < 1 {
		log.Warn("SESSION_TTL_HOURS too low; resetting to 1", "was", c.SessionTTLHours)
		c.SessionTTLHours = 1
	}

	if c.MaxCallParticipants < 2 {
		log.Warn("MAX_CALL_PARTICIPANTS too low; resetting to 2", "was", c.MaxCallParticipants)
		c.MaxCallParticipants = 2
	}

	if c.MaxFileBytes < 1024 {
		log.Warn("MAX_FILE_MB results in a very small limit; resetting to 1 MB")
		c.MaxFileBytes = 1024 * 1024
	}

	if len(c.BlockedFileExtensions) == 0 {
		log.Warn("BLOCKED_FILE_EXTENSIONS=none — uploads of executables/scripts are allowed; only set this if you trust everyone with an account")
	} else {
		log.Info("blocking upload of executable/script file types", "count", len(c.BlockedFileExtensions))
	}

	if c.MaxUserStorageBytes < 0 {
		c.MaxUserStorageBytes = 0 // unlimited
	} else if c.MaxUserStorageBytes > 0 && c.MaxUserStorageBytes < c.MaxFileBytes {
		log.Warn("MAX_USER_STORAGE_MB is smaller than MAX_FILE_MB; raising it to match", "was_mb", c.MaxUserStorageBytes/(1<<20))
		c.MaxUserStorageBytes = c.MaxFileBytes
	}

	if c.SMTPHost == "" {
		log.Info("SMTP_HOST not set via environment/.env — self-service password reset is disabled unless set from the admin Settings screen")
	} else {
		log.Info("SMTP configured via environment/.env — self-service password reset enabled", "host", c.SMTPHost, "port", c.SMTPPort)
	}

	if c.OIDCIssuerURL == "" {
		log.Info("OIDC_ISSUER_URL not set — SSO disabled; username/password is the only login method")
	} else if redirect, err := c.EffectiveOIDCRedirectURL(); err != nil {
		log.Error(err.Error())
		os.Exit(1)
	} else {
		log.Info("OIDC configured", "issuer", c.OIDCIssuerURL, "redirect", redirect, "auto_create_users", c.OIDCAutoCreateUsers)
	}

	log.Info("configuration",
		"listen", c.ListenAddr,
		"data_dir", c.DataDir,
		"session_ttl_h", c.SessionTTLHours,
		"max_call_participants", c.MaxCallParticipants,
		"max_file_mb", c.MaxFileBytes/(1<<20),
		"log_level", c.LogLevel,
		"trust_proxy", c.TrustProxy,
		"proxy_tls", c.ProxyTLS,
	)
}

// DetectPrimaryLANIP picks the IPv4 address other LAN devices most likely
// reach this machine on. Interface order is arbitrary (a VPN or virtual
// adapter often comes first), so it prefers, in order: the source address of
// the default route (a UDP "dial" sends no packets), then any private
// RFC1918 address, then any other non-loopback, non-link-local address.
func DetectPrimaryLANIP() string {
	if c, err := net.Dial("udp4", "192.0.2.1:9"); err == nil {
		ip := c.LocalAddr().(*net.UDPAddr).IP
		c.Close()
		if ip.IsPrivate() {
			return ip.String()
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	fallback := ""
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.To4() == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.IsPrivate() {
				return ip.String()
			}
			if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	return fallback
}
