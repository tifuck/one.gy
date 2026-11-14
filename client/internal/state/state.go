// Package state owns the engine's SQLite database (plan 7.1): connection
// pragmas, the numbered schema migrations and small typed accessors.
package state

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"runtime"

	_ "modernc.org/sqlite"
)

// DB is the engine state database.
type DB struct{ *sql.DB }

// Open opens (creating if needed) the database and applies pending migrations.
func Open(path string) (*DB, error) {
	// Create it private first; SQLite gives -wal/-shm the same mode.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err := os.Chmod(path, 0o600); err != nil && runtime.GOOS != "windows" {
		return nil, err
	}
	q := url.Values{}
	for _, p := range []string{"journal_mode(WAL)", "synchronous(FULL)", "foreign_keys(1)", "busy_timeout(10000)"} {
		q.Add("_pragma", p)
	}
	db, err := sql.Open("sqlite", "file:"+(&url.URL{Path: path}).EscapedPath()+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// ponytail: one connection serialises all access (no SQLITE_BUSY between
	// our own goroutines); add a read pool if queries ever queue behind writes.
	db.SetMaxOpenConns(1)
	s := &DB{db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// migrations are applied in order; PRAGMA user_version records how many ran.
// Append only: never edit or reorder a shipped entry.
var migrations = []string{
	// 1: initial schema (plan 7.1)
	`CREATE TABLE account (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		server_url TEXT NOT NULL,
		user_id INTEGER NOT NULL DEFAULT 0,
		username TEXT NOT NULL,
		device_id TEXT NOT NULL DEFAULT '',
		device_name TEXT NOT NULL DEFAULT '',
		signed_in INTEGER NOT NULL DEFAULT 0,
		remote_cursor INTEGER,
		key_check TEXT NOT NULL DEFAULT '',
		auth_salt TEXT NOT NULL DEFAULT '',
		sealed_secrets TEXT NOT NULL DEFAULT '',
		sealed_nonce TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE sync (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		local_root TEXT NOT NULL,
		remote_root_id INTEGER,
		remote_path TEXT NOT NULL DEFAULT '',
		type TEXT NOT NULL,
		encryption TEXT NOT NULL,
		config_json TEXT NOT NULL DEFAULT '{}',
		fs_kind TEXT NOT NULL DEFAULT '',
		case_sensitive INTEGER NOT NULL DEFAULT 1,
		state TEXT NOT NULL DEFAULT 'scanning',
		paused INTEGER NOT NULL DEFAULT 0,
		last_synced_at TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	);
	` + remoteNodeDDL("remote_node") + `
	CREATE INDEX remote_node_parent ON remote_node (parent_id);
	` + remoteNodeDDL("remote_node_snapshot") + `
	CREATE TABLE synced (
		sync_id TEXT NOT NULL REFERENCES sync(id) ON DELETE CASCADE,
		rel_path TEXT NOT NULL,
		kind TEXT NOT NULL,
		remote_id TEXT NOT NULL DEFAULT '',
		local_fid TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		mtime_ns INTEGER NOT NULL DEFAULT 0,
		plain_sha256 TEXT NOT NULL DEFAULT '',
		remote_content_version INTEGER NOT NULL DEFAULT 0,
		remote_change_seq INTEGER NOT NULL DEFAULT 0,
		mode INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (sync_id, rel_path)
	);
	CREATE TABLE local_cache (
		sync_id TEXT NOT NULL REFERENCES sync(id) ON DELETE CASCADE,
		rel_path TEXT NOT NULL,
		local_fid TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		mtime_ns INTEGER NOT NULL DEFAULT 0,
		ctime_ns INTEGER NOT NULL DEFAULT 0,
		plain_sha256 TEXT NOT NULL DEFAULT '',
		hashed_at TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (sync_id, rel_path)
	);
	CREATE TABLE op (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sync_id TEXT REFERENCES sync(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		rel_path TEXT NOT NULL DEFAULT '',
		remote_id TEXT NOT NULL DEFAULT '',
		pre_json TEXT NOT NULL DEFAULT '{}',
		state TEXT NOT NULL DEFAULT 'planned',
		attempt INTEGER NOT NULL DEFAULT 0,
		next_at TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		spool_dir TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX op_state ON op (state, next_at);
	CREATE TABLE upload_session (
		op_id INTEGER PRIMARY KEY REFERENCES op(id) ON DELETE CASCADE,
		server_session_id TEXT NOT NULL DEFAULT '',
		wrapped_file_key TEXT NOT NULL DEFAULT '',
		base_nonce TEXT NOT NULL DEFAULT '',
		chunk_count INTEGER NOT NULL DEFAULT 0,
		parts_done TEXT NOT NULL DEFAULT '[]',
		source_fid TEXT NOT NULL DEFAULT '',
		source_size INTEGER NOT NULL DEFAULT 0,
		source_mtime_ns INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE issue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sync_id TEXT REFERENCES sync(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		rel_path TEXT NOT NULL DEFAULT '',
		detail_json TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		resolved_at TEXT
	);
	CREATE TABLE transfer_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sync_id TEXT,
		direction TEXT NOT NULL,
		rel_path TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		state TEXT NOT NULL,
		error TEXT NOT NULL DEFAULT '',
		manual INTEGER NOT NULL DEFAULT 0,
		started_at TEXT NOT NULL DEFAULT '',
		finished_at TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE debris (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sync_id TEXT REFERENCES sync(id) ON DELETE CASCADE,
		rel_path TEXT NOT NULL,
		debris_path TEXT NOT NULL,
		reason TEXT NOT NULL DEFAULT '',
		at TEXT NOT NULL
	);
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`,
	// 2: the one.gy name an item was synced under, so a local name that
	// differs (escaped, clash suffix, NFD bytes) keeps its mapping.
	`ALTER TABLE synced ADD COLUMN remote_name TEXT NOT NULL DEFAULT '';`,
	// 3: journal finish time (activity), plaintext hashes verified by
	// downloading (files without encrypted meta), open-issue lookups.
	`ALTER TABLE op ADD COLUMN finished_at TEXT NOT NULL DEFAULT '';
	CREATE TABLE remote_hash (
		file_id TEXT PRIMARY KEY,
		payload_checksum TEXT NOT NULL,
		plain_sha256 TEXT NOT NULL
	);
	CREATE INDEX issue_open ON issue (sync_id, resolved_at);`,
	// 4: the master key sealed under the server share + a local key (+ the
	// PIN key when at_rest_pin), see account.atRestKey.
	`ALTER TABLE account ADD COLUMN at_rest_sealed TEXT NOT NULL DEFAULT '';
	ALTER TABLE account ADD COLUMN at_rest_nonce TEXT NOT NULL DEFAULT '';
	ALTER TABLE account ADD COLUMN at_rest_pin INTEGER NOT NULL DEFAULT 0;`,
	// 5: the key tree (sync-api.md "Key tree"): wraps on cached nodes (same
	// column order in both node tables: SwapSnapshot copies with SELECT *),
	// the master key sealed under the second server share, and the pool of
	// pre-wrapped keys a locked engine uses for new files and folders.
	`ALTER TABLE remote_node ADD COLUMN tree_wrap TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node ADD COLUMN tree_nonce TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node ADD COLUMN tree_parent INTEGER;
	ALTER TABLE remote_node ADD COLUMN tree_name_wrap TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node ADD COLUMN tree_name_nonce TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node_snapshot ADD COLUMN tree_wrap TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node_snapshot ADD COLUMN tree_nonce TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node_snapshot ADD COLUMN tree_parent INTEGER;
	ALTER TABLE remote_node_snapshot ADD COLUMN tree_name_wrap TEXT NOT NULL DEFAULT '';
	ALTER TABLE remote_node_snapshot ADD COLUMN tree_name_nonce TEXT NOT NULL DEFAULT '';
	ALTER TABLE account ADD COLUMN at_rest_master TEXT NOT NULL DEFAULT '';
	ALTER TABLE account ADD COLUMN at_rest_master_nonce TEXT NOT NULL DEFAULT '';
	CREATE TABLE key_pool (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sealed_key TEXT NOT NULL,
		sealed_nonce TEXT NOT NULL,
		master_wrap TEXT NOT NULL,
		master_nonce TEXT NOT NULL
	);`,
	// 6: whether a synced file was end-to-end encrypted, taken from the
	// cached nodes for rows synced before.
	`ALTER TABLE synced ADD COLUMN e2ee INTEGER NOT NULL DEFAULT 0;
	UPDATE synced SET e2ee = 1 WHERE kind = 'file' AND remote_id IN (SELECT id FROM remote_node WHERE kind = 'file' AND is_e2e = 1);`,
}

// remoteNodeDDL is part of migration 1 (live table + snapshot staging table).
// Frozen: later column changes go in a new migration, not here.
func remoteNodeDDL(table string) string {
	return fmt.Sprintf(`CREATE TABLE %s (
		kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
		id TEXT NOT NULL,
		parent_id INTEGER,
		seq INTEGER NOT NULL DEFAULT 0,
		is_trashed INTEGER NOT NULL DEFAULT 0,
		is_e2e INTEGER NOT NULL DEFAULT 0,
		name TEXT NOT NULL DEFAULT '',
		encrypted_name TEXT NOT NULL DEFAULT '',
		name_nonce TEXT NOT NULL DEFAULT '',
		encrypted_key TEXT NOT NULL DEFAULT '',
		key_nonce TEXT NOT NULL DEFAULT '',
		stored_extension TEXT NOT NULL DEFAULT '',
		cipher_size INTEGER NOT NULL DEFAULT 0,
		plain_size INTEGER NOT NULL DEFAULT 0,
		payload_checksum TEXT NOT NULL DEFAULT '',
		content_version INTEGER NOT NULL DEFAULT 0,
		encrypted_meta TEXT NOT NULL DEFAULT '',
		meta_nonce TEXT NOT NULL DEFAULT '',
		plain_sha256 TEXT,
		mtime_ns INTEGER,
		mode INTEGER,
		is_backup INTEGER NOT NULL DEFAULT 0,
		backup_device_id TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (kind, id)
	);`, table)
}

func (s *DB) migrate() error {
	var have int
	if err := s.QueryRow(`PRAGMA user_version`).Scan(&have); err != nil {
		return err
	}
	if have > len(migrations) {
		return fmt.Errorf("state DB schema %d is newer than this engine (%d)", have, len(migrations))
	}
	for i := have; i < len(migrations); i++ {
		err := s.Tx(context.Background(), func(tx *sql.Tx) error {
			if _, err := tx.Exec(migrations[i]); err != nil {
				return err
			}
			_, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("state migration %d: %w", i+1, err)
		}
	}
	return nil
}

// Tx runs fn in a transaction, committing only if it returns nil.
func (s *DB) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}
