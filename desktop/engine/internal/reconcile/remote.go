package reconcile

import (
	"fmt"
	"path"
	"sort"

	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
)

// Remote side: give every remote node the local path it maps to (plan 7.7
// name rules), resolving names the local file system cannot hold and
// siblings that would land on the same local name.

type rnode struct {
	*RemoteNode
	path     string
	readOnly bool
}

func join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func parentOf(p string) string {
	if d := path.Dir(p); d != "." {
		return d
	}
	return ""
}

// walkRemote places the children of parentID (local path ppath).
func (r *run) walkRemote(parentID, ppath string, ro bool) {
	type cand struct {
		n    *RemoteNode
		name string
	}
	groups := map[string][]cand{}
	var order []string
	for _, n := range r.kids[parentID] {
		if !n.NameOK {
			r.issue("integrity", ppath, fmt.Sprintf("A one.gy item (id %s) has a name that cannot be decrypted; it is skipped.", n.ID), "ignore")
			r.stallRemote(n)
			continue
		}
		if n.Name == "" {
			r.issue("invalid_name", ppath, fmt.Sprintf("A one.gy item (id %s) has an empty name; it is skipped.", n.ID), "ignore")
			r.stallRemote(n)
			continue
		}
		var name string
		if b := r.baseByID[n.ID]; b != nil && b.RemoteName == n.Name {
			name = path.Base(b.RelPath) // keep the mapping chosen when it was synced
		} else {
			name = r.names.ToLocal(n.Name)
			if name != n.Name && r.cfg.IssueMode == "advanced" {
				r.issue("invalid_name", join(ppath, name), "The one.gy name "+fmt.Sprintf("%q", n.Name)+" is not allowed on this computer.", "rename", "ignore")
				r.stallRemote(n)
				r.stallPath(join(ppath, name))
				continue
			}
		}
		if r.names.TooLong(name) {
			r.issue("invalid_name", join(ppath, name), "The name is too long for this drive.", "rename", "ignore")
			r.stallRemote(n)
			continue
		}
		k := r.key(name)
		if groups[k] == nil {
			order = append(order, k)
		}
		groups[k] = append(groups[k], cand{n, name})
	}
	used := map[string]bool{}
	for k := range groups {
		used[k] = true
	}
	for _, k := range order {
		g := groups[k]
		if len(g) == 1 {
			r.place(g[0].n, join(ppath, g[0].name), ro)
			continue
		}
		ns := make([]*RemoteNode, len(g))
		names := make([]string, len(g))
		for i, c := range g {
			ns[i], names[i] = c.n, c.name
		}
		r.clash(ppath, ns, names, used, ro)
	}
}

func (r *run) place(n *RemoteNode, p string, ro bool) {
	rn := &rnode{RemoteNode: n, path: p, readOnly: ro || n.ReadOnly}
	r.remote[n.ID] = rn
	if n.Kind == localfs.KindDir {
		if rn.readOnly {
			r.roPaths[p] = true
		}
		r.walkRemote(n.ID, p, rn.readOnly)
	}
}

// stallRemote leaves n and its subtree unplaced this pass; base rows that
// point at them are skipped rather than taken for remote deletes.
func (r *run) stallRemote(n *RemoteNode) {
	r.remoteStalled[n.ID] = true
	for _, c := range r.kids[n.ID] {
		r.stallRemote(c)
	}
}

func (r *run) fileCount(id string) int {
	n := 0
	for _, c := range r.kids[id] {
		if c.Kind == localfs.KindFile {
			n++
		} else {
			n += r.fileCount(c.ID)
		}
	}
	return n
}

// clash handles siblings that map to the same local name (plan 7.7 issues:
// same name, case-only, duplicate folders).
func (r *run) clash(ppath string, g []*RemoteNode, names []string, used map[string]bool, ro bool) {
	exact, allDirs, allFiles := true, true, true
	for i, n := range g {
		exact = exact && localfs.NFC(names[i]) == localfs.NFC(names[0])
		allDirs = allDirs && n.Kind == localfs.KindDir
		allFiles = allFiles && n.Kind == localfs.KindFile
	}
	kind := "case_clash"
	if exact {
		kind = "name_clash"
	}
	if r.cfg.IssueMode == "advanced" {
		for i, n := range g {
			r.issue(kind, join(ppath, names[i]), "Several one.gy items map to this name here.", "rename", "ignore")
			r.stallRemote(n)
		}
		r.stallPath(join(ppath, names[0]))
		return
	}
	// Main: the one already synced, then folders, then the folder with more
	// files, then the oldest.
	idx := make([]int, len(g))
	for i := range idx {
		idx[i] = i
	}
	files := map[string]int{}
	for _, n := range g {
		if n.Kind == localfs.KindDir {
			files[n.ID] = r.fileCount(n.ID)
		}
	}
	sort.SliceStable(idx, func(a, b int) bool {
		x, y := g[idx[a]], g[idx[b]]
		if bx, by := r.baseByID[x.ID] != nil, r.baseByID[y.ID] != nil; bx != by {
			return bx
		}
		if x.Kind != y.Kind {
			return x.Kind == localfs.KindDir
		}
		if files[x.ID] != files[y.ID] {
			return files[x.ID] > files[y.ID]
		}
		if x.Seq != y.Seq {
			return x.Seq < y.Seq
		}
		return x.ID < y.ID
	})
	main := g[idx[0]]
	mainPath := join(ppath, names[idx[0]])
	writable := r.k.up && !ro && !main.ReadOnly
	if exact && allDirs && writable {
		r.place(main, mainPath, ro)
		for _, i := range idx[1:] {
			r.mergeInto(main, mainPath, g[i])
		}
		return
	}
	if exact && allFiles && writable && main.SHA256 != "" {
		same := true
		for _, i := range idx[1:] {
			same = same && g[i].SHA256 == main.SHA256
		}
		if same {
			r.place(main, mainPath, ro)
			for _, i := range idx[1:] {
				d := g[i]
				r.stallRemote(d)
				r.add(Op{Kind: TrashRemote, Path: mainPath, EntryKind: d.Kind, RemoteID: d.ID, RemoteSeq: d.Seq, Size: d.Size,
					Reason: "identical duplicate on one.gy"})
			}
			return
		}
	}
	r.place(main, mainPath, ro)
	for _, i := range idx[1:] {
		for n := 2; ; n++ {
			label := fmt.Sprintf(" (%d)", n)
			if !exact {
				label = fmt.Sprintf(" (case %d)", n)
			}
			cand := localfs.InsertSuffix(names[i], label)
			if k := r.key(cand); !used[k] {
				used[k] = true
				r.place(g[i], join(ppath, cand), ro)
				break
			}
		}
	}
}

// mergeInto moves the children of dup into main (MEGA's merge): identical
// files are trashed, other name clashes get a " (n)" suffix on one.gy, and
// the emptied duplicate is trashed. Sub-folder clashes merge on a later pass.
func (r *run) mergeInto(main *RemoteNode, mainPath string, dup *RemoteNode) {
	r.stallRemote(dup)
	have := map[string]*RemoteNode{}
	for _, c := range r.kids[main.ID] {
		if c.NameOK {
			have[r.key(r.names.ToLocal(c.Name))] = c
		}
	}
	keep := false
	for _, c := range r.kids[dup.ID] {
		if !c.NameOK {
			keep = true
			continue
		}
		name := c.Name
		k := r.key(r.names.ToLocal(name))
		if m := have[k]; m != nil {
			if m.Kind == localfs.KindFile && c.Kind == localfs.KindFile && m.SHA256 != "" && m.SHA256 == c.SHA256 {
				r.add(Op{Kind: TrashRemote, Path: join(mainPath, r.names.ToLocal(name)), EntryKind: c.Kind, RemoteID: c.ID,
					RemoteSeq: c.Seq, Size: c.Size, Reason: "identical file in a duplicate folder"})
				continue
			}
			if m.Kind != localfs.KindDir || c.Kind != localfs.KindDir {
				for n := 2; ; n++ {
					cand := localfs.InsertSuffix(c.Name, fmt.Sprintf(" (%d)", n))
					if kk := r.key(r.names.ToLocal(cand)); have[kk] == nil {
						name, k = cand, kk
						break
					}
				}
			}
		}
		have[k] = c
		r.add(Op{Kind: MoveRemote, Path: join(mainPath, r.names.ToLocal(name)), EntryKind: c.Kind, RemoteID: c.ID, RemoteSeq: c.Seq,
			ParentPath: mainPath, ParentRemoteID: main.ID, RemoteName: name, Reason: "merge duplicate folder"})
	}
	if !keep {
		r.add(Op{Kind: TrashRemote, Path: mainPath, EntryKind: localfs.KindDir, RemoteID: dup.ID, RemoteSeq: dup.Seq,
			Reason: "duplicate folder merged"})
	}
}
