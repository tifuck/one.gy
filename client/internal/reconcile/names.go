package reconcile

import (
	"fmt"
	"path"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

// One.gy allows several items with one name in a folder (E2EE names are
// opaque to the server), so the reconciler keeps remote writes off names an
// unsynced one.gy item already uses.

// occupant is the unsynced one.gy item already at local path p, other than
// the node self.
func (r *run) occupant(p, self string) *rnode {
	rn := r.newAt[r.key(p)]
	if rn == nil || rn.ID == self || r.claimedRemote[rn.ID] || r.remoteStalled[rn.ID] {
		return nil
	}
	return rn
}

// freeName returns p with the first " (n)" suffix no local or remote item uses.
func (r *run) freeName(p string) string {
	for i := 2; ; i++ {
		cand := join(parentOf(p), localfs.InsertSuffix(path.Base(p), fmt.Sprintf(" (%d)", i)))
		if k := r.key(cand); !r.taken[k] {
			r.taken[k] = true
			return cand
		}
	}
}

// remoteMove plans moving the base item it (on one.gy at from) to final. An
// unsynced one.gy item already there is resolved first: an identical file is
// trashed as a duplicate; otherwise the one.gy item keeps the name (share
// links point at it) and this item moves to a free " (n)" name on both
// sides, or, with conflict policy "ask", the path waits for the user.
// Returns the item's final local path; ok is false when nothing was planned.
func (r *run) remoteMove(it *item, from, final, reason string) (string, bool) {
	if occ := r.occupant(final, it.rn.ID); occ != nil {
		switch {
		case it.kind == localfs.KindFile && occ.Kind == localfs.KindFile && occ.SHA256 != "" && occ.SHA256 == it.l.SHA256:
			r.claimedRemote[occ.ID] = true
			r.add(Op{Kind: TrashRemote, Path: final, EntryKind: occ.Kind, RemoteID: occ.ID, RemoteSeq: occ.Seq, Size: occ.Size,
				Reason: "identical file already on one.gy"})
		case r.policy() == "ask":
			r.issue("name_clash", final, "one.gy already has another item with this name here.", "rename", "ignore")
			r.stallPath(final)
			return final, false
		default:
			to := r.freeName(final)
			r.add(Op{Kind: MoveLocal, From: final, Path: to, EntryKind: it.kind, Local: expect(it.l), Target: absent,
				Reason: "a one.gy item already has this name"})
			r.localMoves = append(r.localMoves, move{final, to})
			final = to
		}
	}
	name, ok := r.remoteName(final, it.b)
	if !ok {
		return final, false
	}
	r.add(Op{Kind: MoveRemote, From: from, Path: final, EntryKind: it.kind, RemoteID: it.rn.ID, RemoteSeq: it.rn.Seq,
		ParentPath: parentOf(final), RemoteName: name, Base: it.b, Reason: reason})
	r.remoteMoves = append(r.remoteMoves, move{from, final})
	return final, true
}
