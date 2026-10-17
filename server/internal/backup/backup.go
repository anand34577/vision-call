// Package backup makes and restores backups of a Vision Call server that
// uses the built-in SQLite database.
//
// A full backup is a zip with the database, the uploaded files and the
// session signing key. The server also keeps a daily database-only snapshot
// in DATA_DIR/backups.
//
// Restoring never swaps files under a running server. The backup is checked
// and unpacked into DATA_DIR/restore-pending, the server restarts, and
// ApplyPending moves it into place before the database is opened. Whatever
// was there before is kept in DATA_DIR/pre-restore-<time>.
package backup

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"visioncall/internal/db"
)

const (
	dbName        = "visioncall.db"
	secretName    = "jwt_secret"
	manifestName  = "manifest.json"
	pendingDir    = "restore-pending"
	snapshotsDir  = "backups"
	snapshotKeep  = 7
	snapshotLabel = "visioncall-"
)

type manifest struct {
	App       string `json:"app"`
	Version   string `json:"version"`
	CreatedAt string `json:"created_at"`
}

// Snapshot is one automatic database backup in DATA_DIR/backups.
type Snapshot struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"created_at"`
}

// WriteFull streams a full backup zip to w.
func WriteFull(w io.Writer, d *db.DB, dataDir, version string) error {
	tmp, err := os.CreateTemp(dataDir, "backup-*.db")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	tmp.Close()
	os.Remove(tmpPath) // VACUUM INTO refuses to overwrite an existing file
	defer os.Remove(tmpPath)
	if err := d.Backup(tmpPath); err != nil {
		return err
	}

	zw := zip.NewWriter(w)
	m, _ := json.MarshalIndent(manifest{App: "visioncall", Version: version, CreatedAt: time.Now().UTC().Format(time.RFC3339)}, "", "  ")
	if err := addBytes(zw, manifestName, m); err != nil {
		return err
	}
	if err := addFile(zw, dbName, tmpPath); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dataDir, secretName)); err == nil {
		if err := addFile(zw, secretName, filepath.Join(dataDir, secretName)); err != nil {
			return err
		}
	}
	filesDir := filepath.Join(dataDir, "files")
	entries, err := os.ReadDir(filesDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if err := addFile(zw, "files/"+e.Name(), filepath.Join(filesDir, e.Name())); err != nil {
			return err
		}
	}
	return zw.Close()
}

// create adds a compressed entry stamped with the current time (zw.Create
// leaves the date at 1980).
func create(zw *zip.Writer, name string) (io.Writer, error) {
	return zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()})
}

func addBytes(zw *zip.Writer, name string, b []byte) error {
	w, err := create(zw, name)
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func addFile(zw *zip.Writer, name, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w, err := create(zw, name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}

// TakeSnapshot writes today's database snapshot (replacing one already made
// today) and keeps only the newest few.
func TakeSnapshot(d *db.DB, dataDir string) (Snapshot, error) {
	dir := filepath.Join(dataDir, snapshotsDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Snapshot{}, err
	}
	name := snapshotLabel + time.Now().Format("2006-01-02") + ".db"
	path := filepath.Join(dir, name)
	tmp := path + ".tmp"
	os.Remove(tmp)
	if err := d.Backup(tmp); err != nil {
		os.Remove(tmp)
		return Snapshot{}, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return Snapshot{}, err
	}
	prune(dir)
	info, err := os.Stat(path)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{Name: name, Size: info.Size(), CreatedAt: info.ModTime().UTC().Format(time.RFC3339)}, nil
}

func prune(dir string) {
	list, _ := ListSnapshots(filepath.Dir(dir))
	for i, s := range list {
		if i >= snapshotKeep {
			os.Remove(filepath.Join(dir, s.Name))
		}
	}
}

// ListSnapshots returns the automatic snapshots, newest first.
func ListSnapshots(dataDir string) ([]Snapshot, error) {
	entries, err := os.ReadDir(filepath.Join(dataDir, snapshotsDir))
	if errors.Is(err, os.ErrNotExist) {
		return []Snapshot{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Snapshot{}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, snapshotLabel) || !strings.HasSuffix(n, ".db") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Snapshot{Name: n, Size: info.Size(), CreatedAt: info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out, nil
}

// SnapshotPath returns the path of a snapshot by name, refusing anything
// that isn't a plain snapshot file name.
func SnapshotPath(dataDir, name string) (string, error) {
	if name != filepath.Base(name) || !strings.HasPrefix(name, snapshotLabel) || !strings.HasSuffix(name, ".db") {
		return "", fmt.Errorf("invalid backup name")
	}
	path := filepath.Join(dataDir, snapshotsDir, name)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("backup not found")
	}
	return path, nil
}

// StageDatabase checks a SQLite database file and stages it to replace the
// current database on the next start. Uploaded files are left as they are.
func StageDatabase(dataDir, dbPath string) error {
	staging, err := freshStaging(dataDir)
	if err != nil {
		return err
	}
	if err := copyFile(dbPath, filepath.Join(staging, dbName)); err != nil {
		return err
	}
	return checkStaged(staging)
}

// StageZip checks a full backup zip and stages it for the next start.
func StageZip(dataDir, zipPath string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("not a Vision Call backup: %w", err)
	}
	defer zr.Close()
	staging, err := freshStaging(dataDir)
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := f.Name
		// Only the entries a backup can contain, and never a path that
		// escapes the staging folder.
		switch {
		case name == dbName, name == secretName, name == manifestName:
		case strings.HasPrefix(name, "files/") && !f.FileInfo().IsDir() &&
			filepath.Base(name) == strings.TrimPrefix(name, "files/") && !strings.Contains(name, ".."):
		default:
			continue
		}
		dest := filepath.Join(staging, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := extract(f, dest); err != nil {
			return err
		}
	}
	return checkStaged(staging)
}

func extract(f *zip.File, dest string) error {
	src, err := f.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// Bound decompressed size so a zip bomb can't fill the disk.
	n, err := io.Copy(out, io.LimitReader(src, maxEntryBytes+1))
	if err == nil && n > maxEntryBytes {
		err = fmt.Errorf("backup entry %s is too large", f.Name)
	}
	if err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

const maxEntryBytes = 32 << 30

func freshStaging(dataDir string) (string, error) {
	staging := filepath.Join(dataDir, pendingDir)
	if err := os.RemoveAll(staging); err != nil {
		return "", err
	}
	return staging, os.MkdirAll(staging, 0o755)
}

// checkStaged opens the staged database (which also upgrades an older
// backup to the current schema) and makes sure it has an admin to sign in
// with. A bad backup is removed, so nothing happens on restart.
func checkStaged(staging string) error {
	path := filepath.Join(staging, dbName)
	fail := func(err error) error {
		os.RemoveAll(staging)
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fail(fmt.Errorf("the backup has no database in it"))
	}
	d, err := db.Open("sqlite", path)
	if err != nil {
		return fail(fmt.Errorf("the backup's database can't be opened: %w", err))
	}
	admins, err := d.CountEnabledAdmins()
	d.Close()
	if err != nil {
		return fail(fmt.Errorf("the backup's database can't be read: %w", err))
	}
	if admins == 0 {
		return fail(fmt.Errorf("the backup has no active admin account, so nobody could sign in after restoring it"))
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		os.Remove(path + suffix)
	}
	return nil
}

// HasPending reports whether a restore is waiting for the next start.
func HasPending(dataDir string) bool {
	_, err := os.Stat(filepath.Join(dataDir, pendingDir, dbName))
	return err == nil
}

// ApplyPending moves a staged restore into place. Call it before opening the
// database. It returns true when a restore was applied, in which case the
// caller should run RebaseFilePaths once the database is open.
func ApplyPending(dataDir string) (bool, error) {
	staging := filepath.Join(dataDir, pendingDir)
	if !HasPending(dataDir) {
		return false, nil
	}
	keep := filepath.Join(dataDir, "pre-restore-"+time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(keep, 0o755); err != nil {
		return false, err
	}
	// Everything moved aside is recorded so a failure part-way can put the
	// original data back instead of leaving the server with an empty database.
	type move struct{ from, to string }
	var done []move
	rollback := func() {
		for i := len(done) - 1; i >= 0; i-- {
			_ = os.Rename(done[i].to, done[i].from)
		}
	}
	aside := func(from, to string) bool {
		if _, err := os.Stat(from); err != nil {
			return true
		}
		if err := os.Rename(from, to); err != nil {
			return false
		}
		done = append(done, move{from, to})
		return true
	}
	for _, name := range []string{dbName, dbName + "-wal", dbName + "-shm", secretName} {
		if !aside(filepath.Join(dataDir, name), filepath.Join(keep, name)) {
			rollback()
			return false, fmt.Errorf("could not set aside %s", name)
		}
	}
	stagedFiles := filepath.Join(staging, "files")
	_, zipHadFiles := os.Stat(stagedFiles)
	if zipHadFiles == nil {
		if !aside(filepath.Join(dataDir, "files"), filepath.Join(keep, "files")) {
			rollback()
			return false, fmt.Errorf("could not set aside the files folder")
		}
	}
	// Move the backup in.
	if err := os.Rename(filepath.Join(staging, dbName), filepath.Join(dataDir, dbName)); err != nil {
		rollback()
		return false, err
	}
	if _, err := os.Stat(filepath.Join(staging, secretName)); err == nil {
		if err := os.Rename(filepath.Join(staging, secretName), filepath.Join(dataDir, secretName)); err != nil {
			_ = os.Rename(filepath.Join(dataDir, dbName), filepath.Join(staging, dbName))
			rollback()
			return false, err
		}
	}
	if zipHadFiles == nil {
		if err := os.Rename(stagedFiles, filepath.Join(dataDir, "files")); err != nil {
			rollback()
			return false, err
		}
	}
	os.RemoveAll(staging)
	return true, nil
}

func moveIfExists(from, to string) {
	if _, err := os.Stat(from); err == nil {
		_ = os.Rename(from, to)
	}
}

func copyFile(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

// PrunePreRestore removes pre-restore-* folders older than maxAge. They hold a
// full copy of the replaced data, so keeping them forever grows the disk and
// retains data an admin may believe is gone.
func PrunePreRestore(dataDir string, maxAge time.Duration) {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "pre-restore-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > maxAge {
			_ = os.RemoveAll(filepath.Join(dataDir, e.Name()))
		}
	}
}
