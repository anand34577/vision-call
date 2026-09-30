package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
)

// uploadLocks serializes concurrent uploads from the same user around the
// storage-quota check-then-write, so two requests racing the pre-check
// (each individually under quota at the moment it's read) can no longer
// both pass and jointly push the user over MAX_USER_STORAGE_MB. Uploads
// from different users never contend with each other.
var uploadLocks sync.Map // map[int64]*sync.Mutex

func lockForUpload(userID int64) *sync.Mutex {
	v, _ := uploadLocks.LoadOrStore(userID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// looksExecutable does a minimal magic-byte check for the file types the
// upload block-list exists to stop - "something a teammate could double-
// click and run" - independent of whatever extension the client claims.
// This is deliberately narrow (PE/ELF/Mach-O binaries and #! scripts): it
// catches the "renamed .exe to .txt" bypass without false-positiving on the
// huge range of legitimate document/image/archive/media types the app is
// supposed to keep allowing.
func looksExecutable(sniff []byte) bool {
	switch {
	case len(sniff) >= 2 && sniff[0] == 'M' && sniff[1] == 'Z': // Windows PE (.exe/.dll/.scr/...)
		return true
	case len(sniff) >= 4 && bytes.Equal(sniff[:4], []byte{0x7f, 'E', 'L', 'F'}): // Linux ELF
		return true
	case len(sniff) >= 4 && (bytes.Equal(sniff[:4], []byte{0xFE, 0xED, 0xFA, 0xCE}) || // Mach-O 32-bit
		bytes.Equal(sniff[:4], []byte{0xFE, 0xED, 0xFA, 0xCF}) || // Mach-O 64-bit
		bytes.Equal(sniff[:4], []byte{0xCA, 0xFE, 0xBA, 0xBE})): // Mach-O universal / Java class (both blocked deliberately)
		return true
	case len(sniff) >= 2 && sniff[0] == '#' && sniff[1] == '!': // shebang script (sh, bash, python, ...)
		return true
	default:
		return false
	}
}

func (a *API) handleCallHistory(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	limit := 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	calls, err := a.db.ListCallsForUser(me.ID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load call history")
		return
	}
	writeJSON(w, http.StatusOK, calls)
}

// transferDeadline replaces the server-wide 60s read/write timeouts for the
// two routes that move whole files, which a slow VPN link can't finish in
// 60s. Every other route keeps the tight global timeouts.
const transferDeadline = 30 * time.Minute

// orphanFileAge is how long an unreferenced upload survives before
// CleanupOrphanFiles removes it — long enough for a message being composed.
const orphanFileAge = 24 * time.Hour

// CleanupOrphanFiles deletes uploads nothing references any more (never
// sent, or their message was deleted) so they stop filling the disk and
// counting against the uploader's quota. Run periodically from main.
func (a *API) CleanupOrphanFiles() {
	cutoff := time.Now().Add(-orphanFileAge).UTC().Format(time.RFC3339)
	paths, err := a.db.DeleteOrphanFiles(cutoff)
	if err != nil {
		a.log.Warn("cleanup orphan files", "err", err)
		return
	}
	for _, path := range paths {
		if !withinDirectory(a.cfg.DataDir, path) {
			continue
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			a.log.Warn("remove orphan file", "path", path, "err", err)
		}
	}
	if len(paths) > 0 {
		a.log.Info("removed orphan files", "count", len(paths))
	}
}

func (a *API) handleUpload(w http.ResponseWriter, r *http.Request) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(transferDeadline))
	me := auth.CurrentUser(r)
	sv := a.settings.Get()
	r.Body = http.MaxBytesReader(w, r.Body, sv.MaxFileBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("upload too large or malformed (max %d MB)", sv.MaxFileBytes/(1<<20)))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()

	// Held for the whole check-write-recheck sequence below so two uploads
	// from the same user can no longer race the quota check (see
	// uploadLocks' doc comment). Uploads from other users are unaffected.
	lock := lockForUpload(me.ID)
	lock.Lock()
	defer lock.Unlock()

	if sv.MaxUserStorageBytes > 0 {
		used, err := a.db.SumFileBytesForUploader(me.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not check storage usage")
			return
		}
		if used >= sv.MaxUserStorageBytes {
			writeErr(w, http.StatusInsufficientStorage, fmt.Sprintf("storage quota exceeded (max %d MB)", sv.MaxUserStorageBytes/(1<<20)))
			return
		}
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if len(ext) > 10 {
		ext = ""
	}
	if sv.BlockedFileExtensions[ext] {
		writeErr(w, http.StatusUnsupportedMediaType, fmt.Sprintf("files of type %q are not allowed", ext))
		return
	}
	name := filepath.Base(header.Filename)
	if name == "" || name == "." || name == "/" {
		name = "file" + ext
	}

	// Read first 512 bytes for content-type sniffing and the executable
	// magic-byte check below, then copy the rest.
	var sniffBuf [512]byte
	n, _ := io.ReadFull(file, sniffBuf[:])
	if len(sv.BlockedFileExtensions) > 0 && looksExecutable(sniffBuf[:n]) {
		// The block-list exists to stop exactly this kind of file; renaming
		// payload.exe to payload.txt must not be enough to slip past it.
		writeErr(w, http.StatusUnsupportedMediaType, "this file's content looks like an executable or script, which isn't allowed regardless of its extension")
		return
	}
	detectedMime := http.DetectContentType(sniffBuf[:n])

	// Stored name never trusts the client; original name is kept in the DB.
	storedName, err := randomHex(16)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not generate file name")
		return
	}
	storedPath := filepath.Join(a.cfg.DataDir, "files", storedName+ext)
	dst, err := os.Create(storedPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store file")
		return
	}
	written, err := io.Copy(dst, io.MultiReader(bytes.NewReader(sniffBuf[:n]), file))
	dst.Close()
	if err != nil {
		os.Remove(storedPath)
		writeErr(w, http.StatusInternalServerError, "could not write file")
		return
	}
	if sv.MaxUserStorageBytes > 0 {
		used, err := a.db.SumFileBytesForUploader(me.ID)
		if err == nil && used+written > sv.MaxUserStorageBytes {
			os.Remove(storedPath)
			writeErr(w, http.StatusInsufficientStorage, fmt.Sprintf("storage quota exceeded (max %d MB)", sv.MaxUserStorageBytes/(1<<20)))
			return
		}
	}
	// Client-supplied Content-Type is never used for storage; magic-byte
	// detection is the sole source of truth. This blocks inline serving of
	// script-disguised uploads.
	mime := detectedMime
	if mime == "" || !strings.Contains(mime, "/") {
		mime = "application/octet-stream"
	}
	f, err := a.db.InsertFile(me.ID, name, mime, written, storedPath)
	if err != nil {
		os.Remove(storedPath)
		writeErr(w, http.StatusInternalServerError, "could not record file")
		return
	}
	writeJSON(w, http.StatusCreated, f.FileBrief)
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (a *API) handleDownload(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid file id")
		return
	}
	f, err := a.db.GetFile(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	allowed, err := a.db.CanAccessFile(id, auth.CurrentUser(r).ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not authorize file")
		return
	}
	if !allowed {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	info, err := os.Stat(f.Path)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file missing from storage")
		return
	}
	disposition := "attachment"
	// Only safe raster images, video, and audio are allowed inline.
	// SVG (image/svg+xml), HTML, and PDF are forced to attachment to prevent Stored XSS.
	isSafeRasterImage := strings.HasPrefix(f.Mime, "image/") && f.Mime != "image/svg+xml"
	if isSafeRasterImage || strings.HasPrefix(f.Mime, "video/") || strings.HasPrefix(f.Mime, "audio/") {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", f.Mime)
	// Use the bytes that are actually on disk; the database is metadata and
	// may be stale if an operator replaced or recovered a file manually.
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"`, disposition, sanitizeHeaderName(f.Name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(transferDeadline))
	http.ServeFile(w, r, f.Path)
}

func sanitizeHeaderName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r < 32 || r > 126 {
			return '_'
		}
		return r
	}, name)
	return name
}

var lastRetentionRun time.Time

// PurgeOldMessages enforces MESSAGE_RETENTION_DAYS, at most once a day.
// Files they referenced become orphans and are removed by CleanupOrphanFiles.
func (a *API) PurgeOldMessages() {
	days := a.settings.Get().MessageRetentionDays
	if days <= 0 || time.Since(lastRetentionRun) < 23*time.Hour {
		return
	}
	lastRetentionRun = time.Now()
	cutoff := time.Now().AddDate(0, 0, -days).UTC().Format(time.RFC3339)
	n, err := a.db.PurgeMessagesBefore(cutoff)
	if err != nil {
		a.log.Warn("message retention purge", "err", err)
		return
	}
	if n > 0 {
		a.log.Info("message retention: purged old messages", "count", n, "older_than_days", days)
	}
}
