package exec

import (
	"context"
	"database/sql"
	"strconv"

	"github.com/tifuck/one.gy/client/internal/api"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/state"
)

// restoreRemote brings a synced item back from the one.gy trash
// (RestoreRemote); a folder comes back with what was trashed with it. The
// synced row stays; a node no longer in the trash is superseded (the next
// pass sees where it is).
func (x *Executor) restoreRemote(ctx context.Context, j *job) error {
	o := j.rec.Op
	if j.row.State == state.OpPlanned {
		if err := j.set(ctx, state.OpStaged); err != nil {
			return err
		}
	}
	if j.row.State == state.OpStaged {
		c, err := x.client()
		if err != nil {
			return err
		}
		var n *api.Node
		if o.EntryKind == localfs.KindDir {
			id, perr := strconv.ParseInt(o.RemoteID, 10, 64)
			if perr != nil {
				return ErrSuperseded
			}
			n, err = c.RestoreFolder(ctx, id)
		} else {
			n, err = c.RestoreFile(ctx, o.RemoteID)
		}
		switch {
		case api.IsCode(err, "not_found"):
			return ErrSuperseded
		case err != nil:
			return apiIssue(err, o.Path)
		}
		j.rec.Node = n
		if err := j.set(ctx, state.OpRemoteDone); err != nil {
			return err
		}
	}
	return j.commit(ctx, func(tx *sql.Tx) error {
		if err := storeNode(tx, j.rec.Node); err != nil {
			return err
		}
		r, err := x.baseRow(tx, o.Base)
		if err != nil || r == nil {
			return err
		}
		r.RemoteChangeSeq = j.rec.Node.Seq
		return state.PutSynced(tx, r)
	})
}
