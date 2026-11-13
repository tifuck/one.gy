package reconcile

import (
	"fmt"
	"strings"

	"github.com/tifuck/one.gy/client/internal/localfs"
)

// Items with no synced row: created on one side, or on both (first run,
// rebuild after a lost state DB). Config.Initial decides the first run;
// "source" sides never destroy data (replaced items go to debris or trash).

const fat32Max = 1<<32 - 1

func (r *run) initial() string {
	if r.first {
		return r.cfg.Initial
	}
	return ""
}

func (r *run) decideNew(local []string, remote []*rnode) {
	byKey := map[string]*rnode{}
	for _, rn := range remote {
		byKey[r.key(rn.path)] = rn
	}
	paired := map[string]bool{}
	for _, p := range local {
		e := r.local.Entries[p]
		if rn := byKey[r.key(p)]; rn != nil {
			paired[rn.ID] = true
			r.newPair(&item{kind: e.Kind, lpath: p, l: e, rn: rn})
			continue
		}
		r.localOnly(p, e)
	}
	for _, rn := range remote {
		if !paired[rn.ID] && !r.claimedRemote[rn.ID] { // claimed: trashed as a duplicate of a base item
			r.remoteOnly(rn)
		}
	}
}

// newPair: created on both sides at the same path.
func (r *run) newPair(it *item) {
	e, n, p := it.l, it.rn, r.lp(it.lpath)
	switch {
	case e.Kind != n.Kind:
		switch {
		case r.k.up && r.k.down:
			r.conflictCopy(e, n, p, nil, "file and folder at the same name")
		case r.k.down:
			r.deleteLocal(it, "download-only sync: replaced by the one.gy version")
		default:
			r.issue("conflict", p, "A file and a folder have the same name here and on one.gy.", "rename", "ignore")
			r.stallPath(p)
		}
	case e.Kind == localfs.KindDir:
		r.add(Op{Kind: Link, Path: p, EntryKind: e.Kind, RemoteID: n.ID, RemoteName: n.Name, Local: expect(e), Reason: "folder on both sides"})
	case n.SHA256 != "" && n.SHA256 == e.SHA256:
		r.add(Op{Kind: Link, Path: p, EntryKind: e.Kind, RemoteID: n.ID, RemoteName: n.Name, Size: e.Size, SHA256: e.SHA256,
			ContentVersion: n.ContentVersion, Local: expect(e), Reason: "same file on both sides"})
	case n.SHA256 == "" && n.Size == e.Size:
		r.add(Op{Kind: VerifyLink, Path: p, EntryKind: e.Kind, RemoteID: n.ID, RemoteName: n.Name, Size: e.Size, SHA256: e.SHA256,
			ContentVersion: n.ContentVersion, PayloadChecksum: n.PayloadChecksum, Local: expect(e), Reason: "same size; compare content"})
	case !r.k.up:
		r.download(n, p, expect(e), nil, "download-only sync")
	case r.initial() == "local_source":
		r.replaceRemote(it, p)
	case !r.k.down && r.cfg.Versioning:
		r.upload(it, p, n.ContentVersion, "upload-only sync: replaces the one.gy file (kept as a version)")
	case !r.k.down:
		r.issue("conflict", p, "A different file with this name is already on one.gy, but this sync only uploads.", "keep_local", "keep_remote", "ignore")
		r.stallPath(p)
	case r.initial() == "remote_source":
		r.download(n, p, expect(e), nil, "one.gy is the source")
	default:
		r.contentConflict(it, p)
	}
}

// replaceRemote puts the local file in place of the one.gy one. Without
// versions the old file goes to the one.gy trash instead of being overwritten.
func (r *run) replaceRemote(it *item, p string) {
	if r.cfg.Versioning {
		r.upload(it, p, it.rn.ContentVersion, "this computer is the source (old version kept)")
		return
	}
	r.create(it.l, p, it.rn.Name, nil, "this computer is the source")
	r.add(Op{Kind: TrashRemote, Path: p, EntryKind: it.rn.Kind, RemoteID: it.rn.ID, RemoteSeq: it.rn.Seq, Size: it.rn.Size,
		Reason: "replaced by this computer's version (moved to the one.gy trash)"})
}

func (r *run) localOnly(p string, e *localEntry) {
	it := &item{kind: e.Kind, lpath: p, l: e}
	switch {
	case !r.k.up:
		r.deleteLocal(it, "download-only sync: local additions are reverted")
	case r.k.down && r.initial() == "remote_source":
		r.deleteLocal(it, "one.gy is the source")
	case r.localDests[r.key(p)]:
		r.conflictCopy(e, nil, r.lp(p), nil, "a one.gy item arrives at this name")
	case r.isRO(p):
		r.issue("read_only", p, "This one.gy folder is a backup of another device and cannot be changed from here.", "ignore")
		r.stallPath(p)
	default:
		if name, ok := r.remoteName(p, nil); ok {
			r.create(e, r.lp(p), name, nil, "new on this computer")
		}
	}
}

func (r *run) remoteOnly(rn *rnode) {
	if r.isStalled(rn.path) { // e.g. a name collision waiting for the user
		return
	}
	for _, t := range r.trashedNew {
		if strings.HasPrefix(rn.path, t+"/") {
			return
		}
	}
	switch {
	case r.k.up && r.initial() == "local_source" && r.cfg.Type != "archive" && !rn.readOnly:
		r.add(Op{Kind: TrashRemote, Path: rn.path, EntryKind: rn.Kind, RemoteID: rn.ID, RemoteSeq: rn.Seq, Size: rn.Size,
			Reason: "this computer is the source (moved to the one.gy trash)"})
		if rn.Kind == localfs.KindDir {
			r.trashedNew = append(r.trashedNew, rn.path)
		}
		return
	case !r.k.down:
		return
	case rn.Kind == localfs.KindFile && rn.Size > fat32Max && (r.cfg.FSKind == "vfat" || r.cfg.FSKind == "fat32"):
		r.issue("too_large", rn.path, "This file is larger than 4 GB, the limit of this drive.", "ignore")
		r.stallPath(rn.path)
		return
	}
	p := rn.path
	if len(r.localKeys[r.key(p)]) > 0 && !r.vacated[r.key(p)] { // a synced local item stays at this name
		if rn.Kind == localfs.KindDir {
			r.issue("name_clash", p, "A local item already uses this name.", "rename", "ignore")
			r.stallPath(p)
			return
		}
		for i := 2; ; i++ {
			cand := join(parentOf(p), localfs.InsertSuffix(r.names.ToLocal(rn.Name), fmt.Sprintf(" (%d)", i)))
			if !r.taken[r.key(cand)] {
				p = cand
				break
			}
		}
	}
	if rn.Kind == localfs.KindDir {
		r.add(Op{Kind: CreateLocalDir, Path: p, EntryKind: rn.Kind, RemoteID: rn.ID, RemoteName: rn.Name, Target: absent, Reason: "new on one.gy"})
		return
	}
	r.download(rn, p, absent, nil, "new on one.gy")
}
