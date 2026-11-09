package state

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// RemoteNode is one cached server node (sync-api.md "Node shapes"). For
// folders EncryptedKey/KeyNonce hold the wrapped name key, for files the
// wrapped file key. Names stay encrypted on disk; they are decrypted on use.
type RemoteNode struct {
	Kind            string // "folder" | "file"
	ID              string // folder ids in decimal, file ids as UUID
	ParentID        *int64 // nil = drive root
	Seq             int64
	IsTrashed       bool
	IsE2E           bool
	Name            string
	EncryptedName   string
	NameNonce       string
	EncryptedKey    string
	KeyNonce        string
	StoredExtension string
	CipherSize      int64
	PlainSize       int64
	PayloadChecksum string
	ContentVersion  int64
	EncryptedMeta   string
	MetaNonce       string
	IsBackup        bool
	BackupDeviceID  string
	UpdatedAt       string
}

const nodeCols = `kind, id, parent_id, seq, is_trashed, is_e2e, name, encrypted_name, name_nonce, encrypted_key, key_nonce,
	stored_extension, cipher_size, plain_size, payload_checksum, content_version, encrypted_meta, meta_nonce,
	is_backup, backup_device_id, updated_at`

func scanNode(row interface{ Scan(...any) error }) (*RemoteNode, error) {
	var n RemoteNode
	var parent sql.NullInt64
	err := row.Scan(&n.Kind, &n.ID, &parent, &n.Seq, &n.IsTrashed, &n.IsE2E, &n.Name, &n.EncryptedName, &n.NameNonce,
		&n.EncryptedKey, &n.KeyNonce, &n.StoredExtension, &n.CipherSize, &n.PlainSize, &n.PayloadChecksum,
		&n.ContentVersion, &n.EncryptedMeta, &n.MetaNonce, &n.IsBackup, &n.BackupDeviceID, &n.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if parent.Valid {
		n.ParentID = &parent.Int64
	}
	return &n, nil
}

// nodeUpdate refreshes every column of an existing row, but never with an
// older seq: a mutation response the executor stored must not be undone by a
// change-feed page fetched before it.
var nodeUpdate = func() string {
	s := ` ON CONFLICT(kind, id) DO UPDATE SET plain_sha256 = NULL, mtime_ns = NULL, mode = NULL`
	for _, c := range strings.Split(nodeCols, ",") {
		if c = strings.TrimSpace(c); c != "kind" && c != "id" {
			s += ", " + c + " = excluded." + c
		}
	}
	return s + ` WHERE excluded.seq >= seq`
}()

// UpsertNode writes n into table (remote_node or remote_node_snapshot).
// plain_sha256/mtime_ns/mode are reset: they are re-derived from the meta.
func UpsertNode(tx *sql.Tx, table string, n *RemoteNode) error {
	if table != "remote_node" && table != "remote_node_snapshot" {
		return errors.New("bad node table")
	}
	_, err := tx.Exec(`INSERT INTO `+table+` (`+nodeCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`+nodeUpdate,
		n.Kind, n.ID, n.ParentID, n.Seq, n.IsTrashed, n.IsE2E, n.Name, n.EncryptedName, n.NameNonce, n.EncryptedKey,
		n.KeyNonce, n.StoredExtension, n.CipherSize, n.PlainSize, n.PayloadChecksum, n.ContentVersion,
		n.EncryptedMeta, n.MetaNonce, n.IsBackup, n.BackupDeviceID, n.UpdatedAt)
	return err
}

// DeleteNode removes a hard-deleted node (tombstone).
func DeleteNode(tx *sql.Tx, kind, id string) error {
	_, err := tx.Exec(`DELETE FROM remote_node WHERE kind = ? AND id = ?`, kind, id)
	return err
}

// GetNode returns nil, nil when the node is not cached.
func (s *DB) GetNode(ctx context.Context, kind, id string) (*RemoteNode, error) {
	n, err := scanNode(s.QueryRowContext(ctx, `SELECT `+nodeCols+` FROM remote_node WHERE kind = ? AND id = ?`, kind, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return n, err
}

// Children lists the non-trashed folders and files directly under parent
// (nil = drive root), folders first.
func (s *DB) Children(ctx context.Context, parent *int64) ([]*RemoteNode, error) {
	q := `SELECT ` + nodeCols + ` FROM remote_node WHERE is_trashed = 0 AND parent_id IS ? ORDER BY kind DESC, id`
	rows, err := s.QueryContext(ctx, q, parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RemoteNode
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// SubtreeTotals counts non-trashed files and plaintext bytes under a folder
// (nil = whole drive), skipping trashed folders and everything below them.
func (s *DB) SubtreeTotals(ctx context.Context, root *int64) (files, bytes int64, err error) {
	q := `WITH RECURSIVE f(id) AS (
		SELECT CAST(id AS INTEGER) FROM remote_node WHERE kind = 'folder' AND is_trashed = 0 AND parent_id IS ?
		UNION SELECT CAST(n.id AS INTEGER) FROM remote_node n JOIN f ON n.parent_id = f.id
			WHERE n.kind = 'folder' AND n.is_trashed = 0)
		SELECT COUNT(*), COALESCE(SUM(plain_size), 0) FROM remote_node
		WHERE kind = 'file' AND is_trashed = 0 AND (parent_id IS ? OR parent_id IN (SELECT id FROM f))`
	err = s.QueryRowContext(ctx, q, root, root).Scan(&files, &bytes)
	return files, bytes, err
}

// SwapSnapshot replaces remote_node with the staged snapshot and sets the cursor.
func (s *DB) SwapSnapshot(ctx context.Context, cursor int64) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{`DELETE FROM remote_node`, `INSERT INTO remote_node SELECT * FROM remote_node_snapshot`, `DELETE FROM remote_node_snapshot`} {
			if _, err := tx.Exec(q); err != nil {
				return err
			}
		}
		return SetRemoteCursor(tx, &cursor)
	})
}

// ClearSnapshot empties the snapshot staging table.
func (s *DB) ClearSnapshot(ctx context.Context) error {
	_, err := s.ExecContext(ctx, `DELETE FROM remote_node_snapshot`)
	return err
}
