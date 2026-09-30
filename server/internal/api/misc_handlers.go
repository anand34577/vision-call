package api

import (
	"crypto/subtle"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"visioncall/internal/config"
	"visioncall/internal/ice"
)

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func (a *API) handleIce(w http.ResponseWriter, r *http.Request) {
	sv := a.settings.Get()
	servers := []iceServer{}
	if sv.TurnHost != "" && sv.TurnSecret != "" {
		user, pass := ice.Credentials(sv.TurnSecret, 12*time.Hour)
		servers = append(servers,
			iceServer{URLs: []string{"stun:" + sv.TurnHost}},
			iceServer{
				URLs:       []string{"turn:" + sv.TurnHost + "?transport=udp", "turn:" + sv.TurnHost + "?transport=tcp"},
				Username:   user,
				Credential: pass,
			})
	}
	writeJSON(w, http.StatusOK, map[string]any{"iceServers": servers})
}

func dirSize(path string) int64 {
	var total int64
	filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// storageStatsCacheTTL bounds how often the (potentially expensive, full
// tree-walk) files-directory size is recomputed. Shared by handleAdminStats
// and handleMetrics so an unauthenticated Prometheus scrape can't force a
// filesystem walk on every request.
const storageStatsCacheTTL = 30 * time.Second

type storageStats struct {
	DBBytes    int64
	FilesBytes int64
}

var (
	storageStatsMu       sync.Mutex
	storageStatsCached   storageStats
	storageStatsCachedAt time.Time
)

func (a *API) storageStats() storageStats {
	storageStatsMu.Lock()
	defer storageStatsMu.Unlock()
	if time.Since(storageStatsCachedAt) < storageStatsCacheTTL {
		return storageStatsCached
	}
	dbSize := int64(0)
	if info, err := os.Stat(filepath.Join(a.cfg.DataDir, "visioncall.db")); err == nil {
		dbSize = info.Size()
	}
	storageStatsCached = storageStats{
		DBBytes:    dbSize,
		FilesBytes: dirSize(filepath.Join(a.cfg.DataDir, "files")),
	}
	storageStatsCachedAt = time.Now()
	return storageStatsCached
}

func (a *API) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	stats := map[string]any{
		"version":      config.Version,
		"uptime_hours": time.Since(a.startedAt).Hours(),
		"db_driver":    string(a.db.Dialect()),
	}
	if users, err := a.db.CountActiveUsers(); err == nil {
		stats["users"] = users
	}
	if a.hub != nil {
		stats["online"] = a.hub.OnlineCount()
		stats["active_calls"] = a.hub.ActiveCalls()
	}
	st := a.storageStats()
	stats["storage"] = map[string]any{
		"db_bytes":    st.DBBytes,
		"files_bytes": st.FilesBytes,
		"total_bytes": st.DBBytes + st.FilesBytes,
	}
	writeJSON(w, http.StatusOK, stats)
}

// handleMetrics exposes a small set of gauges in Prometheus's plain-text
// exposition format, unauthenticated like /healthz (this is a LAN/VPN-only
// intranet server — Prometheus doesn't send session cookies, and there's
// nothing here an operator scraping their own network shouldn't see).
// Hand-written rather than pulling in client_golang: a handful of gauges
// don't need a metrics library, just the format Prometheus already expects.
func (a *API) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !a.metricsAllowed(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var b strings.Builder
	gauge := func(name, help string, value float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n%s %v\n", name, help, name, name, value)
	}

	gauge("visioncall_uptime_seconds", "Seconds since the server started.", time.Since(a.startedAt).Seconds())
	if users, err := a.db.CountActiveUsers(); err == nil {
		gauge("visioncall_users_total", "Total registered user accounts.", float64(users))
	}
	if a.hub != nil {
		gauge("visioncall_online_users", "Currently connected (websocket) users.", float64(a.hub.OnlineCount()))
		gauge("visioncall_active_calls", "Currently active calls (1:1 + conference rooms).", float64(a.hub.ActiveCalls()))
	}
	st := a.storageStats()
	gauge("visioncall_db_bytes", "Size of the sqlite database file on disk.", float64(st.DBBytes))
	gauge("visioncall_files_bytes", "Total size of uploaded files on disk.", float64(st.FilesBytes))

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	gauge("visioncall_go_goroutines", "Number of running goroutines.", float64(runtime.NumGoroutine()))
	gauge("visioncall_go_heap_alloc_bytes", "Bytes of allocated heap objects.", float64(mem.HeapAlloc))

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

// handleDownloadCert allows LAN and mobile devices to download the server's public
// TLS certificate (e.g. self-signed root CA) for easy installation into their trust stores.
func (a *API) handleDownloadCert(w http.ResponseWriter, r *http.Request) {
	certPath := a.cfg.TLSCert
	if certPath == "" {
		certPath = filepath.Join(a.cfg.DataDir, "cert.pem")
	}
	if _, err := os.Stat(certPath); err != nil {
		writeErr(w, http.StatusNotFound, "no certificate available on server")
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="visioncall-ca.crt"`)
	http.ServeFile(w, r, certPath)
}

// metricsAllowed guards /metrics: a bearer token when METRICS_TOKEN is set,
// otherwise only loopback and private-network callers (so a server exposed to
// the internet doesn't publish usage numbers to everyone).
func (a *API) metricsAllowed(r *http.Request) bool {
	sv := a.settings.Get()
	if sv.MetricsToken != "" {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		return subtle.ConstantTimeCompare([]byte(got), []byte(sv.MetricsToken)) == 1
	}
	ip := net.ParseIP(RealIP(r, sv.TrustProxy))
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
