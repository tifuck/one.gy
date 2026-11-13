package state

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Accessors for the journal (op, upload_session), issues, transfer history,
// debris and verified remote hashes (plan 7.1, 7.6).

// Journal states (plan 7.6).
const (
	OpPlanned    = "planned"
	OpStaged     = "staged"
	OpRemoteDone = "remote_done"
	OpLocalDone  = "local_done"
	OpCommitted  = "committed"
	OpFailed     = "failed"
	OpSuperseded = "superseded"
)

// OpRow is one journal entry. Pre is the executor's JSON record (the planned
// op plus what the executor learned along the way).
type OpRow struct {
	ID         int64
	SyncID     string
	Kind       string
	RelPath    string
	RemoteID   string
	Pre        string
	State      string
	Attempt    int
	Error      string
	SpoolDir   string
	CreatedAt  string
	FinishedAt string
}

const opCols = `id, COALESCE(sync_id, ''), kind, rel_path, remote_id, pre_json, state, attempt, error, spool_dir, created_at, finished_at`

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func scanOp(row interface{ Scan(...any) error }) (*OpRow, error) {
	var o OpRow
	err := row.Scan(&o.ID, &o.SyncID, &o.Kind, &o.RelPath, &o.RemoteID, &o.Pre, &o.State, &o.Attempt, &o.Error, &o.SpoolDir, &o.CreatedAt, &o.FinishedAt)
	return &o, err
}

// InsertOp journals a planned op and sets o.ID.
func (s *DB) InsertOp(ctx context.Context, o *OpRow) error {
	o.State, o.CreatedAt = OpPlanned, now()
	res, err := s.ExecContext(ctx, `INSERT INTO op (sync_id, kind, rel_path, remote_id, pre_json, state, spool_dir, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, o.SyncID, o.Kind, o.RelPath, o.RemoteID, o.Pre, o.State, o.SpoolDir, o.CreatedAt)
	if err != nil {
		return err
	}
	o.ID, err = res.LastInsertId()
	return err
}

// SetOpState records a new state (and the updated record) before the next side effect.
func (s *DB) SetOpState(ctx context.Context, id int64, state, pre string) error {
	_, err := s.ExecContext(ctx, `UPDATE op SET state = ?, pre_json = ? WHERE id = ?`, state, pre, id)
	return err
}

// FinishOp ends an op (committed, failed or superseded). Committing goes
// through FinishOpTx so the synced rows change in the same transaction.
func (s *DB) FinishOp(ctx context.Context, id int64, state, errText string) error {
	return s.Tx(ctx, func(tx *sql.Tx) error { return FinishOpTx(tx, id, state, errText) })
}

func FinishOpTx(tx *sql.Tx, id int64, state, errText string) error {
	_, err := tx.Exec(`UPDATE op SET state = ?, error = ?, attempt = attempt + 1, finished_at = ? WHERE id = ?`, state, errText, now(), id)
	return err
}

// DeleteOp drops a journal entry (planned ops at recovery).
func (s *DB) DeleteOp(ctx context.Context, id int64) error {
	_, err := s.ExecContext(ctx, `DELETE FROM op WHERE id = ?`, id)
	return err
}

// UnfinishedOps returns the ops of a sync that never reached an end state.
func (s *DB) UnfinishedOps(ctx context.Context, syncID string) ([]*OpRow, error) {
	return s.queryOps(ctx, `SELECT `+opCols+` FROM op WHERE sync_id = ? AND state IN (?, ?, ?, ?) ORDER BY id`,
		syncID, OpPlanned, OpStaged, OpRemoteDone, OpLocalDone)
}

// RecentOps returns committed ops, newest first (activity.recent).
func (s *DB) RecentOps(ctx context.Context, limit int) ([]*OpRow, error) {
	return s.queryOps(ctx, `SELECT `+opCols+` FROM op WHERE state = ? ORDER BY id DESC LIMIT ?`, OpCommitted, limit)
}

func (s *DB) queryOps(ctx context.Context, q string, args ...any) ([]*OpRow, error) {
	rows, err := s.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OpRow
	for rows.Next() {
		o, err := scanOp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// PruneOps keeps the newest keep finished ops.
func (s *DB) PruneOps(ctx context.Context, keep int) error {
	_, err := s.ExecContext(ctx, `DELETE FROM op WHERE state IN (?, ?, ?) AND id <= (SELECT COALESCE(MAX(id), 0) FROM op) - ?`,
		OpCommitted, OpFailed, OpSuperseded, keep)
	return err
}

// UploadSession is the resumable state of an upload op (plan 7.1).
type UploadSession struct {
	OpID          int64
	SessionID     string
	BaseNonce     string // b64 header nonce of the spooled container
	ChunkCount    int
	SourceFID     string
	SourceSize    int64
	SourceMtimeNs int64
}

func (s *DB) GetUploadSession(ctx context.Context, opID int64) (*UploadSession, error) {
	var u UploadSession
	err := s.QueryRowContext(ctx, `SELECT op_id, server_session_id, base_nonce, chunk_count, source_fid, source_size, source_mtime_ns
		FROM upload_session WHERE op_id = ?`, opID).Scan(&u.OpID, &u.SessionID, &u.BaseNonce, &u.ChunkCount, &u.SourceFID, &u.SourceSize, &u.SourceMtimeNs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

func (s *DB) PutUploadSession(ctx context.Context, u *UploadSession) error {
	_, err := s.ExecContext(ctx, `INSERT OR REPLACE INTO upload_session (op_id, server_session_id, base_nonce, chunk_count, source_fid, source_size, source_mtime_ns)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, u.OpID, u.SessionID, u.BaseNonce, u.ChunkCount, u.SourceFID, u.SourceSize, u.SourceMtimeNs)
	return err
}

func (s *DB) DeleteUploadSession(ctx context.Context, opID int64) error {
	_, err := s.ExecContext(ctx, `DELETE FROM upload_session WHERE op_id = ?`, opID)
	return err
}

// IssueRow is a stored issue; Detail is the JSON of message, actions and
// kind-specific detail.
type IssueRow struct {
	ID        int64
	SyncID    string
	Kind      string
	RelPath   string
	Detail    string
	CreatedAt string
}

const issueCols = `id, COALESCE(sync_id, ''), kind, rel_path, detail_json, created_at`

// OpenIssues lists unresolved issues (syncID "" = all syncs), oldest first.
func (s *DB) OpenIssues(ctx context.Context, syncID string) ([]*IssueRow, error) {
	rows, err := s.QueryContext(ctx, `SELECT `+issueCols+` FROM issue WHERE resolved_at IS NULL AND (? = '' OR sync_id = ?) ORDER BY id`, syncID, syncID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*IssueRow
	for rows.Next() {
		var r IssueRow
		if err := rows.Scan(&r.ID, &r.SyncID, &r.Kind, &r.RelPath, &r.Detail, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// GetIssue returns an open issue (nil, nil if unknown or resolved).
func (s *DB) GetIssue(ctx context.Context, id int64) (*IssueRow, error) {
	var r IssueRow
	err := s.QueryRowContext(ctx, `SELECT `+issueCols+` FROM issue WHERE id = ? AND resolved_at IS NULL`, id).Scan(
		&r.ID, &r.SyncID, &r.Kind, &r.RelPath, &r.Detail, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &r, err
}

// AddIssue stores a new open issue and sets r.ID and r.CreatedAt.
func (s *DB) AddIssue(ctx context.Context, r *IssueRow) error {
	r.CreatedAt = now()
	res, err := s.ExecContext(ctx, `INSERT INTO issue (sync_id, kind, rel_path, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`,
		r.SyncID, r.Kind, r.RelPath, r.Detail, r.CreatedAt)
	if err != nil {
		return err
	}
	r.ID, err = res.LastInsertId()
	return err
}

// UpdateIssueDetail refreshes the message/detail of an open issue.
func (s *DB) UpdateIssueDetail(ctx context.Context, id int64, detail string) error {
	_, err := s.ExecContext(ctx, `UPDATE issue SET detail_json = ? WHERE id = ?`, detail, id)
	return err
}

func (s *DB) ResolveIssue(ctx context.Context, id int64) error {
	_, err := s.ExecContext(ctx, `UPDATE issue SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`, now(), id)
	return err
}

// TransferRecord is one finished transfer (transfer_history).
type TransferRecord struct {
	SyncID     string
	Direction  string
	RelPath    string
	Size       int64
	State      string
	Error      string
	Manual     bool
	StartedAt  string
	FinishedAt string
}

func (s *DB) AddTransferHistory(ctx context.Context, t *TransferRecord) error {
	_, err := s.ExecContext(ctx, `INSERT INTO transfer_history (sync_id, direction, rel_path, size, state, error, manual, started_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, t.SyncID, t.Direction, t.RelPath, t.Size, t.State, t.Error, t.Manual, t.StartedAt, t.FinishedAt)
	if err == nil {
		_, err = s.ExecContext(ctx, `DELETE FROM transfer_history WHERE id <= (SELECT MAX(id) FROM transfer_history) - 5000`)
	}
	return err
}

// AddDebris records an item moved to the sync's debris folder.
func AddDebris(tx *sql.Tx, syncID, relPath, debrisPath, reason string) error {
	_, err := tx.Exec(`INSERT INTO debris (sync_id, rel_path, debris_path, reason, at) VALUES (?, ?, ?, ?, ?)`, syncID, relPath, debrisPath, reason, now())
	return err
}

// TakeDebris removes and returns the debris records of a sync moved there
// before cutoff (their files are the caller's to delete).
func (s *DB) TakeDebris(ctx context.Context, syncID string, cutoff time.Time) ([]string, error) {
	var out []string
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		c := cutoff.UTC().Format(time.RFC3339Nano)
		rows, err := tx.Query(`SELECT debris_path FROM debris WHERE sync_id = ? AND at < ?`, syncID, c)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p string
			if err := rows.Scan(&p); err != nil {
				rows.Close()
				return err
			}
			out = append(out, p)
		}
		rows.Close()
		_, err = tx.Exec(`DELETE FROM debris WHERE sync_id = ? AND at < ?`, syncID, c)
		return err
	})
	return out, err
}

// RemoteHash returns a plaintext hash verified for this payload ("" = none).
func (s *DB) RemoteHash(ctx context.Context, fileID, payloadChecksum string) (string, error) {
	var h string
	err := s.QueryRowContext(ctx, `SELECT plain_sha256 FROM remote_hash WHERE file_id = ? AND payload_checksum = ?`, fileID, payloadChecksum).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return h, err
}

// RemoteHashes returns every verified hash keyed by file id + payload checksum.
func (s *DB) RemoteHashes(ctx context.Context) (map[[2]string]string, error) {
	rows, err := s.QueryContext(ctx, `SELECT file_id, payload_checksum, plain_sha256 FROM remote_hash`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[[2]string]string{}
	for rows.Next() {
		var id, pc, h string
		if err := rows.Scan(&id, &pc, &h); err != nil {
			return nil, err
		}
		out[[2]string{id, pc}] = h
	}
	return out, rows.Err()
}

func PutRemoteHash(tx *sql.Tx, fileID, payloadChecksum, plainSHA256 string) error {
	_, err := tx.Exec(`INSERT OR REPLACE INTO remote_hash (file_id, payload_checksum, plain_sha256) VALUES (?, ?, ?)`, fileID, payloadChecksum, plainSHA256)
	return err
}

// SyncedAt returns the base row at relPath (nil, nil if none).
func SyncedAt(tx *sql.Tx, syncID, relPath string) (*SyncedRow, error) {
	var r SyncedRow
	err := tx.QueryRow(`SELECT `+syncedCols+` FROM synced WHERE sync_id = ? AND rel_path = ?`, syncID, relPath).Scan(
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

// SyncedSubtree returns the rows at and below relPath, keyed by path.
func (s *DB) SyncedSubtree(ctx context.Context, syncID, relPath string) (map[string]*SyncedRow, error) {
	rows, err := s.QueryContext(ctx, `SELECT `+syncedCols+` FROM synced WHERE sync_id = ? AND (rel_path = ? OR `+below+`)`,
		syncID, relPath, relPath, relPath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*SyncedRow{}
	for rows.Next() {
		var r SyncedRow
		if err := rows.Scan(&r.SyncID, &r.RelPath, &r.Kind, &r.RemoteID, &r.LocalFID, &r.Size, &r.MtimeNs, &r.PlainSHA256,
			&r.RemoteContentVersion, &r.RemoteChangeSeq, &r.Mode, &r.RemoteName); err != nil {
			return nil, err
		}
		out[r.RelPath] = &r
	}
	return out, rows.Err()
}
