package reconcile

import "testing"

const conflictA = "a (conflict from DEV 2026-11-08 1432).txt"

// Every cell of the plan 7.7 table for a synced file "a.txt" (two-way).
func TestMatrixFiles(t *testing.T) {
	local := map[string]func(*world){
		"unchanged": func(w *world) { w.lf("a.txt", "L1", "h1") },
		"modified":  func(w *world) { w.lf("a.txt", "L1", "h2") },
		"deleted":   func(w *world) {},
		"moved":     func(w *world) { w.lf("b.txt", "L1", "h1") },
		"moved+mod": func(w *world) { w.lf("b.txt", "L1", "h2") },
		"saved-new": func(w *world) { w.lf("a.txt", "L9", "h2") }, // safe save: new id, same path = modified
	}
	remote := map[string]func(*world){
		"unchanged":  func(w *world) { w.rf("u1", "root", "a.txt", "h1", 1, 10) },
		"modified":   func(w *world) { w.rf("u1", "root", "a.txt", "r2", 2, 11) },
		"deleted":    func(w *world) {},
		"moved":      func(w *world) { w.rf("u1", "root", "c.txt", "h1", 1, 11) },
		"moved-same": func(w *world) { w.rf("u1", "root", "b.txt", "h1", 1, 11) },
		"moved+mod":  func(w *world) { w.rf("u1", "root", "c.txt", "r2", 2, 12) },
		"same-hash":  func(w *world) { w.rf("u1", "root", "a.txt", "h1", 2, 11) }, // re-uploaded, same content
	}
	cases := []struct {
		l, r string
		want []string
	}{
		{"unchanged", "unchanged", nil},
		{"unchanged", "modified", []string{"download a.txt"}},
		{"unchanged", "deleted", []string{"delete_local a.txt"}},
		{"unchanged", "moved", []string{"move_local a.txt>c.txt"}},
		{"unchanged", "same-hash", nil},
		{"modified", "unchanged", []string{"upload a.txt @u1"}},
		{"saved-new", "unchanged", []string{"upload a.txt @u1"}},
		{"modified", "modified", []string{"conflict a.txt>" + conflictA}},
		{"modified", "deleted", []string{"upload a.txt"}},
		{"modified", "moved", []string{"move_local a.txt>c.txt", "upload c.txt @u1"}},
		{"deleted", "unchanged", []string{"trash_remote a.txt"}},
		{"deleted", "modified", []string{"download a.txt"}},
		{"deleted", "deleted", []string{"forget a.txt"}},
		{"deleted", "moved", []string{"download c.txt"}},
		{"moved", "unchanged", []string{"move_remote a.txt>b.txt"}},
		{"moved", "modified", []string{"move_remote a.txt>b.txt", "download b.txt"}},
		{"moved", "deleted", []string{"upload b.txt"}},
		{"moved", "moved-same", []string{"link b.txt"}},
		{"moved", "moved", []string{"move_local b.txt>c.txt"}},
		{"moved+mod", "unchanged", []string{"move_remote a.txt>b.txt", "upload b.txt @u1"}},
		{"moved", "moved+mod", []string{"move_local b.txt>c.txt", "download c.txt"}},
	}
	for _, c := range cases {
		w := newWorld().bf("a.txt", "u1", "L1", "h1", 1)
		local[c.l](w)
		remote[c.r](w)
		p := w.plan(t)
		eq(t, c.l+"/"+c.r, summary(p), c.want...)
		if len(p.Issues) != 0 {
			t.Errorf("%s/%s: unexpected issues %v", c.l, c.r, issueKinds(p))
		}
	}
}

func TestMatrixPreconditions(t *testing.T) {
	w := newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h2").rf("u1", "root", "a.txt", "h1", 1, 10)
	up := opOf(t, w.plan(t), Upload)
	if up.ContentVersion != 1 || up.RemoteID != "u1" || up.Local == nil || up.Local.ID != "L1" || up.SHA256 != "h2" || up.Base == nil {
		t.Errorf("replace upload %+v", up)
	}
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).rf("u1", "root", "a.txt", "h1", 1, 10)
	tr := opOf(t, w.plan(t), TrashRemote)
	if tr.RemoteSeq != 10 || tr.RemoteID != "u1" {
		t.Errorf("trash must CAS on the seq it judged: %+v", tr)
	}
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h1").rf("u1", "root", "a.txt", "r2", 2, 11)
	dl := opOf(t, w.plan(t), Download)
	if dl.ContentVersion != 2 || dl.PayloadChecksum != "pc-u1" || dl.SHA256 != "r2" || dl.Local == nil || dl.Local.Absent {
		t.Errorf("download %+v", dl)
	}
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).rf("u1", "root", "c.txt", "h1", 1, 11)
	dl = opOf(t, w.plan(t), Download)
	if !dl.Local.Absent || dl.Base == nil {
		t.Errorf("restore download must expect an absent target: %+v", dl)
	}
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("b.txt", "L1", "h1").rf("u1", "root", "a.txt", "h1", 1, 10)
	mv := opOf(t, w.plan(t), MoveRemote)
	if mv.RemoteSeq != 10 || mv.RemoteName != "b.txt" || mv.ParentPath != "" {
		t.Errorf("move %+v", mv)
	}
	// one.gy went v1 -> v3 back to the synced content (edit + revert elsewhere):
	// a local edit must replace against v3, not the base row's stale v1.
	for _, typ := range []string{"two_way", "backup"} {
		w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h2").rf("u1", "root", "a.txt", "h1", 3, 12)
		w.cfg.Type = typ
		if up := opOf(t, w.plan(t), Upload); up.ContentVersion != 3 {
			t.Errorf("%s: replace CAS %d, want the current version 3", typ, up.ContentVersion)
		}
	}
}

func TestCreatedOnBothSides(t *testing.T) {
	cases := []struct {
		name string
		w    *world
		want []string
	}{
		{"identical", newWorld().lf("n.txt", "L1", "same").rf("u1", "root", "n.txt", "same", 1, 5), []string{"link n.txt"}},
		{"different", newWorld().lf("n.txt", "L1", "loc1").rf("u1", "root", "n.txt", "rem2", 1, 5), []string{"conflict n.txt>n (conflict from DEV 2026-11-08 1432).txt"}},
		{"unknown hash same size", newWorld().lf("n.txt", "L1", "abcd").rf("u1", "root", "n.txt", "", 1, 5), nil},
		{"folders", newWorld().ld("d", "D1").rd("f1", "root", "d", 5), []string{"link d"}},
		{"file vs folder", newWorld().lf("d", "L1", "x").rd("f1", "root", "d", 5), []string{"conflict d>d (conflict from DEV 2026-11-08 1432)"}},
	}
	for _, c := range cases {
		c.w.cfg.Initial = ""
		c.w.bf("other", "zz", "LO", "o", 1).lf("other", "LO", "o").rf("zz", "root", "other", "o", 1, 1) // not a first run
		if c.name == "unknown hash same size" {
			c.w.remote[0].Size = 4
			c.want = []string{"verify_link n.txt"}
		}
		eq(t, c.name, summary(c.w.plan(t)), c.want...)
	}
}
