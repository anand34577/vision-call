package api

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/backup"
	"visioncall/internal/config"
	"visioncall/internal/db"
)

// SetRestart gives the API a way to restart the server, used after a
// restore has been staged (it is applied while the server starts up).
func (a *API) SetRestart(fn func()) { a.restart = fn }

// maxRestoreBytes bounds an uploaded restore file.
const maxRestoreBytes = 16 << 30

func (a *API) backupsSupported(w http.ResponseWriter) bool {
	if a.db.Dialect() != db.DialectSQLite {
		writeErr(w, http.StatusBadRequest, "backups here only cover the built-in database; use pg_dump or mysqldump for Postgres or MySQL")
		return false
	}
	return true
}

func (a *API) handleListBackups(w http.ResponseWriter, r *http.Request) {
	if a.db.Dialect() != db.DialectSQLite {
		writeJSON(w, http.StatusOK, map[string]any{
			"supported": false,
			"reason":    "This server uses " + string(a.db.Dialect()) + ". Back it up with that database's own tools (pg_dump or mysqldump), plus the files folder.",
			"snapshots": []backup.Snapshot{},
		})
		return
	}
	list, err := backup.ListSnapshots(a.cfg.DataDir)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list backups")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"supported": true, "snapshots": list})
}

func (a *API) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.backupsSupported(w) {
		return
	}
	s, err := backup.TakeSnapshot(a.db, a.cfg.DataDir)
	if err != nil {
		if a.log != nil {
			a.log.Error("snapshot failed", "err", err)
		}
		writeErr(w, http.StatusInternalServerError, "could not create backup")
		return
	}
	a.audit(r, "backup_create", "backup", nil, s.Name)
	writeJSON(w, http.StatusOK, s)
}

func (a *API) handleDownloadSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.backupsSupported(w) {
		return
	}
	path, err := backup.SnapshotPath(a.cfg.DataDir, chi.URLParam(r, "name"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(transferDeadline))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(path)))
	http.ServeFile(w, r, path)
}

// handleDownloadFull streams a zip with the database, uploads and session key.
func (a *API) handleDownloadFull(w http.ResponseWriter, r *http.Request) {
	if !a.backupsSupported(w) {
		return
	}
	name := "visioncall-backup-" + time.Now().Format("2006-01-02-1504") + ".zip"
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(transferDeadline))
	// Build the zip on disk first: a failure then becomes a clean 500 instead
	// of a truncated archive behind an already-sent 200.
	tmp, err := os.CreateTemp(a.cfg.DataDir, "backup-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create backup")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := backup.WriteFull(tmp, a.db, a.cfg.DataDir, config.Version); err != nil {
		if a.log != nil {
			a.log.Error("full backup failed", "err", err)
		}
		writeErr(w, http.StatusInternalServerError, "could not create backup")
		return
	}
	a.audit(r, "backup_download", "backup", nil, name)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	http.ServeContent(w, r, name, time.Now(), tmp)
}

func (a *API) handleRestoreSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.backupsSupported(w) {
		return
	}
	a.restoreMu.Lock()
	defer a.restoreMu.Unlock()
	path, err := backup.SnapshotPath(a.cfg.DataDir, chi.URLParam(r, "name"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	if err := backup.StageDatabase(a.cfg.DataDir, path); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.finishRestore(w, r, filepath.Base(path))
}

// handleRestoreUpload accepts a full backup (.zip) or a database file (.db).
func (a *API) handleRestoreUpload(w http.ResponseWriter, r *http.Request) {
	if !a.backupsSupported(w) {
		return
	}
	a.restoreMu.Lock()
	defer a.restoreMu.Unlock()
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(transferDeadline))
	r.Body = http.MaxBytesReader(w, r.Body, maxRestoreBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "upload a backup file")
		return
	}
	part, err := mr.NextPart()
	if err != nil || part.FormName() != "file" {
		writeErr(w, http.StatusBadRequest, "upload a backup file")
		return
	}
	name := strings.ToLower(part.FileName())
	if !strings.HasSuffix(name, ".zip") && !strings.HasSuffix(name, ".db") {
		writeErr(w, http.StatusBadRequest, "choose a .zip backup or a .db database file")
		return
	}
	// Written to the data folder rather than /tmp, which is often small.
	tmp, err := os.CreateTemp(a.cfg.DataDir, "restore-upload-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the upload")
		return
	}
	defer os.Remove(tmp.Name())
	_, copyErr := io.Copy(tmp, part)
	tmp.Close()
	if copyErr != nil {
		writeErr(w, http.StatusBadRequest, "the upload was interrupted")
		return
	}
	if strings.HasSuffix(name, ".zip") {
		err = backup.StageZip(a.cfg.DataDir, tmp.Name())
	} else {
		err = backup.StageDatabase(a.cfg.DataDir, tmp.Name())
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.finishRestore(w, r, part.FileName())
}

func (a *API) finishRestore(w http.ResponseWriter, r *http.Request, from string) {
	a.audit(r, "backup_restore", "backup", nil, from)
	canRestart := a.restart != nil
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restarting": canRestart})
	if canRestart {
		go func() {
			time.Sleep(time.Second) // let the response reach the browser first
			a.restart()
		}()
	}
}
