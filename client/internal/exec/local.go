package exec

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/reconcile"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Local mutations: mkdir, move/rename (also conflict copies), delete to
// debris (never unlink), and the no-I/O Link and Forget. A staged local op
// first checks whether its effect already happened (crash after the side
// effect, before the journal caught up).

func (x *Executor) createLocalDir(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		in, ok, err := x.stat(o.Path)
		switch {
		case err != nil:
			return err
		case ok && in.Kind != localfs.KindDir:
			return ErrSuperseded
		case !ok:
			if !x.parentDirOK(o.Path) {
				return ErrSuperseded
			}
			if err := os.Mkdir(x.abs(o.Path), 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
				return permIssue(err, o.Path)
			}
			localfs.SyncDir(filepath.Dir(x.abs(o.Path)))
		}
		if err := j.set(ctx, state.OpLocalDone); err != nil {
			return err
		}
	}
	row, err := x.localRow(o.Path, "folder")
	if err != nil {
		return err
	}
	if row.Kind != "folder" {
		return ErrSuperseded
	}
	n, err := x.node(ctx, localfs.KindDir, o.RemoteID)
	if err != nil {
		return err
	}
	row.RemoteID, row.RemoteName = o.RemoteID, o.RemoteName
	if n != nil {
		row.RemoteChangeSeq = n.Seq
	}
	return j.commit(ctx, func(tx *sql.Tx) error { return x.putRow(tx, o.Base, row) })
}

// moveLocal renames From to Path (MoveLocal and Conflict).
func (x *Executor) moveLocal(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		src, dst := x.abs(o.From), x.abs(o.Path)
		srcOK, err := x.matches(o.From, o.Local)
		if err != nil {
			return err
		}
		if !srcOK {
			if done, err := x.matches(o.Path, o.Local); err != nil || !done {
				return orSuperseded(err)
			}
		} else {
			if !x.parentDirOK(o.Path) {
				return ErrSuperseded
			}
			var err error
			if same(src, dst) { // case-only rename on a case-insensitive file system
				err = os.Rename(src, dst)
			} else {
				err = localfs.RenameNoReplace(src, dst)
			}
			if errors.Is(err, fs.ErrExist) {
				return ErrSuperseded
			}
			if err != nil {
				return permIssue(err, o.From)
			}
		}
		if err := j.set(ctx, state.OpLocalDone); err != nil {
			return err
		}
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		r, err := x.baseRow(tx, o.Base)
		if err != nil || r == nil {
			return err
		}
		if o.Kind == reconcile.Conflict {
			return state.DeleteSynced(tx, x.s.ID, r.RelPath, true)
		}
		if err := state.MoveSynced(tx, x.s.ID, r.RelPath, o.Path); err != nil {
			return err
		}
		r.RelPath, r.RemoteName = o.Path, o.RemoteName
		if in, ok, err := x.stat(o.Path); err == nil && ok {
			r.LocalFID = string(in.ID)
		}
		return state.PutSynced(tx, r)
	})
}

func same(a, b string) bool {
	ia, err1 := os.Lstat(a)
	ib, err2 := os.Lstat(b)
	return err1 == nil && err2 == nil && os.SameFile(ia, ib)
}

func orSuperseded(err error) error {
	if err != nil {
		return err
	}
	return ErrSuperseded
}

// deleteLocal moves Path (and its subtree) into the sync's debris folder.
func (x *Executor) deleteLocal(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		ok, err := x.matches(o.Path, o.Local)
		if err != nil || !ok {
			return orSuperseded(err)
		}
		if o.EntryKind == localfs.KindDir && o.Base != nil {
			if err := x.subtreeSynced(ctx, o); err != nil {
				return err
			}
		}
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		_, there, err := x.stat(o.Path)
		if err != nil {
			return err
		}
		if there { // else: moved before a crash, or deleted meanwhile
			if ok, err := x.matches(o.Path, o.Local); err != nil || !ok {
				return orSuperseded(err)
			}
			d, err := localfs.MoveToDebris(x.s.Root, o.Path, time.Now())
			if err != nil {
				return permIssue(err, o.Path)
			}
			j.rec.Debris = d
		}
		if err := j.set(ctx, state.OpLocalDone); err != nil {
			return err
		}
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if j.rec.Debris != "" {
			if err := state.AddDebris(tx, x.s.ID, o.Path, j.rec.Debris, o.Reason); err != nil {
				return err
			}
		}
		return x.dropRows(tx, o.Base, o.Path)
	})
}

// subtreeSynced refuses to move a folder away while anything inside it is
// not exactly as last synced (new or edited since the plan was made).
func (x *Executor) subtreeSynced(ctx context.Context, o reconcile.Op) error {
	var basePath string
	err := x.env.DB.Tx(ctx, func(tx *sql.Tx) error {
		r, err := x.baseRow(tx, o.Base)
		if r != nil {
			basePath = r.RelPath
		}
		return err
	})
	if err != nil {
		return err
	}
	if basePath == "" {
		return ErrSuperseded
	}
	rows, err := x.env.DB.SyncedSubtree(ctx, x.s.ID, basePath)
	if err != nil {
		return err
	}
	root := x.abs(o.Path)
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return ErrSuperseded
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		key := basePath
		if rel != "." {
			key = path.Join(basePath, rel)
		}
		in, err := localfs.Lstat(p)
		if err != nil {
			return ErrSuperseded
		}
		if rel != "." && x.Rules != nil && x.Rules.Match(path.Join(o.Path, rel), in.Kind, in.Size) == ignore.Excluded {
			if in.Kind == localfs.KindDir {
				return filepath.SkipDir
			}
			return nil // excluded items travel with their folder
		}
		r := rows[key]
		if r == nil {
			return ErrSuperseded
		}
		if (r.Kind == "folder") != (in.Kind == localfs.KindDir) {
			return ErrSuperseded
		}
		if in.Kind == localfs.KindFile && (in.Size != r.Size || !localfs.SameMtime(in.MtimeNs, r.MtimeNs, x.s.FSKind)) {
			return ErrSuperseded
		}
		return nil
	})
}

// link records agreement without a transfer.
func (x *Executor) link(ctx context.Context, j *job) error {
	o := j.rec.Op
	if ok, err := x.matches(o.Path, o.Local); err != nil || !ok {
		return orSuperseded(err)
	}
	n, err := x.node(ctx, o.EntryKind, o.RemoteID)
	if err != nil {
		return err
	}
	if n == nil || n.IsTrashed || (o.EntryKind == localfs.KindFile && n.ContentVersion != o.ContentVersion) {
		return ErrSuperseded
	}
	return j.commit(ctx, func(tx *sql.Tx) error { return x.linkRow(tx, o, n) })
}

func (x *Executor) linkRow(tx *sql.Tx, o reconcile.Op, n *state.RemoteNode) error {
	kind := "file"
	if o.EntryKind == localfs.KindDir {
		kind = "folder"
	}
	row, err := x.localRow(o.Path, kind)
	if err != nil {
		return err
	}
	row.RemoteID, row.RemoteName, row.RemoteChangeSeq = o.RemoteID, o.RemoteName, n.Seq
	if kind == "file" {
		row.PlainSHA256, row.RemoteContentVersion = o.SHA256, n.ContentVersion
	}
	if old, err := x.baseRow(tx, o.Base); err != nil {
		return err
	} else if old != nil && old.RelPath != o.Path {
		if err := state.MoveSynced(tx, x.s.ID, old.RelPath, o.Path); err != nil {
			return err
		}
	}
	row.SyncID = x.s.ID
	return state.PutSynced(tx, row)
}

func (x *Executor) forget(ctx context.Context, j *job) error {
	o := j.rec.Op
	return j.commit(ctx, func(tx *sql.Tx) error { return x.dropRows(tx, o.Base, "") })
}

// permIssue turns permission and sharing errors into issues; others stay
// errors (retried).
func permIssue(err error, p string) error {
	switch {
	case localfs.IsLocked(err):
		return issuef("locked", p, "The file is in use by another program; it will be retried.", "retry")
	case errors.Is(err, fs.ErrPermission):
		return issuef("permission", p, "Permission denied: "+err.Error(), "retry", "open")
	}
	return err
}
