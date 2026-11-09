package reconcile

import "testing"

func typed(typ string, f func(*world)) []string {
	w := newWorld().bf("a.txt", "u1", "L1", "h1", 1)
	w.cfg.Type = typ
	f(w)
	return summary(w.plan(nil))
}

func TestSyncTypes(t *testing.T) {
	type cell = func(*world)
	localDeleted := cell(func(w *world) { w.rf("u1", "root", "a.txt", "h1", 1, 1) })
	remoteDeleted := cell(func(w *world) { w.lf("a.txt", "L1", "h1") })
	localEdit := cell(func(w *world) { w.lf("a.txt", "L1", "h2").rf("u1", "root", "a.txt", "h1", 1, 1) })
	remoteEdit := cell(func(w *world) { w.lf("a.txt", "L1", "h1").rf("u1", "root", "a.txt", "r2", 2, 2) })
	remoteMove := cell(func(w *world) { w.lf("a.txt", "L1", "h1").rf("u1", "root", "c.txt", "h1", 1, 2) })
	localNew := cell(func(w *world) { w.lf("a.txt", "L1", "h1").rf("u1", "root", "a.txt", "h1", 1, 1).lf("n.txt", "L2", "n") })
	remoteNew := cell(func(w *world) {
		w.lf("a.txt", "L1", "h1").rf("u1", "root", "a.txt", "h1", 1, 1).rf("u2", "root", "n.txt", "n", 1, 2)
	})
	cases := []struct {
		typ, name string
		c         cell
		want      []string
	}{
		{"full", "local delete", localDeleted, []string{"trash_remote a.txt"}},
		{"backup", "local delete", localDeleted, []string{"trash_remote a.txt"}},
		{"archive", "local delete", localDeleted, nil},
		{"mirror", "local delete", localDeleted, []string{"download a.txt"}},
		{"backup", "remote delete", remoteDeleted, []string{"upload a.txt"}},
		{"archive", "remote delete", remoteDeleted, []string{"upload a.txt"}},
		{"mirror", "remote delete", remoteDeleted, []string{"delete_local a.txt"}},
		{"backup", "local edit", localEdit, []string{"upload a.txt @u1"}},
		{"mirror", "local edit", localEdit, []string{"download a.txt"}},
		{"mirror", "remote edit", remoteEdit, []string{"download a.txt"}},
		{"backup", "remote move", remoteMove, []string{"move_remote c.txt>a.txt"}},
		{"mirror", "remote move", remoteMove, []string{"move_local a.txt>c.txt"}},
		{"backup", "local new", localNew, []string{"upload n.txt"}},
		{"mirror", "local new", localNew, []string{"delete_local n.txt"}},
		{"backup", "remote new", remoteNew, nil},
		{"archive", "remote new", remoteNew, nil},
		{"mirror", "remote new", remoteNew, []string{"download n.txt"}},
	}
	for _, c := range cases {
		eq(t, c.typ+" "+c.name, typed(c.typ, c.c), c.want...)
	}
	// Upload-only sync and a change made on one.gy: kept unless versions exist.
	w := newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h1").rf("u1", "root", "a.txt", "r2", 2, 2)
	w.cfg.Type = "backup"
	p := w.plan(t)
	eq(t, "backup remote edit", summary(p))
	eq(t, "backup remote edit issue", issueKinds(p), "conflict a.txt")
	w.cfg.Versioning = true
	eq(t, "backup remote edit, versions", summary(w.plan(t)), "upload a.txt @u1")
	// Mirror: a new local folder is reverted as a whole (children implied).
	w = newWorld().ld("n", "D1").lf("n/x", "L2", "x").lf("n/y", "L3", "y")
	w.cfg.Type = "mirror"
	eq(t, "mirror new folder", summary(w.plan(t)), "delete_local n")
	// Propagate deletes off: nothing happens, the base row stays.
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).rf("u1", "root", "a.txt", "h1", 1, 1)
	w.cfg.PropagateDeletes = false
	eq(t, "no delete propagation", summary(w.plan(t)))
}

func TestConflictPolicies(t *testing.T) {
	both := func(policy string, versions bool) *Plan {
		w := newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h2").rf("u1", "root", "a.txt", "r2", 2, 2)
		w.cfg.ConflictPolicy, w.cfg.Versioning = policy, versions
		return w.plan(nil)
	}
	eq(t, "keep_both", summary(both("keep_both", true)), "conflict a.txt>"+conflictA)
	eq(t, "prefer_remote without versions", summary(both("prefer_remote", false)), "conflict a.txt>"+conflictA)
	eq(t, "prefer_local without versions", summary(both("prefer_local", false)), "conflict a.txt>"+conflictA)
	eq(t, "prefer_remote", summary(both("prefer_remote", true)), "download a.txt")
	p := both("prefer_local", true)
	eq(t, "prefer_local", summary(p), "upload a.txt @u1")
	if o := opOf(t, p, Upload); o.ContentVersion != 2 {
		t.Errorf("prefer_local must CAS on the current remote version, got %d", o.ContentVersion)
	}
	p = both("ask", true)
	eq(t, "ask", summary(p))
	eq(t, "ask issue", issueKinds(p), "conflict a.txt")
	if is := p.Issues[0]; len(is.Actions) != 4 || is.Detail["local"] == nil {
		t.Errorf("ask issue %+v", is)
	}
	// Moved on one.gy and edited on both: move, then the conflict copy at the new place.
	w := newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h2").rf("u1", "root", "c.txt", "r2", 2, 2)
	eq(t, "move then conflict", summary(w.plan(t)), "move_local a.txt>c.txt", "conflict c.txt>c (conflict from DEV 2026-11-08 1432).txt")
	// Two conflicts in the same minute get distinct names.
	w = newWorld().bf("a.txt", "u1", "L1", "h1", 1).lf("a.txt", "L1", "h2").rf("u1", "root", "a.txt", "r2", 2, 2).lf(conflictA, "L7", "x")
	w.bf(conflictA, "u7", "L7", "x", 1).rf("u7", "root", conflictA, "x", 1, 1)
	eq(t, "taken conflict name", summary(w.plan(t)), "conflict a.txt>a (conflict from DEV 2026-11-08 1432 2).txt")
}

func TestGuards(t *testing.T) {
	many := func() *world {
		w := newWorld()
		for i := 0; i < 100; i++ {
			p := "f" + string(rune('A'+i/26)) + string(rune('a'+i%26))
			w.bf(p, "u"+p, "L"+p, "h", 1).rf("u"+p, "root", p, "h", 1, 1)
			if i < 40 {
				w.lf(p, "L"+p, "h")
			}
		}
		return w
	}
	p := many().plan(t)
	eq(t, "mass local delete", summary(p))
	if len(p.Issues) != 1 || p.Issues[0].Kind != "mass_delete" || p.Issues[0].Detail["count"] != 60 || p.Issues[0].Detail["side"] != "local" {
		t.Fatalf("mass delete issue %+v", p.Issues)
	}
	w := many()
	w.cfg.MassDeleteLocal = "apply"
	if n := len(w.plan(t).Ops); n != 60 {
		t.Fatalf("apply: %d ops", n)
	}
	w.cfg.MassDeleteLocal = "restore"
	for _, o := range w.plan(t).Ops {
		if o.Kind != Download {
			t.Fatalf("restore planned %s", o.Kind)
		}
	}
	// Remote wipe protection: someone empties the folder on the website.
	w = newWorld()
	for i := 0; i < 60; i++ {
		p := "g" + string(rune('A'+i/26)) + string(rune('a'+i%26))
		w.bf(p, "u"+p, "L"+p, "h", 1).lf(p, "L"+p, "h")
	}
	p = w.plan(t)
	eq(t, "remote wipe", summary(p))
	eq(t, "remote wipe issue", issueKinds(p), "mass_delete ")
	// Below the percentage: allowed.
	w = many()
	w.cfg.MassDeletePercent = 70
	if len(w.plan(t).Ops) != 60 {
		t.Fatal("under the percent threshold the deletes go through")
	}

	w = newWorld().bf("a", "u1", "L1", "h", 1)
	w.cfg.RootMissing = true
	eq(t, "root missing", issueKinds(w.plan(t)), "root_missing ")
	w = many()
	w.local = map[string]*localEntry{}
	p = w.plan(t)
	eq(t, "empty root", issueKinds(p), "root_missing ")
	eq(t, "empty root ops", summary(p))
	w = newWorld().bf("a", "u1", "L1", "h", 1)
	in := &Input{Config: w.cfg, Local: newWorld().tree(), Remote: Remote{RootMissing: true}, Base: w.base}
	eq(t, "remote root missing", issueKinds(Reconcile(in)), "remote_root_missing ")
}

func TestInitialStrategies(t *testing.T) {
	first := func(initial, typ string, versions bool) []string {
		w := newWorld().lf("same", "L1", "s").rf("u1", "root", "same", "s", 1, 1).
			lf("diff", "L2", "loc").rf("u2", "root", "diff", "rem", 1, 1).
			lf("onlylocal", "L3", "x").rf("u3", "root", "onlyremote", "y", 1, 1)
		w.cfg.Initial, w.cfg.Type, w.cfg.Versioning = initial, typ, versions
		return summary(w.plan(nil))
	}
	eq(t, "merge", first("merge", "two_way", false), "conflict diff>diff (conflict from DEV 2026-11-08 1432)", "upload onlylocal", "link same", "download onlyremote")
	eq(t, "local_source", first("local_source", "two_way", false), "upload onlylocal", "link same", "upload diff", "trash_remote diff", "trash_remote onlyremote")
	eq(t, "local_source + versions", first("local_source", "two_way", true), "upload onlylocal", "link same", "upload diff @u2", "trash_remote onlyremote")
	eq(t, "remote_source", first("remote_source", "two_way", false), "link same", "download onlyremote", "download diff", "delete_local onlylocal")
	eq(t, "mirror", first("merge", "mirror", false), "link same", "download onlyremote", "download diff", "delete_local onlylocal")
	eq(t, "archive local_source keeps remote extras", first("local_source", "archive", false), "upload onlylocal", "link same", "upload diff", "trash_remote diff")
}

func TestPreview(t *testing.T) {
	w := newWorld().lf("diff", "L2", "loc").rf("u2", "root", "diff", "remote", 1, 1).
		lf("up", "L3", "12345").rf("u3", "root", "down", "123", 1, 1).bf("gone", "u4", "L4", "h", 1).rf("u4", "root", "gone", "h", 1, 1)
	w.cfg.Initial = ""
	pv := w.plan(t).Preview()
	// The conflict counts the one.gy version's 6 bytes as a download.
	if pv.Uploads.Count != 2 || pv.Uploads.Bytes != 8 || pv.Downloads.Count != 2 || pv.Downloads.Bytes != 9 || pv.Conflicts != 1 || pv.Deletions != 1 || len(pv.Items) != 4 {
		t.Fatalf("preview %+v", pv)
	}
	if pv.Items[0].Action != "conflict" || pv.Items[3].Action != "delete_remote" {
		t.Fatalf("items %+v", pv.Items)
	}
}
