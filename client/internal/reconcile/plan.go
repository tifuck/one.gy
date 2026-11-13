package reconcile

import (
	"path"
	"sort"
	"strings"

	"github.com/tifuck/one.gy/client/internal/ignore"
	"github.com/tifuck/one.gy/client/internal/localfs"
	"github.com/tifuck/one.gy/client/internal/scan"
	"github.com/tifuck/one.gy/client/internal/state"
)

// run is the state of one Reconcile call.
type run struct {
	cfg   *Config
	k     caps
	names localfs.Names
	local *scan.Tree
	first bool // no base rows yet: Config.Initial applies

	base       []*state.SyncedRow
	baseByID   map[string]*state.SyncedRow
	baseByPath map[string]*state.SyncedRow

	kids          map[string][]*RemoteNode
	remote        map[string]*rnode // placed remote nodes by id
	remoteStalled map[string]bool
	roPaths       map[string]bool
	newAt         map[string]*rnode // keys of remote paths held by nodes no base row claimed
	trashed       map[string]int64  // Remote.Trashed
	goneLocal     map[string]bool   // base paths whose local item is gone

	localKeys     map[string][]string // key -> local paths
	claimedLocal  map[string]bool     // local paths owned by a base item
	claimedRemote map[string]bool
	stalledKeys   map[string]bool // keys of paths where nothing may be planned
	stalledList   []string        // the same paths, as given
	taken         map[string]bool // keys of local names in use (conflict copy names)
	localDests    map[string]bool // keys of planned local destinations
	vacated       map[string]bool // keys of local paths planned to be moved away
	trashedNew    []string        // new remote folders trashed by local_source

	localMoves, remoteMoves []move

	ops    []Op
	issues []Issue
}

type (
	stateRow   = state.SyncedRow
	localEntry = scan.Entry
	move       struct{ from, to string }
)

func applyMoves(ms []move, p string) string {
	for _, m := range ms {
		if p == m.from {
			p = m.to
		} else if strings.HasPrefix(p, m.from+"/") {
			p = m.to + p[len(m.from):]
		}
	}
	return p
}

func (r *run) lp(p string) string { return applyMoves(r.localMoves, p) }
func (r *run) rp(p string) string { return applyMoves(r.remoteMoves, p) }

func (r *run) key(p string) string { return localfs.Key(p, r.cfg.CaseSensitive) }

func (r *run) issue(kind, p, msg string, actions ...string) {
	r.issues = append(r.issues, Issue{Kind: kind, Path: p, Message: msg, Actions: actions})
}

func (r *run) stallPath(p string) {
	r.stalledKeys[r.key(p)] = true
	r.stalledList = append(r.stalledList, p)
}

// isStalled: p or an ancestor is stalled locally (scan) or by a decision.
func (r *run) isStalled(p string) bool {
	if r.local.IsStalled(p) {
		return true
	}
	for q := p; q != ""; q = parentOf(q) {
		if r.stalledKeys[r.key(q)] {
			return true
		}
	}
	return false
}

// isRO: p is inside a read-only (another device's backup) folder.
func (r *run) isRO(p string) bool {
	for q := p; q != ""; q = parentOf(q) {
		if r.roPaths[q] {
			return true
		}
	}
	return false
}

func (r *run) add(o Op) {
	switch o.Kind {
	case MoveLocal, Conflict:
		r.vacated[r.key(o.From)] = true
		fallthrough
	case CreateLocalDir, Download:
		r.localDests[r.key(o.Path)] = true
		r.taken[r.key(o.Path)] = true
	}
	r.ops = append(r.ops, o)
}

func kindOf(s string) localfs.Kind {
	if s == "folder" {
		return localfs.KindDir
	}
	return localfs.KindFile
}

func expect(e *scan.Entry) *Expect {
	x := &Expect{Kind: e.Kind, ID: e.ID, Size: e.Size, MtimeNs: e.MtimeNs}
	if e.Kind == localfs.KindDir {
		x.Size, x.MtimeNs = 0, 0 // folders: kind and id only
	}
	return x
}

var absent = &Expect{Absent: true}

// item is one thing compared three ways. Base items come from synced rows;
// new items have b == nil.
type item struct {
	b        *state.SyncedRow
	kind     localfs.Kind
	lpath    string
	l        *scan.Entry
	rn       *rnode
	replaced bool // rn is a new remote node at the same path as the base item (deleted + re-created on one.gy)
}

// Reconcile plans one pass. It never performs I/O.
func Reconcile(in *Input) *Plan {
	cfg := in.Config
	switch {
	case cfg.RootMissing:
		return &Plan{Issues: []Issue{{Kind: "root_missing", Message: "The local folder is missing or was replaced. Nothing is synced until it is back.", Actions: []string{"retry", "remove_sync"}}}}
	case in.Remote.RootMissing:
		return &Plan{Issues: []Issue{{Kind: "remote_root_missing", Message: "The one.gy folder was removed.", Actions: []string{"restore_remote_root", "remove_sync"}}}}
	case len(in.Local.Entries) == 0 && len(in.Local.Stalled) == 0 && len(in.Base) > cfg.MassDeleteCount:
		return &Plan{Issues: []Issue{{Kind: "root_missing", Message: "The local folder is empty although it was synced. Is the drive connected?", Actions: []string{"retry", "remove_sync"}}}}
	}
	r := &run{cfg: &cfg, k: capsOf(&cfg), names: localfs.NamesFor(cfg.FSKind), local: in.Local, first: len(in.Base) == 0,
		trashed: in.Remote.Trashed, goneLocal: map[string]bool{}, base: in.Base, baseByID: map[string]*state.SyncedRow{}, baseByPath: map[string]*state.SyncedRow{},
		kids: map[string][]*RemoteNode{}, remote: map[string]*rnode{}, remoteStalled: map[string]bool{}, roPaths: map[string]bool{},
		localKeys: map[string][]string{}, claimedLocal: map[string]bool{}, claimedRemote: map[string]bool{},
		stalledKeys: map[string]bool{}, taken: map[string]bool{}, localDests: map[string]bool{}, vacated: map[string]bool{}}
	for _, b := range in.Base {
		r.baseByPath[b.RelPath] = b
		if b.RemoteID != "" {
			r.baseByID[b.RemoteID] = b
		}
	}
	for i := range in.Remote.Nodes {
		n := &in.Remote.Nodes[i]
		r.kids[n.ParentID] = append(r.kids[n.ParentID], n)
	}
	for _, ks := range r.kids {
		sort.Slice(ks, func(i, j int) bool {
			if ks[i].Seq != ks[j].Seq {
				return ks[i].Seq < ks[j].Seq
			}
			return ks[i].ID < ks[j].ID
		})
	}
	r.walkRemote(in.Remote.RootID, "", false)

	for p := range in.Local.Entries {
		k := r.key(p)
		r.localKeys[k] = append(r.localKeys[k], p)
		r.taken[k] = true
	}
	for _, rn := range r.remote {
		r.taken[r.key(rn.path)] = true
	}
	for _, ps := range r.localKeys {
		if len(ps) > 1 { // NFC/NFD (or case) variants of one name side by side
			sort.Strings(ps)
			for _, p := range ps {
				r.issue("name_clash", p, "Several local items differ only in Unicode form or case; they are skipped.", "rename", "ignore")
			}
			r.stallPath(ps[0])
		}
	}

	items := r.baseItems()
	newLocal, newRemote := r.newItems()
	for _, it := range items {
		r.decideBase(it)
	}
	r.decideNew(newLocal, newRemote)
	r.finish()
	return &Plan{Ops: order(r.ops), Issues: r.issues}
}

// baseItems pairs every synced row with its current local entry and remote node.
func (r *run) baseItems() []*item {
	bases := append([]*state.SyncedRow(nil), r.base...)
	sort.SliceStable(bases, func(i, j int) bool {
		di, dj := strings.Count(bases[i].RelPath, "/"), strings.Count(bases[j].RelPath, "/")
		if di != dj {
			return di < dj
		}
		return bases[i].RelPath < bases[j].RelPath
	})
	byFID := map[localfs.FileID][]string{}
	for p, e := range r.local.Entries {
		if e.ID != "" {
			byFID[e.ID] = append(byFID[e.ID], p)
		}
	}
	free := func(p string, kind localfs.Kind) bool {
		e := r.local.Entries[p]
		return e != nil && e.Kind == kind && !r.claimedLocal[p] && r.baseByPath[p] == nil
	}
	var items []*item
	for _, b := range bases {
		kind := kindOf(b.Kind)
		r.claimedRemote[b.RemoteID] = true
		if r.local.Rules.MatchPath(b.RelPath, kind, b.Size) == ignore.Excluded {
			r.add(Op{Kind: Forget, Path: b.RelPath, EntryKind: kind, Base: b, Reason: "now excluded by " + ignore.FileName})
			continue
		}
		it := &item{b: b, kind: kind}
		switch {
		case r.local.Entries[b.RelPath] != nil:
			it.lpath = b.RelPath // same path = the same item, even with a new file id
		default:
			if ps := r.localKeys[r.key(b.RelPath)]; len(ps) == 1 && free(ps[0], kind) {
				it.lpath = ps[0] // case or Unicode-form rename
			} else if ps := byFID[localfs.FileID(b.LocalFID)]; b.LocalFID != "" && len(ps) == 1 && free(ps[0], kind) {
				it.lpath = ps[0] // moved
			}
		}
		if it.lpath != "" {
			it.l = r.local.Entries[it.lpath]
			r.claimedLocal[it.lpath] = true
		} else {
			r.goneLocal[b.RelPath] = true
		}
		if r.remoteStalled[b.RemoteID] || r.isStalled(b.RelPath) || (it.l != nil && r.isStalled(it.lpath)) {
			r.stallPath(b.RelPath)
			continue
		}
		it.rn = r.remote[b.RemoteID]
		items = append(items, it)
	}
	if !localfs.IdentityStable(r.cfg.FSKind) {
		r.hashMoves(items, free)
	}
	// A new remote node where a base item lost its own: replaced on one.gy.
	r.newAt = map[string]*rnode{}
	for id, rn := range r.remote {
		if !r.claimedRemote[id] {
			r.newAt[r.key(rn.path)] = rn
		}
	}
	for _, it := range items {
		if it.rn == nil && it.l != nil {
			if rn := r.newAt[r.key(it.lpath)]; rn != nil && !r.claimedRemote[rn.ID] {
				it.rn, it.replaced = rn, true
				r.claimedRemote[rn.ID] = true
			}
		}
	}
	return items
}

// hashMoves finds moved files on file systems without ids: a vanished
// synced file and exactly one new file with its size and hash.
func (r *run) hashMoves(items []*item, free func(string, localfs.Kind) bool) {
	bySum := map[string][]string{}
	for p, e := range r.local.Entries {
		if e.Kind == localfs.KindFile && e.SHA256 != "" && free(p, localfs.KindFile) {
			bySum[e.SHA256] = append(bySum[e.SHA256], p)
		}
	}
	for _, it := range items {
		if it.l != nil || it.kind != localfs.KindFile || it.b.PlainSHA256 == "" {
			continue
		}
		if ps := bySum[it.b.PlainSHA256]; len(ps) == 1 && free(ps[0], localfs.KindFile) && r.local.Entries[ps[0]].Size == it.b.Size {
			it.lpath, it.l = ps[0], r.local.Entries[ps[0]]
			r.claimedLocal[ps[0]] = true
			delete(r.goneLocal, it.b.RelPath)
		}
	}
}

// newItems returns the unclaimed local and remote entries, sorted by path.
func (r *run) newItems() (local []string, remote []*rnode) {
	for p, e := range r.local.Entries {
		if !r.claimedLocal[p] && !e.SizeExcluded && !r.isStalled(p) {
			local = append(local, p)
		}
	}
	for id, rn := range r.remote {
		if !r.claimedRemote[id] && !r.isStalled(rn.path) {
			res := r.local.Rules.MatchPath(rn.path, rn.Kind, rn.Size)
			if res == ignore.Included {
				remote = append(remote, rn)
			}
		}
	}
	sort.Strings(local)
	sort.Slice(remote, func(i, j int) bool { return remote[i].path < remote[j].path })
	return local, remote
}

func (r *run) remoteName(lpath string, b *state.SyncedRow) (string, bool) {
	if b != nil && b.RemoteName != "" && path.Base(lpath) == path.Base(b.RelPath) {
		return b.RemoteName, true
	}
	name, ok := r.names.ToRemote(path.Base(lpath))
	if !ok {
		r.issue("invalid_name", lpath, "This name cannot be represented on one.gy; rename it.", "rename", "ignore")
		r.stallPath(lpath)
	}
	return name, ok
}
