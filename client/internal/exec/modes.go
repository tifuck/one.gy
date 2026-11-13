package exec

import (
	"context"
	"database/sql"
	"os"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
)

// Mode-only changes (SetModeRemote, SetModeLocal): the executable bit moves
// through the encrypted meta without a content transfer.

// setModeRemote rewrites the file's encrypted meta with the local mode,
// guarded by if_content_version. Standard files have no meta: only the row
// records the mode.
func (x *Executor) setModeRemote(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if ok, err := x.matches(o.Path, o.Local); err != nil || !ok {
			return orSuperseded(err)
		}
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		n, err := x.node(ctx, localfs.KindFile, o.RemoteID)
		if err != nil {
			return err
		}
		if n == nil || n.IsTrashed || n.ContentVersion != o.ContentVersion {
			return ErrSuperseded
		}
		if n.IsE2E {
			key, err := x.env.Tree.Key(n)
			if err != nil {
				return keyIssue(err)
			}
			meta, nonce, err := e2ee.EncryptMeta(e2ee.Meta{FileID: o.RemoteID, ContentVersion: o.ContentVersion, PlainSize: o.Size,
				PlainSHA256: o.SHA256, MtimeNs: o.Local.MtimeNs, Mode: o.Mode}, key)
			if err != nil {
				return err
			}
			c, err := x.client()
			if err != nil {
				return err
			}
			res, err := c.SetMeta(ctx, o.RemoteID, meta, nonce, o.ContentVersion)
			switch {
			case api.IsCode(err, "precondition_failed"), api.IsCode(err, "not_found"):
				return ErrSuperseded // the content changed meanwhile: the next pass decides
			case err != nil:
				return apiIssue(err, o.Path)
			}
			j.rec.Node = res
		}
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
	}
	return x.commitMode(ctx, j)
}

// setModeLocal sets the local file's permission bits to Mode.
func (x *Executor) setModeLocal(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		ok, err := x.matches(o.Path, o.Local)
		if err != nil || !ok {
			return orSuperseded(err)
		}
		if err := os.Chmod(x.abs(o.Path), os.FileMode(o.Mode)&os.ModePerm); err != nil {
			return permIssue(err, o.Path)
		}
		if err := j.set(ctx, state.OpLocalDone); err != nil {
			return err
		}
	}
	return x.commitMode(ctx, j)
}

// commitMode records the op's mode (and the meta write's seq) on the row.
func (x *Executor) commitMode(ctx context.Context, j *job) error {
	o := j.rec.Op
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, j.rec.Node); err != nil {
			return err
		}
		r, err := x.baseRow(tx, o.Base)
		if err != nil || r == nil {
			return err
		}
		r.Mode = int64(o.Mode)
		if j.rec.Node != nil {
			r.RemoteChangeSeq = j.rec.Node.Seq
		}
		return state.PutSynced(tx, r)
	})
}
