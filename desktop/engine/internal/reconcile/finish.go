package reconcile

import (
	"fmt"
	"sort"
	"strings"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
)

// Passes over the whole plan: read-only folders, folders deleted on one side
// with new content inside, subtree deletes, the mass-delete guard (plan 7.8).

func isDelete(k OpKind) bool { return k == DeleteLocal || k == TrashRemote || k == Forget }

func (r *run) finish() {
	r.readOnly()
	r.survivors()
	r.suppressSubtreeDeletes()
	r.massDelete()
	ops := r.ops[:0]
	for _, o := range r.ops {
		if o.Kind != "" {
			ops = append(ops, o)
		}
	}
	r.ops = ops
}

// readOnly drops remote writes inside another device's backup folder.
func (r *run) readOnly() {
	for i := range r.ops {
		o := &r.ops[i]
		ro := false
		switch o.Kind {
		case Upload, CreateRemoteDir, SetModeRemote:
			ro = r.isRO(o.Path)
		case MoveRemote:
			ro = r.isRO(o.Path) || (r.remote[o.RemoteID] != nil && r.remote[o.RemoteID].readOnly)
		case TrashRemote:
			ro = r.remote[o.RemoteID] != nil && r.remote[o.RemoteID].readOnly
		}
		if ro {
			r.issue("read_only", o.Path, "This one.gy folder is a backup of another device and cannot be changed from here.", "ignore")
			r.stallPath(o.Path)
			o.Kind = ""
		}
	}
}

// survivors: a folder deleted on one side is kept (re-created where it is
// gone, or restored from the one.gy trash) when anything inside it is not
// deleted: new or edited items, or paths this pass cannot judge (plan 7.7).
// Deepest folders first, so a kept child keeps its parent.
func (r *run) survivors() {
	var keep []string // sorted paths that survive
	for _, o := range r.ops {
		if o.Kind != "" && !isDelete(o.Kind) {
			keep = append(keep, o.Path)
		}
	}
	for p := range r.local.Stalled {
		keep = append(keep, p)
	}
	keep = append(keep, r.stalledList...)
	sort.Strings(keep)
	hasBelow := func(dir string) bool {
		i := sort.SearchStrings(keep, dir+"/")
		return i < len(keep) && strings.HasPrefix(keep[i], dir+"/")
	}
	var dirs []int
	var restored []string
	for i, o := range r.ops {
		// Unsynced one.gy folders trashed on purpose (merged duplicates,
		// local_source extras) are not judged by their local path.
		if o.EntryKind == localfs.KindDir && (o.Kind == DeleteLocal || (o.Kind == TrashRemote && o.Base != nil)) {
			dirs = append(dirs, i)
		}
	}
	sort.SliceStable(dirs, func(a, b int) bool {
		return strings.Count(r.ops[dirs[a]].Path, "/") > strings.Count(r.ops[dirs[b]].Path, "/")
	})
	for _, i := range dirs {
		o := &r.ops[i]
		if !hasBelow(o.Path) {
			continue
		}
		switch {
		case o.Base == nil:
			o.Kind = ""
			continue
		case o.Kind == TrashRemote: // deleted here: keep the one.gy folder, re-create it here
			name := o.Base.RemoteName
			if rn := r.remote[o.RemoteID]; rn != nil {
				name = rn.Name
			}
			*o = Op{Kind: CreateLocalDir, Path: o.Path, EntryKind: localfs.KindDir, RemoteID: o.RemoteID, RemoteName: name, Target: absent,
				Base: o.Base, Reason: "deleted here, but one.gy has new content inside"}
		case r.restorable(o.Base): // deleted on one.gy: restore it there
			*o = Op{Kind: RestoreRemote, Path: o.Path, EntryKind: localfs.KindDir, RemoteID: o.Base.RemoteID, Local: o.Local, Base: o.Base,
				Reason: "deleted on one.gy, but this computer has new content inside: restored from the one.gy trash"}
			restored = append(restored, o.Path)
		default: // deleted on one.gy: re-create it there
			name, ok := r.remoteName(o.Path, o.Base)
			if !ok {
				o.Kind = ""
				continue
			}
			*o = Op{Kind: CreateRemoteDir, Path: o.Path, EntryKind: localfs.KindDir, ParentPath: parentOf(o.Path), RemoteName: name,
				Local: o.Local, Base: o.Base, Reason: "deleted on one.gy, but this computer has new content inside"}
		}
		j := sort.SearchStrings(keep, o.Path)
		keep = append(keep, "")
		copy(keep[j+1:], keep[j:])
		keep[j] = o.Path
	}
	// Synced items below a restored folder come back with it.
	for i := range r.ops {
		o := &r.ops[i]
		for _, d := range restored {
			if o.Kind == DeleteLocal && o.Base != nil && strings.HasPrefix(o.Path, d+"/") {
				o.Kind = ""
			}
		}
	}
}

// suppressSubtreeDeletes drops deletes under a folder that is deleted as a
// whole on the same side (the folder op covers them, rows included).
func (r *run) suppressSubtreeDeletes() {
	local, remote := map[string]bool{}, map[string]bool{}
	for _, o := range r.ops {
		if o.EntryKind == localfs.KindDir && o.Kind == DeleteLocal {
			local[o.Path] = true
		} else if o.EntryKind == localfs.KindDir && o.Kind == TrashRemote {
			remote[o.Path] = true
		}
	}
	covered := func(set map[string]bool, p string) bool {
		for q := parentOf(p); q != ""; q = parentOf(q) {
			if set[q] {
				return true
			}
		}
		return false
	}
	for i := range r.ops {
		o := &r.ops[i]
		switch o.Kind {
		case DeleteLocal:
			if covered(local, o.Path) {
				o.Kind = ""
			}
		case TrashRemote:
			if o.Base != nil && covered(remote, o.Path) {
				o.Kind = ""
			}
		case Forget:
			if covered(local, o.Path) || covered(remote, o.Path) {
				o.Kind = ""
			}
		}
	}
}

// massDelete holds back deletes of synced items when one pass would delete
// more than MassDeleteCount items and MassDeletePercent of the sync on
// either side, unless the user already answered.
func (r *run) massDelete() {
	paths := make([]string, len(r.base))
	for i, b := range r.base {
		paths[i] = b.RelPath
	}
	sort.Strings(paths)
	rowsAt := func(o *Op) int {
		if o.EntryKind != localfs.KindDir {
			return 1
		}
		i := sort.SearchStrings(paths, o.Path+"/")
		j := sort.SearchStrings(paths, o.Path+"0") // '0' follows '/'
		return 1 + j - i
	}
	for _, side := range []struct {
		kind      OpKind
		name, ans string
		msg       string
		actions   []string
	}{
		{TrashRemote, "local", r.cfg.MassDeleteLocal, "%d items were deleted on this computer. Delete them on one.gy too?", []string{"keep_local", "keep_remote", "open"}},
		{DeleteLocal, "remote", r.cfg.MassDeleteRemote, "%d items were deleted on one.gy. Delete them on this computer too?", []string{"keep_remote", "keep_local", "open"}},
	} {
		n := 0
		for i := range r.ops {
			if o := &r.ops[i]; o.Kind == side.kind && o.Base != nil {
				n += rowsAt(o)
			}
		}
		if side.ans == "apply" || n <= r.cfg.MassDeleteCount || n*100 <= r.cfg.MassDeletePercent*len(r.base) {
			continue
		}
		for i := range r.ops {
			if o := &r.ops[i]; o.Kind == side.kind && o.Base != nil {
				o.Kind = ""
			}
		}
		r.issues = append(r.issues, Issue{Kind: "mass_delete", Message: fmt.Sprintf(side.msg, n), Actions: side.actions,
			Detail: map[string]any{"side": side.name, "count": n}})
	}
}
