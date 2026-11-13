package state

import (
	"context"
	"database/sql"
	"errors"
)

// SyncedRow is the last agreed state of one item (plan 7.1 "synced"): the
// base of the three-way compare. RelPath is the local path ('/'-separated),
// Kind "file" | "folder", RemoteName the one.gy name it was synced under.
type SyncedRow struct {
	SyncID               string
	RelPath              string
	Kind                 string
	RemoteID             string
	LocalFID             string
	Size                 int64
	MtimeNs              int64
	PlainSHA256          string
	RemoteContentVersion int64
	RemoteChangeSeq      int64
	Mode                 int64
	RemoteName           string
}

const syncedCols = `sync_id, rel_path, kind, remote_id, local_fid, size, mtime_ns, plain_sha256, remote_content_version, remote_change_seq, mode, remote_name`

// ListSynced returns the base rows of a sync, ordered by path.
func (s *DB) ListSynced(ctx context.Context, syncID string) ([]*SyncedRow, error) {
	rows, err := s.QueryContext(ctx, `SELECT `+syncedCols+` FROM synced WHERE sync_id = ? ORDER BY rel_path`, syncID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SyncedRow
	for rows.Next() {
		var r SyncedRow
		if err := rows.Scan(&r.SyncID, &r.RelPath, &r.Kind, &r.RemoteID, &r.LocalFID, &r.Size, &r.MtimeNs, &r.PlainSHA256,
			&r.RemoteContentVersion, &r.RemoteChangeSeq, &r.Mode, &r.RemoteName); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// SyncedByRemote returns the base row for a remote node (nil, nil if none).
// Ops find their row this way: earlier moves may have rewritten its path.
func SyncedByRemote(tx *sql.Tx, syncID, remoteID string) (*SyncedRow, error) {
	var r SyncedRow
	err := tx.QueryRow(`SELECT `+syncedCols+` FROM synced WHERE sync_id = ? AND remote_id = ? AND remote_id != ''`, syncID, remoteID).Scan(
		&r.SyncID, &r.RelPath, &r.Kind, &r.RemoteID, &r.LocalFID, &r.Size, &r.MtimeNs, &r.PlainSHA256,
		&r.RemoteContentVersion, &r.RemoteChangeSeq, &r.Mode, &r.RemoteName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SyncedByPath returns the base row at relPath (nil, nil if none).
func (s *DB) SyncedByPath(ctx context.Context, syncID, relPath string) (*SyncedRow, error) {
	var r SyncedRow
	err := s.QueryRowContext(ctx, `SELECT `+syncedCols+` FROM synced WHERE sync_id = ? AND rel_path = ?`, syncID, relPath).Scan(
		&r.SyncID, &r.RelPath, &r.Kind, &r.RemoteID, &r.LocalFID, &r.Size, &r.MtimeNs, &r.PlainSHA256,
		&r.RemoteContentVersion, &r.RemoteChangeSeq, &r.Mode, &r.RemoteName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// PutSynced inserts or replaces a base row.
func PutSynced(tx *sql.Tx, r *SyncedRow) error {
	_, err := tx.Exec(`INSERT OR REPLACE INTO synced (`+syncedCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.SyncID, r.RelPath, r.Kind, r.RemoteID, r.LocalFID, r.Size, r.MtimeNs, r.PlainSHA256,
		r.RemoteContentVersion, r.RemoteChangeSeq, r.Mode, r.RemoteName)
	return err
}

// below matches the rows strictly under the path bound to both ? (binary
// order: '/' is 0x2F, '0' is 0x30; LIKE would fold ASCII case).
const below = `rel_path > ? || '/' AND rel_path < ? || '0'`

// DeleteSynced removes the row at relPath and, with subtree, every row below it.
func DeleteSynced(tx *sql.Tx, syncID, relPath string, subtree bool) error {
	if _, err := tx.Exec(`DELETE FROM synced WHERE sync_id = ? AND rel_path = ?`, syncID, relPath); err != nil || !subtree {
		return err
	}
	_, err := tx.Exec(`DELETE FROM synced WHERE sync_id = ? AND `+below, syncID, relPath, relPath)
	return err
}

// MoveSynced renames the row at from, and every row below it, to to.
func MoveSynced(tx *sql.Tx, syncID, from, to string) error {
	if err := DeleteSynced(tx, syncID, to, true); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE synced SET rel_path = ? WHERE sync_id = ? AND rel_path = ?`, to, syncID, from); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE synced SET rel_path = ? || substr(rel_path, length(?) + 1) WHERE sync_id = ? AND `+below,
		to, from, syncID, from, from)
	return err
}

// LocalCacheRow avoids re-hashing unchanged files (plan 7.1 "local_cache").
type LocalCacheRow struct {
	RelPath     string
	LocalFID    string
	Size        int64
	MtimeNs     int64
	CtimeNs     int64
	PlainSHA256 string
	HashedAt    string
}

// LoadLocalCache returns the hash cache of a sync by path.
func (s *DB) LoadLocalCache(ctx context.Context, syncID string) (map[string]*LocalCacheRow, error) {
	rows, err := s.QueryContext(ctx, `SELECT rel_path, local_fid, size, mtime_ns, ctime_ns, plain_sha256, hashed_at FROM local_cache WHERE sync_id = ?`, syncID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*LocalCacheRow{}
	for rows.Next() {
		var r LocalCacheRow
		if err := rows.Scan(&r.RelPath, &r.LocalFID, &r.Size, &r.MtimeNs, &r.CtimeNs, &r.PlainSHA256, &r.HashedAt); err != nil {
			return nil, err
		}
		out[r.RelPath] = &r
	}
	return out, rows.Err()
}

// SaveLocalCache upserts and deletes cache rows in one transaction.
func (s *DB) SaveLocalCache(ctx context.Context, syncID string, upserts []*LocalCacheRow, deletes []string) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		for _, r := range upserts {
			if _, err := tx.Exec(`INSERT OR REPLACE INTO local_cache (sync_id, rel_path, local_fid, size, mtime_ns, ctime_ns, plain_sha256, hashed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, syncID, r.RelPath, r.LocalFID, r.Size, r.MtimeNs, r.CtimeNs, r.PlainSHA256, r.HashedAt); err != nil {
				return err
			}
		}
		for _, p := range deletes {
			if _, err := tx.Exec(`DELETE FROM local_cache WHERE sync_id = ? AND rel_path = ?`, syncID, p); err != nil {
				return err
			}
		}
		return nil
	})
}

// SubtreeNodes returns the non-trashed folders and files below root (nil =
// whole drive), skipping trashed folders and everything under them. The
// caller decrypts names and meta into reconcile.RemoteNode.
func (s *DB) SubtreeNodes(ctx context.Context, root *int64) ([]*RemoteNode, error) {
	q := `WITH RECURSIVE f(id) AS (
		SELECT CAST(id AS INTEGER) FROM remote_node WHERE kind = 'folder' AND is_trashed = 0 AND parent_id IS ?
		UNION SELECT CAST(n.id AS INTEGER) FROM remote_node n JOIN f ON n.parent_id = f.id
			WHERE n.kind = 'folder' AND n.is_trashed = 0)
		SELECT ` + nodeCols + ` FROM remote_node
		WHERE is_trashed = 0 AND (parent_id IS ? OR parent_id IN (SELECT id FROM f))`
	rows, err := s.QueryContext(ctx, q, root, root)
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
