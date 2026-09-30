package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"

	"visioncall/internal/api"
	"visioncall/internal/auth"
	"visioncall/internal/backup"
	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/logger"
	"visioncall/internal/oidc"
	"visioncall/internal/settings"
	"visioncall/internal/signaling"
	"visioncall/static"
)

func main() {
	setupService()

	var cliAddr, cliPort, backupPath, envFile string
	var showVersion, healthOnly bool
	flag.BoolVar(&showVersion, "version", false, "Print the version and exit")
	flag.BoolVar(&healthOnly, "healthcheck", false, "Check that the running server answers, then exit 0 (healthy) or 1")
	flag.StringVar(&cliAddr, "addr", "", "Listen address (e.g. :8080 or :9000)")
	flag.StringVar(&cliPort, "port", "", "Listen port (e.g. 8080 or 9000)")
	flag.StringVar(&backupPath, "backup", "", "Write a consistent DB backup to this path and exit (built-in SQLite only; use pg_dump or mysqldump for Postgres/MySQL)")
	flag.StringVar(&envFile, "env-file", ".env", "Optional .env file to load. Real environment variables (including Docker's) always take priority over it.")
	flag.Parse()
	if showVersion {
		fmt.Println(config.Version)
		return
	}

	// Priority: real environment variables (set by the shell, systemd, or
	// Docker's `environment:`) > .env file > everything else. godotenv.Load
	// (not Overload) only fills in keys that aren't already set, which is
	// exactly that ordering — a missing .env file is not an error.
	if err := godotenv.Load(envFile); err != nil && !os.IsNotExist(err) {
		log.Printf("warning: could not load %s: %v", envFile, err)
	}

	cfg := config.Load()
	if cliAddr != "" {
		cfg.ListenAddr = cliAddr
	} else if cliPort != "" {
		if !strings.HasPrefix(cliPort, ":") {
			cfg.ListenAddr = ":" + cliPort
		} else {
			cfg.ListenAddr = cliPort
		}
	}

	if healthOnly {
		os.Exit(healthcheck(cfg.ListenAddr))
	}

	lg, logLevel := logger.New(cfg.LogLevel)
	lg.Info("vision call", "version", config.Version)

	// Also wire as the default slog logger so any third-party code that calls
	// slog.Info etc. routes through our handler.
	slog.SetDefault(lg)

	cfg.Validate(lg)

	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "files"), 0o755); err != nil {
		lg.Error("cannot create data directory", "path", filepath.Join(cfg.DataDir, "files"), "err", err)
		os.Exit(1)
	}

	renameLegacyDB(cfg.DataDir, lg)
	// A restore staged from the admin screen is applied here, before the
	// database is opened.
	restored, err := backup.ApplyPending(cfg.DataDir)
	if err != nil {
		lg.Error("could not apply the restored backup", "err", err)
		os.Exit(1)
	}
	if restored {
		lg.Info("restored a backup; the previous data was kept in a pre-restore folder", "data_dir", cfg.DataDir)
		cfg.JWTSecret = config.Load().JWTSecret // the backup brought its own session key
	}
	driver, dsn, err := cfg.DBDriverAndDSN(filepath.Join(cfg.DataDir, "visioncall.db"))
	if err != nil {
		lg.Error("invalid DATABASE_URL", "err", err)
		os.Exit(1)
	}
	dbh, err := db.Open(driver, dsn)
	if err != nil {
		lg.Error("cannot open database", "driver", driver, "err", err)
		os.Exit(1)
	}
	defer dbh.Close()
	if restored {
		if err := dbh.RebaseFilePaths(filepath.Join(cfg.DataDir, "files")); err != nil {
			lg.Error("could not update file locations after restoring", "err", err)
		}
	}

	if backupPath != "" {
		if err := dbh.Backup(backupPath); err != nil {
			lg.Error("backup failed", "err", err)
			os.Exit(1)
		}
		lg.Info("backup written", "path", backupPath)
		return
	}

	if err := dbh.ExpireOldSessions(); err != nil {
		lg.Warn("expire old sessions on startup", "err", err)
	}
	if err := dbh.ExpireOldPasswordResetTokens(); err != nil {
		lg.Warn("expire old password reset tokens on startup", "err", err)
	}
	if err := dbh.FinalizeOpenCalls(); err != nil {
		lg.Warn("finalize open calls on startup", "err", err)
	}

	// This process is meant to run unattended for weeks/months, so the boot-
	// time cleanup above isn't enough on its own — without a recurring pass,
	// expired sessions and reset tokens only ever get pruned on the next
	// restart. cleanupStop is closed during graceful shutdown below.
	settingsStore := settings.New(dbh, cfg, logLevel)

	// OIDC is read through the settings store (env/.env > Settings screen >
	// default), so values saved from the admin UI take effect on restart.
	var oidcMgr *oidc.Manager
	if sv := settingsStore.Get(); sv.OIDCIssuerURL != "" {
		redirect := sv.OIDCRedirectURL
		if redirect == "" && sv.PublicBaseURL != "" {
			redirect = sv.PublicBaseURL + "/api/oidc/callback"
		}
		if redirect == "" {
			lg.Error("OIDC issuer is set but neither OIDC_REDIRECT_URL nor PUBLIC_BASE_URL is; SSO disabled")
		} else if oidcMgr, err = oidc.New(context.Background(), oidc.Config{
			IssuerURL:    sv.OIDCIssuerURL,
			ClientID:     sv.OIDCClientID,
			ClientSecret: sv.OIDCClientSecret,
			RedirectURL:  redirect,
			JWTSecret:    cfg.JWTSecret,
		}); err != nil {
			lg.Error("failed to initialize OIDC; SSO disabled", "err", err)
			oidcMgr = nil
		}
	}

	hub := signaling.NewHub(cfg, dbh, lg, settingsStore)
	apiHandler := api.New(cfg, dbh, hub, oidcMgr, settingsStore, lg)

	cleanupStop := make(chan struct{})
	defer close(cleanupStop)
	go runPeriodicCleanup(dbh, apiHandler, lg, cleanupStop)
	if dbh.Dialect() == db.DialectSQLite {
		go runDailySnapshots(dbh, cfg.DataDir, lg, cleanupStop)
	}

	// After a restore is staged the server restarts itself: it exits with a
	// non-zero code so Docker, systemd and the Windows service manager start
	// it again, and the restore is applied on the way up.
	restartCh := make(chan struct{})
	var restartOnce sync.Once
	apiHandler.SetRestart(func() { restartOnce.Do(func() { close(restartCh) }) })

	bootstrapAdmin(cfg, dbh, lg)

	r := chi.NewRouter()
	r.Mount("/api", apiHandler.Router())
	r.Get("/ws", hub.HandleWS)

	r.Get("/cert.pem", func(w http.ResponseWriter, req *http.Request) {
		certPath := cfg.TLSCert
		if certPath == "" {
			certPath = filepath.Join(cfg.DataDir, "cert.pem")
		}
		if _, err := os.Stat(certPath); err != nil {
			http.Error(w, "Certificate not found on server", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="visioncall-ca.crt"`)
		http.ServeFile(w, req, certPath)
	})

	distFS := static.Dist()
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) { serveSPA(w, req, distFS) })
	r.Get("/", func(w http.ResponseWriter, req *http.Request) { serveSPA(w, req, distFS) })

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           securityHeaders(r),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		lg.Error("TLS_CERT and TLS_KEY must be set together")
		os.Exit(1)
	}

	var extraHosts []string
	if cfg.ExternalIP != "" {
		extraHosts = append(extraHosts, cfg.ExternalIP)
	} else if lanIP := config.DetectPrimaryLANIP(); lanIP != "" {
		extraHosts = append(extraHosts, lanIP)
	}
	if cfg.PublicBaseURL != "" {
		if u, err := url.Parse(cfg.PublicBaseURL); err == nil && u.Hostname() != "" {
			extraHosts = append(extraHosts, u.Hostname())
		}
	}

	// TLS is this process's job unless a reverse proxy terminates it
	// (TRUST_PROXY) or the operator explicitly opted out (DISABLE_TLS).
	// TRUST_PROXY is DB-editable from the Settings screen (env/.env still
	// wins if set) - reading it through settingsStore here, instead of the
	// raw env/.env-only cfg value, is what makes a Settings-screen change
	// actually take effect on the next restart rather than being silently
	// ignored by this specific decision.
	tlsActive := !settingsStore.Get().TrustProxy && !cfg.DisableTLS
	if !tlsActive {
		cfg.TLSCert, cfg.TLSKey = "", "" // ignore any cert the operator left set; Validate already warned about this
	} else if cfg.TLSCert == "" {
		certPath, keyPath, err := ensureSelfSignedCert(cfg.DataDir, extraHosts, lg)
		if err != nil {
			lg.Error("failed to generate self-signed certificate", "err", err)
			os.Exit(1)
		}
		cfg.TLSCert = certPath
		cfg.TLSKey = keyPath
	} else {
		// If custom cert path was set (e.g. via Docker Compose default) but files do not exist, fall back to self-signed
		if _, err := os.Stat(cfg.TLSCert); err != nil {
			lg.Warn("configured TLS_CERT file not found; generating self-signed certificate instead", "path", cfg.TLSCert)
			certPath, keyPath, err := ensureSelfSignedCert(cfg.DataDir, extraHosts, lg)
			if err != nil {
				lg.Error("failed to generate self-signed certificate", "err", err)
				os.Exit(1)
			}
			cfg.TLSCert = certPath
			cfg.TLSKey = keyPath
		}
	}

	var companionSrv *http.Server
	var companionMu sync.Mutex

	go func() {
		var err error
		if tlsActive {
			lg.Info("server starting with TLS", "addr", cfg.ListenAddr, "cert", cfg.TLSCert)

			companionMu.Lock()
			if cfg.HTTPSRedirect {
				defaultHost := cfg.ExternalIP
				if defaultHost == "" && len(extraHosts) > 0 {
					defaultHost = extraHosts[0]
				}
				allowedHosts := append([]string{defaultHost, "localhost", "127.0.0.1"}, extraHosts...)
				companionSrv = startHTTPRedirect(cfg.HTTPAddr, cfg.ListenAddr, defaultHost, allowedHosts, lg)
			} else {
				companionSrv = startHTTPPlain(cfg.HTTPAddr, securityHeaders(r), lg)
			}
			companionMu.Unlock()

			err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			lg.Info("server starting", "addr", cfg.ListenAddr, "tls", false)
			err = srv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			lg.Error("server fatal error", "err", err)
			os.Exit(1)
		}
	}()

	ctx, stop := shutdownContext()
	defer stop()
	restarting := false
	select {
	case <-ctx.Done():
	case <-restartCh:
		restarting = true
	}

	lg.Info("received shutdown signal; draining connections")
	hub.Close()
	apiHandler.Limiter().Stop()
	apiHandler.IPLimiter().Stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	companionMu.Lock()
	cs := companionSrv
	companionMu.Unlock()
	if cs != nil {
		_ = cs.Shutdown(shutdownCtx)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil {
		lg.Error("graceful shutdown error", "err", err)
	}
	lg.Info("server stopped")
	if restarting {
		lg.Info("restarting to apply the restored backup")
		dbh.Close()
		os.Exit(3)
	}
}

// runDailySnapshots keeps a daily copy of the database in DATA_DIR/backups
// (the newest 7), shown and restorable in Admin > Backups.
func runDailySnapshots(dbh *db.DB, dataDir string, lg *slog.Logger, stop <-chan struct{}) {
	take := func() {
		if s, err := backup.TakeSnapshot(dbh, dataDir); err != nil {
			lg.Error("daily backup failed", "err", err)
		} else {
			lg.Info("daily backup written", "file", s.Name)
		}
	}
	select {
	case <-time.After(2 * time.Minute):
		take()
	case <-stop:
		return
	}
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			take()
		case <-stop:
			return
		}
	}
}

// runPeriodicCleanup re-runs the same expiry sweeps main() does once at
// boot, on a recurring timer, for as long as the server is up. Without this,
// sessions/password_reset_tokens only shrink on the next restart — on a
// long-uptime LAN server that means unbounded growth between restarts, and
// (for reset tokens specifically) a slower ConsumePasswordResetToken scan
// the longer the server has been running.
func runPeriodicCleanup(dbh *db.DB, apiHandler *api.API, lg *slog.Logger, stop <-chan struct{}) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := dbh.ExpireOldSessions(); err != nil {
				lg.Warn("periodic cleanup: expire old sessions", "err", err)
			}
			if err := dbh.ExpireOldPasswordResetTokens(); err != nil {
				lg.Warn("periodic cleanup: expire old password reset tokens", "err", err)
			}
			apiHandler.CleanupOrphanFiles()
			apiHandler.PurgeOldMessages()
		case <-stop:
			return
		}
	}
}

func isSafeHost(h string) bool {
	if len(h) == 0 || len(h) > 253 {
		return false
	}
	for _, r := range h {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		isSpecial := r == '.' || r == '-' || r == '_'
		if !isAlphaNum && !isSpecial {
			return false
		}
	}
	return true
}

func isAllowedHost(h string, allowed []string) bool {
	if !isSafeHost(h) {
		return false
	}
	hLower := strings.ToLower(strings.TrimSpace(h))
	for _, a := range allowed {
		if strings.ToLower(strings.TrimSpace(a)) == hLower {
			return true
		}
	}
	return false
}

func startHTTPRedirect(redirectAddr, httpsAddr, defaultHost string, allowedHosts []string, lg *slog.Logger) *http.Server {
	_, httpsPort, _ := net.SplitHostPort(httpsAddr)
	if defaultHost == "" {
		defaultHost = "localhost"
	}
	redirectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqHost, _, err := net.SplitHostPort(r.Host)
		if err != nil || reqHost == "" {
			reqHost = r.Host
		}
		if !isAllowedHost(reqHost, allowedHosts) {
			reqHost = defaultHost
		}
		targetHost := reqHost
		if httpsPort != "" && httpsPort != "443" {
			targetHost = net.JoinHostPort(reqHost, httpsPort)
		}
		cleanURI := r.URL.RequestURI()
		cleanURI = strings.ReplaceAll(cleanURI, "\r", "")
		cleanURI = strings.ReplaceAll(cleanURI, "\n", "")
		targetURL := "https://" + targetHost + cleanURI
		http.Redirect(w, r, targetURL, http.StatusMovedPermanently)
	})

	srv := &http.Server{
		Addr:              redirectAddr,
		Handler:           redirectHandler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	go func() {
		lg.Info("http-to-https redirect listener active", "addr", redirectAddr, "target_https", httpsAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			lg.Warn("http-to-https redirect listener stopped", "err", err)
		}
	}()

	return srv
}

// startHTTPPlain runs the full app (same handler as the HTTPS listener) on a
// second, plain-HTTP port — used instead of startHTTPRedirect when
// HTTPS_REDIRECT is false, so both the encrypted and unencrypted ports work
// (camera/mic still require the HTTPS one in a browser, but health checks,
// simple clients, or a "try it before trusting the cert" visit all work
// over plain HTTP too).
func startHTTPPlain(addr string, handler http.Handler, lg *slog.Logger) *http.Server {
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		lg.Info("plain-http companion listener active", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			lg.Warn("plain-http companion listener stopped", "err", err)
		}
	}()
	return srv
}

func serveSPA(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if info, err := fs.Stat(fsys, p); p == "" || err != nil || info.IsDir() {
		p = "index.html" // SPA fallback for client-side routes; never list directories
	}
	// Embedded files carry no modtime, so without explicit headers the
	// browser re-downloads the whole bundle on every visit. Vite's /assets/
	// names are content-hashed, so they can be cached forever; everything
	// else (index.html, sw.js, manifest) must revalidate to pick up deploys.
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFileFS(w, r, fsys, p)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// Tight CSP: media-src allows blob: for local stream previews. connect-src
		// is 'self' only — that already permits a same-origin ws:/wss: connection
		// per the CSP fetch-directive spec, so it need not (and must not) also
		// list the bare ws:/wss: schemes, which would let a script connect to
		// *any* websocket host, not just this origin.
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "+
				"font-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func bootstrapAdmin(cfg *config.Config, dbh *db.DB, lg *slog.Logger) {
	count, err := dbh.CountUsers()
	if err != nil || count > 0 {
		return
	}

	password := cfg.BootstrapAdminPassword
	generated := false
	if password == "" {
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			lg.Error("generate bootstrap password", "err", err)
			os.Exit(1)
		}
		password = hex.EncodeToString(buf)
		generated = true
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		lg.Error("hash bootstrap password", "err", err)
		os.Exit(1)
	}

	if _, err := dbh.CreateUser(cfg.BootstrapAdminUser, cfg.BootstrapAdminUser, hash, "admin"); err != nil {
		lg.Error("create bootstrap admin account", "err", err)
		os.Exit(1)
	}

	lg.Info("bootstrap admin account created", "username", cfg.BootstrapAdminUser)
	if generated {
		// Use stdlib log for maximum visibility regardless of configured log level.
		log.Printf("===================================================")
		log.Printf("Bootstrap admin password: %s", password)
		log.Printf("(shown once — set BOOTSTRAP_ADMIN_PASSWORD to pin it)")
		log.Printf("===================================================")
	}
}

// ensureSelfSignedCert reuses the existing self-signed cert as long as it
// still covers every address this machine currently has. LAN/VPN boxes
// routinely change subnet (a new DHCP lease, moving to a different network,
// a VPN interface appearing later) - checking existence alone would leave a
// stale cert that silently stops covering the machine's real address, so
// every boot compares the cert's SANs against localCertificateNames() and
// regenerates (extending, not shrinking, the SAN set) the moment they drift.
func ensureSelfSignedCert(dataDir string, extraHosts []string, lg *slog.Logger) (certPath, keyPath string, err error) {
	certPath = filepath.Join(dataDir, "cert.pem")
	keyPath = filepath.Join(dataDir, "key.pem")

	dnsNames, ipAddresses := localCertificateNames(extraHosts...)

	if existing, certErr := loadExistingCertNames(certPath); certErr == nil {
		if _, keyErr := os.Stat(keyPath); keyErr == nil {
			expiringSoon := time.Now().After(existing.notAfter.Add(-30 * 24 * time.Hour))
			if existing.covers(dnsNames, ipAddresses) && !expiringSoon {
				return certPath, keyPath, nil // still covers every current address and isn't about to expire
			}
			if expiringSoon {
				lg.Info("self-signed certificate expires within 30 days; regenerating", "expires", existing.notAfter)
			} else {
				lg.Info("machine's network addresses changed since the certificate was generated; regenerating to cover the new ones",
					"dns", dnsNames, "ip", ipAddressStrings(ipAddresses))
			}
			// Keep any previously-covered names too, so devices that only
			// ever reached this server over an older address (e.g. a VPN
			// peer on a different subnet than the one just detected) aren't
			// dropped from the new certificate.
			dnsNames = mergeDNS(existing.dns, dnsNames)
			ipAddresses = mergeIPs(existing.ips, ipAddresses)
		}
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return "", "", err
	}
	template := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"Vision Call (Self-Signed)"},
			CommonName:   "Vision Call LAN Root CA",
		},
		NotBefore:             time.Now().Add(-5 * time.Minute),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddresses,
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return "", "", err
	}

	privBytes, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes}), 0o644); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privBytes}), 0o600); err != nil {
		_ = os.Remove(certPath)
		return "", "", err
	}

	return certPath, keyPath, nil
}

// certNames is the SAN set read back out of an existing certificate on disk.
type certNames struct {
	dns      []string
	ips      []net.IP
	notAfter time.Time
}

// covers reports whether every one of the machine's current addresses is
// already present in the certificate's existing SAN list.
func (c certNames) covers(dnsNames []string, ipAddresses []net.IP) bool {
	dnsSet := map[string]bool{}
	for _, d := range c.dns {
		dnsSet[d] = true
	}
	for _, d := range dnsNames {
		if !dnsSet[d] {
			return false
		}
	}
	ipSet := map[string]bool{}
	for _, ip := range c.ips {
		ipSet[ip.String()] = true
	}
	for _, ip := range ipAddresses {
		if !ipSet[ip.String()] {
			return false
		}
	}
	return true
}

// loadExistingCertNames reads back the DNS/IP SANs of the cert already on
// disk, so a regeneration can extend rather than drop coverage.
func loadExistingCertNames(certPath string) (certNames, error) {
	raw, err := os.ReadFile(certPath)
	if err != nil {
		return certNames{}, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return certNames{}, fmt.Errorf("no PEM block in %s", certPath)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return certNames{}, err
	}
	return certNames{dns: cert.DNSNames, ips: cert.IPAddresses, notAfter: cert.NotAfter}, nil
}

func mergeDNS(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range [][]string{a, b} {
		for _, d := range list {
			if d != "" && !seen[d] {
				seen[d] = true
				out = append(out, d)
			}
		}
	}
	return out
}

func mergeIPs(a, b []net.IP) []net.IP {
	seen := map[string]bool{}
	var out []net.IP
	for _, list := range [][]net.IP{a, b} {
		for _, ip := range list {
			key := ip.String()
			if ip != nil && !seen[key] {
				seen[key] = true
				out = append(out, ip)
			}
		}
	}
	return out
}

func ipAddressStrings(ips []net.IP) []string {
	out := make([]string, len(ips))
	for i, ip := range ips {
		out[i] = ip.String()
	}
	return out
}

func localCertificateNames(extraHosts ...string) (dnsNames []string, ipAddresses []net.IP) {
	seenDNS := map[string]bool{}
	addDNS := func(name string) {
		name = strings.TrimSpace(name)
		if name != "" && !seenDNS[name] {
			seenDNS[name] = true
			dnsNames = append(dnsNames, name)
		}
	}
	addDNS("localhost")
	if hostname, err := os.Hostname(); err == nil {
		addDNS(strings.ToLower(hostname))
	}
	seenIP := map[string]bool{}
	addIP := func(ip net.IP) {
		if ip == nil {
			return
		}
		key := ip.String()
		if !seenIP[key] {
			seenIP[key] = true
			ipAddresses = append(ipAddresses, ip)
		}
	}
	for _, h := range extraHosts {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			addIP(ip)
		} else {
			addDNS(strings.ToLower(h))
		}
	}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			switch value := addr.(type) {
			case *net.IPNet:
				addIP(value.IP)
			case *net.IPAddr:
				addIP(value.IP)
			}
		}
	}
	return dnsNames, ipAddresses
}

// renameLegacyDB moves a database created before the project was renamed
// (videocall.db and its -wal/-shm files) to the current name, so upgrading
// keeps all existing data.
func renameLegacyDB(dataDir string, lg *slog.Logger) {
	oldPath := filepath.Join(dataDir, "videocall.db")
	newPath := filepath.Join(dataDir, "visioncall.db")
	if _, err := os.Stat(newPath); err == nil {
		return
	}
	if _, err := os.Stat(oldPath); err != nil {
		return
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Rename(oldPath+suffix, newPath+suffix); err != nil && !os.IsNotExist(err) {
			lg.Error("could not rename the old database file", "from", oldPath+suffix, "err", err)
			os.Exit(1)
		}
	}
	lg.Info("renamed database file", "from", oldPath, "to", newPath)
}
