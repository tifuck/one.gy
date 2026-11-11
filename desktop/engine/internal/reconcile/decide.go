package reconcile

import (
	"fmt"
	"path"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
)

// The three-way matrix of plan 7.7 per sync type (plan 6.1).

func (r *run) decideBase(it *item) {
	b, n := it.b, it.rn
	ld, rd := it.l == nil, n == nil
	ltype := !ld && it.l.Kind != it.kind
	file := it.kind == localfs.KindFile
	if !rd && !it.replaced && file && n.ContentVersion < b.RemoteContentVersion {
		r.issue("integrity", b.RelPath, "one.gy served an older version than this computer already synced; it was not applied.", "retry", "ignore")
		r.stallPath(b.RelPath)
		return
	}
	lc := !ld && !ltype && file && it.l.SHA256 != b.PlainSHA256
	rc := !rd && file && (it.replaced || n.ContentVersion != b.RemoteContentVersion) && !(n.SHA256 != "" && n.SHA256 == b.PlainSHA256)
	lm := !ld && it.lpath != b.RelPath
	rm := !rd && !it.replaced && n.path != b.RelPath
	switch {
	case ld && rd:
		r.add(Op{Kind: Forget, Path: b.RelPath, EntryKind: it.kind, Base: b, Reason: "deleted on both sides"})
	case ld:
		r.localGone(it, rc || rm)
	case rd:
		r.remoteGone(it, lc || ltype, lm)
	case ltype || n.Kind != it.kind:
		r.typeChange(it)
	case it.replaced && !file:
		r.add(Op{Kind: Link, Path: r.lp(it.lpath), EntryKind: it.kind, RemoteID: n.ID, RemoteName: n.Name, Local: expect(it.l), Base: b,
			Reason: "folder re-created on one.gy"})
	case r.k.up && r.k.down:
		r.twoWay(it, lc, rc, lm, rm)
	case r.k.down:
		r.mirror(it, lc, rc)
	default:
		r.upOnly(it, lc, rc, lm, rm)
	}
}

// localGone: deleted on this computer, still on one.gy.
func (r *run) localGone(it *item, remoteChanged bool) {
	switch {
	case !r.k.up: // mirror reverts local deletes
		r.restoreLocal(it)
	case !r.k.down:
		if remoteChanged {
			r.add(Op{Kind: Forget, Path: it.b.RelPath, EntryKind: it.kind, Base: it.b, Reason: "deleted here, changed on one.gy: kept there"})
		} else if r.k.delRemote {
			r.trashRemote(it)
		}
	case remoteChanged || r.cfg.MassDeleteLocal == "restore": // edits beat deletes
		r.restoreLocal(it)
	case r.k.delRemote:
		r.trashRemote(it)
	}
}

// remoteGone: deleted (or moved out of the sync) on one.gy, still here.
func (r *run) remoteGone(it *item, localChanged, moved bool) {
	switch {
	case !r.k.down:
		r.reupload(it, "missing on one.gy")
	case !r.k.up:
		if r.k.delLocal {
			r.deleteLocal(it, "deleted on one.gy")
		}
	case localChanged || moved || r.cfg.MassDeleteRemote == "restore": // edits beat deletes
		r.reupload(it, "changed here, deleted on one.gy")
	case r.k.delLocal:
		r.deleteLocal(it, "deleted on one.gy")
	}
}

func (r *run) restoreLocal(it *item) {
	n := it.rn
	if it.kind == localfs.KindDir {
		r.add(Op{Kind: CreateLocalDir, Path: n.path, EntryKind: it.kind, RemoteID: n.ID, RemoteName: n.Name, Target: absent, Base: it.b,
			Reason: "restored from one.gy"})
		return
	}
	r.download(n, n.path, absent, it.b, "restored from one.gy")
}

func (r *run) download(n *rnode, p string, local *Expect, b *stateRow, reason string) {
	r.add(Op{Kind: Download, Path: p, EntryKind: localfs.KindFile, RemoteID: n.ID, RemoteName: n.Name, Size: n.Size, SHA256: n.SHA256,
		ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: local, Base: b, Reason: reason})
}

func (r *run) trashRemote(it *item) {
	r.add(Op{Kind: TrashRemote, Path: it.b.RelPath, EntryKind: it.kind, RemoteID: it.rn.ID, RemoteSeq: it.rn.Seq, Size: it.b.Size,
		Base: it.b, Reason: "deleted on this computer"})
}

func (r *run) deleteLocal(it *item, reason string) {
	r.add(Op{Kind: DeleteLocal, Path: r.lp(it.lpath), EntryKind: it.l.Kind, Size: it.l.Size, Local: expect(it.l), Base: it.b, Reason: reason})
}

// reupload creates the local item on one.gy again at its current path, or
// restores it from the one.gy trash when that brings back the same item.
func (r *run) reupload(it *item, reason string) {
	if it.l.Kind == it.kind && r.restorable(it.b) {
		r.add(Op{Kind: RestoreRemote, Path: it.b.RelPath, EntryKind: it.kind, RemoteID: it.b.RemoteID, Base: it.b,
			Reason: reason + ": restored from the one.gy trash"})
		return
	}
	p := r.lp(it.lpath)
	name, ok := r.remoteName(it.lpath, it.b)
	if !ok {
		return
	}
	r.create(it.l, p, name, it.b, reason)
}

func (r *run) create(e *localEntry, p, name string, b *stateRow, reason string) {
	o := Op{Kind: Upload, Path: p, EntryKind: e.Kind, ParentPath: parentOf(p), RemoteName: name, Local: expect(e), Base: b, Reason: reason}
	if e.Kind == localfs.KindDir {
		o.Kind = CreateRemoteDir
	} else {
		o.Size, o.SHA256, o.Mode = e.Size, e.SHA256, e.Mode
	}
	r.add(o)
}

func (r *run) upload(it *item, p string, cas int64, reason string) {
	e := it.l
	r.add(Op{Kind: Upload, Path: p, EntryKind: localfs.KindFile, RemoteID: it.rn.ID, RemoteName: it.rn.Name, ContentVersion: cas,
		Size: e.Size, SHA256: e.SHA256, Mode: e.Mode, Local: expect(e), Base: it.b, Reason: reason})
}

// typeChange: file <-> folder at the same name is a conflict (plan 7.7).
func (r *run) typeChange(it *item) {
	switch {
	case r.k.up && r.k.down:
		r.conflictCopy(it.l, it.rn, r.lp(it.lpath), it.b, "file and folder at the same name")
	case r.k.down:
		r.deleteLocal(it, "download-only sync: replaced by the one.gy version")
	case r.k.delRemote && !it.replaced:
		r.trashRemote(it) // the local item is uploaded as new next pass
	default:
		r.add(Op{Kind: Forget, Path: it.b.RelPath, EntryKind: it.kind, Base: it.b, Reason: "type changed here"})
	}
}

func (r *run) twoWay(it *item, lc, rc, lm, rm bool) {
	n := it.rn
	final := r.lp(it.lpath)
	switch {
	case rm && it.lpath != n.path: // includes moved on both sides to different places: one.gy wins
		reason := "moved on one.gy"
		if lm {
			reason = "moved on both sides; the one.gy location wins"
		}
		if final != n.path {
			r.moveLocal(it, final, n.path, reason)
		}
		final = n.path
	case lm && !rm:
		if from := r.rp(n.path); from != final {
			var ok bool
			if final, ok = r.remoteMove(it, from, final, "moved on this computer"); !ok {
				return
			}
		}
	case lm && rm && !lc && !rc: // moved to the same place on both sides
		r.add(Op{Kind: Link, Path: final, EntryKind: it.kind, RemoteID: n.ID, RemoteName: n.Name, Size: n.Size, SHA256: it.l.SHA256,
			ContentVersion: n.ContentVersion, Local: expect(it.l), Base: it.b, Reason: "moved to the same place on both sides"})
	}
	switch {
	case lc && rc:
		r.contentConflict(it, final)
	case lc: // !rc: the one.gy content is the base content, maybe under a newer version
		r.upload(it, final, n.ContentVersion, "changed on this computer")
	case rc:
		r.download(n, final, expect(it.l), it.b, "changed on one.gy")
	default:
		r.modes(it, final)
	}
}

func (r *run) moveLocal(it *item, from, to, reason string) {
	r.add(Op{Kind: MoveLocal, From: from, Path: to, EntryKind: it.kind, RemoteID: it.rn.ID, RemoteName: it.rn.Name,
		Local: expect(it.l), Target: absent, Base: it.b, Reason: reason})
	r.localMoves = append(r.localMoves, move{from, to})
}

func (r *run) policy() string {
	p := r.cfg.ConflictPolicy
	if (p == "prefer_remote" || p == "prefer_local") && !r.cfg.Versioning {
		return "keep_both" // the losing copy must survive (plan 6.2)
	}
	if p == "" {
		return "keep_both"
	}
	return p
}

// contentConflict: changed on both sides (or created on both) with different content.
func (r *run) contentConflict(it *item, p string) {
	n, e := it.rn, it.l
	if n.SHA256 != "" && n.SHA256 == e.SHA256 {
		r.add(Op{Kind: Link, Path: p, EntryKind: localfs.KindFile, RemoteID: n.ID, RemoteName: n.Name, Size: e.Size, SHA256: e.SHA256,
			ContentVersion: n.ContentVersion, Local: expect(e), Base: it.b, Reason: "same content on both sides"})
		return
	}
	switch r.policy() {
	case "ask":
		r.issues = append(r.issues, Issue{Kind: "conflict", Path: p, Message: "Changed on both this computer and one.gy.",
			Actions: []string{"keep_both", "keep_remote", "keep_local", "ignore"},
			Detail:  map[string]any{"local": map[string]any{"size": e.Size, "sha256": e.SHA256}, "remote": map[string]any{"size": n.Size, "sha256": n.SHA256}}})
		r.stallPath(p)
	case "prefer_remote":
		r.download(n, p, expect(e), it.b, "conflict: one.gy preferred")
	case "prefer_local":
		r.upload(it, p, n.ContentVersion, "conflict: this computer preferred")
	default:
		r.conflictCopy(e, n, p, it.b, "changed on both sides")
	}
}

// conflictCopy renames the local item out of the way; the one.gy version
// (n, nil when unknown) keeps the name (share links point at it).
func (r *run) conflictCopy(e *localEntry, n *rnode, p string, b *stateRow, reason string) {
	o := Op{Kind: Conflict, From: p, Path: r.conflictName(p), EntryKind: e.Kind, Size: e.Size, Local: expect(e), Target: absent,
		Base: b, Reason: reason}
	if n != nil && n.Kind == localfs.KindFile {
		o.RemoteSize = n.Size
	}
	r.add(o)
}

// conflictName: "report (conflict from LAPTOP 2026-11-08 1432).docx",
// with " 2", " 3" inside the parentheses if taken.
func (r *run) conflictName(p string) string {
	dir, name := parentOf(p), path.Base(p)
	label := "conflict from " + r.names.ToLocal(r.cfg.Device) + " " + r.cfg.Now.Format("2006-01-02 1504")
	for i := 1; ; i++ {
		l := label
		if i > 1 {
			l = fmt.Sprintf("%s %d", label, i)
		}
		cand := join(dir, localfs.InsertSuffix(name, " ("+l+")"))
		if k := r.key(cand); !r.taken[k] {
			r.taken[k] = true
			return cand
		}
	}
}

// mirror: one.gy is the truth; local edits and moves are reverted (the old
// local copy goes to debris through the download's replace).
func (r *run) mirror(it *item, lc, rc bool) {
	n := it.rn
	if from := r.lp(it.lpath); from != n.path {
		r.moveLocal(it, from, n.path, "download-only sync: one.gy location")
	}
	if lc || rc {
		r.download(n, n.path, expect(it.l), it.b, "download-only sync")
	} else {
		r.modes(it, n.path)
	}
}

// upOnly (backup, archive): this computer is the truth for structure and
// content. A change made on one.gy is only overwritten when versions keep it.
func (r *run) upOnly(it *item, lc, rc, lm, rm bool) {
	n := it.rn
	final := r.lp(it.lpath)
	if from := r.rp(n.path); (lm || rm) && from != final {
		var ok bool
		if final, ok = r.remoteMove(it, from, final, "upload-only sync: this computer's location"); !ok {
			return
		}
	}
	switch {
	case rc && r.cfg.Versioning:
		r.upload(it, final, n.ContentVersion, "upload-only sync: replaces the one.gy change (kept as a version)")
	case rc:
		r.issues = append(r.issues, Issue{Kind: "conflict", Path: final, Message: "Changed on one.gy, but this sync only uploads.",
			Actions: []string{"keep_local", "keep_remote", "ignore"}})
		r.stallPath(final)
	case lc:
		r.upload(it, final, n.ContentVersion, "changed on this computer")
	default:
		r.modes(it, final)
	}
}
