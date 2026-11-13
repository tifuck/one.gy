package state

import (
	"context"
	"database/sql"
	"errors"
)

// SyncRow is a configured sync. Config holds the IPC Sync options that have no
// column of their own (JSON object).
type SyncRow struct {
	ID            string
	Name          string
	LocalRoot     string
	RemoteRootID  *int64 // nil = drive root
	RemotePath    string
	Type          string
	Encryption    string
	Config        string
	FSKind        string
	CaseSensitive bool
	State         string
	Paused        bool
	LastSyncedAt  string
	CreatedAt     string
}

const syncCols = `id, name, local_root, remote_root_id, remote_path, type, encryption, config_json, fs_kind, case_sensitive, state, paused, last_synced_at, created_at`

func scanSync(row interface{ Scan(...any) error }) (*SyncRow, error) {
	var r SyncRow
	var root sql.NullInt64
	err := row.Scan(&r.ID, &r.Name, &r.LocalRoot, &root, &r.RemotePath, &r.Type, &r.Encryption, &r.Config,
		&r.FSKind, &r.CaseSensitive, &r.State, &r.Paused, &r.LastSyncedAt, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	if root.Valid {
		r.RemoteRootID = &root.Int64
	}
	return &r, nil
}

// ListSyncs returns all syncs, oldest first.
func (s *DB) ListSyncs(ctx context.Context) ([]*SyncRow, error) {
	rows, err := s.QueryContext(ctx, `SELECT `+syncCols+` FROM sync ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SyncRow
	for rows.Next() {
		r, err := scanSync(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetSync returns nil, nil for an unknown id.
func (s *DB) GetSync(ctx context.Context, id string) (*SyncRow, error) {
	r, err := scanSync(s.QueryRowContext(ctx, `SELECT `+syncCols+` FROM sync WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// PutSync inserts or updates a sync row. An upsert, not INSERT OR REPLACE:
// replacing would delete the row and cascade away its journal and base state.
func (s *DB) PutSync(ctx context.Context, r *SyncRow) error {
	_, err := s.ExecContext(ctx, `INSERT INTO sync (`+syncCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, local_root = excluded.local_root, remote_root_id = excluded.remote_root_id,
		remote_path = excluded.remote_path, type = excluded.type, encryption = excluded.encryption, config_json = excluded.config_json,
		fs_kind = excluded.fs_kind, case_sensitive = excluded.case_sensitive, state = excluded.state, paused = excluded.paused,
		last_synced_at = excluded.last_synced_at, created_at = excluded.created_at`,
		r.ID, r.Name, r.LocalRoot, r.RemoteRootID, r.RemotePath, r.Type, r.Encryption, r.Config,
		r.FSKind, r.CaseSensitive, r.State, r.Paused, r.LastSyncedAt, r.CreatedAt)
	return err
}

// DeleteSync removes a sync and (by cascade) its journal, issues and base state.
func (s *DB) DeleteSync(ctx context.Context, id string) error {
	_, err := s.ExecContext(ctx, `DELETE FROM sync WHERE id = ?`, id)
	return err
}

// OpenIssueCount counts unresolved issues of a sync.
func (s *DB) OpenIssueCount(ctx context.Context, syncID string) (int, error) {
	var n int
	err := s.QueryRowContext(ctx, `SELECT COUNT(*) FROM issue WHERE sync_id = ? AND resolved_at IS NULL`, syncID).Scan(&n)
	return n, err
}
