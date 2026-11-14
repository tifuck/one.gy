// Package exec owns the execution of reconciler plans (plan 7.5, 7.6): the
// journal (every op goes planned -> staged -> remote_done/local_done ->
// committed, persisted before each side effect; committed and the synced
// rows in one transaction), startup recovery, the upload and download
// pipelines, remote and local mutations, and the transfer pool. The op
// contract is the package doc of internal/reconcile/ops.go.
package exec

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/remote"
	"github.com/tifuck/one.gy/client/internal/state"
)

// ErrSuperseded: a precondition no longer holds; the op is dropped and the
// next pass re-plans.
var ErrSuperseded = errors.New("superseded")

// ErrCrashed is returned after a test crash hook fired (the journal is left
// exactly as a killed process would leave it).
var ErrCrashed = errors.New("crash injected")

// IssueError is a failure the user has to see (engine-ipc.md issue kinds).
type IssueError struct {
	Kind    string
	Path    string
	Message string
	Actions []string
}

func (e *IssueError) Error() string { return e.Kind + ": " + e.Message }

func issuef(kind, p, msg string, actions ...string) *IssueError {
	return &IssueError{Kind: kind, Path: p, Message: msg, Actions: actions}
}

// Account is the slice of account.Manager the executor uses.
type Account interface {
	Client() (*api.Client, error)
	MasterKey() ([]byte, error)
}

// Env is shared by all executors of the engine.
type Env struct {
	DB   *state.DB
	Tree *remote.Tree
	Acct Account
	Pool *Pool
	// Caps returns the (cached) server capabilities.
	Caps func(context.Context) (*api.Capabilities, error)
	// FreeSpace returns the free bytes of the volume holding a path (nil =
	// no check).
	FreeSpace func(string) (int64, error)
}

// Sync is the per-sync configuration an executor applies.
type Sync struct {
	ID             string
	Root           string
	RootID         *int64 // nil = drive root
	Encryption     string // e2ee | standard: new files and folders
	HideExtensions bool
	KeepExecBit    bool
	Thumbnails     bool
	FSKind         string
	Up, Down       *Bucket // per-sync bandwidth limits
}

// Executor runs the ops of one sync. Ops of one plan may run concurrently
// (content ops); everything else about an op is serialised by its journal row.
type Executor struct {
	env *Env
	s   Sync

	// Rules are the .onegyignore rules of the current pass (folder deletes
	// skip excluded entries when checking that nothing new is inside).
	Rules *ignore.Set

	// Crash, when set (tests), is asked at every journal boundary
	// ("pre-<state>": side effect done, state not yet written; "<state>":
	// written) and simulates a kill when it returns true.
	Crash func(point string, kind reconcile.OpKind) bool
}

func New(env *Env, s Sync) *Executor { return &Executor{env: env, s: s} }

// record is the journal's pre_json: the planned op plus what the executor
// learned on the way (persisted with every state change).
type record struct {
	Op       reconcile.Op               `json:"op"`
	UploadID string                     `json:"upload_id,omitempty"` // random, so it is unique per user across devices and DB rebuilds
	FileID   string                     `json:"file_id,omitempty"`   // proposed id of a new file
	Folder   *api.CreateFolderRequest   `json:"folder,omitempty"`
	Up       *upState                   `json:"up,omitempty"`
	SHA256   string                     `json:"sha256,omitempty"` // verified plaintext hash (downloads)
	E2EE     bool                       `json:"e2ee,omitempty"`   // the downloaded node was end-to-end encrypted
	Seq      int64                      `json:"seq,omitempty"`    // if_seq for the next step of a move
	Node     *api.Node                  `json:"node,omitempty"`   // remote result
	Debris   string                     `json:"debris,omitempty"`
	Meta     map[string]json.RawMessage `json:"meta,omitempty"`
}

type job struct {
	x   *Executor
	row *state.OpRow
	rec *record
}

type crashPanic struct{}

func (x *Executor) crash(point string, kind reconcile.OpKind) {
	if x.Crash != nil && x.Crash(point, kind) {
		panic(crashPanic{})
	}
}

// set persists the next journal state (and the record) before the side
// effect that follows it.
func (j *job) set(ctx context.Context, st string) error {
	j.x.crash("pre-"+st, j.rec.Op.Kind)
	b, err := json.Marshal(j.rec)
	if err != nil {
		return err
	}
	if err := j.x.env.DB.SetOpState(ctx, j.row.ID, st, string(b)); err != nil {
		return err
	}
	j.row.State = st
	j.x.crash(st, j.rec.Op.Kind)
	return nil
}

// commit writes the synced rows and the committed state in one transaction.
func (j *job) commit(ctx context.Context, fn func(tx *sql.Tx) error) error {
	j.x.crash("pre-"+state.OpCommitted, j.rec.Op.Kind)
	return j.x.env.DB.Tx(ctx, func(tx *sql.Tx) error {
		if err := fn(tx); err != nil {
			return err
		}
		return state.FinishOpTx(tx, j.row.ID, state.OpCommitted, "")
	})
}

func token() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func uuid4() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Execute journals op and runs it. It returns nil once committed,
// ErrSuperseded, an *IssueError, or another error. Offline and cancelled
// ops stay in the journal; Recover continues them.
func (x *Executor) Execute(ctx context.Context, op reconcile.Op) error {
	rec := &record{Op: op}
	switch op.Kind {
	case reconcile.Upload:
		rec.UploadID = "op-" + token()
		if op.RemoteID == "" {
			rec.FileID = uuid4()
		}
	}
	pre, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	row := &state.OpRow{SyncID: x.s.ID, Kind: string(op.Kind), RelPath: op.Path, RemoteID: op.RemoteID, Pre: string(pre)}
	if err := x.env.DB.InsertOp(ctx, row); err != nil {
		return err
	}
	return x.run(ctx, &job{x: x, row: row, rec: rec}, func() { x.crash(state.OpPlanned, op.Kind) })
}

// Recover finishes the journal after a restart (plan 7.6): planned ops are
// dropped, later states continue from where they stopped (each step
// re-checks its preconditions or detects that its effect already happened).
func (x *Executor) Recover(ctx context.Context) error {
	ops, err := x.env.DB.UnfinishedOps(ctx, x.s.ID)
	if err != nil {
		return err
	}
	for _, row := range ops {
		var rec record
		if err := json.Unmarshal([]byte(row.Pre), &rec); err != nil {
			slog.Error("journal: unreadable op, dropping it", "op", row.ID, "err", err)
			x.env.DB.FinishOp(ctx, row.ID, state.OpFailed, "unreadable journal record")
			continue
		}
		if row.State == state.OpPlanned {
			x.cleanup(row.ID)
			if err := x.env.DB.DeleteOp(ctx, row.ID); err != nil {
				return err
			}
			continue
		}
		slog.Info("journal: resuming op", "op", row.ID, "kind", row.Kind, "state", row.State)
		err := x.run(ctx, &job{x: x, row: row, rec: &rec}, nil)
		if errors.Is(err, ErrCrashed) || errors.Is(err, api.ErrOffline) || ctx.Err() != nil {
			return err
		}
	}
	return nil
}

// unfinished: the op could not finish for now (offline, cancelled); it stays
// in the journal for Recover and is not an op failure.
func unfinished(err error) bool {
	return errors.Is(err, api.ErrOffline) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func (x *Executor) run(ctx context.Context, j *job, before func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(crashPanic); !ok {
				panic(r)
			}
			err = ErrCrashed
		}
	}()
	if before != nil {
		before()
	}
	err = x.dispatch(ctx, j)
	switch {
	case err == nil:
		x.cleanup(j.row.ID)
		return nil
	case unfinished(err) || ctx.Err() != nil:
		return err
	case errors.Is(err, ErrSuperseded):
		x.cleanup(j.row.ID)
		x.env.DB.FinishOp(context.Background(), j.row.ID, state.OpSuperseded, "")
		return err
	}
	x.cleanup(j.row.ID)
	x.env.DB.FinishOp(context.Background(), j.row.ID, state.OpFailed, err.Error())
	return err
}

func (x *Executor) dispatch(ctx context.Context, j *job) error {
	switch j.rec.Op.Kind {
	case reconcile.CreateLocalDir:
		return x.createLocalDir(ctx, j)
	case reconcile.MoveLocal, reconcile.Conflict:
		return x.moveLocal(ctx, j)
	case reconcile.DeleteLocal:
		return x.deleteLocal(ctx, j)
	case reconcile.Link:
		return x.link(ctx, j)
	case reconcile.Forget:
		return x.forget(ctx, j)
	case reconcile.CreateRemoteDir:
		return x.createRemoteDir(ctx, j)
	case reconcile.MoveRemote:
		return x.moveRemote(ctx, j)
	case reconcile.TrashRemote:
		return x.trashRemote(ctx, j)
	case reconcile.Upload:
		return x.upload(ctx, j)
	case reconcile.Download, reconcile.VerifyLink:
		return x.download(ctx, j)
	case reconcile.RestoreRemote:
		return x.restoreRemote(ctx, j)
	case reconcile.SetModeRemote:
		return x.setModeRemote(ctx, j)
	case reconcile.SetModeLocal:
		return x.setModeLocal(ctx, j)
	}
	return fmt.Errorf("unknown op kind %q", j.rec.Op.Kind)
}

// cleanup removes the op's temp and spool files.
func (x *Executor) cleanup(opID int64) {
	id := strconv.FormatInt(opID, 10)
	os.RemoveAll(filepath.Join(x.s.Root, ".onegy", "spool", id))
	os.Remove(filepath.Join(x.s.Root, ".onegy", "tmp", id+".enc"))
	os.Remove(filepath.Join(x.s.Root, ".onegy", "tmp", id+".plain"))
	x.env.DB.DeleteUploadSession(context.Background(), opID)
}

// Root is the sync root this executor works in.
func (x *Executor) Root() string { return x.s.Root }

func (x *Executor) abs(rel string) string { return filepath.Join(x.s.Root, filepath.FromSlash(rel)) }

func (x *Executor) tmpPath(opID int64, ext string) string {
	return filepath.Join(x.s.Root, ".onegy", "tmp", strconv.FormatInt(opID, 10)+ext)
}

func (x *Executor) spoolDir(opID int64) string {
	return filepath.Join(x.s.Root, ".onegy", "spool", strconv.FormatInt(opID, 10))
}

// stat returns the entry at rel; ok is false when nothing is there.
func (x *Executor) stat(rel string) (in localfs.Info, ok bool, err error) {
	in, err = localfs.Lstat(x.abs(rel))
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) { // ENOTDIR: a parent is a file
		return in, false, nil
	}
	if err != nil {
		return in, false, err
	}
	if !localfs.IdentityStable(x.s.FSKind) {
		in.ID = ""
	}
	return in, true, nil
}

// matches checks a local precondition (reconcile.Expect).
func (x *Executor) matches(rel string, e *reconcile.Expect) (bool, error) {
	in, ok, err := x.stat(rel)
	if err != nil || e == nil {
		return false, err
	}
	if e.Absent {
		return !ok, nil
	}
	return ok && sameEntry(in, e, x.s.FSKind), nil
}

func sameEntry(in localfs.Info, e *reconcile.Expect, fsKind string) bool {
	if in.Kind != e.Kind || (e.ID != "" && in.ID != e.ID) {
		return false
	}
	return in.Kind != localfs.KindFile || (in.Size == e.Size && localfs.SameMtime(in.MtimeNs, e.MtimeNs, fsKind))
}

// parentDirOK reports whether the local parent folder of rel exists.
func (x *Executor) parentDirOK(rel string) bool {
	d := path.Dir(rel)
	if d == "." {
		return true
	}
	in, ok, err := x.stat(d)
	return err == nil && ok && in.Kind == localfs.KindDir
}

// remoteParent resolves the one.gy folder for a local parent path.
func (x *Executor) remoteParent(ctx context.Context, parentPath, parentRemoteID string) (*int64, error) {
	if parentRemoteID != "" {
		id, err := strconv.ParseInt(parentRemoteID, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("bad parent id %q", parentRemoteID)
		}
		return &id, nil
	}
	if parentPath == "" {
		return x.s.RootID, nil
	}
	var row *state.SyncedRow
	err := x.env.DB.Tx(ctx, func(tx *sql.Tx) (err error) {
		row, err = state.SyncedAt(tx, x.s.ID, parentPath)
		return err
	})
	if err != nil {
		return nil, err
	}
	if row == nil || row.Kind != "folder" || row.RemoteID == "" {
		return nil, ErrSuperseded // the parent is created by an earlier op of a later pass
	}
	id, err := strconv.ParseInt(row.RemoteID, 10, 64)
	if err != nil {
		return nil, ErrSuperseded
	}
	return &id, nil
}

// baseRow finds the op's synced row where it is now (earlier moves of the
// same plan may have rewritten its path).
func (x *Executor) baseRow(tx *sql.Tx, b *state.SyncedRow) (*state.SyncedRow, error) {
	if b == nil {
		return nil, nil
	}
	if b.RemoteID != "" {
		if r, err := state.SyncedByRemote(tx, x.s.ID, b.RemoteID); r != nil || err != nil {
			return r, err
		}
	}
	return state.SyncedAt(tx, x.s.ID, b.RelPath)
}

// dropRows deletes the base item's rows (and below), or those at fallback.
func (x *Executor) dropRows(tx *sql.Tx, b *state.SyncedRow, fallback string) error {
	r, err := x.baseRow(tx, b)
	if err != nil {
		return err
	}
	if r != nil {
		return state.DeleteSynced(tx, x.s.ID, r.RelPath, true)
	}
	if b == nil && fallback != "" {
		return state.DeleteSynced(tx, x.s.ID, fallback, true)
	}
	return nil
}

// putRow writes the row at rel for the local entry there, replacing the
// base row when it sat elsewhere.
func (x *Executor) putRow(tx *sql.Tx, b *state.SyncedRow, row *state.SyncedRow) error {
	old, err := x.baseRow(tx, b)
	if err != nil {
		return err
	}
	if old != nil && old.RelPath != row.RelPath {
		if err := state.DeleteSynced(tx, x.s.ID, old.RelPath, false); err != nil {
			return err
		}
	}
	row.SyncID = x.s.ID
	return state.PutSynced(tx, row)
}

// keepName keeps the one.gy name already recorded for an item that stays
// where it is: a content op carries the name from planning time, and a move
// earlier in the same plan may have renamed the item since.
func (x *Executor) keepName(tx *sql.Tx, b *state.SyncedRow, row *state.SyncedRow) error {
	old, err := x.baseRow(tx, b)
	if err == nil && old != nil && old.RemoteID == row.RemoteID && old.RelPath == row.RelPath && old.RemoteName != "" {
		row.RemoteName = old.RemoteName
	}
	return err
}

// localRow builds a synced row from the local entry at rel.
func (x *Executor) localRow(rel, kind string) (*state.SyncedRow, error) {
	in, ok, err := x.stat(rel)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrSuperseded
	}
	r := &state.SyncedRow{RelPath: rel, Kind: kind, LocalFID: string(in.ID), Mode: int64(in.Mode)}
	if kind == "file" {
		r.Size, r.MtimeNs = in.Size, in.MtimeNs
	}
	return r, nil
}

// node returns the cached remote node (nil when unknown).
func (x *Executor) node(ctx context.Context, kind localfs.Kind, id string) (*state.RemoteNode, error) {
	k := "file"
	if kind == localfs.KindDir {
		k = "folder"
	}
	return x.env.DB.GetNode(ctx, k, id)
}

// storeNode caches a mutation response at once, so the next pass sees it
// without waiting for the change feed.
func storeNode(tx *sql.Tx, n *api.Node) error {
	if n == nil {
		return nil
	}
	return state.UpsertNode(tx, "remote_node", remote.ToState(n))
}

func (x *Executor) storeNodeNow(ctx context.Context, n *api.Node) error {
	return x.env.DB.Tx(ctx, func(tx *sql.Tx) error { return storeNode(tx, n) })
}

func (x *Executor) client() (*api.Client, error) { return x.env.Acct.Client() }

// apiIssue maps server errors that need the user onto issues.
func apiIssue(err error, p string) error {
	var e *api.Error
	if !errors.As(err, &e) {
		return err
	}
	switch e.Code {
	case "quota_exceeded":
		return issuef("quota", p, "Your one.gy storage is full; uploads are paused.", "retry")
	case "read_only":
		return issuef("read_only", p, "This one.gy folder is a backup of another device and cannot be changed from here.", "ignore")
	case "integrity_error":
		return issuef("integrity", p, "one.gy reported a damaged stored copy; it will be retried.", "retry")
	}
	return err
}
