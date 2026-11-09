package reconcile

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/tifuck/one.gy/desktop/engine/internal/ignore"
	"github.com/tifuck/one.gy/desktop/engine/internal/localfs"
	"github.com/tifuck/one.gy/desktop/engine/internal/scan"
	"github.com/tifuck/one.gy/desktop/engine/internal/state"
)

// world is a test fixture: local entries, remote nodes (root "root") and base rows.
type world struct {
	local   map[string]*scan.Entry
	remote  []RemoteNode
	base    []*state.SyncedRow
	cfg     Config
	rules   string
	stall   map[string]string
	trashed map[string]int64
}

func newWorld() *world {
	return &world{local: map[string]*scan.Entry{}, cfg: Config{Type: "two_way", ConflictPolicy: "keep_both", IssueMode: "smart",
		PropagateDeletes: true, MassDeleteCount: 50, MassDeletePercent: 20, CaseSensitive: true, FSKind: "ext4", Device: "DEV",
		Now: time.Date(2026, 11, 8, 14, 32, 0, 0, time.UTC), Initial: "merge"}}
}

func (w *world) lf(p, id, sha string) *world {
	w.local[p] = &scan.Entry{Kind: localfs.KindFile, Size: int64(len(sha)), MtimeNs: 1, ID: localfs.FileID(id), Mode: 0o644, SHA256: sha}
	return w
}

func (w *world) ld(p, id string) *world {
	w.local[p] = &scan.Entry{Kind: localfs.KindDir, ID: localfs.FileID(id)}
	return w
}

// rf adds a remote file; sha "" = unknown hash, size = len(sha) or size.
func (w *world) rf(id, parent, name, sha string, ver, seq int64) *world {
	w.remote = append(w.remote, RemoteNode{ID: id, Kind: localfs.KindFile, ParentID: parent, Name: name, NameOK: true, Seq: seq,
		ContentVersion: ver, PayloadChecksum: "pc-" + id, Size: int64(len(sha)), SHA256: sha})
	return w
}

func (w *world) rd(id, parent, name string, seq int64) *world {
	w.remote = append(w.remote, RemoteNode{ID: id, Kind: localfs.KindDir, ParentID: parent, Name: name, NameOK: true, Seq: seq})
	return w
}

func (w *world) bf(p, rid, fid, sha string, ver int64) *world {
	w.base = append(w.base, &state.SyncedRow{SyncID: "s", RelPath: p, Kind: "file", RemoteID: rid, LocalFID: fid, Size: int64(len(sha)),
		PlainSHA256: sha, RemoteContentVersion: ver, RemoteName: p[strings.LastIndex(p, "/")+1:]})
	return w
}

func (w *world) bd(p, rid, fid string) *world {
	w.base = append(w.base, &state.SyncedRow{SyncID: "s", RelPath: p, Kind: "folder", RemoteID: rid, LocalFID: fid,
		RemoteName: p[strings.LastIndex(p, "/")+1:]})
	return w
}

func (w *world) tree() *scan.Tree {
	rules := ignore.NewSet()
	if w.rules != "" {
		r, errs := ignore.Parse(w.rules)
		if errs != nil {
			panic(errs)
		}
		rules.Add("", r)
	}
	st := w.stall
	if st == nil {
		st = map[string]string{}
	}
	return &scan.Tree{Entries: w.local, Stalled: st, Rules: rules}
}

func (w *world) plan(*testing.T) *Plan {
	return Reconcile(&Input{Config: w.cfg, Local: w.tree(), Remote: Remote{RootID: "root", Nodes: w.remote, Trashed: w.trashed}, Base: w.base})
}

// summary renders ops as "kind [from>]path[ @remote-id for replace uploads]".
func summary(p *Plan) []string {
	var out []string
	for _, o := range p.Ops {
		s := string(o.Kind) + " "
		if o.From != "" {
			s += o.From + ">"
		}
		s += o.Path
		if o.Kind == Upload && o.RemoteID != "" {
			s += " @" + o.RemoteID
		}
		out = append(out, s)
	}
	return out
}

func issueKinds(p *Plan) []string {
	var out []string
	for _, is := range p.Issues {
		out = append(out, is.Kind+" "+is.Path)
	}
	sort.Strings(out)
	return out
}

func eq(t *testing.T, label string, got []string, want ...string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(append([]string(nil), want...)) && !(len(got) == 0 && len(want) == 0) {
		t.Errorf("%s:\n got  %q\n want %q", label, got, want)
	}
}

func opOf(t *testing.T, p *Plan, kind OpKind) Op {
	t.Helper()
	for _, o := range p.Ops {
		if o.Kind == kind {
			return o
		}
	}
	t.Fatalf("no %s op in %q", kind, summary(p))
	return Op{}
}
