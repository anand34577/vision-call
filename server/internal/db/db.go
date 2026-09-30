package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*/*.sql
var migrationFS embed.FS

// Dialect names the SQL engine a DB is talking to. SQLite is the zero value
// and the default: it needs no setup, so it's what the app falls back to
// whenever DATABASE_URL isn't set.
type Dialect string

const (
	DialectSQLite   Dialect = "sqlite"
	DialectPostgres Dialect = "postgres"
	DialectMySQL    Dialect = "mysql"
)

type DB struct {
	*sql.DB
	dialect Dialect
}

func (d *DB) Dialect() Dialect { return d.dialect }

// Open connects to the configured database. driver is "sqlite" (default),
// "postgres", or "mysql". dsn is a plain filesystem path (or ":memory:") for
// sqlite, and a driver-native connection string for the others.
func Open(driver, dsn string) (*DB, error) {
	dialect := Dialect(driver)
	var sqldb *sql.DB
	var err error

	switch dialect {
	case DialectPostgres:
		sqldb, err = sql.Open("postgres", dsn)
	case DialectMySQL:
		sqldb, err = sql.Open("mysql", dsn)
	default:
		dialect = DialectSQLite
		path := "file:" + filepath.ToSlash(dsn) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
		sqldb, err = sql.Open("sqlite", path)
	}
	if err != nil {
		return nil, err
	}

	switch dialect {
	case DialectSQLite:
		if dsn == ":memory:" {
			// A pooled connection would each get its own private, empty
			// in-memory database (no shared cache configured) — keep this to
			// one connection. Only tests use ":memory:".
			sqldb.SetMaxOpenConns(1)
		} else {
			// WAL mode (enabled above) lets readers run concurrently with a
			// single writer; SQLite itself serializes writes and
			// busy_timeout retries them, so a small pool mainly buys
			// concurrent reads. Small, fixed pool: this app targets a
			// handful of concurrent users, not a number worth making
			// tunable yet.
			sqldb.SetMaxOpenConns(4)
			sqldb.SetMaxIdleConns(4)
		}
	default:
		// Note: fixed pool for postgres/mysql too; add a config knob if
		// a real deployment's connection count needs tuning.
		sqldb.SetMaxOpenConns(20)
		sqldb.SetMaxIdleConns(10)
	}

	d := &DB{DB: sqldb, dialect: dialect}
	if err := sqldb.Ping(); err != nil {
		_ = sqldb.Close()
		return nil, fmt.Errorf("connect (%s): %w", dialect, err)
	}
	if err := d.migrate(); err != nil {
		_ = sqldb.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

func (d *DB) migrate() error {
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(191) PRIMARY KEY, applied_at VARCHAR(64) NOT NULL)`); err != nil {
		return err
	}
	dir := "migrations/" + string(d.dialect)
	entries, err := fs.Glob(migrationFS, dir+"/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)
	for _, name := range entries {
		version := filepath.Base(name)
		var count int
		if err := d.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			continue
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := d.Begin()
		if err != nil {
			return err
		}
		for _, stmt := range splitStatements(string(body)) {
			if _, err := tx.Exec(stmt); err != nil {
				tx.Rollback()
				return fmt.Errorf("%s: %w", version, err)
			}
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, time.Now().UTC().Format(time.RFC3339)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// splitStatements breaks a migration file into individual statements on ';'
// at end of line. mysql's driver (unlike sqlite/postgres) can't run a
// multi-statement string through a single Exec, so migrations run one
// statement at a time everywhere for consistency.
//
// Comment lines are stripped before splitting: a `-- ...;` comment whose
// text itself ends in a semicolon right before the newline would otherwise
// split off as its own "statement" containing only a comment, which mysql
// rejects with ER_EMPTY_QUERY.
func splitStatements(body string) []string {
	var sql strings.Builder
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		sql.WriteString(line)
		sql.WriteByte('\n')
	}
	var out []string
	for _, raw := range strings.Split(sql.String(), ";\n") {
		s := strings.TrimSpace(raw)
		s = strings.TrimSuffix(s, ";")
		if s == "" {
			continue
		}
		out = append(out, s)
	}
	return out
}

// ---- placeholder rebinding + LastInsertId emulation for Postgres ----
//
// The app's queries are all written with '?' placeholders (sqlite and mysql
// both accept that natively). Postgres needs '$1, $2, ...' instead, and its
// driver doesn't populate sql.Result.LastInsertId() the way sqlite/mysql do
// — so for postgres we rebind '?' and, for the handful of tables the app
// calls LastInsertId() on, rewrite the INSERT into an INSERT ... RETURNING
// id and fake up the Result.

var insertTableRE = regexp.MustCompile(`(?i)^\s*INSERT\s+INTO\s+(\w+)`)

// pgReturningIDTables are the tables db.go's callers use res.LastInsertId()
// on after an INSERT — the only ones that need the RETURNING id rewrite.
var pgReturningIDTables = map[string]bool{
	"users": true, "files": true, "groups": true, "calls": true, "messages": true, "polls": true, "poll_options": true,
}

// mysqlGroupsRE finds the "groups" table name, which is a reserved word in
// MySQL 8 and must be backquoted there (sqlite/postgres accept it bare).
var mysqlGroupsRE = regexp.MustCompile(`(?i)\b(FROM|INTO|UPDATE|JOIN)\s+groups\b`)

func rebind(dialect Dialect, query string) string {
	if dialect == DialectMySQL {
		return mysqlGroupsRE.ReplaceAllString(query, "$1 `groups`")
	}
	if dialect != DialectPostgres || !strings.Contains(query, "?") {
		return query
	}
	var b strings.Builder
	n := 0
	inQuote := false
	chars := []rune(query)
	for i := 0; i < len(chars); i++ {
		r := chars[i]
		if r == '\'' {
			// Check for escaped single quote '' inside quotes
			if inQuote && i+1 < len(chars) && chars[i+1] == '\'' {
				b.WriteRune('\'')
				b.WriteRune('\'')
				i++
				continue
			}
			inQuote = !inQuote
			b.WriteRune('\'')
		} else if r == '?' && !inQuote {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

type insertResult struct{ id int64 }

func (r insertResult) LastInsertId() (int64, error) { return r.id, nil }
func (r insertResult) RowsAffected() (int64, error) { return 1, nil }

type queryRower interface {
	QueryRow(query string, args ...any) *sql.Row
}

func pgExec(x interface {
	queryRower
	Exec(query string, args ...any) (sql.Result, error)
}, dialect Dialect, query string, args ...any) (sql.Result, error) {
	if dialect == DialectPostgres {
		if m := insertTableRE.FindStringSubmatch(query); m != nil && pgReturningIDTables[strings.ToLower(m[1])] && !strings.Contains(strings.ToUpper(query), "RETURNING") {
			var id int64
			if err := x.QueryRow(rebind(dialect, query)+" RETURNING id", args...).Scan(&id); err != nil {
				return nil, err
			}
			return insertResult{id}, nil
		}
	}
	return x.Exec(rebind(dialect, query), args...)
}

// Exec/Query/QueryRow/Begin shadow the promoted *sql.DB methods so every
// existing call site (all written with '?' placeholders) works unmodified
// against any dialect.

func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return pgExec(d.DB, d.dialect, query, args...)
}

func (d *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.DB.Query(rebind(d.dialect, query), args...)
}

func (d *DB) QueryRow(query string, args ...any) *sql.Row {
	return d.DB.QueryRow(rebind(d.dialect, query), args...)
}

func (d *DB) Begin() (*Tx, error) {
	tx, err := d.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &Tx{Tx: tx, dialect: d.dialect}, nil
}

type Tx struct {
	*sql.Tx
	dialect Dialect
}

func (t *Tx) Exec(query string, args ...any) (sql.Result, error) {
	return pgExec(t.Tx, t.dialect, query, args...)
}

func (t *Tx) Query(query string, args ...any) (*sql.Rows, error) {
	return t.Tx.Query(rebind(t.dialect, query), args...)
}

func (t *Tx) QueryRow(query string, args ...any) *sql.Row {
	return t.Tx.QueryRow(rebind(t.dialect, query), args...)
}

// insertIgnoreSQL builds a dialect-appropriate "insert, skip if the row
// already exists" statement. cols is "table (a, b, c)", values is the
// matching "?, ?, ?", conflictCols is the unique/PK columns the conflict is
// keyed on (unused by mysql, which infers it from the key that clashed).
func insertIgnoreSQL(dialect Dialect, cols, values, conflictCols string) string {
	switch dialect {
	case DialectMySQL:
		return `INSERT IGNORE INTO ` + cols + ` VALUES (` + values + `)`
	default: // sqlite, postgres
		return `INSERT INTO ` + cols + ` VALUES (` + values + `) ON CONFLICT (` + conflictCols + `) DO NOTHING`
	}
}

// Backup writes a consistent point-in-time copy of the database to destPath
// using SQLite's VACUUM INTO (also compacts the copy — smaller than a raw
// file copy of a WAL-mode db, and safe to run while the server is live).
// Only sqlite is supported here: Postgres/MySQL already have standard tools
// for this (pg_dump/mysqldump) that do it better than we could reinvent.
func (d *DB) Backup(destPath string) error {
	if d.dialect != DialectSQLite {
		return fmt.Errorf("backup is only supported for the built-in sqlite database (current: %s); use pg_dump or mysqldump instead", d.dialect)
	}
	// VACUUM INTO takes the destination as a SQL string literal, not a bind
	// parameter — quote it by escaping embedded single quotes.
	escaped := strings.ReplaceAll(filepath.ToSlash(destPath), "'", "''")
	_, err := d.DB.Exec(fmt.Sprintf("VACUUM INTO '%s'", escaped))
	return err
}

// isUniqueViolation recognizes a unique-constraint error across all three
// dialects: SQLite/Postgres say "unique", MySQL says "duplicate entry" —
// neither driver gives a single portable error type for this, so this is
// substring matching by necessity.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate")
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func sqlNullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func nullStringPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}
